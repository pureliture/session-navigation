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

SOURCE = "session-navigation-hermes"
ADAPTER_ID = "hermes"
TOOLSET = "session_navigation"

#: Scope branch marker: no exact branch API exists, so fork isolation
#: beyond the session is not claimed.
BRANCH_SCOPE = "unknown"

#: Must mirror the bridge's `INTERNAL_TOOL_NAMES`
#: (`openai_compatible_bridge/context_compaction.py`): when any of these
#: names appears in the request tool list, the bridge disables its own
#: compaction (`tool_name_collision`) so exactly one compact owner remains.
BRIDGE_COLLISION_TOOLS = frozenset(
    {"hide_context", "summarize_context", "list_context_items", "unhide_context", "manage_context"}
)

HIDE_TOOL = "hide_context"
LIST_TOOL = "list_context_items"
UNHIDE_TOOL = "unhide_context"
SUMMARIZE_TOOL = "summarize_context"
MANAGE_TOOL = "manage_context"
#: Static system-prompt guidance for the human supervision protocol. It is
#: fixed text (never per-session state) rendered once per new session; when
#: the host lacks the section API or the plugin loads disabled, only the
#: tool descriptions carry the protocol.
SUPERVISION_SECTION_ID = "session-navigation.human-supervision"
SUPERVISION_SECTION_MAX_CHARS = 1200
SUPERVISION_SECTION_TEXT = (
    "Finish each work unit and answer first. Then, if useful, batch cleanup in one call. "
    "After cleanup, the final message must restate the complete answer with all requested facts/values; never say 'reported above' or 'see above'. "
    "You decide when/what/how: hide unneeded results (rules), summarize facts still needed (session LLM); "
    "auto prefers summary with rule fallback. Prefer literal IDs already shown in context notes; use "
    "list_context_items(view=candidates) only when needed, and avoid re-verifying unchanged files. "
    "Display limits never restrict targets. "
    "Deferred tools: exact names via tool_describe, then tool_call. Originals remain restorable. "
    "For user list/restore requests, show numbered hidden items with tool, size, time and summary; numbers belong to that list. "
    "Bind N to its shown item_id BEFORE refreshing; unhide_context that same ID and verify visible. "
    "Ask on ambiguous references; never pick the first item. Restore-all fixes the unfiltered hidden ID set first, "
    "then verifies and reports successes/failures/remaining. State persists; do not infer restart causes."
)

TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    HIDE_TOOL: {
        "name": HIDE_TOOL,
        "description": (
            "Hide one tool result with rule excerpts; no LLM. Originals remain restorable."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tool_call_id": {
                    "type": "string",
                    "description": "The tool call ID whose result body should be hidden.",
                }
            },
            "required": ["tool_call_id"],
            "additionalProperties": False,
        },
    },
    LIST_TOOL: {
        "name": LIST_TOOL,
        "description": (
            "Discover visible cleanup IDs with view=candidates; limit is display-only (default 30). "
            "For a user list request, display hidden items as a numbered table with tool, size, time and summary."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional filter over item IDs and summaries.",
                },
                "view": {"type": "string", "enum": ["items", "candidates"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "required": [],
            "additionalProperties": False,
        },
    },
    UNHIDE_TOOL: {
        "name": UNHIDE_TOOL,
        "description": (
            "Restore original by item_id without re-execution. For item N, bind the displayed item_id before refreshing, "
            "confirm it against the list immediately before restore, restore that same ID, and verify it is visible. "
            "Ask about ambiguous references; never guess. Report missing or stale IDs without substitution."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "item_id": {
                    "type": "string",
                    "description": "The hidden item ID to unhide.",
                },
                "expected_version": {
                    "type": "integer",
                    "description": "CAS guard from the listed row version; stale replays are rejected.",
                },
            },
            "required": ["item_id"],
            "additionalProperties": False,
        },
    },
    SUMMARIZE_TOOL: {
        "name": SUMMARIZE_TOOL,
        "description": (
            "Summarize one tool result using the session LLM; no rule fallback."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tool_call_id": {
                    "type": "string",
                    "description": "The tool call ID whose result body should be summarized.",
                }
            },
            "required": ["tool_call_id"],
            "additionalProperties": False,
        },
    },
    MANAGE_TOOL: {
        "name": MANAGE_TOOL,
        "description": (
            "Clean agent-chosen tool_call_ids. hide=rules; summarize=session LLM; auto=summary with rule fallback. "
            "Any eligible ID accepted; returns per-item outcomes. keep_lines: exact single-line substrings to retain (hide only, total 1024 bytes)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tool_call_ids": {
                    "type": "array",
                    "minItems": 1,
                    "items": {"type": "string"},
                    "description": "Agent-chosen tool call IDs from the completed work; no per-call count limit.",
                },
                "action": {
                    "type": "string",
                    "enum": ["auto", "hide", "summarize"],
                    "description": "hide uses rules only; summarize requires a configured model; auto prefers summarize with rule fallback.",
                },
                "keep_lines": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tool_call_ids"],
            "additionalProperties": False,
        },
    },
}


def bridge_should_yield(tool_names: Any) -> bool:
    """True when the bridge must stand down for this plugin session.

    Mirrors the bridge `tool_name_collision` rule: any overlap between
    the request tool list and `BRIDGE_COLLISION_TOOLS` disables bridge
    compaction so compacting has exactly one owner.
    """
    if isinstance(tool_names, dict):
        names = set(tool_names)
    else:
        try:
            names = set(tool_names or [])
        except TypeError:
            return False
    return bool(BRIDGE_COLLISION_TOOLS & {str(name) for name in names})
