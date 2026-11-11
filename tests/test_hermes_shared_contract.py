import copy
from dataclasses import replace
import json

import pytest

from _adapter_loader import hermes_adapter
from session_navigation.engine import SessionNavigationEngine
from session_navigation.pending_summary import settle_summary
from session_navigation.sqlite_store import SQLiteContextStore

adapter = hermes_adapter()


def setup_state(tmp_path, summarizer=None):
    engine = SessionNavigationEngine(store=SQLiteContextStore(tmp_path / "s.db"))
    state = adapter.factories.PluginState(engine=engine, summarizer=summarizer,
        is_enabled=lambda: True, count_middlewares=lambda: 0)
    body = "alpha details available\n" * 200
    request = {"input": [
        {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": json.dumps({"path": "source.txt"})},
        {"type": "function_call_output", "call_id": "c1", "output": body}]}
    kwargs = {"request": request, "api_mode": "codex_responses", "session_id": "s"}
    return state, kwargs, adapter.factories.scope_for(state, "s")


def pending(state, scope):
    entry = state.store.entries(scope.scope_key())[0]
    record = state.engine.store.adapter_targets(scope)[0]
    from session_navigation.model import ToolResultRecord
    result = state.engine.compact_sync(scope, ToolResultRecord(entry.call_id,
        content=entry.content, content_sha256=entry.content_sha256,
        invocation=json.loads(record["invocation_snapshot"]), invocation_digest=record["invocation_digest"]))
    assert result.ok, result.error
    item = replace(result.item, compaction_source="summarize_pending", invocation_snapshot=json.loads(record["invocation_snapshot"]), version=result.item.version + 1)
    assert state.engine.store.put(scope, item, expected_version=result.item.version).ok
    return item


class Summary:
    def __init__(self, text="alpha details available.", callback=None):
        self.text = text
        self.calls = 0
        self.callback = callback

    async def summarize(self, original, evidence, **kwargs):
        self.calls += 1
        if self.callback:
            self.callback()
        if self.text is None:
            raise RuntimeError("local model unavailable")
        return {"summary": self.text}


@pytest.mark.parametrize("text,source", [("alpha details available.", "llm_summary"), ("Invented unrelated facts", "explicit_user_hide"), (None, "explicit_user_hide")])
def test_middleware_consumes_pending_and_projects_current_version(tmp_path, text, source):
    summarizer = Summary(text)
    state, kwargs, scope = setup_state(tmp_path, summarizer)
    middleware = adapter.factories.make_middleware(state)
    original = copy.deepcopy(kwargs["request"])
    middleware(**kwargs)
    item = pending(state, scope)
    response = middleware(**kwargs)
    saved = state.engine.store.get(scope, item.item_id)
    assert saved.compaction_source == source
    assert saved.version == item.version + 1
    assert response["request"]["input"][1]["output"] == saved.compacted
    assert kwargs["request"] == original
    middleware(**kwargs)
    assert summarizer.calls == 1
    assert scope.branch_scope == "unknown"
    assert state.engine.store.adapter_targets("hermes:default:s:default")
    state.engine.store.close()


def test_summary_cas_cannot_overwrite_unhide(tmp_path):
    summary = Summary()
    state, kwargs, scope = setup_state(tmp_path, summary)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    item = pending(state, scope)
    remote = SQLiteContextStore(tmp_path / "s.db")
    summary.callback = lambda: remote.restore(scope, item.item_id, expected_version=item.version)
    response = middleware(**kwargs)
    assert state.engine.store.get(scope, item.item_id).visibility == "visible"
    assert response["request"] == kwargs["request"]
    assert not settle_summary(state.engine.store, scope, item.item_id, item.version, summary.text).ok
    remote.close()
    state.engine.store.close()


def test_pending_without_session_model_keeps_rule_hide(tmp_path):
    state, kwargs, scope = setup_state(tmp_path)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    item = pending(state, scope)
    middleware(**kwargs)
    saved = state.engine.store.get(scope, item.item_id)
    assert saved.compaction_source == "explicit_user_hide"
    assert saved.compacted == item.compacted
    state.engine.store.close()


def test_pending_uses_host_ctx_llm(tmp_path):
    from types import SimpleNamespace
    calls = []
    def complete(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text=json.dumps({"summary": "alpha details available."}))
    summarizer = adapter.llm.CtxLlmSummarizer(SimpleNamespace(llm=SimpleNamespace(complete=complete)))
    state, kwargs, scope = setup_state(tmp_path, summarizer)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    item = pending(state, scope)
    middleware(**kwargs)
    assert state.engine.store.get(scope, item.item_id).compaction_source == "llm_summary"
    assert len(calls) == 1 and calls[0]["purpose"] == "session-navigation-summarize"
    state.engine.store.close()


def test_disable_and_coexistence_revoke_capabilities(tmp_path):
    state, kwargs, scope = setup_state(tmp_path)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    assert state.engine.store.adapter_can(scope, "hide")
    assert not state.engine.store.adapter_can(scope, "summarize")
    state.count_middlewares = lambda: 1
    middleware(**kwargs)
    assert not state.engine.store.adapter_can(scope, "hide")
    state.count_middlewares = lambda: 0
    middleware(**kwargs)
    state.is_enabled = lambda: False
    assert middleware(**kwargs) is None
    assert not state.engine.store.adapter_can(scope, "hide")
    state.engine.store.close()


@pytest.mark.parametrize("kind", ["duplicate_call", "duplicate_result", "destructive", "protected", "unsupported_mode"])
def test_unsafe_or_ambiguous_targets_are_not_published(tmp_path, kind):
    state, kwargs, scope = setup_state(tmp_path)
    request = kwargs["request"]
    if kind == "duplicate_call":
        request["input"].insert(0, copy.deepcopy(request["input"][0]))
    elif kind == "duplicate_result":
        request["input"].append(copy.deepcopy(request["input"][1]))
    elif kind == "destructive":
        request["input"][0].update(name="terminal", arguments=json.dumps({"command": "rm -rf workspace"}))
    elif kind == "protected":
        request["input"][1]["output"] = "Error: permission denied\n" * 200
    else:
        kwargs["api_mode"] = "anthropic_messages"
    adapter.factories.make_middleware(state)(**kwargs)
    assert state.engine.store.adapter_targets(scope) == []
    state.engine.store.close()
