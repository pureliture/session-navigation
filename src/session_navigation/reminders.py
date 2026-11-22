"""Bounded, advisory request-copy reminders; no target selection or mutations."""
from __future__ import annotations

import json
from collections import OrderedDict
from typing import Any

NOTE_BYTES = 16 * 1024
MAX_ID_CHARS = 128
MAX_NOTES_PER_WAVE = 4
ELIGIBLE_BYTE_STEP = 100 * 1024
WORTHWHILE_BYTES = 32 * 1024


class _SessionReminderState:
    __slots__ = (
        "turn",
        "watermark",
        "intra_credit",
        "unfired_credit",
        "fired_in_turn",
        "notes_in_wave",
        "last_fired_step",
        "suppress_next_growth",
    )

    def __init__(self, suppress_next_growth: bool = False) -> None:
        self.turn: str = ""
        self.watermark: int = 0
        self.intra_credit: int = 0
        self.unfired_credit: int = 0
        self.fired_in_turn: bool = False
        self.notes_in_wave: int = 0
        self.last_fired_step: int | None = None
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
        after_tool: bool = True,
        step_key: int | None = None,
    ) -> str | None:
        judged, _, _, _ = self.note_with_reason(
            session,
            turn,
            _tokens,
            _window,
            candidates,
            eligible_bytes=eligible_bytes,
            after_tool=after_tool,
            step_key=step_key,
        )
        return judged

    def note_with_reason(
        self,
        session: str,
        turn: str,
        _tokens: int,
        _window: int | None,
        candidates: list[dict[str, Any]],
        eligible_bytes: int | None = None,
        after_tool: bool = True,
        step_key: int | None = None,
    ) -> tuple[str | None, str, int, int]:
        """Judge once and report why the boundary note fired or not.

        Returns ``(note, reason, eligible_count, eligible_bytes)``. ``reason``
        is stable for tests and logs; ``note()`` keeps the old contract.
        """
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
        if not turn:
            return None, "empty_turn", total, total_bytes
        state = self._state(session)
        is_new_turn = state.turn != turn
        delta = total_bytes - state.watermark
        was_suppressed = state.suppress_next_growth
        state.suppress_next_growth = False
        state.turn = turn
        state.watermark = total_bytes

        if was_suppressed:
            if is_new_turn:
                if state.fired_in_turn:
                    state.unfired_credit = 0
                state.intra_credit = 0
                state.fired_in_turn = False
                state.notes_in_wave = 0
                state.last_fired_step = None
            if total_bytes < state.unfired_credit:
                state.unfired_credit = total_bytes
            return None, "suppressed_unhide_growth", total, total_bytes

        if delta < 0:
            state.unfired_credit = 0
            state.intra_credit = 0
            state.fired_in_turn = False
            state.notes_in_wave = 0
            state.last_fired_step = None
        else:
            gain = delta if delta > 0 else 0
            if is_new_turn:
                state.unfired_credit = (
                    min(total_bytes, gain)
                    if state.fired_in_turn
                    else min(total_bytes, state.unfired_credit + gain)
                )
                state.intra_credit = gain
                state.fired_in_turn = False
                state.notes_in_wave = 0
                state.last_fired_step = None
            else:
                state.unfired_credit = min(total_bytes, state.unfired_credit + gain)
                state.intra_credit += gain
                if state.intra_credit >= ELIGIBLE_BYTE_STEP:
                    state.intra_credit = 0
                    state.notes_in_wave = 0
                    state.last_fired_step = None
        if not after_tool:
            return None, "not_after_tool", total, total_bytes
        if total <= 0:
            return None, "no_candidates", total, total_bytes
        if total_bytes < WORTHWHILE_BYTES:
            return None, "below_worthwhile_bytes", total, total_bytes
        if state.unfired_credit < WORTHWHILE_BYTES:
            return None, "below_unfired_credit", total, total_bytes
        if state.notes_in_wave >= MAX_NOTES_PER_WAVE:
            return None, "wave_cap_reached", total, total_bytes
        if step_key is not None and state.last_fired_step == step_key:
            return None, "step_already_fired", total, total_bytes

        state.fired_in_turn = True
        state.notes_in_wave += 1
        state.last_fired_step = step_key
        size_hint = f" ({total_bytes // 1024} KiB)" if total_bytes >= 1024 else ""
        base_header = (
            f"[context-navigation] eligible={total}{size_hint}. "
            "Before your final answer (or after a large tool batch), if completed outputs below are no longer needed in full and the user did not ask to wait or restore originals, "
            "call manage_context once to batch-clean all unneeded tool_call_ids directly from Rows below "
            "(skip list_context_items unless IDs were omitted; hide=rules, summarize=session LLM, auto=LLM/rules); then send one complete final answer with all facts/values "
            "(never write the answer twice or say 'reported above'/'see above'). Rows:[id,tool,path/command,bytes,turn]."
        )
        budget = NOTE_BYTES - len(base_header.encode()) - 80
        rows = []
        used_bytes = 0
        for item in candidates:
            cid = item.get("tool_call_id")
            if not isinstance(cid, str) or not cid or len(cid) > MAX_ID_CHARS:
                continue
            row = json.dumps(
                [
                    cid,
                    str(item.get("tool_name", ""))[:24],
                    str(item.get("hint", ""))[:48],
                    item["bytes_size"],
                    item.get("turn", 0),
                ],
                ensure_ascii=True,
                separators=(",", ":"),
            )
            row_bytes = len(row.encode()) + 1
            if used_bytes + row_bytes > budget:
                break
            rows.append(row)
            used_bytes += row_bytes
        omitted = max(0, total - len(rows))
        more_hint = (
            f" (+{omitted} via list_context_items(view=candidates))"
            if omitted > 0
            else ""
        )
        header = (
            f"[context-navigation] eligible={total}{size_hint}{more_hint}. "
            "Before your final answer (or after a large tool batch), if completed outputs below are no longer needed in full and the user did not ask to wait or restore originals, "
            "call manage_context once to batch-clean all unneeded tool_call_ids directly from Rows below "
            "(skip list_context_items unless IDs were omitted; hide=rules, summarize=session LLM, auto=LLM/rules); then send one complete final answer with all facts/values "
            "(never write the answer twice or say 'reported above'/'see above'). Rows:[id,tool,path/command,bytes,turn]."
        )
        return header + ("\n" + "\n".join(rows) if rows else ""), "fired", total, total_bytes
