"""Reference Hermes plugin wiring for context-hide (S4, M2-3).

This is the host-process shim between Hermes and the pure helpers
(`payload`, `session`, `handlers`). It owns everything host-specific:

- tool registration (`hide_context`, `list_context_items`, `unhide_context`)
- the `llm_request` middleware (record -> plan -> apply on a copy)
- scope derivation from host identifiers (never model arguments)
- enabled-off default, coexistence record-only mode, fail-open errors

It owns nothing engine-specific: summarization, protection rules,
storage, and visibility stay in `context_hide`. The engine never
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

- Summarization is rule-only by default: the plugin creates the engine
  without an external summarizer, so no model call, no credentials,
  and no extra cost happen unless an operator explicitly wires one.
  When an LFM summarizer is added later it must be a separate local
  call, never the main-model path (`ctx.llm`), to keep usage, auth,
  and trust boundaries apart and keep fail-open simple.
- `branch_scope` is `"unknown"`: Hermes exposes no exact branch API
  to the plugin, so no full fork isolation is claimed. A compression
  rotation issues a new `session_id`, which naturally starts a fresh
  scope: hidden state never carries over silently.
- `transform_tool_result` is NOT used: stored conversation history is
  never rewritten, only the outgoing request copy.
- Logs carry counts, item IDs, and error codes only, never result
  bodies or commands.
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from .handlers import hide as _engine_hide
from .handlers import middleware_step as _engine_step
from .handlers import list_records as _engine_list
from .handlers import unhide as _engine_unhide
from .presentation import PresentationRegistry, decorate_items
from .session import SessionTranscriptStore
from context_hide.model import Scope
from context_hide.engine import ContextHideEngine
from context_hide.openai_compatible import OpenAICompatibleTransport
from context_hide.summary import ModelSummarizer, SummarizerConfig
from context_hide.transport import Summarizer, SummarizerError
from .schemas import ADAPTER_ID, BRANCH_SCOPE, SOURCE
logger = logging.getLogger(__name__)

def _default_count_llm_middlewares() -> int:
    """Count the OTHER registered `llm_request` middleware callbacks.

    Verified on 2026-10-11 against the installed runtime
    (``hermes_cli.middleware.apply_llm_request_middleware`` plus
    ``PluginManager.invoke_middleware``): the request chain COMPOSES in
    registration order -- each callback receives the previous callback's
    payload, and the last dict returned under ``request`` is what the provider
    sees. So a later middleware can overwrite our replacement and we can
    overwrite theirs; the chain does not by itself guarantee a single hide
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

    engine: ContextHideEngine = field(default_factory=ContextHideEngine)
    summarizer: Summarizer | None = None
    store: SessionTranscriptStore = field(default_factory=SessionTranscriptStore)
    presentations: PresentationRegistry = field(default_factory=PresentationRegistry)
    profile: str = "default"
    is_enabled: Callable[[], bool] = field(default=lambda: False)
    count_middlewares: Callable[[], int] = field(
        default=_default_count_llm_middlewares)


def _make_configured_summarizer(ctx: Any) -> Summarizer | None:
    """Create only an explicitly configured local model summarizer."""
    get_config = getattr(ctx, "get_config", None)
    if not callable(get_config):
        return None

    def setting(name: str, default: Any) -> Any:
        try:
            return get_config(name, default)
        except Exception:
            return default

    mode = setting("summary_mode", "rules")
    if mode == "rules":
        return None
    if mode != "llm":
        logger.warning("context-hide summarizer disabled error_code=invalid_mode")
        return None

    base_url = setting("base_url", "")
    model = setting("model", "")
    timeout_seconds = setting("timeout_seconds", 60)
    max_input_bytes = setting("max_input_bytes", 12_288)
    max_output_tokens = setting("max_output_tokens", 384)
    if not isinstance(base_url, str) or not base_url.strip() or not isinstance(model, str) or not model.strip():
        logger.warning("context-hide summarizer disabled error_code=invalid_configuration")
        return None
    for value in (timeout_seconds, max_input_bytes, max_output_tokens):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            logger.warning("context-hide summarizer disabled error_code=invalid_configuration")
            return None

    try:
        transport = OpenAICompatibleTransport(base_url)
    except SummarizerError as exc:
        logger.warning(
            "context-hide summarizer disabled error_code=%s", exc.reason)
        return None
    return ModelSummarizer(
        generate=transport.generate,
        config=SummarizerConfig(
            model=model,
            timeout_seconds=timeout_seconds,
            max_input_bytes=max_input_bytes,
            max_output_tokens=max_output_tokens,
        ),
    )

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


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


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
        result = _engine_hide(
            state.engine, state.store, scope, target.strip(),
            summarizer=state.summarizer,
        )
        if not result.ok or result.plan is None:
            return _dump({"ok": False, "error": result.error or "not_found"})
        original_bytes = 0
        if result.item is not None:
            original_bytes = len(result.item.original.encode("utf-8"))
        state.presentations.record_hidden(
            scope.scope_key(), result.plan.item_id, original_bytes)
        return _dump({
            "ok": True,
            "item_id": result.plan.item_id,
            "visibility_version": result.plan.visibility_version,
        })

    return hide_context

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
        result = _engine_summarize(
            state.engine, state.store, scope, target.strip(), state.summarizer)
        if not result.ok or result.plan is None:
            return _dump({"ok": False, "error": result.error or "not_found"})
        original_bytes = 0
        if result.item is not None:
            original_bytes = len(result.item.original.encode("utf-8"))
        state.presentations.record_hidden(
            scope.scope_key(), result.plan.item_id, original_bytes)
        return _dump({
            "ok": True,
            "item_id": result.plan.item_id,
            "visibility_version": result.plan.visibility_version,
            "compaction_source": "llm",
        })

    return summarize_context


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
        hidden_count = sum(item["visibility"] == "compacted" for item in items)
        prefix = "검색 조건에 맞는" if query else "현재"
        message = f"{prefix} 숨겨진 항목 {hidden_count}건" if hidden_count else f"{prefix} 숨겨진 항목 없음"
        return _dump({
            "ok": True, "count": len(items), "items": items,
            "hidden_count": hidden_count, "message": message,
        })

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
        result = _engine_unhide(state.engine, scope, resolved or "")
        if not result.ok or result.item is None:
            return _dump({"ok": False, "error": result.error or "not_found"})
        state.presentations.mark_visible(scope.scope_key(), result.item.item_id)
        return _dump({
            "ok": True,
            "item_id": result.item.item_id,
            "visibility_version": result.item.version,
        })

    return unhide_context


def make_middleware(state: PluginState) -> Callable[..., dict[str, Any] | None]:
    """Build the `llm_request` middleware callback for this registration."""

    def on_llm_request(**kwargs: Any) -> dict[str, Any] | None:
        try:
            if not state.is_enabled():
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
            if state.count_middlewares() > 0:
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
                    "context-hide coexistence: recorded %d results, skipped %d, "
                    "request unchanged", len(stored), len(skipped))
                return {
                    "request": copy.deepcopy(request),
                    "source": SOURCE,
                    "reason": "other_middleware_present",
                }
            step = _engine_step(state.engine, state.store, scope, api_mode, request)
            applied = step["applied"]
            skipped = step["skipped"]
            reason = step["trace"].get("reason", "")
            if not reason:
                reason = f"applied {len(applied)}, skipped {len(skipped)}"
            logger.debug(
                "context-hide middleware: %s (found %s)",
                reason, step["trace"].get("found", 0))
            return {
                "request": step["request"],
                "source": SOURCE,
                "reason": reason,
            }
        except Exception as exc:
            # Fail open: Hermes logs and continues with the original request.
            logger.warning(
                "context-hide middleware fail-open: %s", type(exc).__name__)
    return on_llm_request


