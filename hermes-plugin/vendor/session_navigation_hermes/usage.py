"""Session-local main-request usage and pending, rough context savings."""

from __future__ import annotations

import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any


# Adapted from Nous Research's hermes-agent (agent/model_metadata.py, MIT License,
# Copyright (c) 2025 Nous Research; see THIRD_PARTY_NOTICES.md).
# Kept locally so the Hermes plugin uses only public runtime surfaces with zero
# external dependencies.
_CHARS_PER_TOKEN = 4
_CJK_DENSE_RE = re.compile(
    "[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]"
)


def estimate_tokens(text: str) -> int:
    """Return a rough, dependency-free Unicode-aware token estimate.

    Approximates CJK/Hangul/Kana codepoints as ~1 token each and all other text
    as ``ceil(UTF-8 bytes / 4)`` (using ``errors="replace"`` so lone surrogates
    never raise). Used only for approximate ``next ≈`` footer deltas in ``/nav``
    — never for byte-based reminder triggers or exact restoration. Estimates
    differ from actual model tokenization and may drift from future Hermes host
    releases.
    """
    if not text:
        return 0
    text = str(text)
    if text.isascii():
        return (len(text) + 3) // _CHARS_PER_TOKEN
    stripped = _CJK_DENSE_RE.sub("", text)
    dense = len(text) - len(stripped)
    return dense + ((len(stripped.encode("utf-8", "replace")) + 3) // _CHARS_PER_TOKEN)


def compact_tokens(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1000:
        return f"{value / 1000:.1f}K"
    return str(value)


@dataclass
class SessionUsage:
    prompt_tokens: int | None = None
    context_length: int | None = None
    removed_tokens: int = 0
    messages: dict[str, int] = field(default_factory=dict)


class UsageTracker:
    def __init__(self, max_sessions: int = 128):
        self._sessions: OrderedDict[str, SessionUsage] = OrderedDict()
        self._lock = threading.RLock()
        self._max_sessions = max_sessions

    def _session(self, session_id: str) -> SessionUsage:
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionUsage()
        self._sessions.move_to_end(session_id)
        while len(self._sessions) > self._max_sessions:
            self._sessions.popitem(last=False)
        return self._sessions[session_id]

    def observe(self, **context: Any) -> None:
        if context.get("aux_task") or context.get("is_auxiliary"):
            return
        session_id = context.get("session_id")
        usage = context.get("usage")
        prompt = usage.get("prompt_tokens") if isinstance(usage, dict) else None
        if not isinstance(session_id, str) or not session_id or type(prompt) is not int or prompt < 0:
            return
        window = context.get("context_length")
        with self._lock:
            session = self._session(session_id)
            session.prompt_tokens = prompt
            session.context_length = window if type(window) is int and window > 0 else None
            session.removed_tokens = 0

    def record_messages(self, session_id: str, messages: list[tuple[str, str, int, str]]) -> None:
        estimates = {key: estimate_tokens(text) for key, _role, _index, text in messages}
        with self._lock:
            self._session(session_id).messages = estimates

    def message_tokens(self, session_id: str, unit: dict[str, Any]) -> int:
        with self._lock:
            session = self._session(session_id)
            return session.messages.get(unit["unit_id"], (int(unit.get("char_count") or 0) + 3) // 4)

    def context_window(self, session_id: str) -> int | None:
        with self._lock:
            return self._session(session_id).context_length

    def adjust(self, session_id: str, removed_tokens: int) -> None:
        with self._lock:
            self._session(session_id).removed_tokens += removed_tokens

    def footer(self, session_id: str) -> str:
        with self._lock:
            session = self._session(session_id)
            if session.prompt_tokens is None:
                text = "context — tokens"
            elif session.context_length is None:
                text = f"context {compact_tokens(session.prompt_tokens)} / — tokens"
            else:
                text = (f"context {compact_tokens(session.prompt_tokens)} / "
                        f"{compact_tokens(session.context_length)} tokens "
                        f"({100 * session.prompt_tokens / session.context_length:.1f}%)")
            if session.removed_tokens:
                sign = "−" if session.removed_tokens > 0 else "+"
                text += f" · next ≈ {sign}{compact_tokens(abs(session.removed_tokens))}"
            return text
