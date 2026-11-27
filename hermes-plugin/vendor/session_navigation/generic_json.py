"""Schema-agnostic safety inspection for arbitrary JSON tool output.

The module never claims semantic preservation of an unknown schema. It applies
uniform structural limits and returns a deterministic digest of a canonical
form which keeps original number tokens, so Python and TypeScript agree on
integers and exponents; values outside the finite double range are refused.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Literal

from session_navigation.policy import parsed_string_evidence_lines


MAX_JSON_BYTES = 64 * 1024
MAX_DEPTH = 256
MAX_NODES = 4096
MAX_STRING_CHARS = 8192
MAX_EVIDENCE_LINES = 64
MAX_EVIDENCE_LINE_CHARS = 240
MAX_EVIDENCE_BYTES = 8192
_UNSAFE_CODEPOINTS = frozenset({0x2028, 0x2029})


@dataclass(frozen=True)
class GenericJsonDecision:
    """Result of inspecting schema-agnostic JSON content."""

    ok: bool
    refusal: str | None
    kind: Literal["object", "array", "scalar"] | None
    nodes: int
    depth: int
    digest: str


@dataclass(frozen=True)
class _RawNumber:
    token: str


def _raw_number(token: str) -> _RawNumber:
    # StrictJsonParser rejects numbers outside the finite double range; keep
    # the original token for the digest but apply the same boundary here.
    if not math.isfinite(float(token)):
        raise ValueError("number out of range")
    return _RawNumber(token)


def _reject_constant(token: str) -> None:
    raise ValueError(f"non-standard JSON constant: {token}")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON key")
        obj[key] = value
    return obj


def _has_unsafe_unicode(value: str) -> bool:
    return any(ord(char) in _UNSAFE_CODEPOINTS or 0xD800 <= ord(char) <= 0xDFFF for char in value)


def _encoded_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _utf8_size(content: str) -> int:
    try:
        return len(content.encode("utf-8"))
    except UnicodeEncodeError:
        # Count lone surrogates without letting them escape the size check.
        return len(content.encode("utf-8", "surrogatepass"))


_VALUE = 0
_TEXT = 1
_CLOSE_OBJECT = 2
_CLOSE_ARRAY = 3


def _canonical(value: Any) -> tuple[str, int, int]:
    """Return canonical form, node count and maximum container depth."""
    out: list[str] = []
    stack: list[tuple[int, Any, int]] = [(_VALUE, value, 0)]
    nodes = 0
    depth = 0
    while stack:
        tag, payload, level = stack.pop()
        if tag == _TEXT:
            out.append(payload)
            continue
        if tag == _CLOSE_OBJECT:
            out.append("}")
            continue
        if tag == _CLOSE_ARRAY:
            out.append("]")
            continue

        nodes += 1
        if nodes > MAX_NODES:
            raise ValueError("too many JSON nodes")
        if isinstance(payload, _RawNumber):
            out.append(payload.token)
        elif payload is None:
            out.append("null")
        elif type(payload) is bool:
            out.append("true" if payload else "false")
        elif isinstance(payload, str):
            if len(payload) > MAX_STRING_CHARS or _has_unsafe_unicode(payload):
                raise ValueError("unsafe JSON string")
            out.append(_encoded_string(payload))
        elif isinstance(payload, dict):
            level += 1
            if level > MAX_DEPTH:
                raise ValueError("JSON nesting too deep")
            depth = max(depth, level)
            out.append("{")
            stack.append((_CLOSE_OBJECT, None, level))
            pairs = sorted(payload.items(), key=lambda item: item[0])
            for index in range(len(pairs) - 1, -1, -1):
                key, item = pairs[index]
                if len(key) > MAX_STRING_CHARS or _has_unsafe_unicode(key):
                    raise ValueError("unsafe JSON key")
                stack.append((_VALUE, item, level))
                stack.append((_TEXT, _encoded_string(key) + ":", 0))
                if index > 0:
                    stack.append((_TEXT, ",", 0))
        elif isinstance(payload, list):
            level += 1
            if level > MAX_DEPTH:
                raise ValueError("JSON nesting too deep")
            depth = max(depth, level)
            out.append("[")
            stack.append((_CLOSE_ARRAY, None, level))
            for index in range(len(payload) - 1, -1, -1):
                stack.append((_VALUE, payload[index], level))
                if index > 0:
                    stack.append((_TEXT, ",", 0))
        else:
            raise ValueError("unsupported JSON value")
    return "".join(out), nodes, depth


def _refusal(code: str) -> GenericJsonDecision:
    return GenericJsonDecision(ok=False, refusal=code, kind=None, nodes=0, depth=0, digest="")


@dataclass(frozen=True)
class _ParsedJson:
    """Strict parse result shared by inspection and structural evidence."""

    value: Any
    canonical: str
    nodes: int
    depth: int


def _parse_strict(content: str) -> tuple[str | None, _ParsedJson | None]:
    """Parse once under the limits used by ``inspect_generic_json``."""
    if not isinstance(content, str):
        return "verification_failed", None
    if _utf8_size(content) > MAX_JSON_BYTES:
        return "input_too_large", None
    if _has_unsafe_unicode(content):
        return "verification_failed", None
    try:
        value = json.loads(
            content,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_constant,
            parse_int=_raw_number,
            parse_float=_raw_number,
        )
        canonical, nodes, depth = _canonical(value)
    except (ValueError, TypeError, RecursionError):
        return "verification_failed", None
    return None, _ParsedJson(value, canonical, nodes, depth)


def _decision(parsed: _ParsedJson) -> GenericJsonDecision:
    kind: Literal["object", "array", "scalar"]
    if isinstance(parsed.value, dict):
        kind = "object"
    elif isinstance(parsed.value, list):
        kind = "array"
    else:
        kind = "scalar"
    return GenericJsonDecision(
        ok=True,
        refusal=None,
        kind=kind,
        nodes=parsed.nodes,
        depth=parsed.depth,
        digest=hashlib.sha256(parsed.canonical.encode("utf-8")).hexdigest(),
    )


def _scalar_token(value: Any) -> str | None:
    if isinstance(value, _RawNumber):
        return value.token
    if value is None:
        return "null"
    if type(value) is bool:
        return "true" if value else "false"
    if isinstance(value, str):
        return _encoded_string(value)
    return None


def _evidence_line(key: str, token: str) -> str:
    line = f"{key}: {token}"
    if len(line) > MAX_EVIDENCE_LINE_CHARS:
        return line[: MAX_EVIDENCE_LINE_CHARS - 3] + "..."
    return line


class _EvidenceBudgetExceeded(Exception):
    """Raised when evidence would exceed the hard line/byte budget."""


def _parsed_policy_evidence(parsed: _ParsedJson) -> tuple[tuple[str, str], ...]:
    """Collect policy-required/protected lines from every parsed value.

    Keys are sorted and arrays walked by index so the result is independent of
    source key order. Each pair is (json path, verbatim decoded line).
    """
    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(path: str, line: str) -> None:
        marker = f"{path}\0{line}"
        if marker not in seen:
            seen.add(marker)
            found.append((path, line))

    def walk(value: Any, path: str) -> None:
        if isinstance(value, dict):
            for key in sorted(value):
                child = f"{path}.{key}" if path else key
                walk(value[key], child)
        elif isinstance(value, list):
            for index, member in enumerate(value):
                walk(member, f"{path}[{index}]")
        elif isinstance(value, str):
            for line in parsed_string_evidence_lines(value):
                add(path or "value", line)
        else:
            token = _scalar_token(value)
            if token is not None:
                labelled = f"{path}: {token}" if path else token
                if parsed_string_evidence_lines(labelled):
                    add(path or "value", token)

    walk(parsed.value, "")
    return tuple(found)


def _bounded_evidence(parsed: _ParsedJson) -> tuple[str, ...]:
    """Deterministic policy-protected and shallow structural evidence."""
    lines: list[str] = []
    used = 0

    def append(key: str, token: str) -> None:
        nonlocal used
        line = _evidence_line(key, token)
        size = len(line.encode("utf-8"))
        if len(lines) >= MAX_EVIDENCE_LINES or used + size > MAX_EVIDENCE_BYTES:
            raise _EvidenceBudgetExceeded
        lines.append(line)
        used += size

    def append_scalars(prefix: str, values: list[Any]) -> None:
        for index in sorted({0, 1, len(values) - 2, len(values) - 1}):
            if not 0 <= index < len(values):
                continue
            token = _scalar_token(values[index])
            if token is not None:
                append(f"{prefix}[{index}]", token)

    # Protected/required lines come first so a budget overflow can never drop
    # them while retaining merely descriptive structural samples.
    for path, line in _parsed_policy_evidence(parsed):
        append(path, line)

    value = parsed.value
    if isinstance(value, dict):
        for key in sorted(value):
            member = value[key]
            token = _scalar_token(member)
            if token is not None:
                append(key, token)
                if isinstance(member, str) and len(member) > MAX_EVIDENCE_LINE_CHARS:
                    append(f"{key}_chars", str(len(member)))
            elif isinstance(member, dict):
                append(key, "object")
            elif isinstance(member, list):
                append(key, f"list({len(member)})")
                append_scalars(key, member)
    elif isinstance(value, list):
        append("items", str(len(value)))
        append_scalars("", value)
    else:
        token = _scalar_token(value)
        if token is not None:
            append("value", token)
    return tuple(lines)


def parsed_json_policy_lines(content: str) -> tuple[str, ...]:
    """Return unprefixed protected/required lines from strictly parsed values."""
    _, parsed = _parse_strict(content)
    if parsed is None:
        return ()
    return tuple(line for _, line in _parsed_policy_evidence(parsed))


def inspect_generic_json_with_evidence(
    content: str,
) -> tuple[GenericJsonDecision, tuple[str, ...]]:
    """Return the inspection decision and structural evidence from one parse."""
    refusal, parsed = _parse_strict(content)
    if parsed is None:
        return _refusal(refusal or "verification_failed"), ()
    try:
        evidence = _bounded_evidence(parsed)
    except _EvidenceBudgetExceeded:
        return _refusal("verification_failed"), ()
    return _decision(parsed), evidence


def inspect_generic_json(content: str) -> GenericJsonDecision:
    """Inspect arbitrary JSON text without interpreting an application schema."""
    refusal, parsed = _parse_strict(content)
    if parsed is None:
        return _refusal(refusal or "verification_failed")
    try:
        _bounded_evidence(parsed)
    except _EvidenceBudgetExceeded:
        return _refusal("verification_failed")
    return _decision(parsed)


def parsed_json_evidence(content: str) -> tuple[str, ...]:
    """Return bounded structural evidence derived from strictly parsed values."""
    _, parsed = _parse_strict(content)
    if parsed is None:
        return ()
    try:
        return _bounded_evidence(parsed)
    except _EvidenceBudgetExceeded:
        return ()
