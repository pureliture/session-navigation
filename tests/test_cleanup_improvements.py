"""Offline boundary, rule and host request-copy regressions."""
import copy
import json

import pytest

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope
from session_navigation.policy import HIGH_SIGNAL_BYTES, RuleSpanSelector, strip_consecutive_numbering
from session_navigation.reminders import BoundaryReminders, NOTE_BYTES
from test_engine import _make_record
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


@pytest.mark.parametrize("keep", ["owner=Orchid", {}, 3])
def test_invalid_keep_is_rejected_without_storage(keep):
    engine = SessionNavigationEngine()
    scope = Scope("test", "default", "s")
    result = engine.compact_sync(scope, _make_record(body()), keep_lines=keep)
    assert result.error == "invalid_keep_lines"
    assert not engine.store.items(scope)


@pytest.mark.parametrize("entry,reason", [("invented=other", "not found verbatim"), ("", "empty"),
    (3, "must be a string"), ("a\nb", "single line"), ("a\rb", "single line")])
def test_invalid_entries_are_ignored_with_english_reasons(entry, reason):
    result = SessionNavigationEngine().compact_sync(Scope("test", "default", "s"), _make_record(body()),
        keep_lines=[entry, "rare middle sentence"])
    assert result.ok
    assert result.keep_lines_ignored[0]["entry"] == entry
    assert reason in result.keep_lines_ignored[0]["reason"]
    assert "rare middle sentence" in result.item.compacted
    assert result.item.original == body()


@pytest.mark.parametrize("entry", ["  rare middle sentence  ", "20:rare middle sentence", " 20| rare middle sentence "])
def test_keep_normalization_is_reported_and_preserves_exact_source(entry):
    result = SessionNavigationEngine().compact_sync(Scope("test", "default", "s"), _make_record(body()), keep_lines=[entry])
    assert result.ok and not result.keep_lines_ignored
    assert result.keep_lines_normalized == ({"entry": entry, "accepted": "rare middle sentence"},)
    assert "Original excerpt: A rare middle sentence that the agent selects." in result.item.compacted
    assert result.item.original == body()


def test_keep_budget_drops_only_overflow_then_accepts_later_entries():
    from session_navigation.policy import normalize_keep_lines
    text = "a" * 700 + "\n" + "b" * 400 + "\nshort"
    valid, ignored, normalized = normalize_keep_lines(text, ["a" * 700, "b" * 400, "short"])
    assert valid == ["a" * 700, "short"]
    assert "1024-byte" in ignored[0]["reason"]
    assert not normalized
    assert normalize_keep_lines("20:literal", ["20:literal"])[0] == ["20:literal"]


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


def test_rule_keeps_numbered_metadata_from_captured_audit_outputs():
    owner_line = "20:owner=atlas-team-7"
    seal_line = "47:audit_seal=atlas-82ca4eacc8"
    lines = [f"{index}:2026-10-07T00:{index:02d}:00Z region us-east service atlas-svc-{index % 7}"
             for index in range(1, 61)]
    lines[19] = owner_line
    lines[46] = seal_line
    choice = RuleSpanSelector().select("\n".join(lines))
    assert owner_line in choice.lines
    assert seal_line in choice.lines


def test_rule_keeps_metadata_from_consecutively_numbered_hermes_read_output():
    lines = [f"{index}|2026-10-07T00:{index:02d}:00Z region us-east service atlas-svc-{index % 7}"
             for index in range(1, 61)]
    lines[19] = "20|owner=atlas-team-7"
    lines[46] = "47|audit_seal=atlas-82ca4eacc8"
    choice = RuleSpanSelector().select(strip_consecutive_numbering("\n".join(lines)))
    assert "owner=atlas-team-7" in choice.lines
    assert "audit_seal=atlas-82ca4eacc8" in choice.lines


def test_all_model_facing_text_is_english():
    from session_navigation.policy import render_compaction
    from hermes_navigation_adapter.schemas import SUPERVISION_SECTION_TEXT

    items = [{"tool_call_id": "chatcmpl-tool-0000000000000001", "tool_name": "read",
              "hint": "audit-01.jsonl", "bytes_size": 40_000, "turn": 1}]
    surfaces = [
        render_compaction("item_1", ["owner=Orchid"]),
        render_compaction("item_1", ["owner=Orchid"], summary_text={"summary": "text"},
                          facts={"exit_code": 0}, options_omitted=True),
        BoundaryReminders().note("s", "1", 100, 1000, items),
        SUPERVISION_SECTION_TEXT,
        json.dumps(hermes_adapter().plugin.TOOL_SCHEMAS, ensure_ascii=False),
    ]
    for surface in surfaces:
        assert surface
        assert not any("\uac00" <= char <= "\ud7a3" for char in surface), surface


def test_reminder_state_machine_silences_small_reads_prevents_oscillation_and_ignores_occupancy():
    reminders = BoundaryReminders()
    assert reminders.note("s", "", 100, 1000, [{"tool_call_id": "x", "bytes_size": 40_000}]) is None
    # Request 1 (after_tool=False) and <32 KiB reads stay silent; 20 KiB carries over from Turn 1 into Turn 2 post-tool!
    assert reminders.note("s", "1", 1000, 128_000, [], after_tool=False) is None
    tiny = [{"tool_call_id": "t0", "tool_name": "read", "hint": "a.py", "bytes_size": 4096, "turn": 1}]
    assert reminders.note("s", "1", 2000, 128_000, tiny, after_tool=True) is None
    u1 = [{"tool_call_id": f"u1-{i}", "tool_name": "read", "hint": "a.txt", "bytes_size": 4000, "turn": 1} for i in range(5)]
    assert reminders.note("s", "1", 8000, 128_000, u1, after_tool=True) is None
    assert reminders.note("s", "2", 9000, 128_000, u1, after_tool=False) is None

    items = [
        {"tool_call_id": f"chatcmpl-tool-{i:016x}", "tool_name": "read", "hint": "phase.txt", "bytes_size": 4000, "turn": 2}
        for i in range(14)
    ]
    note = reminders.note("s", "2", 18_000, 128_000, items, after_tool=True)
    assert note is not None and "eligible=14 (54 KiB)" in note and "via list_context_items" not in note
    assert len(note.encode()) <= NOTE_BYTES
    assert len(note.splitlines()) == 15
    assert json.loads(note.splitlines()[1])[0] == items[0]["tool_call_id"]
    assert reminders.note("s", "2", 19_000, 128_000, items, after_tool=True) is not None

    # Once Turn 3 starts without cleanup, unfired_credit clears; chat-only turns and a tiny 2 KiB read stay silent!
    assert reminders.note("s", "3", 19_500, 128_000, items, after_tool=False) is None
    plus_small = [{"tool_call_id": "tiny-keep", "tool_name": "read", "hint": "c.py", "bytes_size": 2048, "turn": 3}, *items]
    assert reminders.note("s", "3", 20_000, 128_000, plus_small, after_tool=True) is None

    # Context occupancy % (50%, 75%, 85%, 95%) never triggers a reminder; global window compaction belongs to the host.
    for turn_id, tok in (("5", 64_000), ("6", 96_000), ("7", 110_000), ("8", 122_000)):
        assert reminders.note("s", turn_id, tok, 128_000, plus_small, after_tool=False) is None
        assert reminders.note("s", turn_id, tok, 128_000, plus_small, after_tool=True) is None

    # Partial cleanup (105K fire -> hide 10K to 95K -> +6K to 101K) stays silent; full cleanup resets for next wave!
    osc = BoundaryReminders()
    c95 = [{"tool_call_id": "o1", "tool_name": "bash", "hint": "logs", "bytes_size": 95 * 1024, "turn": 1}]
    c105 = [{"tool_call_id": "o2", "tool_name": "bash", "hint": "logs", "bytes_size": 10 * 1024, "turn": 1}, *c95]
    c101 = [{"tool_call_id": "o3", "tool_name": "bash", "hint": "logs", "bytes_size": 6 * 1024, "turn": 1}, *c95]
    assert osc.note("big", "1", 28_000, 1_048_576, c105, after_tool=True) is not None
    assert osc.note("big", "1", 25_000, 1_048_576, c95, after_tool=False) is None
    assert osc.note("big", "1", 27_000, 1_048_576, c101, after_tool=True) is None
    assert osc.note("big", "1", 5_000, 1_048_576, [], after_tool=False) is None
    second_wave = [{"tool_call_id": "w1", "tool_name": "read", "hint": "b.txt", "bytes_size": 120_000, "turn": 1}]
    assert osc.note("big", "1", 35_000, 1_048_576, second_wave, after_tool=True) is not None

    # suppress_unhide absorbs restored byte growth without firing.
    osc.suppress_unhide("big")
    restored = [{"tool_call_id": "u1", "tool_name": "read", "hint": "r.txt", "bytes_size": 180_000, "turn": 1}, *second_wave]
    assert osc.note("big", "1", 850_000, 1_048_576, restored, after_tool=True) is None

    huge = [{"tool_call_id": "a" * 2000, "tool_name": "read", "hint": "h.txt", "bytes_size": 40_000, "turn": 1}]
    assert "a" * 100 not in BoundaryReminders().note("huge", "1", 100, None, huge)

def cleanup_session(records):
    plugin = hermes_adapter().plugin
    state = plugin.PluginState(is_enabled=lambda: True, count_middlewares=lambda: 0)
    messages = []
    for call_id, content in records:
        messages.extend([
            {"role": "assistant", "tool_calls": [{"id": call_id, "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"sample.txt"}'}}]},
            {"role": "tool", "tool_call_id": call_id, "content": content},
        ])
    request = {"messages": messages}
    middleware = plugin.make_middleware(state)
    middleware(request=request, session_id="s", api_mode="chat_completions")
    return plugin, state, middleware, request


def test_engine_hide_keep_lines_and_unlisted_targets():
    plugin, state, middleware, request = cleanup_session([(f"r{i}", body()) for i in range(5)])
    original = copy.deepcopy(request)
    listed = json.loads(plugin.make_list_handler(state)({"view": "candidates", "limit": 3}, session_id="s"))
    assert len(json.loads(plugin.make_list_handler(state)({"view": "candidates"}, session_id="s"))["items"]) == 5
    assert "r0" not in [item["tool_call_id"] for item in listed["items"]]
    manage = plugin.make_manage_handler(state)
    result = json.loads(manage({"tool_call_ids": ["r0"], "action": "hide", "keep_lines": ["rare middle sentence"]}, session_id="s"))
    assert result["applied"] == 1
    patched = middleware(request=request, session_id="s", api_mode="chat_completions")["request"]
    assert "rare middle sentence" in patched["messages"][1]["content"]
    assert patched["messages"][1]["content"] != body()
    mixed = json.loads(manage({"tool_call_ids": ["r1", "r2"], "action": "hide",
                 "keep_lines": ["20:rare middle sentence", "invented"]}, session_id="s"))
    assert mixed["applied"] == 2 and mixed["failed"] == 0
    for item in mixed["items"]:
        assert item["keep_lines_ignored"][0]["entry"] == "invented"
        assert "not found verbatim" in item["keep_lines_ignored"][0]["reason"]
        assert item["keep_lines_normalized"][0]["accepted"] == "rare middle sentence"
    assert json.loads(manage({"tool_call_ids": ["r1"], "action": "auto", "keep_lines": []}, session_id="s"))["error"] == "invalid_keep_lines_action"
    assert request == original


def test_batch_keep_lines_are_resolved_independently_for_each_target():
    records = [(name, f"Report: {name}\nSigned-live generation 42\n" + body()) for name in ("integration", "linker")]
    plugin, state, middleware, request = cleanup_session(records)
    original = copy.deepcopy(request)
    result = json.loads(plugin.make_manage_handler(state)({"tool_call_ids": ["integration", "linker"], "action": "hide",
        "keep_lines": ["Report: integration", "Report: linker", "Signed-live generation 42", "invented"]}, session_id="s"))
    assert result["applied"] == 2 and result["failed"] == 0
    for row, other in zip(result["items"], ("linker", "integration")):
        assert [entry["entry"] for entry in row["keep_lines_ignored"]] == [f"Report: {other}", "invented"]
    patched = middleware(request=request, session_id="s", api_mode="chat_completions")["request"]
    for index, name in ((1, "integration"), (3, "linker")):
        assert f"Report: {name}" in patched["messages"][index]["content"]
        assert "Signed-live generation 42" in patched["messages"][index]["content"]
        assert patched["messages"][index]["content"] != records[index // 2][1]
    assert request == original


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_hermes_tail_note_is_not_persisted_or_used_to_restrict_ids(mode):
    adapter = hermes_adapter()
    state = adapter.plugin.PluginState(is_enabled=lambda: True, count_middlewares=lambda: 0)
    state.usage.observe(session_id="s", usage={"prompt_tokens": 20000}, context_length=128000)
    middleware = adapter.plugin.make_middleware(state)
    key = "messages" if mode == "chat_completions" else "input"
    messages = [{"role": "user", "content": "Inspect these files"}]
    for i in range(7):
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
    assert "eligible=7" in note
    assert "via list_context_items" not in note
    assert '"c0"' in note and '"c6"' in note
    assert len(note.splitlines()) == 8
    assert json.loads(note.splitlines()[1])[-1] == 1
    assert len(note.encode()) <= NOTE_BYTES
    assert middleware(request=request, session_id="s", api_mode=mode, context_length=128000)["request"] == original
    handler = adapter.plugin.make_manage_handler(state)
    result = json.loads(handler({"tool_call_ids": ["c0"], "action": "hide", "keep_lines": ["rare middle sentence"]}, session_id="s"))
    assert result["applied"] == 1
    out = middleware(request=request, session_id="s", api_mode=mode)["request"]
    assert "rare middle sentence" in json.dumps(out)
    assert request == original
    mixed = json.loads(handler({"tool_call_ids": ["c1", "c2"], "action": "hide",
        "keep_lines": [" 20:rare middle sentence ", "invented"]}, session_id="s"))
    assert mixed["applied"] == 2 and mixed["failed"] == 0
    for item in mixed["items"]:
        assert item["keep_lines_ignored"][0]["entry"] == "invented"
        assert "not found verbatim" in item["keep_lines_ignored"][0]["reason"]
        assert item["keep_lines_normalized"][0]["accepted"] == "rare middle sentence"
    assert request == original
    assert state.summarizer is None



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
