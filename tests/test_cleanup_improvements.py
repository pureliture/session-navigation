"""Offline boundary, rule and host request-copy regressions."""
import copy
import json

import pytest

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope
from session_navigation.policy import HIGH_SIGNAL_BYTES, RuleSpanSelector
from session_navigation.reminders import BoundaryReminders, NOTE_BYTES
from test_engine import _make_record
from test_omp_daemon import Daemon, call, record
from _adapter_loader import hermes_adapter


def body():
    lines = [f"fixture row {i:04}: details value={i}" for i in range(160)]
    lines[30:33] = ["owner=Orchid", "completion_code=done-1", "Seal: harbor-91"]
    lines[80] = "A rare middle sentence that the agent selects."
    return "\n".join(lines)


def test_rule_keeps_middle_metadata_and_exact_agent_substrings_without_model():
    engine = SessionNavigationEngine()
    result = engine.compact_sync(Scope("test", "default", "s"), _make_record(body()),
                                 keep_lines=["rare middle sentence"])
    assert result.ok
    assert result.item.original == body()
    assert result.item.compaction_source == "rule"
    for line in ["owner=Orchid", "completion_code=done-1", "Seal: harbor-91", "rare middle sentence"]:
        assert line in result.item.compacted
    assert len(result.item.compacted) < len(body()) / 2
    assert engine.restore(Scope("test", "default", "s"), result.item.item_id).ok


@pytest.mark.parametrize("keep", ["owner=Orchid", ["invented=other"], [""], [3], ["owner=Orchid\ncompletion_code=done-1"], ["x" * 1025]])
def test_invalid_keep_is_rejected_without_storage(keep):
    engine = SessionNavigationEngine()
    scope = Scope("test", "default", "s")
    result = engine.compact_sync(scope, _make_record(body()), keep_lines=keep)
    assert result.error == "invalid_keep_lines"
    assert not engine.store.items(scope)


def test_empty_keep_and_cached_rehide_do_not_silently_drop_new_requirements():
    engine = SessionNavigationEngine()
    scope = Scope("test", "default", "s")
    rec = _make_record(body())
    result = engine.compact_sync(scope, rec, keep_lines=[])
    assert result.ok
    assert engine.compact_sync(scope, rec, keep_lines=["rare middle sentence"]).error == "keep_lines_conflict"


def test_signal_budget_skips_filler_and_retains_warning():
    text = body() + "\n" + "\n".join(f"key{i}=" + "a" * 90 for i in range(100))
    choice = RuleSpanSelector().select(text)
    selected = [line for line in choice.lines if line.startswith("key") and line not in text.splitlines()[-2:]]
    assert sum(len(line.encode()) + 1 for line in selected) <= HIGH_SIGNAL_BYTES
    assert len(choice.lines) < 25
    warning = RuleSpanSelector().select(body().replace("owner=Orchid", "WARN retry budget low"))
    assert "WARN retry budget low" in warning.lines


def test_reminder_boundaries_thresholds_empty_sessions_and_literal_ids():
    reminders = BoundaryReminders()
    items = [{"tool_call_id": f"chatcmpl-tool-{i:016x}", "tool_name": "read", "hint": "phase.txt", "bytes_size": 4000, "turn": 1} for i in range(20)]
    assert reminders.note("s", "1", 100, 1000, []) is None
    assert reminders.note("s", "", 100, 1000, items) is None
    note = reminders.note("s", "1", 100, 1000, items)
    assert "eligible=20" in note and len(note.encode()) <= NOTE_BYTES
    assert len(note.splitlines()) == 4
    assert json.loads(note.splitlines()[1])[0] == items[0]["tool_call_id"]
    assert "summarize facts still needed" in note
    assert reminders.note("s", "1", 499, 1000, items) is None
    for tokens in (500, 750, 900):
        assert reminders.note("s", "1", tokens, 1000, items)
        assert reminders.note("s", "1", tokens, 1000, items) is None
    assert reminders.note("s", "1", 500, 1000, items) is None
    assert reminders.note("s", "2", 100, 1000, items)
    assert reminders.note("other", "1", 100, None, items)
    huge = [{**items[0], "tool_call_id": "a" * 2000}]
    assert "a" * 100 not in reminders.note("s", "3", 100, None, huge)


def test_daemon_hide_keep_lines_and_unlisted_targets():
    daemon = Daemon()
    records = [record(f"r{i}", body()) for i in range(5)]
    call(daemon, "prepare", snapshot_id="one", records=records)
    listed = call(daemon, "list_candidates", snapshot_id="one", limit=3)
    assert listed["total"] == 5
    assert "r0" not in [item["tool_call_id"] for item in listed["items"]]
    result = call(daemon, "manage", snapshot_id="one", tool_call_ids=["r0"], action="hide", keep_lines=["rare middle sentence"])
    assert result["applied"] == 1
    patched = call(daemon, "prepare", snapshot_id="two", records=records)
    assert "rare middle sentence" in patched["patches"][0]["text"]
    assert call(daemon, "manage", snapshot_id="two", tool_call_ids=["r1"], action="hide", keep_lines=["invented"])["items"][0]["error"] == "invalid_keep_lines"
    assert call(daemon, "manage", snapshot_id="two", tool_call_ids=["r1"], action="auto", keep_lines=[])["error"] == "invalid_keep_lines_action"


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_hermes_tail_note_is_not_persisted_or_used_to_restrict_ids(mode):
    adapter = hermes_adapter()
    state = adapter.plugin.PluginState(is_enabled=lambda: True, count_middlewares=lambda: 0)
    state.usage.observe(session_id="s", usage={"prompt_tokens": 20000}, context_length=128000)
    middleware = adapter.plugin.make_middleware(state)
    key = "messages" if mode == "chat_completions" else "input"
    messages = [{"role": "user", "content": "Inspect these files"}]
    for i in range(5):
        if mode == "chat_completions":
            messages.extend([{"role": "assistant", "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"phase.txt"}'}}]},
                             {"role": "tool", "tool_call_id": f"c{i}", "content": body()}])
        else:
            messages.extend([{"type": "function_call", "call_id": f"c{i}", "name": "read_file", "arguments": '{"path":"phase.txt"}'},
                             {"type": "function_call_output", "call_id": f"c{i}", "output": body()}])
    request = {key: messages}
    original = copy.deepcopy(request)
    out = middleware(request=request, session_id="s", api_mode=mode)["request"]
    assert request == original
    assert out[key][:-1] == messages
    note = out[key][-1]["content"]
    if isinstance(note, list):
        note = note[0]["text"]
    assert "eligible=5" in note
    assert "/128000 tokens" in note
    assert json.loads(note.splitlines()[1])[-1] == 1
    assert len(note.encode()) <= NOTE_BYTES
    assert middleware(request=request, session_id="s", api_mode=mode, context_length=128000)["request"] == original
    handler = adapter.plugin.make_manage_handler(state)
    result = json.loads(handler({"tool_call_ids": ["c0"], "action": "hide", "keep_lines": ["rare middle sentence"]}, session_id="s"))
    assert result["applied"] == 1
    out = middleware(request=request, session_id="s", api_mode=mode)["request"]
    assert "rare middle sentence" in json.dumps(out)
    assert request == original
    bad = json.loads(handler({"tool_call_ids": ["c1"], "action": "hide", "keep_lines": ["invented"]}, session_id="s"))
    assert bad["items"][0]["error"] == "invalid_keep_lines"
    assert state.summarizer is None


def test_hermes_action_first_guidance_and_discovery_description():
    schemas = hermes_adapter().plugin.TOOL_SCHEMAS
    assert schemas["list_context_items"]["description"].startswith("Discover visible cleanup IDs")
    from hermes_navigation_adapter.schemas import SUPERVISION_SECTION_TEXT
    assert SUPERVISION_SECTION_TEXT.startswith("At work-unit boundaries")
    assert "tool_describe, then tool_call" in SUPERVISION_SECTION_TEXT


@pytest.mark.parametrize("content", ["tiny", "ERROR do not discard\n" + body()])
def test_no_note_or_hide_for_ineligible_results(content):
    adapter = hermes_adapter()
    state = adapter.plugin.PluginState(is_enabled=lambda: True, count_middlewares=lambda: 0)
    request = {"messages": [{"role": "user", "content": "Inspect file"},
                {"role": "assistant", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"sample.txt"}'}}]},
                {"role": "tool", "tool_call_id": "c", "content": content}]}
    out = adapter.plugin.make_middleware(state)(request=request, session_id="s", api_mode="chat_completions")
    assert out["request"] == request
    result = json.loads(adapter.plugin.make_manage_handler(state)({"tool_call_ids": ["c"], "action": "hide"}, session_id="s"))
    assert result["applied"] == 0


def test_keep_lines_from_decoded_hermes_envelope():
    engine = SessionNavigationEngine()
    text = body()
    envelope = json.dumps({"path": "sample.txt", "total_lines": 160,
                           "content": "\n".join(f"{i + 1}|{line}" for i, line in enumerate(text.splitlines()))})
    result = engine.compact_sync(Scope("test", "default", "s"), _make_record(envelope), keep_lines=["rare middle sentence"])
    assert result.ok
    assert "rare middle sentence" in result.item.compacted
    assert "owner=Orchid" in result.item.compacted
    assert result.item.original == envelope
