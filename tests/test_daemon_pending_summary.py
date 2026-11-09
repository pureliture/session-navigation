import json

from session_navigation import cli
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation_omp.daemon import Daemon

OUTPUT = "\n".join(f"line {i}: value {i * 7}" for i in range(40))
MESSAGES = [
    {"role": "assistant", "timestamp": 1, "content": [{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "cat data"}}]},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "isError": False, "content": [{"type": "text", "text": OUTPUT}]},
]


def setup(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    (home / ".omp/agent/sessions/p").mkdir(parents=True)
    (home / ".omp/agent/sessions/p/2026_sid.jsonl").write_text("\n".join(json.dumps({"type": "message", "message": m}) for m in MESSAGES))
    monkeypatch.setenv("HOME", str(home))
    state = str(tmp_path / "s.db")
    assert cli.main(["hide", "--scope", "pi:default:sid:default", "--path", state, "--item-id", "c1", "--mode", "summarize"]) == 0
    capsys.readouterr()
    daemon = Daemon(store=SQLiteContextStore(state))
    record = {"call_id": "c1", "tool_name": "bash", "arguments": {"command": "cat data"}, "status": "ok", "content": OUTPUT}
    reply = daemon.handle({"method": "prepare", "params": {"session_id": "sid", "snapshot_id": "t", "records": [record]}})
    return daemon, reply


def test_pending_summary_is_offered_then_replaced_by_session_model_text(tmp_path, monkeypatch, capsys):
    daemon, reply = setup(tmp_path, monkeypatch, capsys)
    (job,) = reply["pending_summaries"]
    assert job["content"] == OUTPUT
    summary = "cat data printed 40 lines, line 0: value 0 through line 39: value 273."
    done = daemon.handle({"method": "apply_summary", "params": {"session_id": "sid", "item_id": job["item_id"], "summary_text": summary}})
    if not done["ok"]:
        assert done["error"] == "verification_failed"
        return
    item = daemon.store.get(daemon._scope("sid"), job["item_id"])
    assert item.compaction_source == "llm_summary" and item.compacted == summary


def test_summary_failure_falls_back_to_plain_hide(tmp_path, monkeypatch, capsys):
    daemon, reply = setup(tmp_path, monkeypatch, capsys)
    item_id = reply["pending_summaries"][0]["item_id"]
    assert daemon.handle({"method": "summary_failed", "params": {"session_id": "sid", "item_id": item_id}})["ok"]
    assert daemon.store.get(daemon._scope("sid"), item_id).compaction_source == "explicit_user_hide"
    again = daemon.handle({"method": "summary_failed", "params": {"session_id": "sid", "item_id": item_id}})
    assert again == {"ok": False, "error": "not_found"}


def test_unrelated_or_larger_summary_falls_back_to_plain_hide(tmp_path, monkeypatch, capsys):
    daemon, reply = setup(tmp_path, monkeypatch, capsys)
    item_id = reply["pending_summaries"][0]["item_id"]
    invented = "The user clicked a button and typed into a text box while browsing the interface."
    done = daemon.handle({"method": "apply_summary", "params": {"session_id": "sid", "item_id": item_id, "summary_text": invented}})
    assert done["error"] == "verification_failed"
    assert daemon.store.get(daemon._scope("sid"), item_id).compaction_source == "explicit_user_hide"


def test_append_does_not_replay_earlier_pending_summaries(tmp_path, monkeypatch, capsys):
    daemon, first = setup(tmp_path, monkeypatch, capsys)
    assert len(first["pending_summaries"]) == 1
    response = daemon.handle({"method": "prepare", "params": {
        "session_id": "sid", "snapshot_id": "t", "append": True, "records": [{
            "call_id": "c2", "tool_name": "read", "arguments": {"path": "other"},
            "content": OUTPUT, "status": "ok",
        }]}})
    assert response["ok"] and response["pending_summaries"] == []
    assert set(daemon.snapshots["sid"][1]) == {"c1", "c2"}
