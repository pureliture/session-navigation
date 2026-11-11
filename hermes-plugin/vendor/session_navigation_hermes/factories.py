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
from .handlers import restore as _engine_restore
from .handlers import summarize as _engine_summarize
from .payload import SUPPORTED_API_MODES, drop_messages, message_keys
from .presentation import PresentationRegistry, decorate_items
from .session import SessionTranscriptStore
from .usage import UsageTracker, estimate_tokens
from session_navigation.model import Scope, ToolResultRecord, compute_invocation_digest, _item_id
from session_navigation.policy import refusal_reason, is_destructive_command
from session_navigation.reminders import BoundaryReminders
from .allowlist import AdapterRejected, filter_invocation
from session_navigation.engine import SessionNavigationEngine
from session_navigation.transport import Summarizer, SummarizerError
from .llm import CtxLlmSummarizer
from .schemas import ADAPTER_ID, BRANCH_SCOPE, SOURCE, TOOL_SCHEMAS, SUPERVISION_SECTION_TEXT
logger = logging.getLogger(__name__)

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
    if state.is_enabled():
        _register_adapter(state, child, True)


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
        before = savings(scope) if scope is not None and state.is_enabled() else None
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
        if not state.is_enabled():
            return _dump({"ok": False, "error": "disabled"})
        target = args.get("tool_call_id") if isinstance(args, dict) else None
        if not isinstance(target, str) or not target.strip():
            return _dump({"ok": False, "error": "missing_tool_call_id"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        # hide_context is rule-based only: never pass the configured summarizer.
        result = _engine_compact(
            state.engine, state.store, scope, target.strip(),
        )
        if not result.ok or result.plan is None:
            err = result.error or "not_found"
            if err == "db_error":
                return _dump({"ok": False, "error": err, "choices": ["abort_request", "send_original"]})
            return _dump({"ok": False, "error": err})
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
        if not state.is_enabled():
            return _dump({"ok": False, "error": "disabled"})
        if state.summarizer is None:
            return _dump({"ok": False, "error": "summarizer_unavailable"})
        target = args.get("tool_call_id") if isinstance(args, dict) else None
        if not isinstance(target, str) or not target.strip():
            return _dump({"ok": False, "error": "missing_tool_call_id"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        if state.summarizer is not None and hasattr(state.summarizer, "current_scope_key"):
            state.summarizer.current_scope_key = scope.scope_key()
        result = _engine_summarize(
            state.engine, state.store, scope, target.strip(), state.summarizer)
        if not result.ok or result.plan is None:
            err = result.error or "not_found"
            if err == "db_error":
                return _dump({"ok": False, "error": err, "choices": ["abort_request", "send_original"]})
            return _dump({"ok": False, "error": err})
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
        if not state.is_enabled():
            return _dump({"ok": False, "error": "disabled"})
        query = ""
        if isinstance(args, dict) and isinstance(args.get("query"), str):
            query = args["query"]
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
        if isinstance(args, dict) and args.get("view") == "candidates":
            limit = args.get("limit", 30)
            if type(limit) is not int or not 1 <= limit <= 200:
                return _dump({"ok": False, "error": "invalid_limit"})
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
        items = _engine_list(state.engine, scope, query)
        scope_key = scope.scope_key()
        live_ids = {
            item.item_id for item in state.engine.store.items(scope)
        }
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
        if state.db_error_pending:
            payload["db_error_pending"] = True
            payload["db_error_choices"] = ["abort_request", "send_original"]
            state.db_error_pending = False
        return _dump(payload)

    return list_context_items


def make_unhide_handler(state: PluginState) -> Callable[..., str]:
    """Build the `unhide_context` tool handler bound to this registration."""

    def unhide_context(args: Any, session_id: str = "", **_extra: Any) -> str:
        if not state.is_enabled():
            return _dump({"ok": False, "error": "disabled"})
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
    diagnostics = {}
    if result.keep_lines_ignored:
        diagnostics["keep_lines_ignored"] = list(result.keep_lines_ignored)
    if result.keep_lines_normalized:
        diagnostics["keep_lines_normalized"] = list(result.keep_lines_normalized)
    if not result.ok or result.plan is None:
        return False, result.error or "not_found", None, diagnostics
    state.presentations.record_compacted(
        scope.scope_key(), result.plan.item_id, len(record.content.encode("utf-8")))
    return True, None, result.plan.item_id, diagnostics


def _cleanup_error(state: PluginState, scope: Scope, entry: Any) -> str | None:
    if len(state.store.lookup(scope.scope_key(), entry.call_id)) != 1:
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
        if not state.is_enabled():
            return _dump({"ok": False, "error": "disabled"})
        scope = scope_for(state, session_id)
        if scope is None:
            return _dump({"ok": False, "error": "not_found"})
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
        if keep_lines is not None and action != "hide":
            return _dump({"ok": False, "error": "invalid_keep_lines_action"})
        if action == "summarize" and state.summarizer is None:
            return _dump({"ok": False, "error": "summarizer_unavailable"})
        results: list[dict[str, Any]] = []
        for call_id in dict.fromkeys(want):
            matches = state.store.lookup(scope.scope_key(), call_id)
            error = _cleanup_error(state, scope, matches[0]) if matches else "not_found"
            if error is not None:
                results.append({"tool_call_id": call_id, "ok": False, "error": error})
                continue
            entry = matches[0]
            use_summarizer = action == "summarize" or (action == "auto" and state.summarizer is not None)
            item_id: str | None = None
            if use_summarizer:
                if state.summarizer is not None and hasattr(state.summarizer, "current_scope_key"):
                    state.summarizer.current_scope_key = scope.scope_key()
                outcome = _engine_summarize(
                    state.engine, state.store, scope, entry.call_id, state.summarizer)
                if outcome.ok and outcome.plan is not None:
                    item_id = outcome.plan.item_id
                    state.presentations.record_compacted(
                        scope.scope_key(), item_id, len(entry.content.encode("utf-8")))
                    results.append({"tool_call_id": entry.call_id, "ok": True, "item_id": item_id})
                    continue
                if action == "summarize":
                    results.append({"tool_call_id": entry.call_id, "ok": False, "error": outcome.error or "not_found"})
                    continue
            ok, error, item_id, diagnostics = _apply_hide_for_manage(state, scope, entry, keep_lines)
            row: dict[str, Any] = {"tool_call_id": entry.call_id, "ok": ok, **diagnostics}
            if ok:
                row["item_id"] = item_id
            else:
                row["error"] = error or "not_found"
            results.append(row)
        applied = sum(1 for r in results if r["ok"])
        failed = len(results) - applied
        return _dump({
            "ok": failed == 0,
            "applied": applied,
            "failed": failed,
            "items": results,
        })

    return _track_mutation(state, manage_context)


def _child_request(request: dict[str, Any]) -> dict[str, Any]:
    request = copy.deepcopy(request)
    if isinstance(request.get("tools"), list):
        request["tools"] = [tool for tool in request["tools"]
            if not isinstance(tool, dict) or
            (tool.get("function", {}).get("name") if isinstance(tool.get("function"), dict) else tool.get("name")) not in TOOL_SCHEMAS]
    if isinstance(request.get("instructions"), str):
        request["instructions"] = request["instructions"].replace(SUPERVISION_SECTION_TEXT, "")
    for key in ("messages", "input"):
        messages = request.get(key)
        if not isinstance(messages, list):
            continue
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("system", "developer"):
                continue
            content = message.get("content")
            if isinstance(content, str):
                message["content"] = content.replace(SUPERVISION_SECTION_TEXT, "")
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        block["text"] = block["text"].replace(SUPERVISION_SECTION_TEXT, "")
    return request


def make_middleware(state: PluginState) -> Callable[..., dict[str, Any] | None]:
    """Build the `llm_request` middleware callback for this registration."""

    def on_llm_request(**kwargs: Any) -> dict[str, Any] | None:
        try:
            if not state.is_enabled():
                scope = scope_for(state, kwargs.get("session_id", ""))
                registration = state.engine.store.adapter_session(scope) if scope is not None else None
                if registration is not None:
                    _register_adapter(state, scope, False)
                if scope is not None and (state.child_links.get(scope.session_id) or (registration and registration.get("parent_scope"))):
                    request = kwargs.get("request")
                    if isinstance(request, dict):
                        return {"request": _child_request(request), "source": SOURCE}
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
            if state.count_middlewares() > 0:
                _register_adapter(state, scope, False)
                # Another llm_request middleware is installed. The installed
                # chain composes rewrites in registration order, so OUR
                # replacement is not silently dropped -- but if we run first,
                # a later middleware can still overwrite it, and if we run
                # last we overwrite theirs. Report the situation instead of
                # pretending single ownership: keep recording (tools keep
                # working) but leave this request untouched.
                stored, skipped, _error = state.store.record_request(
                    scope.scope_key(), api_mode, request)
                logger.debug(
                    "session-navigation coexistence: recorded %d results, skipped %d, "
                    "request unchanged", len(stored), len(skipped))
                return {
                    "request": copy.deepcopy(request),
                    "source": SOURCE,
                    "reason": "other_middleware_present",
                }
            supported = api_mode in SUPPORTED_API_MODES
            _register_adapter(state, scope, supported)
            step = _engine_step(state.engine, state.store, scope, api_mode, request,
                               publish_targets=supported, summarizer=state.summarizer)
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
                "session-navigation middleware: %s (found %s)",
                reason, step["trace"].get("found", 0))
            request_out = step["request"]
            if isinstance(request_out, dict):
                found = message_keys(api_mode, request_out)
                store = state.engine.store
                store.ensure_message_units(scope, [
                    (key, role, hashlib.sha256(text.encode("utf-8")).hexdigest(), len(text))
                    for key, role, _index, text in found])
                hidden = set(store.hidden_message_keys(scope))
                if hidden:
                    request_out = drop_messages(api_mode, request_out, hidden)
                users = [(index, text) for _key, role, index, text in message_keys(api_mode, request) if role == "user"]
                if users and not child:
                    entries = state.store.entries(scope.scope_key())
                    candidates = []
                    for entry in reversed(entries):
                        if _cleanup_error(state, scope, entry) is not None:
                            continue
                        index = entry.host_handle.get("index", -1)
                        candidates.append({"tool_call_id": entry.call_id, "tool_name": entry.tool_name,
                                           "hint": entry.raw_arguments.get("command") or entry.raw_arguments.get("path") or "",
                                           "bytes_size": len(entry.content.encode()),
                                           "turn": sum(i <= index for i, _text in users)})
                    turn = f"{len(users)}:{hashlib.sha256(users[-1][1].encode()).hexdigest()}"
                    note = state.reminders.note(scope.scope_key(), turn,
                        estimate_tokens(json.dumps(request_out, ensure_ascii=False)),
                        kwargs.get("context_length") or state.usage.context_window(scope.session_id), candidates)
                    if note:
                        request_out = copy.deepcopy(request_out)
                        if api_mode == "chat_completions":
                            request_out["messages"].append({"role": "user", "content": note})
                        elif isinstance(request_out.get("input"), list):
                            request_out["input"].append({"role": "user", "content": [{"type": "input_text", "text": note}]})
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
    state.engine.store.register_adapter(scope, adapter_id=ADAPTER_ID, instance_id=state.instance_id,
        capabilities={"hide": projecting, "summarize": projecting and state.summarizer is not None,
                      "unhide": projecting}, enabled=projecting,
        **state.child_links.get(scope.session_id, {}))
