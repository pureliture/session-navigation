"""Shared bounded JSON protection decision for every compaction path."""
from __future__ import annotations

import re
from typing import Any

from session_navigation.generic_json import (
    JsonProtectionBudget,
    BoundedJsonParse,
    parse_json_for_protection,
)
from session_navigation.model import EngineConfig, ToolResultRecord
from session_navigation.policy import protected_pattern_refusal, refusal_reason


_LEADING_JSON_WS = re.compile(r"^[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u2060\ufeff]+")
_READ_ENVELOPE_HEADER = re.compile(
    r"^\[(?:[^\[\]\"{}\x00-\x1f\x7f-\x9f]{1,512}#[0-9A-Fa-f]{4}|Skill file: [^\[\]\"{}\x00-\x1f\x7f-\x9f]{1,512})\]\r?\n"
)


def _strip_read_envelope_body(content: str) -> str:
    match = _READ_ENVELOPE_HEADER.match(content)
    return content[match.end():] if match is not None else content


def is_json_like(content: str) -> bool:
    stripped = _LEADING_JSON_WS.sub("", _strip_read_envelope_body(content))
    return bool(stripped) and stripped[0] in '{["'


_is_json_like = is_json_like


def _walk(value: Any, budget: JsonProtectionBudget) -> str | None:
    if isinstance(value, str):
        direct = protected_pattern_refusal(value)
        if direct is not None:
            return direct
        # Only a string that is itself valid JSON (or an envelope header over a
        # JSON body) is decoded again. Ordinary literal backslash-u text is kept as-is.
        if not _is_json_like(value):
            return None
        parsed, refusal = parse_json_for_protection(_strip_read_envelope_body(value), budget)
        if refusal is not None:
            return refusal
        return _walk(parsed.value, budget) if parsed is not None else None
    if isinstance(value, dict):
        for child in value.values():
            refused = _walk(child, budget)
            if refused is not None:
                return refused
        return None
    if isinstance(value, list):
        for child in value:
            refused = _walk(child, budget)
            if refused is not None:
                return refused
        return None
    return None


def json_protection_refusal(content: str) -> str | None:
    """Refusal for protected text in the original or bounded JSON decodings."""
    if not _is_json_like(content):
        return None
    budget = JsonProtectionBudget()
    parsed, refusal = parse_json_for_protection(_strip_read_envelope_body(content), budget)
    if refusal is not None:
        return refusal
    return _walk(parsed.value, budget) if parsed is not None else None


def refusal_reason_for_record(
    record: ToolResultRecord, config: EngineConfig | None = None
) -> str | None:
    """Single decision used by every compaction path in both runtimes."""
    return refusal_reason(record, config) or json_protection_refusal(record.content)
