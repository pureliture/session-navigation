"""A-plan supervision contracts; local requests only, no agent/provider calls."""
from __future__ import annotations
import os, tempfile, gc, pytest
import copy

import json

from _adapter_loader import hermes_adapter

plugin = hermes_adapter().plugin
SESSION = "human-supervision-session"


def _state(**overrides):
    defaults = {"is_enabled": lambda: True, "count_middlewares": lambda: 0}
    defaults.update(overrides)
    return plugin.PluginState(**defaults)


class _FakeIntentLlm:
    def __init__(self, text=None, error=None):
        self.text = text
        self.error = error
        self.kwargs = None

    def complete(self, **kwargs):
        self.kwargs = kwargs
        if self.error is not None:
            raise self.error
        return type("Result", (), {"text": self.text})()


def _frame(content: str, *, section_id: str | None = None, chars: int | None = None) -> str:
    section_id = section_id or plugin.SUPERVISION_SECTION_ID
    declared = len(content) if chars is None else chars
    return (f"## Plugin Context: {section_id}\n"
            f"<!-- hermes-plugin-section-chars:{declared} -->\n\n{content}")


def _container(*sections: str) -> str:
    if not sections:
        return ""
    return ("<!-- hermes-plugin-sections:start -->\n"
            + "\n\n".join(sections)
            + "\n<!-- hermes-plugin-sections:end -->")


def _stale_guidance() -> str:
    return _container(_frame("Old cleanup guidance without tool calls."))


def _body(label="sample"):
    return "\n".join(f"{label} row {i:03d}: " + "a" * 60 for i in range(80))


def _request(body, call_id):
    return {"input": [
        {"type": "function_call", "call_id": call_id, "name": "read_file",
         "arguments": json.dumps({"path": "sample.txt"})},
        {"type": "function_call_output", "call_id": call_id, "output": body},
    ]}


def _compact(state, call_id="call_1", body=None, session=SESSION):
    original = _body() if body is None else body
    plugin.make_middleware(state)(
        request=_request(original, call_id), session_id=session,
        api_mode="codex_responses",
    )
    result = json.loads(plugin.make_hide_handler(state)(
        {"tool_call_id": call_id}, session_id=session,
    ))
    assert result["ok"] is True, result
    return result


def _list(state, query="", session=SESSION):
    return json.loads(plugin.make_list_handler(state)(
        {"query": query}, session_id=session,
    ))


def _restore(state, item_id, session=SESSION):
    return json.loads(plugin.make_unhide_handler(state)(
        {"item_id": item_id}, session_id=session,
    ))



@pytest.fixture(autouse=True)
def _gc_collect():
    yield
    gc.collect()


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))

def test_list_counts_compacted_separately_from_restored_records():
    state = _state()
    empty = _list(state)
    assert empty["count"] == 0 and empty["items"] == []
    assert empty["compacted_count"] == 0
    assert empty["message"] == "Current hidden items: none"

    compacted = _compact(state)
    listed = _list(state)
    assert listed["count"] == len(listed["items"]) == 1
    assert listed["compacted_count"] == 1
    assert listed["message"] == "Current hidden items: 1"

    assert _restore(state, compacted["item_id"])["ok"] is True
    restored = _list(state)
    assert restored["count"] == len(restored["items"]) == 1
    assert restored["items"][0]["visibility"] == "visible"
    assert restored["compacted_count"] == 0
    assert restored["message"] == "Current hidden items: none"


def test_compacted_items_carry_human_fields_and_newest_first():
    state = _state()
    body_a, body_b = _body("alpha"), _body("beta")
    first = _compact(state, "call_1", body_a)
    second = _compact(state, "call_2", body_b)
    assert first["item_id"] != second["item_id"]

    items = {item["item_id"]: item for item in _list(state)["items"]}
    top, below = items[second["item_id"]], items[first["item_id"]]
    assert [item["item_id"] for item in _list(state)["items"]] == [
        second["item_id"], first["item_id"]]
    assert [item["display_number"] for item in _list(state)["items"]] == [1, 2]
    assert top["compaction_order"] > below["compaction_order"]
    assert top["compacted_at"].endswith("Z") and len(top["compacted_at"]) == 20
    assert top["original_bytes_size"] == len(body_b.encode("utf-8"))
    line = top["summary_line"]
    assert line and "\n" not in line and len(line) <= 160
    assert line.split(" ")[0] == "beta"

    restored = _list(state)["items"][0]["item_id"]
    assert _restore(state, restored)["ok"] is True
    after = _list(state)
    # Compacted items keep the numbers and sort first; the restored record
    # stays in the list (history) with display_number None and its
    # original compacted_at retained.
    assert [item["display_number"] for item in after["items"]] == [1, None]
    assert after["items"][0]["item_id"] == first["item_id"]
    assert after["items"][1]["compacted_at"] == top["compacted_at"]


def test_query_view_renumbers_and_reports_search_scope():
    state = _state()
    _compact(state, "call_1", _body("alpha"))
    _compact(state, "call_2", _body("beta"))
    _compact(state, "call_3", _body("gamma"))

    matched = _list(state, query="beta")
    assert matched["compacted_count"] == 1
    assert matched["message"] == "Matching hidden items: 1"
    assert [item["display_number"] for item in matched["items"]] == [1]

    none = _list(state, query="no-such-marker")
    assert none["count"] == 0 and none["compacted_count"] == 0
    assert none["message"] == "Matching hidden items: none"

    full = _list(state)
    assert full["compacted_count"] == 3
    assert [item["display_number"] for item in full["items"]] == [1, 2, 3]



def test_recompact_after_restore_starts_a_new_compact_transition():
    state = _state()
    body = _body("cycle")
    compacted = _compact(state, "call_1", body)
    first = {item["item_id"]: item for item in _list(state)["items"]}[
        compacted["item_id"]]

    # Re-compact while already compacted: same transition, no new timestamp.
    again = _compact(state, "call_1", body)
    assert again["item_id"] == compacted["item_id"]
    same = {item["item_id"]: item for item in _list(state)["items"]}[
        compacted["item_id"]]
    assert same["compaction_order"] == first["compaction_order"]
    assert same["compacted_at"] == first["compacted_at"]

    # Restore, then compact again: a new transition gets a new order.
    assert _restore(state, compacted["item_id"])["ok"] is True
    refreshed = _compact(state, "call_1", body)
    assert refreshed["item_id"] == compacted["item_id"]
    newest = _list(state)
    assert newest["compacted_count"] == 1
    item = newest["items"][0]
    assert item["compaction_order"] > first["compaction_order"]
    assert item["display_number"] == 1
    assert item["compacted_at"] >= first["compacted_at"]


class _SectionCtx:
    """PluginContext surface with the optional prompt-section API."""

    def __init__(self, enabled: bool = True, with_section_api: bool = True):
        self.profile_name = "default"
        self._config = {"enabled": enabled}
        self.tools: dict[str, dict] = {}
        self.middlewares: dict[str, list] = {}
        self.sections: list[dict] = []
        if with_section_api:
            self.register_system_prompt_section = self._register_section

    def _register_section(self, id, content, *, position="after_memory",
                          max_chars=1000):
        self.sections.append({
            "id": id, "content": content, "position": position,
            "max_chars": max_chars,
        })

    def get_config(self, key, default=None):
        return self._config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, description="", **_extra):
        self.tools[name] = {"description": description}

    def register_middleware(self, kind, callback):
        self.middlewares.setdefault(kind, []).append(callback)


def test_enabled_plugin_registers_static_supervision_section():
    ctx = _SectionCtx()
    plugin.register(ctx)
    assert len(ctx.sections) == 1
    section = ctx.sections[0]
    assert section["id"] == "session-navigation.human-supervision"
    assert section["position"] == "after_memory"
    assert section["max_chars"] == 1200
    text = section["content"]
    assert isinstance(text, str) and len(text) <= 1200
    for token in ("list_context_items", "unhide_context", "hidden"):
        assert token in text, token


def test_section_registration_degrades_without_api_or_when_disabled():
    legacy = _SectionCtx(with_section_api=False)
    plugin.register(legacy)  # must not raise on hosts without the API
    assert legacy.tools  # tools still registered

    disabled = _SectionCtx(enabled=False)
    plugin.register(disabled)
    assert disabled.sections == []


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
@pytest.mark.parametrize("deferred", [False, True])
def test_existing_session_gets_supervision_once_without_mutating_request(mode, deferred):
    section = plugin.SUPERVISION_SECTION_TEXT
    names = ("tool_describe", "tool_call") if deferred else ("manage_context",)
    if mode == "chat_completions":
        request = {
            "messages": [{"role": "developer", "content": "Existing system prompt."},
                         {"role": "user", "content": "Continue the existing session."}],
            "tools": [{"type": "function", "function": {"name": name}} for name in names],
        }
    else:
        request = {
            "instructions": "Existing system prompt.",
            "input": [{"type": "message", "role": "user",
                       "content": [{"type": "input_text", "text": "Continue the existing session."}]}],
            "tools": [{"type": "function", "name": name} for name in names],
        }
    original = copy.deepcopy(request)
    middleware = plugin.make_middleware(_state())
    result = middleware(request=request, session_id="existing-session", api_mode=mode, turn_id="turn-1")
    outgoing = result["request"]
    system = outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]
    assert system == "Existing system prompt.\n\n" + section
    assert request == original

    # A provider retry or a host that already included the section must not
    # receive a second copy, and the request's conversation must stay intact.
    retry = middleware(request=outgoing, session_id="existing-session", api_mode=mode, turn_id="turn-1")
    retry_system = retry["request"]["messages"][0]["content"] if mode == "chat_completions" else retry["request"]["instructions"]
    assert retry_system.count(section) == 1
    if mode == "chat_completions":
        assert retry["request"]["messages"][1:] == original["messages"][1:]
    else:
        assert retry["request"]["input"] == original["input"]


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_new_session_with_host_guidance_is_not_duplicated(mode):
    section = plugin.SUPERVISION_SECTION_TEXT
    if mode == "chat_completions":
        request = {"messages": [{"role": "system", "content": [{"type": "text", "text": section}]},
                                {"role": "user", "content": "Start."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": section, "input": [{"type": "message", "role": "user", "content": "Start."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    original = copy.deepcopy(request)
    result = plugin.make_middleware(_state())(request=request, session_id="new-session", api_mode=mode)
    assert result["request"] == original
    assert request == original


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
@pytest.mark.parametrize("case", ["no_tools", "incomplete_bridge", "tool_choice_none", "other_forced_tool", "side_question"])
def test_requests_without_available_cleanup_do_not_gain_supervision(mode, case):
    names = ("tool_describe",) if case == "incomplete_bridge" else ("manage_context",)
    tools = ([{"type": "function", "function": {"name": name}} for name in names]
             if mode == "chat_completions" else [{"type": "function", "name": name} for name in names])
    request = ({"messages": [{"role": "system", "content": "Base."}, {"role": "user", "content": "Continue."}]}
               if mode == "chat_completions" else
               {"instructions": "Base.", "input": [{"type": "message", "role": "user", "content": "Continue."}]})
    if case != "no_tools":
        request["tools"] = tools
    if case == "tool_choice_none":
        request["tool_choice"] = "none"
    if case == "other_forced_tool":
        request["tool_choice"] = {"type": "function", "function": {"name": "read_file"}}
    turn_id = "turn-1:side_question" if case == "side_question" else "turn-1"
    original = copy.deepcopy(request)
    result = plugin.make_middleware(_state())(request=request, session_id="existing-session", api_mode=mode, turn_id=turn_id)
    assert result["request"] == original
    assert request == original


def test_user_quoting_guidance_does_not_replace_system_guidance():
    section = plugin.SUPERVISION_SECTION_TEXT
    request = {"messages": [{"role": "system", "content": "Base."}, {"role": "user", "content": section}],
               "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    result = plugin.make_middleware(_state())(request=request, session_id="quoted-session", api_mode="chat_completions")
    assert result["request"]["messages"][0]["content"] == "Base.\n\n" + section
    assert result["request"]["messages"][1]["content"] == section


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_missing_guidance_is_in_the_same_request_as_a_candidate_reminder(mode):
    section = plugin.SUPERVISION_SECTION_TEXT
    body = "A safe result row.\n" * 2500
    if mode == "chat_completions":
        request = {
            "messages": [
                {"role": "system", "content": "Existing system prompt."},
                {"role": "user", "content": "Read the file."},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-big", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"big.txt"}'}}
                ]},
                {"role": "tool", "tool_call_id": "call-big", "content": body},
            ],
            "tools": [{"type": "function", "function": {"name": "manage_context"}}],
        }
    else:
        request = {
            "instructions": "Existing system prompt.",
            "input": [
                {"type": "message", "role": "user", "content": "Read the file."},
                {"type": "function_call", "call_id": "call-big", "name": "read_file", "arguments": '{"path":"big.txt"}'},
                {"type": "function_call_output", "call_id": "call-big", "output": body},
            ],
            "tools": [{"type": "function", "name": "manage_context"}],
        }
    original = copy.deepcopy(request)
    outgoing = plugin.make_middleware(_state(intent_llm=_FakeIntentLlm('{"intent":"cleanup_allowed"}')))(
        request=request, session_id="large-existing", api_mode=mode)["request"]
    system = outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]
    conversation = outgoing["messages"] if mode == "chat_completions" else outgoing["input"]
    reminder = conversation[-1]["content"]
    if isinstance(reminder, list):
        reminder = reminder[0]["text"]
    assert system == "Existing system prompt.\n\n" + section
    assert "[context-navigation] eligible=1" in reminder
    assert "call-big" in reminder
    if mode == "chat_completions":
        assert outgoing["tool_choice"] == {"type": "function", "function": {"name": "manage_context"}}
    else:
        assert outgoing["tool_choice"] == {"type": "function", "name": "manage_context"}
    assert request == original


@pytest.mark.parametrize("reply,error,with_llm", [
    ('{"intent":"defer"}', None, True),
    ('{"intent":"restore"}', None, True),
    ('{"intent":"unclear"}', None, True),
    ("not-json", None, True),
    ('{"intent":"cleanup_allowed","extra":1}', None, True),
    (None, TimeoutError("timeout"), True),
    (None, None, False),
])
def test_cleanup_intent_fail_closed_keeps_advisory_only(reply, error, with_llm):
    body = "A safe result row.\n" * 2500
    instruction = "Wait; do not clean any results until I ask again."
    request = {
        "input": [
            {"type": "message", "role": "user", "content": instruction},
            {"type": "function_call", "call_id": "call-big", "name": "read_file", "arguments": '{"path":"big.txt"}'},
            {"type": "function_call_output", "call_id": "call-big", "output": body},
        ],
        "tools": [{"type": "function", "name": "manage_context"}],
    }
    llm = _FakeIntentLlm(reply, error) if with_llm else None
    outgoing = plugin.make_middleware(_state(intent_llm=llm))(
        request=request, session_id="fail-closed", api_mode="codex_responses")["request"]
    reminder = outgoing["input"][-1]["content"]
    if isinstance(reminder, list):
        reminder = reminder[0]["text"]
    assert "[context-navigation] eligible=1" in reminder
    assert "tool_choice" not in outgoing
    if llm is not None:
        assert llm.kwargs["purpose"] == "session-navigation-cleanup-intent"
        assert instruction in llm.kwargs["messages"][1]["content"]

@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
@pytest.mark.parametrize("choice_kind", ["allowed_auto", "allowed_required", "required", "typed_required"])
def test_cleanup_reminder_respects_existing_tool_choice(mode, choice_kind):
    body = "A safe result row.\n" * 2500
    if mode == "chat_completions":
        tools = [{"type": "function", "function": {"name": name}} for name in ("manage_context", "unhide_context")]
        request = {
            "messages": [
                {"role": "user", "content": "Read the file and restore a hidden item."},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-big", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"big.txt"}'}}
                ]},
                {"role": "tool", "tool_call_id": "call-big", "content": body},
            ],
            "tools": tools,
        }
    else:
        tools = [{"type": "function", "name": name} for name in ("manage_context", "unhide_context")]
        request = {
            "input": [
                {"type": "message", "role": "user", "content": "Read the file and restore a hidden item."},
                {"type": "function_call", "call_id": "call-big", "name": "read_file", "arguments": '{"path":"big.txt"}'},
                {"type": "function_call_output", "call_id": "call-big", "output": body},
            ],
            "tools": tools,
        }
    if choice_kind.startswith("allowed_"):
        choice = {"type": "allowed_tools", "mode": choice_kind.removeprefix("allowed_"), "tools": tools}
    else:
        choice = "required" if choice_kind == "required" else {"type": "required"}
    request["tool_choice"] = choice
    outgoing = plugin.make_middleware(_state())(request=request, session_id="allowed-tools", api_mode=mode)["request"]
    conversation = outgoing["messages"] if mode == "chat_completions" else outgoing["input"]
    reminder = conversation[-1]["content"]
    if isinstance(reminder, list):
        reminder = reminder[0]["text"]
    assert "[context-navigation]" in reminder
    assert outgoing["tool_choice"] == choice


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
@pytest.mark.parametrize("bridge_args", [
    None,
    '{"calls":[{"name":"list_context_items","arguments":{}}]}',
    r'{"calls":[{"name":"\u006cist_context_items","arguments":{}}]}',
    '{"name":"list_context_items","arguments":{}}',
    json.dumps({"calls": json.dumps([{"name": "list_context_items", "arguments": {}}])}),
])
def test_listing_hidden_items_leaves_restoration_available(mode, bridge_args):
    body = "A safe result row.\n" * 2500
    list_name = "tool_call" if bridge_args is not None else "list_context_items"
    list_args = bridge_args if bridge_args is not None else "{}"
    state = _state()
    compacted = _compact(state, session="restore-list")
    listed = json.dumps(_list(state, session="restore-list"))
    if mode == "chat_completions":
        request = {
            "messages": [
                {"role": "user", "content": "List hidden items and restore the first one."},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-big", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"big.txt"}'}}
                ]},
                {"role": "tool", "tool_call_id": "call-big", "content": body},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-list", "type": "function", "function": {"name": list_name, "arguments": list_args}}
                ]},
                {"role": "tool", "tool_call_id": "call-list", "content": listed},
            ],
            "tools": [
                {"type": "function", "function": {"name": "manage_context"}},
                {"type": "function", "function": {"name": "unhide_context"}},
            ],
        }
    else:
        request = {
            "input": [
                {"type": "message", "role": "user", "content": "List hidden items and restore the first one."},
                {"type": "function_call", "call_id": "call-big", "name": "read_file", "arguments": '{"path":"big.txt"}'},
                {"type": "function_call_output", "call_id": "call-big", "output": body},
                {"type": "function_call", "call_id": "call-list", "name": list_name, "arguments": list_args},
                {"type": "function_call_output", "call_id": "call-list", "output": listed},
            ],
            "tools": [
                {"type": "function", "name": "manage_context"},
                {"type": "function", "name": "unhide_context"},
            ],
        }
    outgoing = plugin.make_middleware(state)(request=request, session_id="restore-list", api_mode=mode)["request"]
    assert "tool_choice" not in outgoing
    assert _restore(state, compacted["item_id"], session="restore-list")["ok"] is True
    assert _list(state, session="restore-list")["items"][0]["visibility"] == "visible"


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_bridge_arguments_mentioning_navigation_do_not_block_cleanup(mode):
    body = "A safe result row.\n" * 2500
    bridge_args = '{"calls":[{"name":"read_file","arguments":{"path":"list_context_items.txt"}}]}'
    if mode == "chat_completions":
        request = {
            "messages": [
                {"role": "user", "content": "Inspect the two files."},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-big", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"big.txt"}'}}
                ]},
                {"role": "tool", "tool_call_id": "call-big", "content": body},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-bridge", "type": "function", "function": {"name": "tool_call", "arguments": bridge_args}}
                ]},
                {"role": "tool", "tool_call_id": "call-bridge", "content": "Small result."},
            ],
            "tools": [{"type": "function", "function": {"name": "manage_context"}}],
        }
        expected = {"type": "function", "function": {"name": "manage_context"}}
    else:
        request = {
            "input": [
                {"type": "message", "role": "user", "content": "Inspect the two files."},
                {"type": "function_call", "call_id": "call-big", "name": "read_file", "arguments": '{"path":"big.txt"}'},
                {"type": "function_call_output", "call_id": "call-big", "output": body},
                {"type": "function_call", "call_id": "call-bridge", "name": "tool_call", "arguments": bridge_args},
                {"type": "function_call_output", "call_id": "call-bridge", "output": "Small result."},
            ],
            "tools": [{"type": "function", "name": "manage_context"}],
        }
        expected = {"type": "function", "name": "manage_context"}
    outgoing = plugin.make_middleware(_state(intent_llm=_FakeIntentLlm('{"intent":"cleanup_allowed"}')))(
        request=request, session_id="unrelated-bridge", api_mode=mode)["request"]
    assert outgoing["tool_choice"] == expected


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_small_request_does_not_force_manage_tool_choice(mode):
    if mode == "chat_completions":
        request = {
            "messages": [
                {"role": "user", "content": "Read a tiny file."},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call-small", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"small.txt"}'}}
                ]},
                {"role": "tool", "tool_call_id": "call-small", "content": "tiny"},
            ],
            "tools": [{"type": "function", "function": {"name": "manage_context"}}],
        }
    else:
        request = {
            "instructions": "Existing system prompt.",
            "input": [
                {"type": "message", "role": "user", "content": "Read a tiny file."},
                {"type": "function_call", "call_id": "call-small", "name": "read_file", "arguments": '{"path":"small.txt"}'},
                {"type": "function_call_output", "call_id": "call-small", "output": "tiny"},
            ],
            "tools": [{"type": "function", "name": "manage_context"}],
        }
    original = copy.deepcopy(request)
    outgoing = plugin.make_middleware(_state())(request=request, session_id="small-existing", api_mode=mode)["request"]
    assert "tool_choice" not in outgoing
    assert request == original


def test_codex_system_input_guidance_is_not_duplicated_into_instructions():
    section = plugin.SUPERVISION_SECTION_TEXT
    request = {
        "instructions": "Base.",
        "input": [
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": section}]},
            {"type": "message", "role": "user", "content": "Continue."},
        ],
        "tools": [{"type": "function", "name": "manage_context"}],
    }
    result = plugin.make_middleware(_state())(request=request, session_id="input-system", api_mode="codex_responses")
    assert result["request"] == request


def test_tool_descriptions_route_human_list_and_restore_requests():
    sections = plugin.TOOL_SCHEMAS
    list_desc = sections["list_context_items"]["description"]
    restore_desc = sections["unhide_context"]["description"]
    assert "user list request" in list_desc and "numbered table" in list_desc
    assert "Restore" in restore_desc and "item_id" in restore_desc
    assert "list" in restore_desc


def test_restore_description_routes_number_references_verbatim():
    desc = plugin.TOOL_SCHEMAS["unhide_context"]["description"]
    assert "item N" in desc and "bind" in desc
    assert "immediately before restore" in desc and "never guess" in desc


def test_numeric_reference_resolves_against_the_last_shown_list():
    state = _state()
    first = _compact(state, "call_1", _body("alpha"))
    second = _compact(state, "call_2", _body("beta"))
    shown = _list(state)
    assert [i["item_id"] for i in shown["items"]] == [second["item_id"], first["item_id"]]
    assert [i["display_number"] for i in shown["items"]] == [1, 2]

    restored = _restore(state, "2번")  # digits + suffix resolve, no ID recall
    assert restored["ok"] is True
    assert restored["item_id"] == first["item_id"]

    # The shown numbers stay stable until the NEXT list call: "1" still names
    # what the user saw as #1, never a number a fresh list would issue.
    late = _restore(state, "#1")
    assert late["ok"] is True
    assert late["item_id"] == second["item_id"]


def test_numeric_reference_fails_closed_without_a_shown_list():
    state = _state()
    compacted = _compact(state, "call_1")
    blocked = _restore(state, "1")
    assert blocked["ok"] is False and blocked["error"] == "no_recent_list"
    # An exact item_id still works without any prior list call.
    exact = _restore(state, compacted["item_id"])
    assert exact["ok"] is True


def test_numeric_reference_out_of_range_and_after_new_list():
    state = _state()
    _compact(state, "call_1")
    _list(state)
    bad = _restore(state, "9")
    assert bad["ok"] is False and bad["error"] == "unknown_display_number"
    stale = _restore(state, "1")
    assert stale["ok"] is True
    _list(state)  # fresh view: nothing compacted, no numbers
    missing = _restore(state, "1")
    assert missing["ok"] is False and missing["error"] == "unknown_display_number"


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_stale_frozen_supervision_section_is_replaced(mode):
    stale = _stale_guidance()
    section = plugin.SUPERVISION_SECTION_TEXT
    if mode == "chat_completions":
        request = {"messages": [{"role": "developer", "content": "Base.\n\n" + stale},
                                {"role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": "Base.\n\n" + stale,
                   "input": [{"type": "message", "role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    original = copy.deepcopy(request)
    outgoing = plugin.make_middleware(_state())(request=request, session_id="stale-section", api_mode=mode)["request"]
    system = outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]
    assert "Old cleanup guidance" not in system
    assert system.endswith(section)
    assert system.count(section) == 1
    assert request == original


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_lookalike_frame_outside_canonical_container_is_preserved(mode):
    lookalike = _frame("Old cleanup guidance without tool calls.")
    section = plugin.SUPERVISION_SECTION_TEXT
    if mode == "chat_completions":
        request = {"messages": [{"role": "developer", "content": "Base.\n\n" + lookalike},
                                {"role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": "Base.\n\n" + lookalike,
                   "input": [{"type": "message", "role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    outgoing = plugin.make_middleware(_state())(request=request, session_id="lookalike-section", api_mode=mode)["request"]
    system = outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]
    assert lookalike in system
    assert system.endswith(section)


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_malformed_frame_keeps_following_prompt_text(mode):
    malformed = _container(_frame("Old cleanup guidance without tool calls.", chars=9999))
    section = plugin.SUPERVISION_SECTION_TEXT
    system_text = "Base.\n\n" + malformed + "\n\nTail after frame."
    if mode == "chat_completions":
        request = {"messages": [{"role": "developer", "content": system_text},
                                {"role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": system_text,
                   "input": [{"type": "message", "role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    outgoing = plugin.make_middleware(_state())(request=request, session_id="malformed-section", api_mode=mode)["request"]
    system = outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]
    assert "Old cleanup guidance" in system
    assert "Tail after frame." in system
    assert system.count(section) == 1


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_stale_and_current_guidance_coexist_only_current_survives(mode):
    stale = _stale_guidance()
    section = plugin.SUPERVISION_SECTION_TEXT
    system_text = "Base.\n\n" + stale + "\n\n" + section
    if mode == "chat_completions":
        request = {"messages": [{"role": "developer", "content": system_text},
                                {"role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": system_text,
                   "input": [{"type": "message", "role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    outgoing = plugin.make_middleware(_state())(request=request, session_id="stale-and-current", api_mode=mode)["request"]
    system = outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]
    assert "Old cleanup guidance" not in system
    assert system.count(section) == 1


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_stale_guidance_in_system_or_developer_slots_is_removed(mode):
    stale = _stale_guidance()
    section = plugin.SUPERVISION_SECTION_TEXT
    stale_message = {"role": "developer" if mode == "chat_completions" else "system",
                     "content": [{"type": "text", "text": "Prefix. " + stale}]}
    if mode == "chat_completions":
        request = {"messages": [{"role": "system", "content": "Base."}, stale_message,
                                {"role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": "Base.", "input": [stale_message,
                   {"type": "message", "role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    original = copy.deepcopy(request)
    outgoing = plugin.make_middleware(_state())(request=request, session_id="stale-slots", api_mode=mode)["request"]
    slot = outgoing["messages"][1] if mode == "chat_completions" else outgoing["input"][0]
    assert "Old cleanup guidance" not in json.dumps(slot, ensure_ascii=False)
    if mode == "chat_completions":
        assert outgoing["messages"][0]["content"].endswith(section)
    else:
        assert outgoing["instructions"].endswith(section)
    assert request == original


@pytest.mark.parametrize("case", ["allowed_tools_no_cleanup", "allowed_tools_with_cleanup"])
def test_allowed_tools_choice_controls_supervision(case):
    section = plugin.SUPERVISION_SECTION_TEXT
    tools = [{"type": "function", "function": {"name": "manage_context"}},
             {"type": "function", "function": {"name": "read_file"}}]
    allowed = ["read_file"] if case == "allowed_tools_no_cleanup" else ["manage_context"]
    request = {"messages": [{"role": "system", "content": "Base."},
                            {"role": "user", "content": "Continue."}],
               "tools": tools,
               "tool_choice": {"type": "allowed_tools",
                               "tools": [{"type": "function", "function": {"name": name}} for name in allowed]}}
    outgoing = plugin.make_middleware(_state())(
        request=request, session_id="allowed-tools", api_mode="chat_completions")["request"]
    system = outgoing["messages"][0]["content"]
    assert (section in system) is (case == "allowed_tools_with_cleanup")


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_disabled_child_and_protection_only_remove_framed_supervision(mode):
    framed = _container(_frame(plugin.SUPERVISION_SECTION_TEXT))
    section = plugin.SUPERVISION_SECTION_TEXT
    if mode == "chat_completions":
        request = {"messages": [{"role": "developer", "content": "Base.\n\n" + framed},
                                {"role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "function": {"name": "manage_context"}}]}
    else:
        request = {"instructions": "Base.\n\n" + framed,
                   "input": [{"type": "message", "role": "user", "content": "Continue."}],
                   "tools": [{"type": "function", "name": "manage_context"}]}
    original = copy.deepcopy(request)

    def system(outgoing):
        return outgoing["messages"][0]["content"] if mode == "chat_completions" else outgoing["instructions"]

    disabled_state = _state(is_enabled=lambda: False)
    disabled = plugin.make_middleware(disabled_state)(
        request=request, session_id="disabled-framed", api_mode=mode)
    assert disabled is not None
    assert section not in system(disabled["request"])
    assert "## Plugin Context:" not in system(disabled["request"])

    child_state = _state()
    child_state.child_links["child-framed"] = {"parent_scope": "hermes:default:parent"}
    child = plugin.make_middleware(child_state)(
        request=request, session_id="child-framed", api_mode=mode)
    assert child is not None
    assert section not in system(child["request"])
    assert "## Plugin Context:" not in system(child["request"])
    assert request == original


@pytest.mark.parametrize("case", ["missing", "not_string"])
def test_codex_without_usable_instructions_sets_instructions_not_input_role(case):
    section = plugin.SUPERVISION_SECTION_TEXT
    request = {
        "input": [{"type": "message", "role": "user", "content": "Continue."}],
        "tools": [{"type": "function", "name": "manage_context"}],
    }
    if case == "not_string":
        request["instructions"] = {"unexpected": "shape"}
    original = copy.deepcopy(request)
    outgoing = plugin.make_middleware(_state())(
        request=request, session_id="codex-no-instructions", api_mode="codex_responses")["request"]
    assert outgoing["instructions"] == section
    assert outgoing["input"] == original["input"]
    assert not any(item.get("role") == "developer" for item in outgoing["input"])
    assert request == original


def test_protection_only_rewrite_removes_framed_supervision():
    framed = _container(_frame(plugin.SUPERVISION_SECTION_TEXT))
    state = _state(is_enabled=lambda: False)
    scope = plugin.scope_for(state, SESSION)
    request = {"messages": [{"role": "developer", "content": "Base.\n\n" + framed},
                            {"role": "user", "content": "Continue."}]}
    factories = hermes_adapter().factories
    outgoing = factories._protection_only_rewrite(
        state, scope, "chat_completions", request, [], set())["request"]


def test_numeric_reference_keeps_working_after_a_restore():
    state = _state()
    _compact(state, "call_1", _body("alpha"))
    second = _compact(state, "call_2", _body("beta"))
    _list(state)  # 1 = second, 2 = first

    first_restore = _restore(state, "1")
    assert first_restore["item_id"] == second["item_id"]
    second_restore = _restore(state, " 2 ")  # surrounding whitespace tolerated
    assert second_restore["ok"] is True


def test_fixed_id_restore_after_recheck_keeps_original_target():
    state = _state()
    first = _compact(state, "call_1", _body("alpha"))
    _compact(state, "call_2", _body("beta"))
    shown = _list(state)
    fixed = next(
        item["item_id"] for item in shown["items"] if item["display_number"] == 2
    )
    assert fixed == first["item_id"]

    # New compact changes the numbering: the same number now names another item.
    _compact(state, "call_3", _body("gamma"))
    rechecked = _list(state)
    assert rechecked["items"][1]["item_id"] != fixed

    # Required path: restore the fixed exact ID, not the new number.
    restored = _restore(state, fixed)
    assert restored["ok"] is True
    assert restored["item_id"] == fixed
    after = _list(state)
    assert next(
        item["visibility"] for item in after["items"] if item["item_id"] == fixed
    ) == "visible"
