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


def test_hermes_hybrid_sequence_summarizer_handles_oversize_and_rolling_chunks():
    from types import SimpleNamespace

    seen_prompts: list[str] = []

    class FakeLlm:
        def complete(self, *, messages, **_kwargs):
            prompt = messages[-1]["content"]
            seen_prompts.append(prompt)
            blocks = prompt.split("--- call_id: ")[1:]
            steps = {}
            ids = []
            for block in blocks:
                cid = block.split(" | ")[0].strip()
                first_line = block.split("---\n", 1)[1].splitlines()[0].strip()
                steps[cid] = first_line
                ids.append(cid)
            payload = json.dumps({
                "sequence_summary": f"Connected findings across {', '.join(ids)}.",
                "steps": steps,
            })
            return SimpleNamespace(text=payload, usage=SimpleNamespace(input_tokens=20, output_tokens=10, total_tokens=30, cost_usd=0.001), audit={"id": f"resp-{len(seen_prompts)}"})

    ctx = FakeCtx(config={"enabled": True})
    ctx.llm = FakeLlm()
    state = adapter.plugin.register(ctx)
    session = "seq-hermes"
    messages = []
    for idx in range(10):
        row_count = 1500 if idx == 2 else 120
        body = "\n".join(f"Step {idx} row {r:04d}: metric_value={idx * 100 + r}" for r in range(row_count))
        messages.extend([
            {"role": "assistant", "content": None, "tool_calls": [{"id": f"s{idx}", "type": "function", "function": {
                "name": "terminal", "arguments": json.dumps({"command": f"check_stage_{idx}"})}}]},
            {"role": "tool", "tool_call_id": f"s{idx}", "content": body},
        ])
    assert len(messages[5]["content"].encode("utf-8")) > 40_000
    middleware = ctx.middlewares["llm_request"][0]
    middleware(request={"messages": messages}, session_id=session, api_mode="chat_completions")
    res = json.loads(ctx.tools["manage_context"]["handler"](
        {"tool_call_ids": [f"s{i}" for i in range(9, -1, -1)], "action": "summarize"},
        session_id=session,
    ))
    assert res["ok"] is True and res["applied"] == 10 and res["failed"] == 0
    assert 1 < len(seen_prompts) < 10
    assert any("Prior steps context" in p for p in seen_prompts[1:])
    patched = middleware(request={"messages": messages}, session_id=session, api_mode="chat_completions")["request"]["messages"]
    tool_bodies = [m["content"] for m in patched if m["role"] == "tool"]
    assert "[terminal: check_stage_0]" in tool_bodies[0]
    assert "[Sequence summary]" not in tool_bodies[0]
    assert "[Sequence summary]" in tool_bodies[9]
    anchor_item_id = next(item["item_id"] for item in res["items"] if item["tool_call_id"] == "s9")
    unhidden = json.loads(ctx.tools["unhide_context"]["handler"]({"item_id": anchor_item_id}, session_id=session))
    assert unhidden["ok"] is True
    after_unhide = middleware(request={"messages": messages}, session_id=session, api_mode="chat_completions")["request"]["messages"]
    tool_bodies_after = [m["content"] for m in after_unhide if m["role"] == "tool"]
    assert tool_bodies_after[9] == messages[19]["content"]
    assert "[terminal: check_stage_0]" in tool_bodies_after[0]
