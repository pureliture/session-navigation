"""Reference Hermes plugin wiring for session-navigation (S4, M2-3).

This is the host-process shim between Hermes and the pure helpers
(`payload`, `session`, `handlers`). It owns everything host-specific:

- tool registration (`hide_context`, `summarize_context`, `list_context_items`, `unhide_context`, `manage_context`)
- the `llm_request` middleware (record -> plan -> apply on a copy)
- scope derivation from host identifiers (never model arguments)
- enabled-off default, coexistence record-only mode, fail-open errors

It owns nothing engine-specific: summarization, protection rules,
storage, and visibility stay in `session_navigation`. The engine never
imports this module; the wheel never ships it.

Verified against (stale-checkout warning: the local Hermes reference
checkout lags `origin/main`, so line numbers there drift; the contract
below follows the official middleware doc plus the transport/dispatch
code actually read):

- official doc `developer-guide/middleware`: `ctx.register_middleware(
  "llm_request", ...)` callbacks receive `request`, `original_request`
  plus runtime context (`session_id`, `task_id`, `turn_id`,
  `api_request_id`, `provider`, `model`, `api_mode`, ...); returning
  `{"request": {...}}` replaces the effective provider kwargs; optional
  `source`/`reason`/`name` strings land in `middleware_trace`.
- `agent/turn_api_request.py`: `llm_request` middleware runs right after
  `_build_api_kwargs`, so it sees provider-format payloads.
- `tools/registry.py` + `model_tools.handle_function_call`: tool
  handlers run as `handler(args, **kwargs)` and must return a string;
  `kwargs` carries identifiers (`task_id`, `session_id`, ...), never
  the conversation messages.

Decisions recorded here (first-version scope):

- D5 session-model-only: `hide_context` is rule-only (never calls a model);
  `summarize_context` uses the session model via `ctx.llm` (25s timeout),
  and returns `summarizer_unavailable` when no session model exists. No
  local-model settings exist.
- `branch_scope` is `"unknown"`: Hermes exposes no exact branch API
  to the plugin, so no full fork isolation is claimed. A compression
  rotation issues a new `session_id`, which naturally starts a fresh
  scope: compacted state never carries over silently.
- `transform_tool_result` is NOT used: stored conversation history is
  never rewritten, only the outgoing request copy.
- Logs carry counts, item IDs, and error codes only, never result
  bodies or commands.
"""

from __future__ import annotations

from contextvars import ContextVar

import re
import copy
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .handlers import compact as _engine_compact
from .handlers import middleware_step as _engine_step
from .handlers import list_records as _engine_list
from .handlers import resolve_plan_dicts as _resolve_plan_dicts
from .handlers import restore as _engine_restore
from .handlers import scope_candidates as _scope_candidates
from .handlers import summarize as _engine_summarize
from .payload import (
    SUPPORTED_API_MODES,
    UNSUPPORTED_API_MODE,
    apply_replacements,
    drop_messages,
    find_tool_results,
    message_keys,
)
from .presentation import PresentationRegistry, decorate_items
from .session import SessionTranscriptStore, _extract_invocations, _extract_invocations_and_duplicates
from .usage import UsageTracker, estimate_tokens
from session_navigation.model import Scope, ToolResultRecord, compute_invocation_digest, _item_id
from session_navigation.db import DBError, DBFullError
from session_navigation.policy import refusal_reason, is_destructive_command
from session_navigation.reminders import BoundaryReminders
from .allowlist import AdapterRejected, filter_invocation
from session_navigation.engine import SessionNavigationEngine
from session_navigation.transport import Summarizer, SummarizerError
from .llm import CtxLlmSummarizer
from .schemas import ADAPTER_ID, BRANCH_SCOPE, MANAGE_TOOL, SOURCE, TOOL_SCHEMAS, SUPERVISION_SECTION_ID, SUPERVISION_SECTION_TEXT
logger = logging.getLogger(__name__)


def _compute_runtime_bundle_fingerprint() -> str:
    """Compute the bundle fingerprint of the currently imported Python modules."""
    import session_navigation as _core_pkg

    core_fp = getattr(_core_pkg, "__bundle_fingerprint__", None) or _core_pkg._source_fingerprint(_core_pkg.__file__)
    adapter_fp = _core_pkg._source_fingerprint(__file__)
    return hashlib.sha256(f"{core_fp}:{adapter_fp}".encode("utf-8")).hexdigest()


RUNTIME_BUNDLE_FINGERPRINT = _compute_runtime_bundle_fingerprint()

def _default_count_llm_middlewares() -> int:
    """Count the OTHER registered `llm_request` middleware callbacks.

    Verified on 2026-10-11 against the installed runtime
    (``hermes_cli.middleware.apply_llm_request_middleware`` plus
    ``PluginManager.invoke_middleware``): the request chain COMPOSES in
    registration order -- each callback receives the previous callback's
    payload, and the last dict returned under ``request`` is what the provider
    sees. So a later middleware can overwrite our replacement and we can
    overwrite theirs; the chain does not by itself guarantee a single compact
    owner.

    This probe therefore only reports how many OTHER callbacks exist. The
    middleware reads that number and decides what to do (see
    ``on_llm_request``). Runs inside the Hermes process, so a lazy host import
    is fine here (the pure helpers stay host-free). Any import problem degrades
    to 0 = "no evidence of others", which keeps the plugin's own behaviour
    instead of silently withholding it.
    """
    try:
        from hermes_cli.plugins import _delivery_manager

        manager = _delivery_manager()
        middlewares = getattr(manager, "_middleware", {}).get("llm_request", [])
        return max(0, len(middlewares) - 1)
    except Exception:
        return 0


@dataclass
class PluginState:
    """Live per-registration plugin state (one per Hermes process load)."""

    engine: SessionNavigationEngine = field(default_factory=SessionNavigationEngine)
    summarizer: Summarizer | None = None
    store: SessionTranscriptStore = field(default_factory=SessionTranscriptStore)
    presentations: PresentationRegistry = field(default_factory=PresentationRegistry)
    profile: str = "default"
    is_enabled: Callable[[], bool] = field(default=lambda: False)
    count_middlewares: Callable[[], int] = field(
        default=_default_count_llm_middlewares)
    db_error_pending: bool = False
    usage: UsageTracker = field(default_factory=UsageTracker)
    reminders: BoundaryReminders = field(default_factory=BoundaryReminders)
    instance_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    delegation_call: ContextVar = field(default_factory=lambda: ContextVar("session_navigation_delegate", default=None))
    child_links: dict[str, dict[str, str | None]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.engine.store.scope_aliases[ADAPTER_ID] = (BRANCH_SCOPE, "default")


def scope_for(state: PluginState, session_id: Any) -> Scope | None:
    """Derive the engine scope from host identifiers, None when absent.

    Blank `session_id` would mix unrelated sessions, so the caller must
    fail open (tool: `not_found`, middleware: pass the request through).
    """
    if not isinstance(session_id, str) or not session_id.strip():
        return None
    profile = state.profile if isinstance(state.profile, str) and state.profile else "default"
    return Scope(
        adapter_id=ADAPTER_ID,
        host_profile=profile,
        session_id=session_id.strip(),
        branch_scope=BRANCH_SCOPE,
    )


def _is_effectively_enabled(state: PluginState) -> bool:
    if not state.is_enabled():
        return False
    get_ctrl = getattr(state.engine.store, "get_adapter_control", None)
    if callable(get_ctrl):
        try:
            ctrl = get_ctrl(ADAPTER_ID)
        except Exception:
            # Fail closed on adapter_control lookup error so protection-only mode
            # preserves hidden items and blocks new mutations.
            return False
        if isinstance(ctrl, dict) and ctrl.get("enabled") is False:
            return False
    return True


def delegation_request(state: PluginState, **kwargs: Any) -> None:
    if kwargs.get("tool_name") == "delegate_task":
        state.delegation_call.set((kwargs.get("session_id", ""), kwargs.get("tool_call_id")))


def subagent_started(state: PluginState, **kwargs: Any) -> None:
    parent = scope_for(state, kwargs.get("parent_session_id"))
    child = scope_for(state, kwargs.get("child_session_id"))
    subagent = kwargs.get("child_subagent_id")
    if parent is None or child is None or parent == child or not isinstance(subagent, str) or not subagent:
        return
    captured = state.delegation_call.get()
    call = captured[1] if captured and (not captured[0] or captured[0] == parent.session_id) else None
    state.child_links[child.session_id] = dict(parent_scope=parent.scope_key(), tool_call_id=call, subagent_id=subagent)
    if _is_effectively_enabled(state):
        _guarded_register(state, child, True)


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _track_mutation(state: PluginState, handler: Callable[..., str]) -> Callable[..., str]:
    def savings(scope: Scope) -> int | None:
        try:
            return sum(estimate_tokens(item.original) - estimate_tokens(item.compacted)
                       for item in state.engine.store.items(scope) if item.visibility == "hidden")
        except Exception:
            return None

    def tracked(args: Any = None, session_id: str = "", **extra: Any) -> str:
        scope = scope_for(state, session_id)
        before = savings(scope) if scope is not None else None
        result = handler(args, session_id=session_id, **extra)
        if before is not None:
            after = savings(scope)
            if after is not None:
                state.usage.adjust(session_id, after - before)
        return result

    return tracked


def make_hide_handler(state: PluginState) -> Callable[..., str]:
    """Build the `hide_context` tool handler bound to this registration."""

    def hide_context(args: Any, session_id: str = "", **_extra: Any) -> str:
        if not _is_effectively_enabled(state):
            return _dump({"ok": False, "error": "disabled"})
        target = args.get("tool_call_id") if isinstance(args, dict) else None
        if not isinstance(target, str) or not target.strip():
            return _dump({"ok": False, "error": "missing_tool_call_id"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        _refresh_registration(state, scope)
        # hide_context is rule-based only: never pass the configured summarizer.
        result = _engine_compact(
            state.engine, state.store, scope, target.strip(),
        )
        if not result.ok and result.error == "verification_failed":
            matches = state.store.lookup(scope.scope_key(), target.strip())
            if matches and _cleanup_error(state, scope, matches[0]) is None:
                ok_fb, err_fb, fb_item_id, _ = _apply_hide_for_manage(state, scope, matches[0])
                if ok_fb and fb_item_id is not None:
                    _guarded_register(state, scope, True)
                    stored_fb = state.engine.store.get(scope, fb_item_id)
                    return _dump({
                        "ok": True,
                        "item_id": fb_item_id,
                        "visibility_version": stored_fb.version if stored_fb is not None else 1,
                    })
                if err_fb:
                    return _dump({"ok": False, "error": err_fb})
        if not result.ok or result.plan is None:
            err = result.error or "not_found"
            if err == "db_error":
                return _dump({"ok": False, "error": err, "choices": ["abort_request", "send_original"]})
            return _dump({"ok": False, "error": err})
        _guarded_register(state, scope, True)
        original_bytes = 0
        if result.item is not None:
            original_bytes = len(result.item.original.encode("utf-8"))
        state.presentations.record_compacted(
            scope.scope_key(), result.plan.item_id, original_bytes)
        return _dump({
            "ok": True,
            "item_id": result.plan.item_id,
            "visibility_version": result.plan.visibility_version,
        })

    return _track_mutation(state, hide_context)

def make_summarize_handler(state: PluginState) -> Callable[..., str]:
    """Build the `summarize_context` tool handler bound to this registration."""

    def summarize_context(args: Any, session_id: str = "", **_extra: Any) -> str:
        if not _is_effectively_enabled(state):
            return _dump({"ok": False, "error": "disabled"})
        if state.summarizer is None:
            return _dump({"ok": False, "error": "summarizer_unavailable"})
        target = args.get("tool_call_id") if isinstance(args, dict) else None
        if not isinstance(target, str) or not target.strip():
            return _dump({"ok": False, "error": "missing_tool_call_id"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        _refresh_registration(state, scope)
        if state.summarizer is not None and hasattr(state.summarizer, "current_scope_key"):
            state.summarizer.current_scope_key = scope.scope_key()
        result = _engine_summarize(
            state.engine, state.store, scope, target.strip(), state.summarizer)
        if not result.ok or result.plan is None:
            err = result.error or "not_found"
            if err == "db_error":
                return _dump({"ok": False, "error": err, "choices": ["abort_request", "send_original"]})
            return _dump({"ok": False, "error": err})
        _guarded_register(state, scope, True)
        original_bytes = 0
        if result.item is not None:
            original_bytes = len(result.item.original.encode("utf-8"))
        state.presentations.record_compacted(
            scope.scope_key(), result.plan.item_id, original_bytes)
        return _dump({
            "ok": True,
            "item_id": result.plan.item_id,
            "visibility_version": result.plan.visibility_version,
            "compaction_source": "llm",
        })

    return _track_mutation(state, summarize_context)


def make_list_handler(state: PluginState) -> Callable[..., str]:
    """Build the `list_context_items` tool handler bound to this registration."""

    def list_context_items(args: Any = None, session_id: str = "", **_extra: Any) -> str:
        query = ""
        if isinstance(args, dict) and isinstance(args.get("query"), str):
            query = args["query"]
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        paused = not _is_effectively_enabled(state)
        if not paused:
            _refresh_registration(state, scope)
        if isinstance(args, dict) and args.get("view") == "candidates":
            limit = args.get("limit", 30)
            if type(limit) is not int or not 1 <= limit <= 200:
                return _dump({"ok": False, "error": "invalid_limit"})
            if not _is_effectively_enabled(state):
                return _dump({"ok": True, "items": []})
            candidates = []
            for entry in reversed(state.store.entries(scope.scope_key())):
                if _cleanup_error(state, scope, entry) is not None:
                    continue
                hints = entry.raw_arguments
                candidates.append({"tool_call_id": entry.call_id, "tool_name": entry.tool_name,
                                   "hint": str(hints.get("command") or hints.get("path") or hints.get("pattern") or "")[:160],
                                   "bytes_size": len(entry.content.encode("utf-8")), "tokens_display": "—"})
                if len(candidates) >= limit:
                    break
            return _dump({"ok": True, "items": candidates})
        try:
            items = _engine_list(state.engine, scope, query)
        except (DBError, DBFullError):
            # A broken database (read-only/locked/full) must surface through
            # the pending-error payload, not an unhandled throw that hides
            # the db_error_pending path below.
            state.db_error_pending = True
            return _dump({"ok": False, "error": "db_error",
                          "db_error_pending": True,
                          "db_error_choices": ["abort_request", "send_original"]})
        scope_key = scope.scope_key()
        try:
            live_ids = {
                item.item_id for item in state.engine.store.items(scope)
            }
        except (DBError, DBFullError):
            state.db_error_pending = True
            live_ids = set()
        state.presentations.prune(scope_key, live_ids)
        items = decorate_items(items, state.presentations.snapshot().get(scope_key, {}))
        state.presentations.record_view(scope_key, [
            (item["display_number"], item["item_id"])
            for item in items if item["display_number"] is not None
        ])
        compacted_count = sum(item["visibility"] == "hidden" for item in items)
        prefix = "Matching" if query else "Current"
        message = f"{prefix} hidden items: {compacted_count}" if compacted_count else f"{prefix} hidden items: none"
        payload: dict[str, Any] = {
            "ok": True, "count": len(items), "items": items,
            "compacted_count": compacted_count, "message": message,
        }
        if paused:
            payload["paused"] = True
            payload["paused_warning"] = (
                "adapter paused: hides/summaries are disabled, but stored hidden "
                "items are still redacted from outgoing requests (protection-only); "
                "capabilities refresh on resume."
            )
        if state.db_error_pending:
            payload["db_error_pending"] = True
            payload["db_error_choices"] = ["abort_request", "send_original"]
            state.db_error_pending = False
        return _dump(payload)

    return list_context_items


def make_unhide_handler(state: PluginState) -> Callable[..., str]:
    """Build the `unhide_context` tool handler bound to this registration."""

    def unhide_context(args: Any, session_id: str = "", **_extra: Any) -> str:
        target = args.get("item_id") if isinstance(args, dict) else None
        if not isinstance(target, str) or not target.strip():
            return _dump({"ok": False, "error": "not_found"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        resolved, resolve_error = state.presentations.resolve_reference(
            scope.scope_key(), target.strip())
        if resolve_error is not None:
            # Fail closed on number references: never guess a target.
            return _dump({"ok": False, "error": resolve_error})
        expected = args.get("expected_version") if isinstance(args, dict) else None
        if expected is not None and (not isinstance(expected, int) or isinstance(expected, bool)):
            return _dump({"ok": False, "error": "invalid_version"})
        result = _engine_restore(state.engine, scope, resolved or "", expected_version=expected)
        if not result.ok or result.item is None:
            err = result.error or "not_found"
            if err == "db_error":
                return _dump({"ok": False, "error": err, "choices": ["abort_request", "send_original"]})
            return _dump({"ok": False, "error": err})
        state.presentations.mark_visible(scope.scope_key(), result.item.item_id)
        state.reminders.suppress_unhide(scope.scope_key())
        return _dump({
            "ok": True,
            "item_id": result.item.item_id,
            "visibility_version": result.item.version,
        })

    return _track_mutation(state, unhide_context)


def _apply_hide_for_manage(state: PluginState, scope: Scope, entry: Any, keep_lines: list[str] | None = None) -> tuple[bool, str | None, str | None, dict[str, Any]]:
    """Apply one rule-based hide through shared engine paths (manage_context helper)."""
    from session_navigation.model import ToolResultRecord, compute_invocation_digest
    from .allowlist import AdapterRejected, filter_invocation

    if getattr(entry, "duplicate_call_id", False):
        return False, "ambiguous", None, {}
    if entry.arguments_parse_error or not entry.tool_name:
        return False, "invalid_invocation", None, {}
    try:
        invocation, omitted = filter_invocation(entry.tool_name, entry.raw_arguments)
    except AdapterRejected as exc:
        return False, exc.code, None, {}
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
    result = state.engine.compact_sync(scope, record, options_omitted=bool(omitted), keep_lines=keep_lines)
    diagnostics: dict[str, Any] = {}
    if result.keep_lines_ignored:
        diagnostics["keep_lines_ignored"] = list(result.keep_lines_ignored)
    if result.keep_lines_normalized:
        diagnostics["keep_lines_normalized"] = list(result.keep_lines_normalized)
    if not result.ok and result.error == "verification_failed" and refusal_reason(record, state.engine.config) is None:
        from session_navigation.model import ContextItem
        from session_navigation.policy import (
            MAX_EXCERPT_BYTES, MAX_EXCERPT_LINE, normalize_keep_lines,
            render_compaction, selectable_text, verified_facts,
        )
        source = selectable_text(record.content)
        lines = source.splitlines()
        eligible = [idx for idx, line in enumerate(lines) if 0 < len(line) <= MAX_EXCERPT_LINE]
        if eligible and (keep_lines is None or isinstance(keep_lines, list)):
            accepted, ignored, normalized = normalize_keep_lines(record.content, keep_lines) if isinstance(keep_lines, list) else ([], [], [])
            if ignored:
                diagnostics["keep_lines_ignored"] = list(ignored)
            if normalized:
                diagnostics["keep_lines_normalized"] = list(normalized)
            selected = sorted({*eligible[:3], *eligible[-2:], *(idx for idx, line in enumerate(lines) if len(line) <= MAX_EXCERPT_LINE and any(part in line for part in accepted))})
            excerpt = tuple(lines[idx] for idx in selected)
            excerpt_bytes = sum(len(line.encode("utf-8")) + 1 for line in excerpt)
            item_id = _item_id(scope.scope_key(), record.call_id, record.content_sha256, record.invocation_digest, record.result_position)
            compacted = render_compaction(item_id, excerpt, facts=verified_facts(record.content), options_omitted=bool(omitted))
            if excerpt_bytes <= MAX_EXCERPT_BYTES and len(compacted.encode("utf-8")) < len(record.content.encode("utf-8")):
                existing = state.engine.store.get(scope, item_id)
                stored = ContextItem(
                    item_id=item_id,
                    tool_call_id=record.call_id,
                    content_sha256=record.content_sha256,
                    invocation_digest=record.invocation_digest,
                    original=record.content,
                    compacted=compacted,
                    excerpt_lines=excerpt,
                    visibility="hidden",
                    version=(existing.version + 1) if existing else 1,
                    tool_name=record.invocation.get("tool_name", ""),
                    compaction_source="rule",
                    invocation_snapshot=record.invocation,
                    invocation_options_omitted=bool(omitted),
                    result_position=record.result_position,
                    created_at=existing.created_at if existing else 0.0,
                    updated_at=0.0,
                )
                saved = state.engine.store.put(scope, stored, expected_version=existing.version if existing else None)
                if saved.ok:
                    state.presentations.record_compacted(scope.scope_key(), item_id, len(record.content.encode("utf-8")))
                    return True, None, item_id, diagnostics
            elif accepted and excerpt_bytes > MAX_EXCERPT_BYTES:
                return False, "keep_lines_too_broad", None, diagnostics
    if not result.ok or result.plan is None:
        return False, result.error or "not_found", None, diagnostics
    state.presentations.record_compacted(
        scope.scope_key(), result.plan.item_id, len(record.content.encode("utf-8")))
    return True, None, result.plan.item_id, diagnostics


def _apply_sequence_summary_for_manage(
    state: PluginState,
    scope: Scope,
    entry: Any,
    summary_text: str,
) -> tuple[bool, str | None, str | None]:
    from session_navigation.model import ContextItem, ToolResultRecord, compute_invocation_digest
    from session_navigation.policy import (
        MAX_EXCERPT_LINE,
        render_compaction,
        required_evidence_lines,
        verified_facts,
    )
    from session_navigation.summary import has_summary_injection
    from .allowlist import AdapterRejected, filter_invocation

    if getattr(entry, "duplicate_call_id", False):
        return False, "ambiguous", None
    if entry.arguments_parse_error or not entry.tool_name:
        return False, "invalid_invocation", None
    try:
        invocation, omitted = filter_invocation(entry.tool_name, entry.raw_arguments)
    except AdapterRejected as exc:
        return False, exc.code, None
    trimmed = summary_text.strip()
    if not trimmed or len(trimmed) > 1800 or has_summary_injection(trimmed):
        return False, "verification_failed", None
    digest = compute_invocation_digest(invocation, omitted if omitted else None)
    record_check = ToolResultRecord(
        call_id=entry.call_id,
        content=entry.content,
        content_sha256=entry.content_sha256,
        invocation=invocation,
        invocation_digest=digest,
        result_position=entry.result_position,
        status="ok",
    )
    refused = refusal_reason(record_check, state.engine.config)
    if refused is not None:
        return False, refused, None
    item_id = _item_id(
        scope.scope_key(), entry.call_id, entry.content_sha256, digest, entry.result_position
    )
    facts = verified_facts(entry.content)
    req = required_evidence_lines(entry.content)
    orig_bytes = len(entry.content.encode("utf-8"))
    excerpt: tuple[str, ...] = ()
    compacted = render_compaction(
        item_id, (), summary_text={"summary": trimmed}, facts=facts, options_omitted=bool(omitted)
    )
    if 0 < len(req) <= 8 and all(len(line) <= MAX_EXCERPT_LINE for line in req):
        with_req = render_compaction(
            item_id, req, summary_text={"summary": trimmed}, facts=facts, options_omitted=bool(omitted)
        )
        if len(with_req.encode("utf-8")) <= orig_bytes * 0.8:
            excerpt = req
            compacted = with_req
    if len(compacted.encode("utf-8")) >= orig_bytes and "\n[Sequence summary] " in trimmed:
        step_only = trimmed.split("\n[Sequence summary] ", 1)[0]
        compacted = render_compaction(
            item_id, (), summary_text={"summary": step_only}, facts=facts, options_omitted=bool(omitted)
        )
        excerpt = ()
    if len(compacted.encode("utf-8")) >= orig_bytes:
        return False, "verification_failed", None
    existing = state.engine.store.get(scope, item_id)
    stored = ContextItem(
        item_id=item_id,
        tool_call_id=entry.call_id,
        content_sha256=entry.content_sha256,
        invocation_digest=digest,
        original=entry.content,
        compacted=compacted,
        excerpt_lines=excerpt,
        visibility="hidden",
        version=(existing.version + 1) if existing else 1,
        tool_name=invocation.get("tool_name", ""),
        compaction_source="llm",
        invocation_snapshot=invocation,
        invocation_options_omitted=bool(omitted),
        result_position=entry.result_position,
        created_at=existing.created_at if existing else 0.0,
        updated_at=0.0,
    )
    saved = state.engine.store.put(
        scope,
        stored,
        expected_version=existing.version if existing else None,
    )
    if not saved.ok:
        return False, saved.error or "db_error", None
    state.presentations.record_compacted(scope.scope_key(), item_id, orig_bytes)
    return True, None, item_id

def _cleanup_error(state: PluginState, scope: Scope, entry: Any) -> str | None:
    if getattr(entry, "duplicate_call_id", False) or len(state.store.lookup(scope.scope_key(), entry.call_id)) != 1:
        return "ambiguous"
    if entry.arguments_parse_error or not entry.tool_name:
        return "invalid_invocation"
    try:
        invocation, omitted = filter_invocation(entry.tool_name, entry.raw_arguments)
    except AdapterRejected as exc:
        return exc.code
    record = ToolResultRecord(call_id=entry.call_id, content=entry.content,
                              content_sha256=entry.content_sha256, invocation=invocation,
                              invocation_digest=compute_invocation_digest(invocation, omitted if omitted else None),
                              result_position=entry.result_position, status="ok")
    item = state.engine.store.get(scope, _item_id(scope.scope_key(), record.call_id, record.content_sha256,
                                               record.invocation_digest, record.result_position))
    if item is not None and item.visibility == "hidden":
        return "already_hidden"
    try:
        if is_destructive_command(entry.tool_name, entry.raw_arguments):
            return "destructive_command"
    except Exception:
        return "destructive_check_failed"
    return refusal_reason(record, state.engine.config)


def make_manage_handler(state: PluginState) -> Callable[..., str]:
    """Build the `manage_context` orchestrator tool handler."""

    def manage_context(args: Any = None, session_id: str = "", **_extra: Any) -> str:
        if not _is_effectively_enabled(state):
            return _dump({"ok": False, "error": "disabled"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        _refresh_registration(state, scope)
        params = args if isinstance(args, dict) else {}
        want = params.get("tool_call_ids")
        if want is None or want == []:
            return _dump({"ok": False, "error": "tool_call_ids_required"})
        if not isinstance(want, list) or not all(isinstance(x, str) and x.strip() for x in want):
            return _dump({"ok": False, "error": "invalid_tool_call_ids"})
        action = params.get("action", "auto")
        if action not in ("auto", "hide", "summarize"):
            return _dump({"ok": False, "error": "invalid_action"})
        keep_lines = params.get("keep_lines")
        if keep_lines == []:
            keep_lines = None
        if keep_lines is not None and action != "hide":
            return _dump({"ok": False, "error": "invalid_keep_lines_action"})
        if action == "summarize" and state.summarizer is None:
            return _dump({"ok": False, "error": "summarizer_unavailable"})
        results: list[dict[str, Any]] = []
        wanted_ids = list(dict.fromkeys(want))
        sequence_summaries: dict[str, str] = {}
        sequence_failure: str | None = None
        use_sequence = (
            action in ("summarize", "auto")
            and state.summarizer is not None
            and callable(getattr(state.summarizer, "summarize_sequence", None))
        )
        if use_sequence:
            from .allowlist import AdapterRejected, filter_invocation

            eligible_by_id: dict[str, Any] = {}
            for call_id in wanted_ids:
                matches = state.store.lookup(scope.scope_key(), call_id)
                if matches and _cleanup_error(state, scope, matches[0]) is None:
                    eligible_by_id[call_id] = matches[0]
            ordered_entries = [
                entry
                for entry in state.store.entries(scope.scope_key())
                if entry.call_id in eligible_by_id
            ]
            seq_steps: list[dict[str, Any]] = []
            for entry in ordered_entries:
                try:
                    inv, _ = filter_invocation(entry.tool_name, entry.raw_arguments)
                except AdapterRejected:
                    continue
                seq_steps.append({
                    "call_id": entry.call_id,
                    "tool_name": entry.tool_name,
                    "invocation": inv,
                    "content": entry.content,
                })
            if seq_steps:
                if hasattr(state.summarizer, "current_scope_key"):
                    state.summarizer.current_scope_key = scope.scope_key()
                sequence_summaries, sequence_failure = state.summarizer.summarize_sequence(
                    seq_steps, action=action, scope_key=scope.scope_key()
                )
        def _fmt_byte_pair(post_b: int, pre_b: int) -> str:
            post = max(0, post_b)
            pre = max(0, pre_b)
            if pre < 1024 and post < 1024:
                return f"{post}/{pre} B"
            pre_kib = f"{pre / 1024:.1f}"
            if post == 0:
                return f"0/{pre_kib} KiB"
            post_kib = post / 1024
            return f"<0.1/{pre_kib} KiB" if post_kib < 0.05 else f"{post_kib:.1f}/{pre_kib} KiB"
        def _item_metrics(target_entry: Any, saved_id: str) -> dict[str, Any]:
            stored_item = state.engine.store.get(scope, saved_id)
            pre_b = len(target_entry.content.encode("utf-8"))
            post_b = len(stored_item.compacted.encode("utf-8")) if stored_item is not None else 0
            mode = (
                "summarize"
                if stored_item is not None and stored_item.compaction_source in ("llm", "llm_summary")
                else "hide"
            )
            return {
                "tool_name": target_entry.tool_name,
                "mode": mode,
                "compacted_bytes": post_b,
                "original_bytes": pre_b,
                "size": _fmt_byte_pair(post_b, pre_b),
            }

        for call_id in wanted_ids:
            matches = state.store.lookup(scope.scope_key(), call_id)
            error = _cleanup_error(state, scope, matches[0]) if matches else "not_found"
            if error is not None:
                failed_row: dict[str, Any] = {"tool_call_id": call_id, "ok": False, "error": error}
                if matches and matches[0].tool_name:
                    failed_row["tool_name"] = matches[0].tool_name
                results.append(failed_row)
                continue
            entry = matches[0]
            use_summarizer = action == "summarize" or (action == "auto" and state.summarizer is not None)
            item_id: str | None = None
            if use_sequence:
                seq_text = sequence_summaries.get(entry.call_id)
                if seq_text:
                    ok_seq, err_seq, item_id = _apply_sequence_summary_for_manage(
                        state, scope, entry, seq_text
                    )
                    if ok_seq and item_id is not None:
                        results.append({
                            "tool_call_id": entry.call_id,
                            "ok": True,
                            "item_id": item_id,
                            **_item_metrics(entry, item_id),
                        })
                        continue
                    if action == "summarize":
                        results.append({
                            "tool_call_id": entry.call_id,
                            "tool_name": entry.tool_name,
                            "ok": False,
                            "error": err_seq or "verification_failed",
                        })
                        continue
                elif action == "summarize":
                    results.append({
                        "tool_call_id": entry.call_id,
                        "tool_name": entry.tool_name,
                        "ok": False,
                        "error": sequence_failure or "summarizer_unavailable",
                    })
                    continue
            elif use_summarizer:
                if state.summarizer is not None and hasattr(state.summarizer, "current_scope_key"):
                    state.summarizer.current_scope_key = scope.scope_key()
                outcome = _engine_summarize(
                    state.engine, state.store, scope, entry.call_id, state.summarizer)
                if outcome.ok and outcome.plan is not None:
                    item_id = outcome.plan.item_id
                    state.presentations.record_compacted(
                        scope.scope_key(), item_id, len(entry.content.encode("utf-8")))
                    results.append({
                        "tool_call_id": entry.call_id,
                        "ok": True,
                        "item_id": item_id,
                        **_item_metrics(entry, item_id),
                    })
                    continue
                if action == "summarize":
                    results.append({
                        "tool_call_id": entry.call_id,
                        "tool_name": entry.tool_name,
                        "ok": False,
                        "error": outcome.error or "not_found",
                    })
                    continue
            ok, error, item_id, diagnostics = _apply_hide_for_manage(state, scope, entry, keep_lines)
            row: dict[str, Any] = {"tool_call_id": entry.call_id, "ok": ok, **diagnostics}
            if entry.tool_name:
                row["tool_name"] = entry.tool_name
            if ok and item_id is not None:
                row["item_id"] = item_id
                row.update(_item_metrics(entry, item_id))
            else:
                row["error"] = error or "not_found"
            results.append(row)
        applied_rows = [r for r in results if r["ok"]]
        applied = len(applied_rows)
        if applied > 0:
            _guarded_register(state, scope, True)
        failed = len(results) - applied
        total_post = sum(int(r.get("compacted_bytes", 0)) for r in applied_rows)
        total_pre = sum(int(r.get("original_bytes", 0)) for r in applied_rows)
        payload: dict[str, Any] = {
            "ok": failed == 0,
            "applied": applied,
            "failed": failed,
            "compacted_bytes": total_post,
            "original_bytes": total_pre,
            "items": results,
        }
        if applied > 0:
            payload["size"] = _fmt_byte_pair(total_post, total_pre)
        return _dump(payload)

    return _track_mutation(state, manage_context)


def _strip_supervision_text(request: dict[str, Any]) -> bool:
    """Remove the static human-supervision guidance in place; return True if changed.

    The host offers no section unregister API and freezes sections for the
    session, so entering protection-only cannot retract already-rendered
    guidance. Stripping our own static text from the outgoing provider
    payload stops the model from being told to call tools that now answer
    ``disabled``, without touching any other content.
    """
    changed = False
    if isinstance(request.get("instructions"), str) and SUPERVISION_SECTION_TEXT in request["instructions"]:
        request["instructions"] = request["instructions"].replace(SUPERVISION_SECTION_TEXT, "")
        changed = True
    for key in ("messages", "input"):
        messages = request.get(key)
        if not isinstance(messages, list):
            continue
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("system", "developer"):
                continue
            content = message.get("content")
            if isinstance(content, str):
                if SUPERVISION_SECTION_TEXT in content:
                    message["content"] = content.replace(SUPERVISION_SECTION_TEXT, "")
                    changed = True
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str) and SUPERVISION_SECTION_TEXT in block["text"]:
                        block["text"] = block["text"].replace(SUPERVISION_SECTION_TEXT, "")
                        changed = True
    return changed



_SUPERVISION_FRAME_RE = re.compile(
    r"## Plugin Context: " + re.escape(SUPERVISION_SECTION_ID) +
    r"\n<!-- hermes-plugin-section-chars:(\d+) -->\n\n"
)


def _strip_stale_supervision_sections(text: str) -> str:
    """Remove an outdated framed supervision section from a request copy.

    Hermes freezes prompt sections into persisted sessions. Existing sessions
    can therefore carry an older module version of this same section; leaving
    it in place would dilute the newer cleanup contract. Only the exact frame
    emitted by Hermes is recognized; user/tool text containing the heading is
    not modified.
    """
    chunks: list[str] = []
    cursor = 0
    for match in _SUPERVISION_FRAME_RE.finditer(text):
        length = int(match.group(1))
        end = match.end() + length
        if end <= len(text) and text[match.end():end] == SUPERVISION_SECTION_TEXT:
            continue
        chunks.append(text[cursor:match.start()])
        cursor = end
    chunks.append(text[cursor:])
    return "".join(chunks)

def _can_add_supervision(request: dict[str, Any], api_mode: str, turn_id: Any) -> bool:
    """Only steer supported requests that expose the cleanup tool or its bridge."""
    if api_mode not in SUPPORTED_API_MODES:
        return False
    if isinstance(turn_id, str) and turn_id.endswith(":side_question"):
        return False
    choice = request.get("tool_choice")
    if choice == "none" or (isinstance(choice, dict) and choice.get("type") == "none"):
        return False
    if isinstance(choice, dict) and choice.get("type") == "function":
        function = choice.get("function")
        name = function.get("name") if isinstance(function, dict) else choice.get("name")
        if isinstance(name, str) and name not in ("manage_context", "tool_call"):
            return False
    tools = request.get("tools")
    if not isinstance(tools, list):
        return False
    names = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        name = function.get("name") if isinstance(function, dict) else tool.get("name")
        if isinstance(name, str):
            names.add(name)
    return MANAGE_TOOL in names or {"tool_describe", "tool_call"}.issubset(names)


def _ensure_supervision_text(request: dict[str, Any], api_mode: str) -> dict[str, Any]:
    """Add or refresh guidance on the outgoing system prompt, not session history."""
    if api_mode == "codex_responses":
        instructions = request.get("instructions", "")
        if not isinstance(instructions, str):
            return request
        if SUPERVISION_SECTION_TEXT in instructions:
            return request
        instructions = _strip_stale_supervision_sections(instructions)
        messages = request.get("input")
    else:
        messages = request.get("messages")
    if not isinstance(messages, list):
        return request

    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("system", "developer"):
            continue
        content = message.get("content")
        if isinstance(content, str) and SUPERVISION_SECTION_TEXT in content:
            return request
        if isinstance(content, list) and SUPERVISION_SECTION_TEXT in "".join(
            block.get("text", "") for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ):
            return request

    updated = dict(request)
    if api_mode == "codex_responses":
        updated["instructions"] = (
            f"{instructions}\n\n{SUPERVISION_SECTION_TEXT}" if instructions else SUPERVISION_SECTION_TEXT
        )
        return updated

    updated_messages = list(messages)
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") not in ("system", "developer"):
            continue
        content = message.get("content")
        updated_message = dict(message)
        if isinstance(content, str):
            normalized = _strip_stale_supervision_sections(content)
            updated_message["content"] = (
                f"{normalized}\n\n{SUPERVISION_SECTION_TEXT}" if normalized else SUPERVISION_SECTION_TEXT
            )
        elif isinstance(content, list):
            updated_content = []
            for block in content:
                if not isinstance(block, dict) or not isinstance(block.get("text"), str):
                    updated_content.append(block)
                    continue
                updated_block = dict(block)
                updated_block["text"] = _strip_stale_supervision_sections(block["text"])
                updated_content.append(updated_block)
            updated_message["content"] = [*updated_content, {"type": "text", "text": SUPERVISION_SECTION_TEXT}]
        else:
            continue
        updated_messages[index] = updated_message
        updated["messages"] = updated_messages
        return updated
    updated["messages"] = [{"role": "system", "content": SUPERVISION_SECTION_TEXT}, *updated_messages]
    return updated


def _child_request(request: dict[str, Any]) -> dict[str, Any]:
    request = copy.deepcopy(request)
    if isinstance(request.get("tools"), list):
        request["tools"] = [tool for tool in request["tools"]
            if not isinstance(tool, dict) or
            (tool.get("function", {}).get("name") if isinstance(tool.get("function"), dict) else tool.get("name")) not in TOOL_SCHEMAS]
    _strip_supervision_text(request)
    return request

def _protection_only_rewrite(
    state: PluginState,
    scope: Scope,
    api_mode: str,
    request: dict[str, Any],
    hidden_items: list[Any],
    hidden_messages: set[str],
    hidden_scopes: list[Scope] | None = None,
) -> dict[str, Any]:
    if api_mode not in SUPPORTED_API_MODES:
        return {
            "request": copy.deepcopy(request),
            "source": SOURCE,
            "reason": UNSUPPORTED_API_MODE,
        }
    request_out = copy.deepcopy(request)
    applied: list[str] = []
    if hidden_items:
        found, _skipped, _err = find_tool_results(api_mode, request_out)
        invocations, duplicate_ids = _extract_invocations_and_duplicates(api_mode, request_out)
        positions: dict[str, int] = {}
        observed_entries: list[tuple[str, int, str, dict[str, Any], ToolResultRecord | None]] = []
        for entry in found:
            pos = positions.get(entry.call_id, 0)
            positions[entry.call_id] = pos + 1
            entry_sha = hashlib.sha256(entry.content.encode("utf-8")).hexdigest()
            tool_name, raw_args, parse_error = invocations.get(entry.call_id, ("", {}, True))
            record: ToolResultRecord | None = None
            if entry.call_id not in duplicate_ids and not parse_error and tool_name:
                try:
                    invocation, omitted = filter_invocation(tool_name, raw_args)
                except AdapterRejected:
                    invocation = None
                else:
                    record = ToolResultRecord(
                        call_id=entry.call_id,
                        result_position=pos,
                        content=entry.content,
                        content_sha256=entry_sha,
                        invocation=invocation,
                        invocation_digest=compute_invocation_digest(
                            invocation, omitted if omitted else None
                        ),
                        status="ok",
                        host_handle=entry.host_handle,
                    )
            observed_entries.append(
                (entry.call_id, pos, entry_sha, entry.host_handle, record)
            )
        plan_dicts = _resolve_plan_dicts(
            state.engine,
            scope,
            observed_entries,
            extra_items=hidden_items,
        )
        request_out, applied, _ = apply_replacements(api_mode, request_out, plan_dicts)
    if hidden_messages:
        request_out = drop_messages(api_mode, request_out, hidden_messages)
    # Protection-only dynamic-disable: the startup-registered section stays in
    # the host prompt, so strip our own guidance from the outgoing copy. The
    # model is no longer told to call tools that now answer `disabled`.
    _strip_supervision_text(request_out)
    return {
        "request": request_out,
        "source": SOURCE,
        "reason": f"protection_only (applied {len(applied)})",
    }


def make_middleware(state: PluginState) -> Callable[..., dict[str, Any] | None]:
    """Build the `llm_request` middleware callback for this registration."""

    def on_llm_request(**kwargs: Any) -> dict[str, Any] | None:
        try:
            if not _is_effectively_enabled(state):
                scope = scope_for(state, kwargs.get("session_id", ""))
                try:
                    registration, hidden_items, hidden_messages, hidden_scopes = _load_protection_state(state, scope)
                except Exception as exc:
                    # Reads failed: protection cannot see what is hidden, so
                    # fail loudly (pending flag + raise) instead of blind.
                    logger.error(
                        "session-navigation middleware cannot load hidden state: %s",
                        type(exc).__name__,
                    )
                    state.db_error_pending = True
                    raise
                request = kwargs.get("request")
                child = bool(
                    scope is not None
                    and (state.child_links.get(scope.session_id) or (registration and registration.get("parent_scope")))
                )
                if child and isinstance(request, dict):
                    request = _child_request(request)
                if scope is not None and isinstance(request, dict) and (hidden_items or hidden_messages):
                    api_mode = kwargs.get("api_mode", "")
                    try:
                        rewritten = _protection_only_rewrite(
                            state,
                            scope,
                            api_mode if isinstance(api_mode, str) else "",
                            request,
                            hidden_items,
                            hidden_messages,
                            hidden_scopes=hidden_scopes,
                        )
                    except Exception as exc:
                        logger.error(
                            "session-navigation middleware protection rewrite failed: %s",
                            type(exc).__name__,
                        )
                        state.db_error_pending = True
                        raise
                    # Registration is bookkeeping: a write failure (read-only,
                    # locked, disk-full) must not skip the rewrite above.
                    if registration is not None or hidden_items or hidden_messages:
                        _guarded_register(state, scope, False)
                    return rewritten
                if scope is not None and (registration is not None or hidden_items or hidden_messages):
                    _guarded_register(state, scope, False)
                if (
                    scope is not None
                    and not child
                    and isinstance(request, dict)
                ):
                    stripped = copy.deepcopy(request)
                    if _strip_supervision_text(stripped):
                        return {"request": stripped, "source": SOURCE,
                                "reason": "protection_only (supervision disabled)"}
                if child and isinstance(request, dict):
                    return {"request": request, "source": SOURCE}
                return None
            request = kwargs.get("request")
            if not isinstance(request, dict):
                return None
            scope = scope_for(state, kwargs.get("session_id", ""))
            if scope is None:
                return {
                    "request": copy.deepcopy(request),
                    "source": SOURCE,
                    "reason": "missing_session",
                }
            api_mode = kwargs.get("api_mode", "")
            if not isinstance(api_mode, str):
                api_mode = ""
            registration = state.engine.store.adapter_session(scope)
            child = bool(state.child_links.get(scope.session_id) or (registration and registration.get("parent_scope")))
            if child:
                request = _child_request(request)
            state.usage.record_messages(scope.session_id, message_keys(api_mode, request))
            other_middlewares = state.count_middlewares()
            supported = api_mode in SUPPORTED_API_MODES
            # Registration is bookkeeping: guard its write so a read-only,
            # locked, or full database cannot skip the rewrite below.
            _guarded_register(state, scope, supported)
            try:
                step = _engine_step(state.engine, state.store, scope, api_mode, request,
                                   publish_targets=supported, summarizer=state.summarizer)
            except Exception as exc:
                # Fail closed: the host sends the original request when
                # middleware raises, so fall back to a protection-only rewrite
                # from reads (which still work on read-only databases) instead.
                logger.error(
                    "session-navigation middleware step failed (%s); using protection-only fallback",
                    type(exc).__name__,
                )
                state.db_error_pending = True
                return _protection_only_fallback(state, scope, api_mode, request)
            if other_middlewares > 0 and isinstance(step.get("trace"), dict):
                step["trace"]["other_middlewares"] = other_middlewares
            applied = step["applied"]
            skipped = step["skipped"]
            reason = step["trace"].get("reason", "")
            if reason == "db_error" or any(
                    (isinstance(x, dict) and x.get("reason") == "db_error") for x in (skipped or [])):
                # D9: the host swallows middleware exceptions and proceeds with the
                # original (fail-open by host contract). There is no abort hook, so
                # the request cannot be stopped here. Record the failure LOUDLY:
                # error log + pending flag surfaced in list output + trace reason.
                # Model-request fail-open (original preserved) is separate from
                # persistence-failure reporting per spec D9.
                logger.error("session-navigation DB error during middleware: persistence failed, request proceeds with originals")
                state.db_error_pending = True
                return {
                    "request": copy.deepcopy(request),
                    "source": SOURCE,
                    "reason": "db_error_persistence_failed_request_fail_open",
                    "pending": True,
                }
            if not reason:
                reason = f"applied {len(applied)}, skipped {len(skipped)}"
            logger.debug(
                "session-navigation middleware: %s (found %s, other_middlewares=%s)",
                reason, step["trace"].get("found", 0), other_middlewares)
            request_out = step["request"]
            if isinstance(request_out, dict):
                found = message_keys(api_mode, request_out)
                store = state.engine.store
                try:
                    store.ensure_message_units(scope, [
                        (key, role, hashlib.sha256(text.encode("utf-8")).hexdigest(), len(text))
                        for key, role, _index, text in found])
                except Exception as exc:
                    # Message-unit bookkeeping must not lose the rewrite above.
                    logger.warning(
                        "session-navigation message-unit write failed (%s); continuing with rewritten request",
                        type(exc).__name__,
                    )
                    state.db_error_pending = True
                hidden: set[str] = set()
                for cand in _scope_candidates(scope):
                    hidden.update(store.hidden_message_keys(cand))
                if hidden:
                    request_out = drop_messages(api_mode, request_out, hidden)
                users = [(index, text) for _key, role, index, text in message_keys(api_mode, request) if role == "user"]
                if users and not child:
                    try:
                        entries = state.store.entries(scope.scope_key())
                    except Exception as exc:
                        # Reminder hints are enrichment only; never fail the turn.
                        logger.warning(
                            "session-navigation transcript read failed (%s); skipping reminder note",
                            type(exc).__name__,
                        )
                        state.db_error_pending = True
                        entries = []
                    candidates = []
                    for entry in reversed(entries):
                        if _cleanup_error(state, scope, entry) is not None:
                            continue
                        index = entry.host_handle.get("index", -1)
                        candidates.append({"tool_call_id": entry.call_id, "tool_name": entry.tool_name,
                                           "hint": entry.raw_arguments.get("command") or entry.raw_arguments.get("path") or "",
                                           "bytes_size": len(entry.content.encode()),
                                           "turn": sum(i <= index for i, _text in users)})
                    mutation_names = ("manage_context", "hide_context", "summarize_context", "unhide_context")
                    after_tool = False
                    seq_len: int | None = None
                    if api_mode == "chat_completions" and isinstance(request_out.get("messages"), list):
                        seq = request_out["messages"]
                        seq_len = len(seq)
                        mut_ids: set[str] = set()
                        for m in seq:
                            if isinstance(m, dict) and isinstance(m.get("tool_calls"), list):
                                for tc in m["tool_calls"]:
                                    fn = tc.get("function") if isinstance(tc, dict) else None
                                    if not isinstance(fn, dict):
                                        continue
                                    fname = str(fn.get("name") or "")
                                    fargs = str(fn.get("arguments") or "")
                                    if fname in mutation_names or (fname == "tool_call" and any(n in fargs for n in mutation_names)):
                                        if isinstance(tc.get("id"), str):
                                            mut_ids.add(tc["id"])
                        for m in reversed(seq):
                            if not isinstance(m, dict) or m.get("role") != "tool":
                                break
                            if m.get("tool_call_id") in mut_ids:
                                after_tool = False
                                break
                            after_tool = True
                    elif isinstance(request_out.get("input"), list):
                        seq = request_out["input"]
                        seq_len = len(seq)
                        mut_ids = set()
                        for item in seq:
                            if isinstance(item, dict) and item.get("type") == "function_call":
                                fname = str(item.get("name") or "")
                                fargs = str(item.get("arguments") or "")
                                if fname in mutation_names or (fname == "tool_call" and any(n in fargs for n in mutation_names)):
                                    if isinstance(item.get("call_id"), str):
                                        mut_ids.add(item["call_id"])
                        for item in reversed(seq):
                            if not isinstance(item, dict) or item.get("type") != "function_call_output":
                                break
                            if item.get("call_id") in mut_ids:
                                after_tool = False
                                break
                            after_tool = True
                    turn = f"{len(users)}:{hashlib.sha256(users[-1][1].encode()).hexdigest()}"
                    note = state.reminders.note(scope.scope_key(), turn,
                        estimate_tokens(json.dumps(request_out, ensure_ascii=False)),
                        kwargs.get("context_length") or state.usage.context_window(scope.session_id), candidates,
                        after_tool=after_tool, step_key=seq_len)
                    if note:
                        request_out = copy.deepcopy(request_out)
                        if api_mode == "chat_completions":
                            request_out["messages"].append({"role": "user", "content": note})
                        elif isinstance(request_out.get("input"), list):
                            request_out["input"].append({"role": "user", "content": [{"type": "input_text", "text": note}]})
                if not child and _can_add_supervision(request_out, api_mode, kwargs.get("turn_id")):
                    request_out = _ensure_supervision_text(request_out, api_mode)
            return {
                "request": request_out,
                "source": SOURCE,
                "reason": reason,
            }
        except Exception as exc:
            logger.error("session-navigation middleware DB error: %s", type(exc).__name__)
            try:
                state.db_error_pending = True
            except Exception:
                pass
            raise
    return on_llm_request


def _register_adapter(state: PluginState, scope: Scope, projecting: bool) -> None:
    register_fn = getattr(state.engine.store, "register_adapter", None)
    if not callable(register_fn):
        return
    register_fn(
        scope,
        adapter_id=ADAPTER_ID,
        instance_id=state.instance_id,
        capabilities={
            "hide": projecting,
            "summarize": projecting and state.summarizer is not None,
            "unhide": projecting,
            "protection_only": True,
            "bundle_fingerprint": RUNTIME_BUNDLE_FINGERPRINT,
        },
        enabled=projecting,
        **state.child_links.get(scope.session_id, {}),
    )


def _guarded_register(state: PluginState, scope: Scope, projecting: bool) -> bool:
    """Best-effort adapter registration: bookkeeping must never break protection.

    Returns True when the registration write landed. On failure (read-only,
    locked, or full database) the error is logged and surfaced via
    `db_error_pending` -- which the list handler reports with
    abort/send-original choices -- instead of raising into the host, where it
    would make the host send the original request unprotected.
    """
    try:
        _register_adapter(state, scope, projecting)
    except Exception as exc:
        logger.warning(
            "session-navigation registration write failed (%s); protection continues",
            type(exc).__name__,
        )
        try:
            state.db_error_pending = True
        except Exception:
            pass
        return False
    return True


def _load_protection_state(
    state: PluginState, scope: Scope | None
) -> tuple[Any, list[Any], set[str], list[Scope]]:
    """Read-only snapshot of hidden items/messages for fail-closed rewrites.

    Reads only, so it stays usable on read-only databases. Raises on read
    failure so the caller fails loudly instead of protecting blind.
    """
    registration = state.engine.store.adapter_session(scope) if scope is not None else None
    candidates = _scope_candidates(scope) if scope is not None else []
    hidden_items: list[Any] = []
    hidden_scopes: list[Scope] = []
    seen_item_ids: set[str] = set()
    hidden_messages: set[str] = set()
    for cand in candidates:
        cand_items = [item for item in state.engine.store.items(cand) if item.visibility == "hidden"]
        if cand_items:
            hidden_scopes.append(cand)
            for item in cand_items:
                if item.item_id not in seen_item_ids:
                    seen_item_ids.add(item.item_id)
                    hidden_items.append(item)
        hidden_messages.update(state.engine.store.hidden_message_keys(cand))
    return registration, hidden_items, hidden_messages, hidden_scopes


def _protection_only_fallback(
    state: PluginState, scope: Scope, api_mode: str, request: dict[str, Any]
) -> dict[str, Any]:
    """Fail-closed fallback when a registration/step write fails.

    The host sends the original request when middleware raises, so raising
    here would leak hidden content. Recompute the protection-only rewrite from
    reads instead (which still work on read-only databases). Only when nothing
    is hidden is the original request returned, flagged pending so the list
    handler surfaces the persistence failure loudly.
    """
    _registration, hidden_items, hidden_messages, hidden_scopes = _load_protection_state(state, scope)
    if isinstance(request, dict) and (hidden_items or hidden_messages):
        rewritten = _protection_only_rewrite(
            state,
            scope,
            api_mode if isinstance(api_mode, str) else "",
            request,
            hidden_items,
            hidden_messages,
            hidden_scopes=hidden_scopes,
        )
        rewritten["pending"] = True
        return rewritten
    return {
        "request": copy.deepcopy(request),
        "source": SOURCE,
        "reason": "db_error_persistence_failed_request_fail_open",
        "pending": True,
    }


def _refresh_registration(state: PluginState, scope: Scope) -> bool:
    """Recompute stored capabilities when effectively enabled but the row is stale.

    A paused turn overwrites the registration with `projecting=False`; without
    a refresh the row keeps capabilities False after resume until the next
    registering turn, so capability reads (`adapter_can`) stay wrong with no
    warning. Refresh once on resume so the next tool/list use heals the row
    instead of waiting for a full middleware turn. No-op (no write) when
    already fresh or while paused.
    """
    if not _is_effectively_enabled(state):
        return False
    try:
        row = state.engine.store.adapter_session(scope)
    except Exception:
        return False
    caps = row.get("capabilities") if isinstance(row, dict) else None
    if not isinstance(caps, dict):
        caps = {}
    stale = (
        not isinstance(row, dict)
        or not row.get("enabled")
        or caps.get("hide") is not True
        or caps.get("unhide") is not True
        or (state.summarizer is not None and caps.get("summarize") is not True)
    )
    if not stale:
        return False
    return _guarded_register(state, scope, True)
