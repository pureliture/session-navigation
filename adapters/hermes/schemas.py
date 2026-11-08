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

- Summarization is rule-only by default: the plugin creates the engine
  without an external summarizer, so no model call, no credentials,
  and no extra cost happen unless an operator explicitly wires one.
  When an LFM summarizer is added later it must be a separate local
  call, never the main-model path (`ctx.llm`), to keep usage, auth,
  and trust boundaries apart and keep fail-open simple.
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
from session_navigation.openai_compatible import OpenAICompatibleTransport
from session_navigation.summary import ModelSummarizer, SummarizerConfig
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
    "session-navigation 도구는 사용자의 세션 채팅 요청에 따라 숨김 상태를 "
    "확인·복원할 때 쓴다. 사용자가 '숨김 목록 보여줘'처럼 요청하면 "
    "list_context_items를 호출해 숨김 건수와 함께 숨김 항목만 골라 표시 번호(1부터), 도구, "
    "원문 크기, 숨김 시각, 한 줄 요약이 담긴 표로 보여준다. 표 아래에 '번호는 이번 목록 "
    "기준입니다. ‘N번 복원해’ 또는 ‘전부 되돌려’라고 요청할 수 있습니다.'라고 안내한다. "
    "'N번 복원해' 요청이 오면 사용자가 본 표의 N번에 해당하는 정확한 item_id를 먼저 고정한다. "
    "복원 직전에 목록을 다시 조회해 현재 상태를 확인하되, 새 목록의 번호로 바꾸지 않고 고정한 "
    "item_id로 unhide_context를 호출한다. 복원 뒤 목록으로 같은 ID가 original인지 확인한다. "
    "'그거 되돌려'는 대상 하나가 분명할 때만 그 item_id로 복원하고, 여러 대상이 가능하면 묻고 "
    "임의로 고르지 않는다. '그거/그것/그 항목'처럼 번호도 ID도 없으면 바로 복원하지 않는다. "
    "직전 대화에서 가리키는 숨김 항목이 하나일 때만 복원하고, 숨김이 2건 이상이거나 대상이 "
    "분명하지 않으면 unhide_context를 호출하지 않고 '어느 항목을 복원할까요?'라고 먼저 묻는다. "
    "목록의 1번을 임의로 고르지 않는다. '전부 되돌려'는 필터 없는 목록에서 숨김 item_id 집합을 고정해 한 건씩 "
    "복원한 뒤 전체 목록으로 성공·실패·남은 건수를 보고한다. 숨김이 0건이면 '현재 숨겨진 항목 없음'이라고만 "
    "말한다. 오래된 큰 도구 결과가 쌓이면 manage_context로 자동 정리할 수 있다. "
    "숨김 상태는 같은 프로필·세션·프로세스에서만 보이고 재시작하면 "
    "사라진다. 재시작 여부를 모를 때 원인을 단정하지 않는다."
)

TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    HIDE_TOOL: {
        "name": HIDE_TOOL,
        "description": (
            "Hide one already-transmitted tool result using rule-based excerpts only "
            "(never calls a model): later model requests carry its summary instead of "
            "the full body. "
            "Pass the tool_call_id shown by the model."
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
            "이 세션에서 숨김(compacted) 처리된 도구 결과를 사람이 확인할 수 "
            "있게 반환한다. 사용자가 '숨김 목록 보여줘', '뭐 숨겨져 있어?'처럼 "
            "요청하면 이 도구를 호출하고, 결과(숨김 건수·표시 번호·도구·원문 "
            "크기·숨김 시각·한 줄 요약)를 사람이 읽기 좋은 표로 정리해 "
            "보여준다. 항목 본문과 명령 원문은 반환하지 않는다. "
            "표시 번호는 목록 호출마다 새로 부여된다. 복원이 필요하면 사용자가 본 표의 "
            "번호에 해당하는 정확한 item_id를 먼저 고정하고, 복원 직전 목록으로 현재 상태를 "
            "확인한 뒤 고정한 item_id로 복원한다. 새 목록의 번호로 바꾸지 않는다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional filter over item IDs and summaries.",
                }
            },
            "required": [],
            "additionalProperties": False,
        },
    },
    UNHIDE_TOOL: {
        "name": UNHIDE_TOOL,
        "description": (
            "숨긴 항목 하나를 재실행 없이 원문으로 복원한다. 요약은 보관되어 "
            "다시 숨길 수 있다. 'N번 복원해' 요청은 "
            "사용자가 본 표의 N번에 해당하는 정확한 item_id를 먼저 고정하고, 복원 직전 "
            "목록으로 현재 상태를 확인한 뒤 고정한 item_id로 호출한다. 새 목록의 번호로 "
            "바꾸지 않는다. '그거 되돌려'는 대상 하나가 분명할 때만 그 item_id로 복원하고, "
            "여러 대상이 가능하면 묻고 임의로 고르지 않는다. 번호도 ID도 없는 '그거/그것/그 항목'만으로는 "
            "복원을 호출하지 않고 먼저 묻는다. 목록의 1번을 임의로 고르지 않는다. '전부 되돌려'는 필터 없는 목록에서 "
            "고정한 집합을 한 건씩 복원한 뒤 전체 목록으로 확인한다. 숫자 형식('2', '2번', '#2')은 "
            "마지막 목록 기준 편의 해석만 하며, 재확인 절차를 대신하지 않는다. "
            "no_recent_list면 먼저 목록을 보여주고, unknown_display_number면 "
            "새 목록을 보여주고 다시 선택받는다. 존재하지 않으면 다른 ID로 "
            "대체하지 않고 오류를 사용자에게 설명한다."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "item_id": {
                    "type": "string",
                    "description": "The hidden item ID to unhide.",
                }
            },
            "required": ["item_id"],
            "additionalProperties": False,
        },
    },
    SUMMARIZE_TOOL: {
        "name": SUMMARIZE_TOOL,
        "description": (
            "Hide one already-transmitted tool result using a configured model "
            "summary: later model requests carry its summary instead of "
            "the full body. Requires a configured summarizer (fails with "
            "summarizer_unavailable otherwise) and never silently falls back to rules. "
            "Pass the tool_call_id shown by the model."
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
            "Automatically hide already-transmitted tool results: inspects the given "
            "tool_call_ids (or all recorded results when omitted) and applies hide or "
            "summarize directly. action=auto uses a model summary when a summarizer is "
            "configured, else rule-based hide. User and assistant messages are never "
            "auto-managed. Returns per-item results; partial failures never report full success."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tool_call_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Tool call IDs to manage. When omitted, all recorded results are considered.",
                },
                "action": {
                    "type": "string",
                    "enum": ["auto", "hide", "summarize"],
                    "description": "hide uses rules only; summarize requires a configured model; auto prefers summarize with rule fallback.",
                },
                "max_items": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 64,
                    "description": "Maximum items to process (default 20).",
                },
            },
            "required": [],
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


