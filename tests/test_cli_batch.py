import json

import pytest

from session_navigation import cli
from session_navigation.db import DBError
from session_navigation.model import ContextItem, MutationResult, ToolResultRecord, compute_sha256
from session_navigation.sqlite_store import SQLiteContextStore


@pytest.fixture
def state(tmp_path):
    path = str(tmp_path / "state.sqlite3")
    store = SQLiteContextStore(path)
    for name in ("a", "b", "c"):
        assert store.put("scope", ContextItem(
            item_id=name, tool_call_id=f"call-{name}", content_sha256=name,
            original=f"original {name}", compacted=f"summary {name}", excerpt_lines=(),
            visibility="visible", version=1, compaction_source="rule",
        )).ok
    store.close()
    return path


def invoke(capsys, state, command, items, *extra):
    code = cli.main([command, "--scope", "scope", "--path", state,
                     "--items-json", json.dumps(items), *extra])
    return code, json.loads(capsys.readouterr().out)


@pytest.mark.parametrize("mode,source", [("hide", "explicit_user_hide"), ("summarize", "summarize_pending")])
def test_batch_hide_and_restore(state, capsys, mode, source):
    requests = [{"item_id": name, "expected_version": 1} for name in ("a", "b")]
    code, result = invoke(capsys, state, "hide", requests, "--mode", mode)
    assert code == 0
    assert result == {"ok": True, "applied": 2, "failed": 0, "items": [
        {"item_id": name, "ok": True, "status": "hidden", "visibility": "hidden", "version": 2}
        for name in ("a", "b")
    ]}
    store = SQLiteContextStore(state)
    assert all(store.get("scope", name).compaction_source == source for name in ("a", "b"))
    store.close()
    assert cli.main(["list", "--scope", "scope", "--path", state]) == 0
    listed = json.loads(capsys.readouterr().out)["items"]
    assert all(row["compaction_source"] == source for row in listed if row["item_id"] in ("a", "b"))
    code, result = invoke(capsys, state, "unhide", [
        {"item_id": name, "expected_version": 2} for name in ("a", "b")
    ])
    assert code == 0 and result["applied"] == 2
    assert all(item["visibility"] == "visible" and item["version"] == 3 for item in result["items"])
    assert cli.main(["list", "--scope", "scope", "--path", state]) == 0
    rows = json.loads(capsys.readouterr().out)["items"]
    assert all(row["summary_line"] == f"original {row['item_id']}" for row in rows)


@pytest.mark.parametrize("command", ["hide", "unhide"])
def test_conflicts_and_missing_items_do_not_abort(state, capsys, command):
    code, result = invoke(capsys, state, command, [
        {"item_id": "a", "expected_version": 0},
        {"item_id": "b", "expected_version": 1},
        {"item_id": "missing"},
        {"item_id": "c", "expected_version": 1},
    ])
    assert code == 2
    assert (result["ok"], result["applied"], result["failed"]) == (False, 2, 2)
    assert [item.get("error") for item in result["items"]] == ["version_conflict", None, "not_found", None]


def test_batch_cas_applies_even_to_idempotent_hide(state, capsys):
    invoke(capsys, state, "hide", [{"item_id": "a"}])
    code, result = invoke(capsys, state, "hide", [{"item_id": "a", "expected_version": 1}])
    assert code == 2 and result["items"][0]["error"] == "version_conflict"


@pytest.mark.parametrize("command", ["hide", "unhide"])
def test_empty_batch(state, capsys, command):
    assert invoke(capsys, state, command, []) == (0, {
        "ok": True, "applied": 0, "failed": 0, "items": [],
    })


@pytest.mark.parametrize("items", ["{}", "[{}]", '[{"item_id":"a","expected_version":true}]', "invalid"])
def test_invalid_batch_rejected(state, items):
    with pytest.raises(SystemExit) as error:
        cli.main(["hide", "--scope", "scope", "--path", state, "--items-json", items])
    assert error.value.code == 2


def test_single_item_output_compatibility(state, capsys):
    assert cli.main(["hide", "--scope", "scope", "--path", state, "--item-id", "a", "--expected-version", "1"]) == 0
    assert capsys.readouterr().out == '{"ok": true, "item_id": "a", "visibility": "hidden", "version": 2, "source": "explicit_user_hide"}\n'
    assert cli.main(["unhide", "--scope", "scope", "--path", state, "--item-id", "a", "--expected-version", "2"]) == 0
    assert capsys.readouterr().out == '{"ok": true, "item_id": "a", "visibility": "visible", "version": 3}\n'


def test_batch_uses_one_store_and_stops_on_db_error(state, capsys, monkeypatch):
    opened = []
    original = cli._store
    def store_factory(path):
        store = original(path)
        opened.append(store)
        return store
    monkeypatch.setattr(cli, "_store", store_factory)
    calls = []
    def fail_put(self, scope, item, **kwargs):
        calls.append(item.item_id)
        return MutationResult(ok=False, error="db_error")
    monkeypatch.setattr(SQLiteContextStore, "put", fail_put)
    assert invoke(capsys, state, "hide", [{"item_id": "a"}, {"item_id": "b"}]) == (
        3, {"ok": False, "error": "db_error"},
    )
    assert len(opened) == 1 and calls == ["a"]


def test_batch_db_open_failure(capsys, monkeypatch):
    def fail(path):
        raise DBError("unavailable")
    monkeypatch.setattr(cli, "_store", fail)
    assert invoke(capsys, "unused", "hide", [{"item_id": "a"}]) == (
        3, {"ok": False, "error": "db_error"},
    )


@pytest.mark.parametrize("command", ["cat sample.txt", "rm sample.txt"])
def test_batch_materializes_unrecorded_tools_and_restores_timeline_snippets(state, capsys, monkeypatch, command):
    content = "\n".join(f"row {index}: original result" for index in range(100))
    record = ToolResultRecord(
        call_id="unrecorded", content=content, content_sha256=compute_sha256(content),
        invocation={"tool_name": "bash", "arguments": {"command": command}},
    )
    timeline = [{"kind": "tool", "tool_call_id": record.call_id, "item_id": record.call_id,
                 "tool_name": "bash", "summary_line": f"$ {command}", "bytes_size": len(content)}]
    monkeypatch.setattr(cli, "_load_omp_session_timeline", lambda scope: (timeline, {record.call_id: record}))
    code, hidden = invoke(capsys, state, "hide", [{"item_id": record.call_id, "expected_version": 1}])
    assert code == 0 and hidden["applied"] == 1
    item = hidden["items"][0]
    code, restored = invoke(capsys, state, "unhide", [
        {"item_id": item["item_id"], "expected_version": item["version"]},
    ])
    assert code == 0 and restored["applied"] == 1
    assert cli.main(["list", "--scope", "scope", "--path", state]) == 0
    assert json.loads(capsys.readouterr().out)["items"][0]["summary_line"] == f"$ {command}"


def test_batch_db_error_after_commits_reports_applied_items(state, capsys, monkeypatch):
    original_put = SQLiteContextStore.put
    calls = []
    def flaky_put(self, scope, item, **kwargs):
        calls.append(item.item_id)
        if len(calls) > 1:
            return MutationResult(ok=False, error="db_full")
        return original_put(self, scope, item, **kwargs)
    monkeypatch.setattr(SQLiteContextStore, "put", flaky_put)
    code, payload = invoke(capsys, state, "hide", [{"item_id": "a"}, {"item_id": "b"}])
    assert code == 3
    assert payload["ok"] is False and payload["error"] == "db_full"
    assert payload["applied"] == 1 and payload["failed"] == 1
    assert [(i["item_id"], i["ok"]) for i in payload["items"]] == [("a", True), ("b", False)]
    assert payload["items"][1]["error"] == "db_full"
