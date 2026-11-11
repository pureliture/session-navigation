"""Hermes adapter request flow and tool handlers (M2-2).

Middleware flow per outbound request:
1. Record the transmitted (call ID -> tool name/args/result body/location)
   list in the session store under this scope.
2. Ask the engine for replacement plans.
3. Apply plans to a copy and return it, never the stored history.

Tool flow (model calls): look the tool call ID up in the session record by
scope + ID. Reject when absent or duplicated, otherwise call the engine.
"""

from collections import Counter
from typing import Any

from .allowlist import AdapterRejected, filter_invocation
from .payload import UNSUPPORTED_API_MODE, apply_replacements
from .session import SessionTranscriptStore
from session_navigation.engine import SessionNavigationEngine, _run_sync
from session_navigation.model import (
    MutationResult,
    Scope,
    ToolResultRecord,
    compute_invocation_digest,
    _item_id,
    pair_unit_id,
)
from session_navigation.transport import Summarizer
from session_navigation.pending_summary import settle_summary
from session_navigation.policy import is_destructive_command, refusal_reason, required_evidence_lines


def compact(
    engine: SessionNavigationEngine,
    store: SessionTranscriptStore,
    scope: Scope,
    tool_call_id: str,
    *,
    status: str = "ok",
    summarizer: Summarizer | None = None,
) -> MutationResult:
    """Compact one transmitted tool result found via the session record."""
    if not isinstance(tool_call_id, str) or not tool_call_id.strip():
        return MutationResult(ok=False, error="missing_tool_call_id")
    entries = store.lookup(scope.scope_key(), tool_call_id.strip())
    if not entries:
        return MutationResult(ok=False, error="not_found")
    if len(entries) > 1:
        return MutationResult(ok=False, error="ambiguous")
    entry = entries[0]
    if entry.arguments_parse_error or not entry.tool_name:
        return MutationResult(ok=False, error="invalid_invocation")
    try:
        invocation, omitted = filter_invocation(entry.tool_name, entry.raw_arguments)
    except AdapterRejected as exc:
        return MutationResult(ok=False, error=exc.code)
    record = ToolResultRecord(
        call_id=entry.call_id,
        result_position=entry.result_position,
        content=entry.content,
        content_sha256=entry.content_sha256,
        invocation=invocation,
        invocation_digest=compute_invocation_digest(
            invocation, omitted if omitted else None),
        status=status,
        host_handle=entry.host_handle,
    )
    options_omitted = bool(omitted)
    return engine.compact_sync(scope, record, summarizer=summarizer, options_omitted=options_omitted)


def summarize(
    engine: SessionNavigationEngine,
    store: SessionTranscriptStore,
    scope: Scope,
    tool_call_id: str,
    summarizer: Any,
    *,
    status: str = "ok",
) -> MutationResult:
    """Summarize one transmitted tool result using the configured model."""
    if not isinstance(tool_call_id, str) or not tool_call_id.strip():
        return MutationResult(ok=False, error="missing_tool_call_id")
    entries = store.lookup(scope.scope_key(), tool_call_id.strip())
    if not entries:
        return MutationResult(ok=False, error="not_found")
    if len(entries) > 1:
        return MutationResult(ok=False, error="ambiguous")
    entry = entries[0]
    if entry.arguments_parse_error or not entry.tool_name:
        return MutationResult(ok=False, error="invalid_invocation")
    try:
        invocation, omitted = filter_invocation(entry.tool_name, entry.raw_arguments)
    except AdapterRejected as exc:
        return MutationResult(ok=False, error=exc.code)
    record = ToolResultRecord(
        call_id=entry.call_id,
        result_position=entry.result_position,
        content=entry.content,
        content_sha256=entry.content_sha256,
        invocation=invocation,
        invocation_digest=compute_invocation_digest(
            invocation, omitted if omitted else None),
        status=status,
        host_handle=entry.host_handle,
    )
    options_omitted = bool(omitted)
    return _run_sync(engine.summarize(scope, record, summarizer, options_omitted=options_omitted))


def list_records(
    engine: SessionNavigationEngine, scope: Scope, query: str = ""
) -> list[dict[str, Any]]:
    """List compacted item metadata without originals or commands."""
    return [item.to_dict() for item in engine.list_items(scope, query)]


def restore(
    engine: SessionNavigationEngine, scope: Scope, item_id: str,
    expected_version: int | None = None,
) -> MutationResult:
    """Mark one item visible again without rerunning tools."""
    if not isinstance(item_id, str) or not item_id.strip():
        return MutationResult(ok=False, error="not_found")
    return engine.restore(scope, item_id.strip(), expected_version=expected_version)


def middleware_step(
    engine: SessionNavigationEngine,
    store: SessionTranscriptStore,
    scope: Scope,
    api_mode: str,
    payload: dict[str, Any],
    *,
    publish_targets: bool = False,
    summarizer: Any = None,
) -> dict[str, Any]:
    """Run one middleware pass: record, plan, apply to a copy (fail-open)."""
    stored, skipped, record_error = store.record_request(
        scope.scope_key(), api_mode, payload)
    trace: dict[str, Any] = {
        "source": "session-navigation-hermes",
        "api_mode": api_mode,
        "found": len(stored),
        "skipped": len(skipped),
    }
    if record_error == UNSUPPORTED_API_MODE:
        trace["reason"] = UNSUPPORTED_API_MODE
        return {
            "request": dict(payload) if isinstance(payload, dict) else payload,
            "applied": [],
            "skipped": skipped,
            "trace": trace,
        }
    records: list[ToolResultRecord] = []
    targets = []
    unique_calls = _unique_calls(api_mode, payload)
    result_counts = Counter(entry.call_id for entry in stored)
    record_skipped: list[dict[str, Any]] = list(skipped)
    handle_by_call_id: dict[str, dict[str, Any]] = {}
    for entry in stored:
        handle_by_call_id.setdefault(entry.call_id, dict(entry.host_handle))
        if entry.arguments_parse_error or not entry.tool_name:
            record_skipped.append({
                "host_handle": dict(entry.host_handle),
                "reason": "invalid_invocation",
            })
            continue
        try:
            invocation, omitted = filter_invocation(
                entry.tool_name, entry.raw_arguments)
        except AdapterRejected as exc:
            record_skipped.append({
                "host_handle": dict(entry.host_handle),
                "reason": exc.code,
            })
            continue
        records.append(
            ToolResultRecord(
                call_id=entry.call_id,
                result_position=entry.result_position,
                content=entry.content,
                content_sha256=entry.content_sha256,
                invocation=invocation,
                invocation_digest=compute_invocation_digest(
                    invocation, omitted if omitted else None),
                status="ok",
                host_handle=entry.host_handle,
            )
        )
        if (entry.call_id in unique_calls and result_counts[entry.call_id] == 1 and
                refusal_reason(records[-1], engine.config) is None and
                not is_destructive_command(entry.tool_name, invocation.get("arguments"))):
            targets.append((records[-1], omitted))
    if publish_targets:
        engine.store.publish_targets(scope, targets)
        _consume_pending(engine, scope, [record for record in records
            if record.call_id in unique_calls and result_counts[record.call_id] == 1], summarizer)
    plans = engine.project(scope, records)
    # Pair-atomic units: one pair_ row per transmitted record (call+result).
    try:
        upsert = getattr(engine.store, "upsert_unit", None)
        if callable(upsert):
            for record in records:
                upsert(scope, unit_id=pair_unit_id(scope.scope_key(), record.call_id, record.content_sha256),
                       kind="tool_result", tool_call_id=record.call_id,
                       content_sha256=record.content_sha256, char_count=len(record.content))
    except Exception:
        pass
    plan_dicts = [
        {
            "item_id": plan.item_id,
            "host_handle": handle_by_call_id.get(
                getattr(plan, "tool_call_id", ""), plan.host_handle),
            "expected_content_sha256": plan.expected_content_sha256,
            "replacement_text": plan.replacement_text,
        }
        for plan in plans
    ]
    new_payload, applied, apply_skipped = apply_replacements(
        api_mode, payload, plan_dicts)
    trace["applied"] = len(applied)
    return {
        "request": new_payload,
        "applied": applied,
        "skipped": record_skipped + apply_skipped,
        "trace": trace,
    }


def _unique_calls(api_mode, payload) -> set[str]:
    if api_mode == "codex_responses":
        calls = [item for item in payload.get("input", [])
                 if isinstance(item, dict) and item.get("type") == "function_call"]
    else:
        calls = [call for message in payload.get("messages", []) if isinstance(message, dict)
                 for call in (message.get("tool_calls") or []) if isinstance(call, dict)]
    counts = Counter(str(call.get("call_id", call.get("id", ""))).strip() for call in calls)
    return {call_id for call_id, count in counts.items() if call_id and count == 1}


def _consume_pending(engine, scope, records, summarizer) -> None:
    for record in records:
        item_id = _item_id(scope.scope_key(), record.call_id, record.content_sha256,
                           record.invocation_digest, record.result_position)
        item = engine.store.get(scope, item_id)
        if item is None or item.visibility != "hidden" or item.compaction_source != "summarize_pending":
            continue
        text = None
        if summarizer is not None:
            try:
                summary = _run_sync(summarizer.summarize(item.original, required_evidence_lines(item.original),
                    invocation=item.invocation_snapshot, context={"scope_key": scope.scope_key()}))
                text = summary.get("summary") if isinstance(summary, dict) else None
            except Exception:
                text = None
        settle_summary(engine.store, scope, item.item_id, item.version, text)
