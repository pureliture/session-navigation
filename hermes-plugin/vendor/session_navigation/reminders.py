"""Bounded, advisory request-copy reminders; no target selection or mutations."""
from __future__ import annotations

import json
from collections import OrderedDict
from typing import Any

DISPLAY_LIMIT = 3
NOTE_BYTES = 1000
ELIGIBLE_BYTE_STEP = 100 * 1024


class BoundaryReminders:
    def __init__(self) -> None:
        self._seen: OrderedDict[str, tuple[str, int, list[str]]] = OrderedDict()

    def note(self, session: str, turn: str, _tokens: int, _window: int | None,
             candidates: list[dict[str, Any]], eligible_bytes: int | None = None) -> str | None:
        if not turn or not candidates:
            return None
        total_bytes = (
            eligible_bytes
            if type(eligible_bytes) is int and eligible_bytes >= 0
            else sum(item["bytes_size"] for item in candidates if type(item.get("bytes_size")) is int and item["bytes_size"] > 0)
        )
        byte_step = total_bytes // ELIGIBLE_BYTE_STEP if total_bytes > 0 else 0
        cand_ids = [str(item["tool_call_id"]) for item in candidates if isinstance(item.get("tool_call_id"), str) and item["tool_call_id"]]
        previous = self._seen.get(session)
        if previous is not None:
            prev_turn, prev_step, prev_ids = previous
            prev_set = set(prev_ids)
            if prev_turn == turn:
                if byte_step < prev_step:
                    self._seen[session] = (prev_turn, byte_step, prev_ids)
                    return None
                if byte_step <= prev_step:
                    return None
            elif cand_ids and not any(cid not in prev_set for cid in cand_ids):
                return None
        size_hint = f" ({total_bytes // 1024} KiB)" if total_bytes >= 1024 else ""
        more_hint = (
            f" (+{len(candidates) - DISPLAY_LIMIT} via list_context_items(view=candidates))"
            if len(candidates) > DISPLAY_LIMIT
            else ""
        )
        header = (
            f"[context-navigation] eligible={len(candidates)}{size_hint}{more_hint}. "
            "Clean strictly by need (never after routine single calls or when asked to wait/restore): keep outputs still needed; "
            "when a research/command phase finishes, sweep ALL unneeded IDs in one manage_context batch "
            "(do not trickle 3/turn; hide=rules, summarize=LLM, auto=LLM/rules), then send one complete final answer with all facts/values "
            "(never write the answer twice or say 'reported above'/'see above'). Rows:[id,tool,path/command,bytes,turn]."
        )
        rows = []
        for item in candidates:
            row = json.dumps([item["tool_call_id"], str(item.get("tool_name", ""))[:24],
                              str(item.get("hint", ""))[:48], item["bytes_size"], item.get("turn", 0)],
                             ensure_ascii=True, separators=(",", ":"))
            if len((header + "\n" + "\n".join([*rows, row])).encode()) <= NOTE_BYTES:
                rows.append(row)
            if len(rows) == DISPLAY_LIMIT:
                break
        merged_ids = list(dict.fromkeys([*(previous[2] if previous else []), *cand_ids]))[-2048:]
        self._seen[session] = (turn, byte_step, merged_ids)
        self._seen.move_to_end(session)
        while len(self._seen) > 128:
            self._seen.popitem(last=False)
        return header + ("\n" + "\n".join(rows) if rows else "")
