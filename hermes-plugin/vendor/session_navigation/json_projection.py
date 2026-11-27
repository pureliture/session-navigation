"""Strict JSON-aware projection for known ``search_files`` outputs.

Two schemas are recognized. ``matches`` remains fail-closed for long evidence
lines. ``files`` uses a deterministic v2 prefix+suffix projection: the common
path prefix is separated once, suffixes are emitted in order, and a verifier
reconstructs the original path list from the original JSON independently of
the projection text. Raw bytes, digest, storage and restore stay engine-owned.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from session_navigation.model import EngineConfig, compute_sha256
from session_navigation.policy import (
    check_refusal_reason,
    contains_sensitive_pattern,
    evidence_spans,
    required_evidence_lines,
)

PROJECTION_VERSION = 1
MATCHES_SCHEMA = "search_files_matches_v1"
FILES_SCHEMA = "search_files_files_v2"
MAX_JSON_BYTES = 64 * 1024
MAX_FIELD_CHARS = 8192
MAX_LIST_ITEMS = 128
MAX_PROJECTION_LINES = 512
MAX_PROJECTION_EVIDENCE_LINES = 640
MAX_PROJECTION_BYTES = 32 * 1024
MIN_LINE_BUDGET = 96
MAX_PROJECTION_LINE_LENGTH = 1024

_MATCHES_KEYS = frozenset(
    {"matches_format", "matches_text", "total_count", "total_count_is_lower_bound", "truncated", "_hint"}
)
_MATCHES_REQUIRED = _MATCHES_KEYS - {"_hint"}
_FILES_KEYS = frozenset({"files", "total_count"})
_UNSAFE_CODEPOINTS = frozenset({0x2028, 0x2029})


@dataclass(frozen=True)
class JsonProjection:
    schema: str
    source: str
    lines: tuple[str, ...]
    required: tuple[str, ...]
    digest: str


@dataclass(frozen=True)
class ProjectionDecision:
    projection: JsonProjection | None = None
    refusal: str | None = None


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant: {value}")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON key")
        obj[key] = value
    return obj


def _loads_strict(content: str) -> dict[str, Any]:
    obj = json.loads(content, object_pairs_hook=_strict_object, parse_constant=_reject_constant)
    if not isinstance(obj, dict):
        raise ValueError("JSON value is not an object")
    return obj


def _is_int(value: Any) -> bool:
    return type(value) is int


def _is_bool(value: Any) -> bool:
    return type(value) is bool


def _encoded(value: str) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _has_unsafe_unicode(value: str) -> bool:
    return any(ord(char) in _UNSAFE_CODEPOINTS or 0xD800 <= ord(char) <= 0xDFFF for char in value)


def _value_refusal(value: str) -> str | None:
    if _has_unsafe_unicode(value):
        return "verification_failed"
    if contains_sensitive_pattern(value):
        return "protected_error"
    reason = check_refusal_reason(value, min_chars=0)
    if reason == "protected_error":
        return "protected_error"
    return "verification_failed" if reason is not None else None


def _append_chunks(
    out: list[str], *, schema: str, field: str, value: str, max_line: int
) -> bool:
    """Append bounded, provenance-labelled JSON-escaped chunks."""
    chars = list(value)
    if not chars:
        out.append(f"projected {schema} {field}+0: \"\"")
        return True
    whole_prefix = f"projected {schema} {field}+0: "
    if len(whole_prefix) + len(_encoded(value)) <= max_line:
        out.append(whole_prefix + _encoded(value))
        return True
    start = 0
    chunk: list[str] = []
    for char in chars:
        candidate = "".join(chunk + [char])
        prefix = f"projected {schema} {field}+{start}: "
        if len(prefix) + len(_encoded(candidate)) > max_line:
            if not chunk:
                return False
            out.append(prefix + _encoded("".join(chunk)))
            start += len(chunk)
            chunk = [char]
            prefix = f"projected {schema} {field}+{start}: "
            if len(prefix) + len(_encoded(char)) > max_line:
                return False
        else:
            chunk = list(candidate)
    if chunk:
        prefix = f"projected {schema} {field}+{start}: "
        out.append(prefix + _encoded("".join(chunk)))
    return True


def _metadata_line(schema: str, field: str, value: Any) -> str:
    if _is_bool(value):
        rendered = "true" if value else "false"
    elif _is_int(value):
        rendered = str(value)
    else:
        rendered = _encoded(str(value))
    return f"projected {schema} {field} = {rendered}"


def _finish(
    *,
    schema: str,
    lines: list[str],
    metadata_lines: tuple[str, ...],
    original: str,
    config: EngineConfig,
) -> ProjectionDecision:
    if len(lines) > MAX_PROJECTION_LINES:
        return ProjectionDecision(refusal="verification_failed")
    source = "\n".join(lines)
    if len(source.encode("utf-8")) > MAX_PROJECTION_BYTES:
        return ProjectionDecision(refusal="verification_failed")
    if any(len(line) > config.max_excerpt_line_length for line in lines):
        return ProjectionDecision(refusal="verification_failed")
    required = tuple(metadata_lines)
    for line in required_evidence_lines(source):
        if line not in required:
            required += (line,)
    if len(required) > config.max_evidence_excerpts:
        return ProjectionDecision(refusal="verification_failed")
    return ProjectionDecision(
        projection=JsonProjection(
            schema=schema, source=source, lines=tuple(lines),
            required=required, digest=compute_sha256(original),
        )
    )


def _project_matches(
    obj: dict[str, Any], original: str, config: EngineConfig, digest: str
) -> ProjectionDecision:
    keys = frozenset(obj)
    if not _MATCHES_REQUIRED.issubset(keys) or not keys.issubset(_MATCHES_KEYS):
        return ProjectionDecision()
    if not isinstance(obj["matches_format"], str) or not isinstance(obj["matches_text"], str):
        return ProjectionDecision(refusal="verification_failed")
    if not _is_int(obj["total_count"]) or obj["total_count"] < 0:
        return ProjectionDecision(refusal="verification_failed")
    if not _is_bool(obj["total_count_is_lower_bound"]) or not _is_bool(obj["truncated"]):
        return ProjectionDecision(refusal="verification_failed")
    if "_hint" in obj and not isinstance(obj["_hint"], str):
        return ProjectionDecision(refusal="verification_failed")
    strings = [obj["matches_format"], obj["matches_text"]]
    if "_hint" in obj:
        strings.append(obj["_hint"])
    if any(len(value) > MAX_FIELD_CHARS for value in strings):
        return ProjectionDecision(refusal="verification_failed")
    for value in strings:
        refusal = _value_refusal(value)
        if refusal is not None:
            return ProjectionDecision(refusal=refusal)

    schema = MATCHES_SCHEMA
    max_line = min(config.max_excerpt_line_length, 240)
    if max_line < MIN_LINE_BUDGET:
        return ProjectionDecision(refusal="verification_failed")
    header = f"projected {schema} schema-version = {PROJECTION_VERSION} digest = {digest}"
    total_line = _metadata_line(schema, "total_count", obj["total_count"])
    lower_line = _metadata_line(schema, "total_count_is_lower_bound", obj["total_count_is_lower_bound"])
    truncated_line = _metadata_line(schema, "truncated", obj["truncated"])
    metadata = (header, total_line, lower_line, truncated_line)
    lines = list(metadata)
    if not _append_chunks(out=lines, schema=schema, field="matches_format", value=obj["matches_format"], max_line=max_line):
        return ProjectionDecision(refusal="verification_failed")
    if "_hint" in obj and not _append_chunks(out=lines, schema=schema, field="_hint", value=obj["_hint"], max_line=max_line):
        return ProjectionDecision(refusal="verification_failed")
    for index, line in enumerate(obj["matches_text"].splitlines()):
        if not line:
            continue
        if not _append_chunks(out=lines, schema=schema, field=f"matches_text[{index}]", value=line, max_line=max_line):
            return ProjectionDecision(refusal="verification_failed")
    return _finish(schema=schema, lines=lines, metadata_lines=metadata, original=original, config=config)


def _common_prefix(values: list[str]) -> str:
    if not values:
        return ""
    prefix = values[0]
    for value in values[1:]:
        index = 0
        while index < len(prefix) and index < len(value) and prefix[index] == value[index]:
            index += 1
        prefix = prefix[:index]
    return prefix


def _prefix_lines(prefix: str, max_line: int) -> list[str] | None:
    lines: list[str] = []
    start = 0
    chunk: list[str] = []
    for char in prefix:
        candidate = "".join(chunk + [char])
        line = f"p;prefix+{start}={_encoded(candidate)}"
        if len(line) > max_line:
            if not chunk:
                return None
            lines.append(f"p;prefix+{start}={_encoded(''.join(chunk))}")
            start += len(chunk)
            chunk = [char]
            if len(f"p;prefix+{start}={_encoded(char)}") > max_line:
                return None
        else:
            chunk = list(candidate)
    if chunk:
        lines.append(f"p;prefix+{start}={_encoded(''.join(chunk))}")
    return lines or [f"p;prefix+0=\"\""]


def _suffix_lines(
    suffixes: list[str], evidence: list[bool], max_line: int
) -> tuple[list[str], list[bool]] | None:
    lines: list[str] = []
    flags: list[bool] = []
    current = "p;suffixes=["
    current_evidence = False
    for index, suffix in enumerate(suffixes):
        token = _encoded(suffix)
        whole = "p;suffixes=[" + token + "]"
        if len(whole) <= max_line:
            candidate = current + token if current.endswith("[") else current + "," + token
            candidate += "]"
            if len(candidate) <= max_line:
                current = candidate[:-1]
                current_evidence = current_evidence or evidence[index]
                continue
            lines.append(current + "]")
            flags.append(current_evidence)
            current = "p;suffixes=[" + _encoded(suffix)
            current_evidence = evidence[index]
            continue

        lines.append(current + "]")
        flags.append(current_evidence)
        current = "p;suffixes=["
        current_evidence = False
        spans = evidence_spans(suffix)
        start = 0
        chunk: list[str] = []
        for position, char in enumerate(suffix):
            label = f"p;suffix+{index}+{start}="
            candidate_value = "".join(chunk + [char])
            cuts_evidence = any(a < position < b for a, b in spans)
            if len(label) + len(_encoded(candidate_value)) > max_line and chunk and not cuts_evidence:
                end = start + len(chunk)
                carries = any(a < end and b > start for a, b in spans)
                lines.append(label + _encoded("".join(chunk)))
                flags.append(carries or evidence[index])
                start = end
                chunk = [char]
                continue
            if len(f"p;suffix+{index}+{start}=") + len(_encoded(char)) > max_line:
                return None
            chunk.append(char)
        if chunk:
            end = start + len(chunk)
            carries = any(a < end and b > start for a, b in spans)
            lines.append(f"p;suffix+{index}+{start}=" + _encoded("".join(chunk)))
            flags.append(carries or evidence[index])
    if current != "p;suffixes=[":
        lines.append(current + "]")
        flags.append(current_evidence)
    return lines, flags


def _project_files(
    obj: dict[str, Any], original: str, config: EngineConfig, digest: str
) -> ProjectionDecision:
    if frozenset(obj) != _FILES_KEYS:
        return ProjectionDecision()
    files = obj["files"]
    if not isinstance(files, list) or len(files) > MAX_LIST_ITEMS:
        return ProjectionDecision(refusal="verification_failed")
    if not _is_int(obj["total_count"]) or obj["total_count"] < 0:
        return ProjectionDecision(refusal="verification_failed")
    if any(not isinstance(value, str) or len(value) > MAX_FIELD_CHARS for value in files):
        return ProjectionDecision(refusal="verification_failed")
    raw_reason = check_refusal_reason(original, min_chars=0)
    if raw_reason is not None:
        return ProjectionDecision(refusal="protected_error" if raw_reason == "protected_error" else "verification_failed")
    for value in files:
        refusal = _value_refusal(value)
        if refusal is not None:
            return ProjectionDecision(refusal=refusal)

    max_line = MAX_PROJECTION_LINE_LENGTH
    prefix = "" if any(value == "" for value in files) else _common_prefix(files)
    suffixes = [value[len(prefix):] for value in files]
    evidence = [bool(required_evidence_lines(value)) for value in files]
    evidence_units = sum(evidence)
    header = (
        f"projected {FILES_SCHEMA} v=2 digest={digest} total_count={obj['total_count']} "
        f"items={len(files)} verified={len(files)} evidence={evidence_units} "
        "note=prefix+suffix;restore=unhide_context"
    )
    if len(header) > max_line:
        return ProjectionDecision(refusal="verification_failed")
    prefix_part = _prefix_lines(prefix, max_line)
    if prefix_part is None:
        return ProjectionDecision(refusal="verification_failed")
    suffix_part = _suffix_lines(suffixes, evidence, max_line)
    if suffix_part is None:
        return ProjectionDecision(refusal="verification_failed")
    suffix_lines, _suffix_flags = suffix_part
    lines = [header] + prefix_part + suffix_lines
    required = tuple(lines)
    if len(required) > MAX_PROJECTION_EVIDENCE_LINES:
        return ProjectionDecision(refusal="verification_failed")
    source = "\n".join(lines)
    if len(source.encode("utf-8")) > MAX_PROJECTION_BYTES or len(lines) > MAX_PROJECTION_LINES:
        return ProjectionDecision(refusal="verification_failed")
    return ProjectionDecision(
        projection=JsonProjection(
            schema=FILES_SCHEMA, source=source, lines=tuple(lines),
            required=required, digest=compute_sha256(original),
        )
    )


def project_json_tool_result(
    content: str, tool_name: Any, config: EngineConfig | None = None
) -> ProjectionDecision:
    if tool_name != "search_files":
        return ProjectionDecision()
    cfg = config or EngineConfig()
    stripped = content.lstrip()
    if not (stripped.startswith("{") or stripped.startswith("[")):
        return ProjectionDecision()
    try:
        if len(content.encode("utf-8")) > MAX_JSON_BYTES:
            return ProjectionDecision(refusal="verification_failed")
    except UnicodeEncodeError:
        return ProjectionDecision(refusal="verification_failed")
    try:
        obj = _loads_strict(content)
    except (ValueError, TypeError):
        return ProjectionDecision(refusal="verification_failed")
    digest = compute_sha256(content)
    matches = _project_matches(obj, content, cfg, digest)
    if matches.projection is not None or matches.refusal is not None:
        return matches
    return _project_files(obj, content, cfg, digest)


def reconstruct_files_projection(source: str) -> list[str] | None:
    """Reconstruct the full path list from a v2 projection, independently."""
    lines = source.splitlines()
    if not lines or not lines[0].startswith(f"projected {FILES_SCHEMA} v=2 "):
        return None
    prefix_parts: list[tuple[int, str]] = []
    suffix_parts: dict[int, list[tuple[int, str]]] = {}
    next_index = 0
    for line in lines[1:]:
        if line.startswith("p;prefix+"):
            head, _, encoded_value = line.partition("=")
            try:
                offset = int(head[len("p;prefix+"):])
            except ValueError:
                return None
            value = json.loads(encoded_value)
            if not isinstance(value, str):
                return None
            prefix_parts.append((offset, value))
        elif line.startswith("p;suffixes=["):
            values = json.loads(line[len("p;suffixes="):])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                return None
            for value in values:
                suffix_parts.setdefault(next_index, []).append((0, value))
                next_index += 1
        elif line.startswith("p;suffix+"):
            head, _, encoded_value = line.partition("=")
            bits = head.split("+")
            if len(bits) != 3:
                return None
            try:
                index, offset = int(bits[1]), int(bits[2])
            except ValueError:
                return None
            value = json.loads(encoded_value)
            if not isinstance(value, str):
                return None
            suffix_parts.setdefault(index, []).append((offset, value))
            next_index = max(next_index, index + 1)
        else:
            return None
    if not prefix_parts:
        return None
    prefix_parts.sort()
    prefix = ""
    expected = 0
    for offset, value in prefix_parts:
        if offset != expected:
            return None
        prefix += value
        expected += len(value)
    if not suffix_parts:
        return []
    result: list[str] = []
    for index in range(max(suffix_parts) + 1):
        parts = suffix_parts.get(index)
        if parts is None:
            return None
        parts.sort()
        suffix = ""
        expected = 0
        for offset, value in parts:
            if offset != expected:
                return None
            suffix += value
            expected += len(value)
        result.append(prefix + suffix)
    return result


def verify_projection(
    content: str, tool_name: Any, projection: JsonProjection, config: EngineConfig | None = None
) -> bool:
    if not isinstance(content, str) or tool_name != "search_files":
        return False
    decision = project_json_tool_result(content, tool_name, config)
    if decision.projection is None:
        return False
    candidate = decision.projection
    if (
        candidate.schema != projection.schema
        or candidate.source != projection.source
        or candidate.lines != projection.lines
        or candidate.required != projection.required
        or candidate.digest != projection.digest
        or projection.digest != compute_sha256(content)
    ):
        return False
    if candidate.schema == FILES_SCHEMA:
        try:
            original = json.loads(content)
        except (ValueError, TypeError):
            return False
        if not isinstance(original, dict) or not isinstance(original.get("files"), list):
            return False
        if reconstruct_files_projection(candidate.source) != original["files"]:
            return False
    return True


def verify_projection_render(
    rendered: str,
    content: str,
    tool_name: Any,
    projection: JsonProjection,
    config: EngineConfig | None = None,
) -> bool:
    """Verify the actual model-facing replacement, not just the projection."""
    if projection.schema != FILES_SCHEMA or not verify_projection(content, tool_name, projection, config):
        return False
    if not isinstance(rendered, str) or not rendered.startswith("[hidden:"):
        return False
    restore_marker = "The remaining result is preserved. Restore it with unhide_context("
    if restore_marker not in rendered:
        return False
    label = "Projected JSON (prefix+suffix; restore with unhide_context): "
    body = rendered.split("\n", 1)[1] if "\n" in rendered else ""
    body = body.split(restore_marker, 1)[0].rstrip("\n")
    rows = body.split("\n")
    if len(rows) != len(projection.lines):
        return False
    for row, expected in zip(rows, projection.lines):
        if not row.startswith(label) or row[len(label):] != expected:
            return False
    try:
        original = json.loads(content)
    except (ValueError, TypeError):
        return False
    decoded = "\n".join(row[len(label):] for row in rows)
    return reconstruct_files_projection(decoded) == original.get("files")
