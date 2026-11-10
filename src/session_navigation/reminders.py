"""Bounded, advisory request-copy reminders; no target selection or mutations."""
from __future__ import annotations

import json
from collections import OrderedDict
from typing import Any

DISPLAY_LIMIT = 3
NOTE_BYTES = 1000


class BoundaryReminders:
    def __init__(self) -> None:
        self._seen: OrderedDict[str, tuple[str, int]] = OrderedDict()

    def note(self, session: str, turn: str, tokens: int, window: int | None,
             candidates: list[dict[str, Any]]) -> str | None:
        if not turn or not candidates:
            return None
        tokens = tokens if type(tokens) is int and tokens >= 0 else 0
        window = window if type(window) is int and window > 0 else None
        percent = 100 * tokens / window if window and window > 0 else None
        tier = sum(percent >= threshold for threshold in (50, 75, 90)) if percent is not None else 0
        previous = self._seen.get(session)
        if previous is not None and previous[0] == turn and tier <= previous[1]:
            return None
        usage = f"~{tokens}/{window} tokens ({percent:.0f}%)" if percent is not None else f"~{tokens}/? tokens (?%)"
        header = (f"[context-navigation] {usage}; eligible={len(candidates)}. "
                  "Finish the work unit and answer first; then, if useful, batch cleanup in one call. "
                  "After cleanup, the final message must restate the complete answer with all requested facts/values; never say 'reported above' or 'see above'. "
                  "You decide when/what/how: hide unneeded results (rules), summarize facts still needed (session LLM). "
                  "Prefer literal IDs already shown here; avoid re-verifying unchanged files. Display only; any valid ID is accepted. "
                  "Use list_context_items(view=candidates) only when needed. Rows: [id,tool,path/command,bytes,turn].")
        rows = []
        for item in candidates:
            row = json.dumps([item["tool_call_id"], str(item.get("tool_name", ""))[:24],
                              str(item.get("hint", ""))[:48], item["bytes_size"], item.get("turn", 0)],
                             ensure_ascii=True, separators=(",", ":"))
            if len((header + "\n" + "\n".join([*rows, row])).encode()) <= NOTE_BYTES:
                rows.append(row)
            if len(rows) == DISPLAY_LIMIT:
                break
        self._seen[session] = (turn, tier)
        self._seen.move_to_end(session)
        while len(self._seen) > 128:
            self._seen.popitem(last=False)
        return header + ("\n" + "\n".join(rows) if rows else "")
