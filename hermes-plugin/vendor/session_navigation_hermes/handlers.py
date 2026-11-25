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
import time
from typing import Any

from .allowlist import AdapterRejected, filter_invocation
from .diagnostics import record_perf
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
    if getattr(entry, "duplicate_call_id", False):
        return MutationResult(ok=False, error="ambiguous")
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
    if getattr(entry, "duplicate_call_id", False):
        return MutationResult(ok=False, error="ambiguous")
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


_HERMES_ADAPTER_ID = "hermes"
_HERMES_BRANCH_SCOPE = "unknown"


def scope_candidates(scope: Scope) -> list[Scope]:
    """Return the exact scope followed by its branch-alias scope when applicable."""
    candidates = [scope]
    if scope.adapter_id == _HERMES_ADAPTER_ID and scope.branch_scope in (_HERMES_BRANCH_SCOPE, "default"):
        alt_branch = "default" if scope.branch_scope == _HERMES_BRANCH_SCOPE else _HERMES_BRANCH_SCOPE
        candidates.append(
            Scope(
                adapter_id=scope.adapter_id,
                host_profile=scope.host_profile,
                session_id=scope.session_id,
                branch_scope=alt_branch,
            )
        )
    return candidates


def conflict_redaction_placeholder(item_id: str) -> str:
    """Return a fail-closed redaction placeholder without leaking raw content."""
    return f"[hidden:{item_id} withheld due to invocation or scope identity conflict]"


def _handle_key(handle: Any) -> tuple[str, int]:
    if not isinstance(handle, dict):
        return ("", -1)
    try:
        index = int(handle.get("index", -1))
    except (TypeError, ValueError):
        index = -1
    return (str(handle.get("api_mode", "")), index)


def _exact_key(
    call_id: Any, result_position: Any, content_sha256: Any, invocation_digest: Any,
) -> tuple[str, int, str, str]:
    try:
        pos = int(result_position or 0)
    except (TypeError, ValueError):
        pos = 0
    return (str(call_id or ""), pos, str(content_sha256 or ""), str(invocation_digest or ""))


def _pair_key(call_id: Any, content_sha256: Any) -> tuple[str, str]:
    return (str(call_id or ""), str(content_sha256 or ""))


def _to_plan_dict(
    plan: Any,
    fallback_item: Any,
    host_handle: dict[str, Any],
    content_sha: str,
) -> dict[str, Any]:
    if plan is not None:
        return {
            "item_id": plan.item_id,
            "host_handle": plan.host_handle,
            "expected_content_sha256": plan.expected_content_sha256,
            "replacement_text": plan.replacement_text,
        }
    return {
        "item_id": fallback_item.item_id,
        "host_handle": host_handle,
        "expected_content_sha256": content_sha,
        "replacement_text": fallback_item.compacted,
    }


def _to_conflict_dict(
    item_id: str,
    host_handle: dict[str, Any],
    content_sha: str,
) -> dict[str, Any]:
    return {
        "item_id": item_id,
        "host_handle": host_handle,
        "expected_content_sha256": content_sha,
        "replacement_text": conflict_redaction_placeholder(item_id),
    }


def resolve_plan_dicts(
    engine: SessionNavigationEngine,
    scope: Scope,
    entries: list[tuple[str, int, str, dict[str, Any], ToolResultRecord | None]],
    *,
    primary_plans: list[Any] | None = None,
    extra_items: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Resolve replacement plans with strict invocation, position, and branch-alias fences.

    Exact 5-tuple matches in `scope` take precedence (honoring explicit `visible`
    state when another invocation digest or position holds a hidden item at the
    same `(call_id, content_sha256)` unless a branch-alias hidden item conflicts).
    `unknown`/`default` alias matches apply only when `scope` has no record for
    that `(call_id, content_sha256)` pair and no alias conflict exists. Whenever
    no exact match applies and at least one hidden candidate exists for
    `(call_id, content_sha256)` (e.g., shifted `result_position`, mismatched
    `invocation_digest`, missing invocation, or alias conflict), emit a redaction
    placeholder instead of a mismatched summary or raw original content.
    """
    if not entries:
        return []
    candidates = scope_candidates(scope)
    primary_scope = candidates[0]
    alias_scope = candidates[1] if len(candidates) > 1 else None

    store_obj = getattr(engine, "store", None)
    items_fn = getattr(store_obj, "items", None)
    items_by_scope: dict[str, list[Any]] = {}
    if callable(items_fn):
        for cand in candidates:
            items_by_scope[cand.scope_key()] = list(items_fn(cand))

    if extra_items:
        p_key = primary_scope.scope_key()
        a_key = alias_scope.scope_key() if alias_scope is not None else None
        seen_ids = {
            getattr(it, "item_id", None)
            for lst in items_by_scope.values()
            for it in lst
        }
        for it in extra_items:
            iid = getattr(it, "item_id", None)
            if iid in seen_ids:
                continue
            target_key = p_key
            item_scope_key = getattr(it, "scope_key", None)
            if isinstance(item_scope_key, str) and item_scope_key == a_key and a_key is not None:
                target_key = a_key
            items_by_scope.setdefault(target_key, []).append(it)
            if iid is not None:
                seen_ids.add(iid)

    primary_items = items_by_scope.get(primary_scope.scope_key(), [])
    alias_items = items_by_scope.get(alias_scope.scope_key(), []) if alias_scope is not None else []

    primary_by_exact: dict[tuple[str, int, str, str], Any] = {}
    primary_by_pair: dict[tuple[str, str], list[Any]] = {}
    for it in primary_items:
        ekey = _exact_key(
            getattr(it, "tool_call_id", ""),
            getattr(it, "result_position", 0),
            getattr(it, "content_sha256", ""),
            getattr(it, "invocation_digest", ""),
        )
        primary_by_exact[ekey] = it
        pkey = _pair_key(getattr(it, "tool_call_id", ""), getattr(it, "content_sha256", ""))
        primary_by_pair.setdefault(pkey, []).append(it)

    alias_by_exact: dict[tuple[str, int, str, str], Any] = {}
    alias_by_pair: dict[tuple[str, str], list[Any]] = {}
    for it in alias_items:
        ekey = _exact_key(
            getattr(it, "tool_call_id", ""),
            getattr(it, "result_position", 0),
            getattr(it, "content_sha256", ""),
            getattr(it, "invocation_digest", ""),
        )
        alias_by_exact[ekey] = it
        pkey = _pair_key(getattr(it, "tool_call_id", ""), getattr(it, "content_sha256", ""))
        alias_by_pair.setdefault(pkey, []).append(it)

    valid_records = [record for _cid, _pos, _sha, _handle, record in entries if record is not None]
    if primary_plans is None:
        primary_plans = engine.project(primary_scope, valid_records) if valid_records else []

    alias_plans: list[Any] = []
    if alias_scope is not None and valid_records and any(getattr(it, "visibility", None) == "hidden" for it in alias_items):
        alias_plans = engine.project(alias_scope, valid_records)

    primary_plan_by_handle = {_handle_key(getattr(plan, "host_handle", None)): plan for plan in primary_plans}
    alias_plan_by_handle = {_handle_key(getattr(plan, "host_handle", None)): plan for plan in alias_plans}

    plan_dicts: list[dict[str, Any]] = []
    seen_handles: set[tuple[str, int]] = set()
    for call_id, pos, content_sha, host_handle, record in entries:
        hkey = _handle_key(host_handle)
        if hkey in seen_handles:
            continue
        pair = _pair_key(call_id, content_sha)
        p_pair_items = primary_by_pair.get(pair, [])
        a_pair_items = alias_by_pair.get(pair, [])
        p_pair_hidden = [it for it in p_pair_items if getattr(it, "visibility", None) == "hidden"]
        a_pair_hidden = [it for it in a_pair_items if getattr(it, "visibility", None) == "hidden"]

        p_exact = None
        a_exact = None
        same_inv_other_pos_hidden: list[Any] = []
        if record is not None:
            ekey = _exact_key(call_id, pos, content_sha, record.invocation_digest)
            p_exact = primary_by_exact.get(ekey)
            a_exact = alias_by_exact.get(ekey)
            same_inv_other_pos_hidden = [
                it for it in (p_pair_hidden + a_pair_hidden)
                if str(getattr(it, "invocation_digest", "")) == record.invocation_digest
                and int(getattr(it, "result_position", 0) or 0) != int(pos or 0)
            ]

        if p_exact is not None and a_exact is not None:
            seen_handles.add(hkey)
            p_vis = getattr(p_exact, "visibility", None)
            a_vis = getattr(a_exact, "visibility", None)
            if p_vis != a_vis:
                conflict_id = str(getattr(p_exact if p_vis == "hidden" else a_exact, "item_id", ""))
                plan_dicts.append(_to_conflict_dict(conflict_id, host_handle, content_sha))
            elif p_vis == "visible":
                if same_inv_other_pos_hidden:
                    conflict_id = str(
                        sorted(same_inv_other_pos_hidden, key=lambda it: str(getattr(it, "item_id", "")))[0].item_id
                    )
                    plan_dicts.append(_to_conflict_dict(conflict_id, host_handle, content_sha))
                continue
            elif str(getattr(p_exact, "compacted", "")) != str(getattr(a_exact, "compacted", "")):
                plan_dicts.append(_to_conflict_dict(str(p_exact.item_id), host_handle, content_sha))
            else:
                plan_dicts.append(
                    _to_plan_dict(primary_plan_by_handle.get(hkey), p_exact, host_handle, content_sha)
                )
            continue

        if p_exact is not None and a_exact is None:
            seen_handles.add(hkey)
            p_vis = getattr(p_exact, "visibility", None)
            if p_vis == "visible":
                ambiguous_hidden = same_inv_other_pos_hidden or a_pair_hidden
                if ambiguous_hidden:
                    conflict_id = str(
                        sorted(ambiguous_hidden, key=lambda it: str(getattr(it, "item_id", "")))[0].item_id
                    )
                    plan_dicts.append(_to_conflict_dict(conflict_id, host_handle, content_sha))
                continue
            if a_pair_items:
                plan_dicts.append(_to_conflict_dict(str(p_exact.item_id), host_handle, content_sha))
            else:
                plan_dicts.append(
                    _to_plan_dict(primary_plan_by_handle.get(hkey), p_exact, host_handle, content_sha)
                )
            continue

        if p_exact is None and a_exact is not None:
            seen_handles.add(hkey)
            a_vis = getattr(a_exact, "visibility", None)
            if a_vis == "visible":
                ambiguous_hidden = same_inv_other_pos_hidden or p_pair_hidden
                if ambiguous_hidden:
                    conflict_id = str(
                        sorted(ambiguous_hidden, key=lambda it: str(getattr(it, "item_id", "")))[0].item_id
                    )
                    plan_dicts.append(_to_conflict_dict(conflict_id, host_handle, content_sha))
                continue
            if p_pair_items:
                plan_dicts.append(_to_conflict_dict(str(a_exact.item_id), host_handle, content_sha))
            else:
                plan_dicts.append(
                    _to_plan_dict(alias_plan_by_handle.get(hkey), a_exact, host_handle, content_sha)
                )
            continue

        # Step B: No exact 5-tuple match applies.
        if not p_pair_hidden and not a_pair_hidden:
            p_plan = primary_plan_by_handle.get(hkey)
            if p_plan is not None:
                seen_handles.add(hkey)
                plan_dicts.append(_to_plan_dict(p_plan, None, host_handle, content_sha))
            continue

        seen_handles.add(hkey)
        all_hidden = p_pair_hidden + a_pair_hidden
        same_pos_hidden = [
            it for it in all_hidden
            if int(getattr(it, "result_position", 0) or 0) == int(pos or 0)
        ]
        conflict_pool = same_pos_hidden or p_pair_hidden or a_pair_hidden
        conflict_id = str(
            getattr(sorted(conflict_pool, key=lambda it: str(getattr(it, "item_id", "")))[0], "item_id", "")
        )
        plan_dicts.append(_to_conflict_dict(conflict_id, host_handle, content_sha))

    return plan_dicts


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
    started = time.perf_counter()
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
        record_perf(
            "middleware_step",
            duration_ms=(time.perf_counter() - started) * 1000.0,
            ok=False,
            error_code=UNSUPPORTED_API_MODE,
            row_count=0,
        )
        return {
            "request": dict(payload) if isinstance(payload, dict) else payload,
            "applied": [],
            "skipped": skipped,
            "trace": trace,
        }
    records: list[ToolResultRecord] = []
    observed_entries: list[tuple[str, int, str, dict[str, Any], ToolResultRecord | None]] = []
    targets = []
    unique_calls = _unique_calls(api_mode, payload)
    result_counts = Counter(entry.call_id for entry in stored)
    record_skipped: list[dict[str, Any]] = list(skipped)
    for entry in stored:
        if getattr(entry, "duplicate_call_id", False) or (entry.tool_name and entry.call_id not in unique_calls):
            record_skipped.append({
                "host_handle": dict(entry.host_handle),
                "reason": "ambiguous_invocation",
            })
            observed_entries.append(
                (entry.call_id, entry.result_position, entry.content_sha256, entry.host_handle, None)
            )
            continue
        if entry.arguments_parse_error or not entry.tool_name:
            record_skipped.append({
                "host_handle": dict(entry.host_handle),
                "reason": "invalid_invocation",
            })
            observed_entries.append(
                (entry.call_id, entry.result_position, entry.content_sha256, entry.host_handle, None)
            )
            continue
        try:
            invocation, omitted = filter_invocation(
                entry.tool_name, entry.raw_arguments)
        except AdapterRejected as exc:
            record_skipped.append({
                "host_handle": dict(entry.host_handle),
                "reason": exc.code,
            })
            observed_entries.append(
                (entry.call_id, entry.result_position, entry.content_sha256, entry.host_handle, None)
            )
            continue
        record = ToolResultRecord(
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
        records.append(record)
        observed_entries.append(
            (entry.call_id, entry.result_position, entry.content_sha256, entry.host_handle, record)
        )
        if (entry.call_id in unique_calls and result_counts[entry.call_id] == 1 and
                refusal_reason(record, engine.config) is None and
                not is_destructive_command(entry.tool_name, invocation.get("arguments"))):
            targets.append((record, omitted))
    if publish_targets:
        engine.store.publish_targets(scope, targets)
        _consume_pending(engine, scope, [record for record in records
            if record.call_id in unique_calls and result_counts[record.call_id] == 1], summarizer)
    plans = engine.project(scope, records)
    # Pair-atomic units: one pair_ row per transmitted record (call+result).
    unit_count = 0
    try:
        units_payload = [
            {
                "unit_id": pair_unit_id(scope.scope_key(), record.call_id, record.content_sha256),
                "kind": "tool_result",
                "tool_call_id": record.call_id,
                "content_sha256": record.content_sha256,
                "char_count": len(record.content),
            }
            for record in records
        ]
        unit_count = len(units_payload)
        upsert_batch = getattr(engine.store, "upsert_units", None)
        if callable(upsert_batch):
            if units_payload:
                upsert_batch(scope, units_payload)
        else:
            upsert = getattr(engine.store, "upsert_unit", None)
            if callable(upsert):
                for unit in units_payload:
                    upsert(
                        scope,
                        unit_id=unit["unit_id"],
                        kind=unit["kind"],
                        tool_call_id=unit["tool_call_id"],
                        content_sha256=unit["content_sha256"],
                        char_count=unit["char_count"],
                    )
    except Exception:
        pass
    plan_dicts = resolve_plan_dicts(
        engine, scope, observed_entries, primary_plans=plans,
    )
    planned_handles = {_handle_key(plan.get("host_handle")) for plan in plan_dicts}
    record_skipped = [
        item for item in record_skipped
        if _handle_key(item.get("host_handle")) not in planned_handles
    ]
    new_payload, applied, apply_skipped = apply_replacements(
        api_mode, payload, plan_dicts)
    trace["applied"] = len(applied)
    record_perf(
        "middleware_step",
        duration_ms=(time.perf_counter() - started) * 1000.0,
        ok=True,
        row_count=len(stored),
        unit_count=unit_count,
    )
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
