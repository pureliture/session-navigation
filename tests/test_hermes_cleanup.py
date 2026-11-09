import json

from _adapter_loader import hermes_adapter
from test_hermes_nav import FakeCtx

adapter = hermes_adapter()


def test_cleanup_discovery_explicit_ids_model_count_and_repeated_turns(monkeypatch):
    ctx = FakeCtx(config={"enabled": True})
    state = adapter.plugin.register(ctx)
    session = "cleanup"
    messages = []

    def add(call_id, body=None, name="read_file", args=None):
        content = body if body is not None else "\n".join(f"Tool {call_id} row {i:03} contains useful details" for i in range(100))
        messages.extend([
            {"role": "assistant", "content": None, "tool_calls": [{"id": call_id, "type": "function", "function": {
                "name": name, "arguments": json.dumps(args or {"path": "sample.txt"})}}]},
            {"role": "tool", "tool_call_id": call_id, "content": content},
        ])

    def tool(name, args):
        return json.loads(ctx.tools[name]["handler"](args, session_id=session))

    for i in range(80):
        add(f"c{i}")
    add("short", "tiny")
    add("danger", name="terminal", args={"command": "rm -rf sample"})
    middleware = ctx.middlewares["llm_request"][0]
    middleware(request={"messages": messages}, session_id=session, api_mode="chat_completions")
    for args in ({}, {"tool_call_ids": []}):
        assert tool("manage_context", args)["error"] == "tool_call_ids_required"
    assert tool("manage_context", {"tool_call_ids": "all"})["error"] == "invalid_tool_call_ids"
    listed = tool("list_context_items", {"view": "candidates"})["items"]
    assert [i["tool_call_id"] for i in listed] == [f"c{i}" for i in range(79, 49, -1)]
    assert listed[0] == {"tool_call_id": "c79", "tool_name": "read_file", "hint": "sample.txt",
                         "bytes_size": len(messages[159]["content"].encode()), "tokens_display": "—"}
    assert len(tool("list_context_items", {"view": "candidates", "limit": 2})["items"]) == 2
    assert tool("list_context_items", {"view": "candidates", "limit": 0})["error"] == "invalid_limit"
    calls = []

    def summarize(engine, store, scope, call_id, summarizer):
        calls.append(call_id)
        return adapter.handlers.compact(engine, store, scope, call_id)

    state.summarizer = object()
    monkeypatch.setattr(adapter.factories, "_engine_summarize", summarize)
    assert tool("manage_context", {"tool_call_ids": ["c0"], "action": "summarize"})["applied"] == 1
    assert calls == ["c0"]
    result = tool("manage_context", {"tool_call_ids": ["c0", "short", "danger", "missing"], "action": "summarize"})
    assert [i["error"] for i in result["items"]] == ["already_hidden", "not_long", "destructive_command", "not_found"]
    assert calls == ["c0"]
    assert "c0" not in [i["tool_call_id"] for i in tool("list_context_items", {"view": "candidates", "limit": 200})["items"]]
    result = tool("manage_context", {"tool_call_ids": [f"c{i}" for i in range(1, 80)], "action": "summarize"})
    assert result["applied"] == 79
    assert calls == [f"c{i}" for i in range(80)]
    add("next-turn")
    middleware(request={"messages": messages}, session_id=session, api_mode="chat_completions")
    assert tool("manage_context", {"tool_call_ids": ["next-turn"], "action": "hide"})["applied"] == 1
    assert len(calls) == 80
    assert tool("list_context_items", {"view": "candidates"})["items"] == []
