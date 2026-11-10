"""A-plan supervision contracts; local requests only, no agent/provider calls."""
from __future__ import annotations
import os, tempfile, gc, pytest

import json

from _adapter_loader import hermes_adapter

plugin = hermes_adapter().plugin
SESSION = "human-supervision-session"


def _state(**overrides):
    return plugin.PluginState(
        is_enabled=lambda: True, count_middlewares=lambda: 0, **overrides,
    )


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
