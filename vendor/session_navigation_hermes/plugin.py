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

import copy
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from .handlers import compact as _engine_compact
from .handlers import middleware_step as _engine_step
from .handlers import list_records as _engine_list
from .handlers import restore as _engine_restore
from .presentation import PresentationRegistry, decorate_items
from .session import SessionTranscriptStore
from session_navigation.model import Scope
from session_navigation.engine import SessionNavigationEngine
from session_navigation.transport import Summarizer, SummarizerError

logger = logging.getLogger(__name__)

from .factories import (
    PluginState,
    _default_count_llm_middlewares,
    _dump,
    make_hide_handler,
    make_list_handler,
    make_manage_handler,
    make_middleware,
    make_summarize_handler,
    make_unhide_handler,
    scope_for,
)
from .llm import CtxLlmSummarizer
from .schemas import (
    ADAPTER_ID,
    BRANCH_SCOPE,
    BRIDGE_COLLISION_TOOLS,
    HIDE_TOOL,
    LIST_TOOL,
    MANAGE_TOOL,
    SUMMARIZE_TOOL,
    SUPERVISION_SECTION_ID,
    SUPERVISION_SECTION_MAX_CHARS,
    SUPERVISION_SECTION_TEXT,
    TOOL_SCHEMAS,
    TOOLSET,
    UNHIDE_TOOL,
    bridge_should_yield,
    SOURCE,
)

def register(ctx: Any) -> PluginState:
    """Hermes plugin entry point: register tools + 1 middleware.

    The plugin starts disabled: tools report `disabled` and the
    middleware returns `None` (no recording, no rewriting) until the
    operator sets `plugins.entries.<plugin_id>.settings.enabled: true`.
    """
    try:
        profile = getattr(ctx, "profile_name", "default") or "default"
    except Exception:
        profile = "default"

    def _is_enabled() -> bool:
        try:
            get_config = getattr(ctx, "get_config", None)
            if not callable(get_config):
                return False
            return bool(get_config("enabled", False))
        except Exception:
            return False

    state = PluginState(
        profile=profile,
        is_enabled=_is_enabled,
        summarizer=None,
    )
    llm = getattr(ctx, "llm", None)
    if llm is not None:
        state.summarizer = CtxLlmSummarizer(ctx, store=state.store)
    ctx.register_tool(
        name=HIDE_TOOL,
        toolset=TOOLSET,
        schema=TOOL_SCHEMAS[HIDE_TOOL],
        handler=make_hide_handler(state),
        description=TOOL_SCHEMAS[HIDE_TOOL]["description"],
    )
    ctx.register_tool(
        name=SUMMARIZE_TOOL,
        toolset=TOOLSET,
        schema=TOOL_SCHEMAS[SUMMARIZE_TOOL],
        handler=make_summarize_handler(state),
        description=TOOL_SCHEMAS[SUMMARIZE_TOOL]["description"],
    )
    ctx.register_tool(
        name=LIST_TOOL,
        toolset=TOOLSET,
        schema=TOOL_SCHEMAS[LIST_TOOL],
        handler=make_list_handler(state),
        description=TOOL_SCHEMAS[LIST_TOOL]["description"],
    )
    ctx.register_tool(
        name=UNHIDE_TOOL,
        toolset=TOOLSET,
        schema=TOOL_SCHEMAS[UNHIDE_TOOL],
        handler=make_unhide_handler(state),
        description=TOOL_SCHEMAS[UNHIDE_TOOL]["description"],
    )
    ctx.register_tool(
        name=MANAGE_TOOL,
        toolset=TOOLSET,
        schema=TOOL_SCHEMAS[MANAGE_TOOL],
        handler=make_manage_handler(state),
        description=TOOL_SCHEMAS[MANAGE_TOOL]["description"],
    )
    ctx.register_middleware("llm_request", make_middleware(state))

    # Optional host capability: freeze the human-supervision protocol into
    # each new session prompt. Absent API, disabled plugin, or a duplicate
    # registration must never block tool/middleware registration.
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if callable(register_section) and state.is_enabled():
        try:
            register_section(
                SUPERVISION_SECTION_ID,
                SUPERVISION_SECTION_TEXT,
                position="after_memory",
                max_chars=SUPERVISION_SECTION_MAX_CHARS,
            )
        except Exception:
            logger.debug("session-navigation: system prompt section unavailable")
    try:
        from . import command as _nav_command

        _nav_command.register(ctx, state)
    except Exception:
        logger.debug("session-navigation: /nav command registration unavailable")
    logger.debug("session-navigation plugin registered (profile=%s)", profile)
    return state
