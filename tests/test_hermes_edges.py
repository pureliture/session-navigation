"""S5 synthetic tests: edge conditions and the summarizer-path decision.

No live Hermes, no network. Covers compression rotation, subagent
isolation, session/engine expiry, disabled toggle, and documents the
rule-only first-version decision with a direct assertion.
"""

from __future__ import annotations
import pytest
import os, tempfile

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from _adapter_loader import hermes_adapter as _load_hermes_adapter
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope
from session_navigation.store import MemoryContextStore

_adapter = _load_hermes_adapter()
plugin = _adapter.plugin
handlers = _adapter.handlers
_session_mod = _adapter.session
SessionTranscriptStore = _session_mod.SessionTranscriptStore


def _long_body(suffix: str = "") -> str:
    lines = [f"Output row {i:03d} details" for i in range(80)]
    lines.extend([
        "id: 01234567-89ab-cdef-0123-456789abcdef",
        "results/output.json generated successfully",
    ])
    if suffix:
        lines.append(suffix)
    return "\n".join(lines)


def _codex_request(body: str, call_id: str = "call_1") -> dict:
    return {
        "input": [
            {"type": "function_call", "call_id": call_id, "name": "read_file",
             "arguments": json.dumps({"path": "results/output.json"})},
            {"type": "function_call_output", "call_id": call_id, "output": body},
        ]
    }


class FakeCtx:
    def __init__(self, config: dict | None = None, profile: str = "default"):
        self.profile_name = profile
        self.config = dict(config or {})
        self.tools: dict[str, dict] = {}
        self.middlewares: dict[str, list] = {}
        self.hooks: dict[str, object] = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def get_config(self, key: str, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, description="", **_extra):
        self.tools[name] = {"handler": handler, "schema": schema}

    def register_middleware(self, kind, callback):
        self.middlewares.setdefault(kind, []).append(callback)


def _enabled_pair(**overrides):
    ctx = FakeCtx(config={"enabled": True, **overrides})
    state = plugin.register(ctx)
    return ctx, state


def _mw(state, body: str, session: str, call_id: str = "call_1") -> dict:
    mw = plugin.make_middleware(state)
    return mw(request=_codex_request(body, call_id), session_id=session,
              api_mode="codex_responses")



@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))

def test_compression_rotation_starts_fresh_scope():
    ctx, state = _enabled_pair()
    compact = ctx.tools["hide_context"]["handler"]
    restore = ctx.tools["unhide_context"]["handler"]
    body = _long_body()

    _mw(state, body, "sess-before")
    before_item = json.loads(compact({"tool_call_id": "call_1"},
                                   session_id="sess-before"))["item_id"]

    # Compression rotated the session id: the old compacted state does NOT
    # carry over, so the new scope's request passes the original body.
    rotated = _mw(state, body, "sess-after")
    assert rotated["request"]["input"][1]["output"] == body

    # The new scope manages its own independent compacted set.
    after_item = json.loads(compact({"tool_call_id": "call_1"},
                                  session_id="sess-after"))["item_id"]
    assert after_item != before_item
    assert _mw(state, body, "sess-after")["request"]["input"][1][
        "output"] != body

    # Unhiding the old scope leaves the new scope compacted (isolation).
    restore_result = json.loads(restore({"item_id": before_item},
                                       session_id="sess-before"))
    assert restore_result["ok"] is True
    assert _mw(state, body, "sess-before")["request"]["input"][1][
        "output"] == body
    assert _mw(state, body, "sess-after")["request"]["input"][1][
        "output"] != body


def test_subagent_scopes_are_managed_and_linked_but_isolated():
    ctx, state = _enabled_pair()
    compact = ctx.tools["hide_context"]["handler"]
    body = _long_body()

    _mw(state, body, "sess-parent")
    parent_item = json.loads(compact({"tool_call_id": "call_1"},
                                   session_id="sess-parent"))["item_id"]

    ctx.middlewares["tool_request"][0](tool_name="delegate_task", tool_call_id="delegate", session_id="sess-parent")
    ctx.hooks["subagent_start"](parent_session_id="sess-parent", child_session_id="sess-child", child_subagent_id="sa-child")
    child = _mw(state, body, "sess-child")
    assert child["request"]["input"][1]["output"] == body
    rows = state.engine.store.child_scopes("hermes:default:sess-parent:unknown")
    assert len(rows) == 1
    assert rows[0]["scope_key"] == "hermes:default:sess-child:unknown"
    assert rows[0]["tool_call_id"] == "delegate"
    assert rows[0]["subagent_id"] == "sa-child"

    # Each scope compacts its own copy under its own item id.
    child_item = json.loads(compact({"tool_call_id": "call_1"},
                                  session_id="sess-child"))["item_id"]
    assert child_item != parent_item

    parent = _mw(state, body, "sess-parent")
    assert parent["request"]["input"][1]["output"] != body


def test_delegation_context_isolated_across_concurrent_batch_and_nested_children():
    ctx, state = _enabled_pair()
    capture = ctx.middlewares["tool_request"][0]
    start = ctx.hooks["subagent_start"]
    def batch(index):
        capture(tool_name="delegate_task", tool_call_id=f"call-{index}", session_id=f"parent-{index}")
        contexts = [copy_context() for _ in range(2)]
        for child, context in enumerate(contexts):
            context.run(start, parent_session_id=f"parent-{index}",
                child_session_id=f"child-{index}-{child}", child_subagent_id=f"sa-{index}-{child}")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(batch, range(4)))
    for index in range(4):
        rows = state.engine.store.child_scopes(f"hermes:default:parent-{index}:unknown")
        assert len(rows) == 2
        assert {row["tool_call_id"] for row in rows} == {f"call-{index}"}
    capture(tool_name="delegate_task", tool_call_id="nested", session_id="child-0-0")
    start(parent_session_id="child-0-0", child_session_id="grandchild", child_subagent_id="sa-nested")
    assert state.engine.store.child_scopes("hermes:default:child-0-0:unknown")[0]["tool_call_id"] == "nested"
    start(parent_session_id="unrelated", child_session_id="unbound", child_subagent_id="sa-unbound")
    assert state.engine.store.child_scopes("hermes:default:unrelated:unknown")[0]["tool_call_id"] is None


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
@pytest.mark.parametrize("enabled", [True, False])
def test_child_requests_have_no_navigation_tools_guidance_or_reminders(mode, enabled):
    ctx, state = _enabled_pair()
    state.is_enabled = lambda: enabled
    ctx.hooks["subagent_start"](parent_session_id="parent", child_session_id="child", child_subagent_id="sa")
    SUPERVISION_SECTION_TEXT = _adapter.schemas.SUPERVISION_SECTION_TEXT
    request = {"tools": [{"type": "function", "function": {"name": "manage_context"}},
                         {"type": "function", "name": "hide_context"},
                         {"type": "function", "function": {"name": "read_file"}}],
               "instructions": SUPERVISION_SECTION_TEXT,
               "messages": [{"role": "system", "content": SUPERVISION_SECTION_TEXT}, {"role": "user", "content": "go"}],
               "input": [{"role": "user", "content": "go"}]}
    original = copy.deepcopy(request)
    state.reminders.note = lambda *args: (_ for _ in ()).throw(AssertionError("child reminder"))
    result = plugin.make_middleware(state)(request=request, session_id="child", api_mode=mode)
    assert request == original
    assert len(result["request"]["tools"]) == 1
    assert result["request"]["instructions"] == ""
    assert result["request"]["messages"][0]["content"] == ""
    assert len(result["request"]["messages"]) == 2


def test_session_expiry_forgets_quiet_scopes():
    # Every new request refreshes the "last transmission" record, so
    # expiry only bites after silence: a late compact finds nothing, while
    # a fresh request re-records and compacting works again.
    now = [1000.0]
    store = SessionTranscriptStore(ttl_seconds=60, time_func=lambda: now[0])
    state = plugin.PluginState(store=store,
                               is_enabled=lambda: True,
                               count_middlewares=lambda: 0)  # sole middleware
    scope = plugin.scope_for(state, "sess-ttl")
    assert scope is not None
    body = _long_body()

    handlers.middleware_step(state.engine, store, scope, "codex_responses",
                             _codex_request(body))
    assert handlers.compact(state.engine, store, scope, "call_1").ok is True

    now[0] += 61.0
    # Silence longer than the TTL: the tool path finds no record.
    assert store.entries(scope.scope_key()) == []
    late = handlers.compact(state.engine, store, scope, "call_1")
    assert late.ok is False and late.error == "not_found"

    # A new request re-records, so compacting works again on the fresh entry.
    handlers.middleware_step(state.engine, store, scope, "codex_responses",
                             _codex_request(body))
    assert handlers.compact(state.engine, store, scope, "call_1").ok is True



def test_disable_returns_to_original_and_reenable_applies():
    ctx = FakeCtx(config={"enabled": True})
    state = plugin.register(ctx)
    mw = ctx.middlewares["llm_request"][0]
    compact = ctx.tools["hide_context"]["handler"]
    body = _long_body()
    kwargs = dict(session_id="sess-toggle", api_mode="codex_responses")

    mw(request=_codex_request(body), **kwargs)
    assert json.loads(compact({"tool_call_id": "call_1"},
                            session_id="sess-toggle"))["ok"] is True
    applied = mw(request=_codex_request(body), **kwargs)
    assert applied["request"]["input"][1]["output"] != body

    ctx.config["enabled"] = False
    assert mw(request=_codex_request(body), **kwargs) is None
    untouched = _codex_request(body)
    snapshot = copy.deepcopy(untouched)
    assert mw(request=untouched, **kwargs) is None
    assert untouched == snapshot

    ctx.config["enabled"] = True
    again = mw(request=_codex_request(body), **kwargs)
    assert again["request"]["input"][1]["output"] != body


def test_first_version_is_rule_only_no_external_call():
    ctx, state = _enabled_pair()
    compact = ctx.tools["hide_context"]["handler"]
    list_items = ctx.tools["list_context_items"]["handler"]
    body = _long_body()

    plugin.make_middleware(state)(request=_codex_request(body),
                                  session_id="sess-rule",
                                  api_mode="codex_responses")
    assert json.loads(compact({"tool_call_id": "call_1"},
                            session_id="sess-rule"))["ok"] is True
    listed = json.loads(list_items({}, session_id="sess-rule"))
    assert listed["count"] == 1
    assert listed["items"][0]["source"] == "rule"


def test_default_middleware_counter_degrades_to_no_others() -> None:
    # Outside a Hermes process the lazy host import fails and must fall
    # back to 0 ("no evidence of others") instead of raising.
    assert plugin._default_count_llm_middlewares() == 0
