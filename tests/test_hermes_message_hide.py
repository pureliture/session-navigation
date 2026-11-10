from _adapter_loader import hermes_adapter

from session_navigation.engine import SessionNavigationEngine
from session_navigation.sqlite_store import SQLiteContextStore

adapter = hermes_adapter()
plugin, payload, command = adapter.plugin, adapter.payload, adapter.command
SESSION = "message-hide-session"


def chat_request():
    return {"messages": [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "first prompt"},
        {"role": "assistant", "content": "calling", "tool_calls": [{"id": "c1", "type": "function"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "out"},
        {"role": "assistant", "content": "final answer"},
    ]}


def test_message_keys_and_drop_keep_tool_pairs():
    request = chat_request()
    keys = payload.message_keys("chat_completions", request)
    assert [(k.split(":")[1], k.split(":")[2]) for k, *_ in keys] == [("user", "p0"), ("assistant", "p1"), ("assistant", "p2")]
    image = {"messages": [{"role": "user", "content": [{"type": "text", "text": "first prompt"}, {"type": "image_url", "image_url": {"url": "a"}}]}]}
    other = {"messages": [{"role": "user", "content": [{"type": "text", "text": "first prompt"}, {"type": "image_url", "image_url": {"url": "b"}}]}]}
    assert payload.message_keys("chat_completions", image)[0][0] != payload.message_keys("chat_completions", other)[0][0]
    dropped = payload.drop_messages("chat_completions", request, {k for k, *_ in keys})
    assert [m["role"] for m in dropped["messages"]] == ["system", "assistant", "tool"]
    assert dropped["messages"][1]["content"] is None and dropped["messages"][1]["tool_calls"]
    assert request["messages"][1]["content"] == "first prompt"
    codex = {"input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                       {"type": "function_call_output", "call_id": "c", "output": "x"}]}
    (key, *_), = payload.message_keys("codex_responses", codex)
    assert payload.drop_messages("codex_responses", codex, {key})["input"] == codex["input"][1:]


def test_nav_hide_msg_removes_prompt_from_next_request(tmp_path):
    state = plugin.PluginState(engine=SessionNavigationEngine(store=SQLiteContextStore(str(tmp_path / "s.db"))),
                               is_enabled=lambda: True, count_middlewares=lambda: 0)
    middleware = plugin.make_middleware(state)
    middleware(request=chat_request(), session_id=SESSION, api_mode="chat_completions")
    listing = command.nav_command(state=state, raw_args="messages", session_id=SESSION)
    assert "Prompts/responses (3)" in listing and "[visible] user" in listing
    assert command.nav_command(state=state, raw_args="hide-msg 1", session_id=SESSION).startswith("Hidden msg:user:p0:")
    out = middleware(request=chat_request(), session_id=SESSION, api_mode="chat_completions")["request"]
    assert [m["content"] for m in out["messages"] if m["role"] == "user"] == []
    assert command.nav_command(state=state, raw_args="unhide-msg 1", session_id=SESSION).startswith("Unhidden")
    out = middleware(request=chat_request(), session_id=SESSION, api_mode="chat_completions")["request"]
    assert [m["content"] for m in out["messages"] if m["role"] == "user"] == ["first prompt"]


def test_hide_msg_refused_while_disabled(tmp_path):
    state = plugin.PluginState(engine=SessionNavigationEngine(store=SQLiteContextStore(str(tmp_path / "s.db"))),
                               is_enabled=lambda: False, count_middlewares=lambda: 0)
    assert command.nav_command(state=state, raw_args="hide-msg 1", session_id=SESSION) == "Session navigation: disabled"
