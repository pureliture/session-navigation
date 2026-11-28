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


def _is_json_like(content: str) -> bool:
    stripped = re.sub(r"^[\s\ufeff]+", "", content)
    return bool(stripped) and stripped[0] in '{["'


def _walk(value: Any, budget: JsonProtectionBudget) -> str | None:
    if isinstance(value, str):
        direct = protected_pattern_refusal(value)
        if direct is not None:
            return direct
        # Only a string that is itself valid JSON is decoded again. A literal
        # backslash-u sequence is ordinary text and is never re-unescaped.
        if not _is_json_like(value):
            return None
        parsed, refusal = parse_json_for_protection(value, budget)
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
    parsed, refusal = parse_json_for_protection(content, budget)
    if refusal is not None:
        return refusal
    return _walk(parsed.value, budget) if parsed is not None else None


def refusal_reason_for_record(
    record: ToolResultRecord, config: EngineConfig | None = None
) -> str | None:
    """Single decision used by every compaction path in both runtimes."""
    return refusal_reason(record, config) or json_protection_refusal(record.content)
