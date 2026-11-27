"""Strict, deterministic JSON-aware projection for known ``search_files`` shapes.

This module is intentionally narrow: it recognizes only two explicit schemas and
refuses everything else.  The canonical projection is derived from the parsed
JSON, never from a prefix of the raw bytes.  Excerpts selected by the rule
selector are therefore excerpts of the projection, not claims about raw lines.
The original bytes, digest and restore path remain owned by the engine/store.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from session_navigation.model import EngineConfig, compute_sha256
from session_navigation.policy import (
    check_refusal_reason,
    contains_sensitive_pattern,
    required_evidence_lines,
)

PROJECTION_VERSION = 1
MATCHES_SCHEMA = "search_files_matches_v1"
FILES_SCHEMA = "search_files_files_v1"
MAX_JSON_BYTES = 64 * 1024
MAX_FIELD_CHARS = 8192
MAX_LIST_ITEMS = 128
MAX_PROJECTION_LINES = 512
MAX_PROJECTION_BYTES = 32 * 1024
MIN_LINE_BUDGET = 96

_MATCHES_KEYS = frozenset(
    {"matches_format", "matches_text", "total_count", "total_count_is_lower_bound", "truncated", "_hint"}
)
_MATCHES_REQUIRED = _MATCHES_KEYS - {"_hint"}
_FILES_KEYS = frozenset({"files", "total_count"})
_UNSAFE_UNICODE = frozenset({"\u2028", "\u2029"})


@dataclass(frozen=True)
class JsonProjection:
    """Canonical projected source plus the evidence lines required from it."""

    schema: str
    source: str
    lines: tuple[str, ...]
    required: tuple[str, ...]
    digest: str


@dataclass(frozen=True)
class ProjectionDecision:
    """Either a usable projection or a fail-closed refusal code."""

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
    obj = json.loads(
        content,
        object_pairs_hook=_strict_object,
        parse_constant=_reject_constant,
    )
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
    return any(char in _UNSAFE_UNICODE for char in value)


def _value_refusal(value: str) -> str | None:
    if _has_unsafe_unicode(value):
        return "verification_failed"
    if contains_sensitive_pattern(value):
        return "protected_error"
    reason = check_refusal_reason(value, min_chars=0)
    if reason is not None:
        return "protected_error" if reason == "protected_error" else "verification_failed"
    return None


def _append_chunks(
    out: list[str],
    *,
    schema: str,
    field: str,
    value: str,
    max_line: int,
) -> bool:
    """Append bounded, provenance-labelled JSON-escaped chunks.

    A semantic unit containing required evidence must fit in one projected
    line; splitting it would make the evidence unverifiable, so it fails
    closed instead.
    """
    chars = list(value)
    if not chars:
        out.append(f"projected {schema} {field}+0: \"\"")
        return True
    whole_prefix = f"projected {schema} {field}+0: "
    if required_evidence_lines(value) and len(whole_prefix) + len(_encoded(value)) > max_line:
        return False
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
            schema=schema,
            source=source,
            lines=tuple(lines),
            required=required,
            digest=compute_sha256(original),
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
    lines = [header, total_line, lower_line, truncated_line]
    if not _append_chunks(out=lines, schema=schema, field="matches_format", value=obj["matches_format"], max_line=max_line):
        return ProjectionDecision(refusal="verification_failed")
    if "_hint" in obj and not _append_chunks(out=lines, schema=schema, field="_hint", value=obj["_hint"], max_line=max_line):
        return ProjectionDecision(refusal="verification_failed")
    for index, line in enumerate(obj["matches_text"].splitlines()):
        if not line:
            continue
        if not _append_chunks(out=lines, schema=schema, field=f"matches_text[{index}]", value=line, max_line=max_line):
            return ProjectionDecision(refusal="verification_failed")
    return _finish(
        schema=schema, lines=lines,
        metadata_lines=(header, total_line, lower_line, truncated_line),
        original=original, config=config,
    )


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
    for value in files:
        refusal = _value_refusal(value)
        if refusal is not None:
            return ProjectionDecision(refusal=refusal)

    schema = FILES_SCHEMA
    max_line = min(config.max_excerpt_line_length, 240)
    if max_line < MIN_LINE_BUDGET:
        return ProjectionDecision(refusal="verification_failed")
    header = f"projected {schema} schema-version = {PROJECTION_VERSION} digest = {digest}"
    total_line = _metadata_line(schema, "total_count", obj["total_count"])
    lines = [header, total_line]
    for index, value in enumerate(files):
        if not value:
            continue
        if not _append_chunks(out=lines, schema=schema, field=f"files[{index}]", value=value, max_line=max_line):
            return ProjectionDecision(refusal="verification_failed")
    return _finish(
        schema=schema, lines=lines, metadata_lines=(header, total_line),
        original=original, config=config,
    )


def project_json_tool_result(
    content: str, tool_name: Any, config: EngineConfig | None = None
) -> ProjectionDecision:
    """Return a strict projection for supported search_files outputs.

    Clearly plain text and oversized plain text fall back to the legacy path.
    Only JSON-looking input that is malformed or untrusted is fail-closed.
    """
    if tool_name != "search_files":
        return ProjectionDecision()
    cfg = config or EngineConfig()
    stripped = content.lstrip()
    json_like = stripped.startswith("{") or stripped.startswith("[")
    if not json_like:
        return ProjectionDecision()
    try:
        raw_bytes = content.encode("utf-8")
    except UnicodeEncodeError:
        return ProjectionDecision(refusal="verification_failed")
    if len(raw_bytes) > MAX_JSON_BYTES:
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


def verify_projection(content: str, tool_name: Any, projection: JsonProjection, config: EngineConfig | None = None) -> bool:
    """Recompute the canonical projection and compare all identity fields."""
    decision = project_json_tool_result(content, tool_name, config)
    if decision.projection is None:
        return False
    return (
        decision.projection.schema == projection.schema
        and decision.projection.source == projection.source
        and decision.projection.lines == projection.lines
        and decision.projection.required == projection.required
        and decision.projection.digest == projection.digest
    )
