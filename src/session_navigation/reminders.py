"""Bounded, advisory request-copy reminders; no target selection or mutations."""
from __future__ import annotations

import json
from collections import OrderedDict
from typing import Any

DISPLAY_LIMIT = 3
NOTE_BYTES = 1000
ELIGIBLE_BYTE_STEP = 100 * 1024
WORTHWHILE_BYTES = 32 * 1024
class _SessionReminderState:
    __slots__ = (
        "turn",
        "watermark",
        "intra_credit",
        "unfired_credit",
        "ids",
        "suppress_next_growth",
    )

    def __init__(self, suppress_next_growth: bool = False) -> None:
        self.turn: str = ""
        self.watermark: int = 0
        self.intra_credit: int = 0
        self.unfired_credit: int = 0
        self.ids: list[str] = []
        self.suppress_next_growth: bool = suppress_next_growth

class BoundaryReminders:
    def __init__(self) -> None:
        self._seen: OrderedDict[str, _SessionReminderState] = OrderedDict()

    def _state(self, session: str, suppress_if_new: bool = False) -> _SessionReminderState:
        state = self._seen.get(session)
        if state is None:
            state = _SessionReminderState(suppress_next_growth=suppress_if_new)
            self._seen[session] = state
        self._seen.move_to_end(session)
        while len(self._seen) > 128:
            self._seen.popitem(last=False)
        return state

    def suppress_unhide(self, session: str) -> None:
        if not session:
            return
        state = self._state(session, suppress_if_new=True)
        state.suppress_next_growth = True

    def note(
        self,
        session: str,
        turn: str,
        _tokens: int,
        _window: int | None,
        candidates: list[dict[str, Any]],
        eligible_bytes: int | None = None,
    ) -> str | None:
        if not turn:
            return None
        total = len(candidates)
        total_bytes = (
            0
            if total <= 0
            else (
                eligible_bytes
                if type(eligible_bytes) is int and eligible_bytes >= 0
                else sum(
                    item["bytes_size"]
                    for item in candidates
                    if type(item.get("bytes_size")) is int and item["bytes_size"] > 0
                )
            )
        )
        cand_ids = (
            []
            if total <= 0
            else [
                str(item["tool_call_id"])
                for item in candidates
                if isinstance(item.get("tool_call_id"), str) and item["tool_call_id"]
            ]
        )
        state = self._state(session)
        is_new_turn = state.turn != turn
        delta = total_bytes - state.watermark
        was_suppressed = state.suppress_next_growth
        state.suppress_next_growth = False
        state.turn = turn
        state.watermark = total_bytes

        if was_suppressed:
            if is_new_turn:
                state.intra_credit = 0
            if total_bytes < state.unfired_credit:
                state.unfired_credit = total_bytes
            if cand_ids:
                state.ids = list(dict.fromkeys([*state.ids, *cand_ids]))[-2048:]
            return None

        gain = delta if delta > 0 else 0
        state.intra_credit = gain if is_new_turn else state.intra_credit + gain
        state.unfired_credit = min(total_bytes, state.unfired_credit + gain)
        if total <= 0 or total_bytes <= 0:
            return None

        prev_set = set(state.ids)
        has_new_candidate = any(cid not in prev_set for cid in cand_ids)
        intra_fired = (not is_new_turn) and state.intra_credit >= ELIGIBLE_BYTE_STEP
        turn_boundary_fired = is_new_turn and (
            (
                has_new_candidate
                and state.unfired_credit >= WORTHWHILE_BYTES
                and total_bytes >= WORTHWHILE_BYTES
            )
            or state.intra_credit >= ELIGIBLE_BYTE_STEP
        )
        if not intra_fired and not turn_boundary_fired:
            return None

        state.intra_credit = 0
        state.unfired_credit = 0
        state.ids = list(dict.fromkeys([*state.ids, *cand_ids]))[-2048:]

        size_hint = f" ({total_bytes // 1024} KiB)" if total_bytes >= 1024 else ""
        more_hint = (
            f" (+{total - DISPLAY_LIMIT} via list_context_items(view=candidates))"
            if total > DISPLAY_LIMIT
            else ""
        )
        header = (
            f"[context-navigation] eligible={total}{size_hint}{more_hint}. "
            "Clean strictly by need (never after routine single calls or when asked to wait/restore): keep outputs still needed; "
            "when a research/command phase finishes, sweep ALL unneeded IDs in one manage_context batch "
            "(do not trickle 3/turn; hide=rules, summarize=LLM, auto=LLM/rules), then send one complete final answer with all facts/values "
            "(never write the answer twice or say 'reported above'/'see above'). Rows:[id,tool,path/command,bytes,turn]."
        )
        rows = []
        for item in candidates:
            row = json.dumps(
                [
                    item["tool_call_id"],
                    str(item.get("tool_name", ""))[:24],
                    str(item.get("hint", ""))[:48],
                    item["bytes_size"],
                    item.get("turn", 0),
                ],
                ensure_ascii=True,
                separators=(",", ":"),
            )
            if len((header + "\n" + "\n".join([*rows, row])).encode()) <= NOTE_BYTES:
                rows.append(row)
            if len(rows) == DISPLAY_LIMIT:
                break
        return header + ("\n" + "\n".join(rows) if rows else "")
