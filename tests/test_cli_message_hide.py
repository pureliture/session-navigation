import json

from session_navigation import cli
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation_omp.daemon import Daemon

MESSAGES = [
    {"role": "user", "content": "please check", "timestamp": 1000},
    {"role": "assistant", "timestamp": 2000, "content": [
        {"type": "text", "text": "Running it"},
        {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "pwd"}}]},
    {"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "isError": False,
     "content": [{"type": "text", "text": "/work"}], "timestamp": 2500},
    {"role": "assistant", "timestamp": 3000, "content": [{"type": "text", "text": "All done"}]},
]
SCOPE = "pi:default:sid:default"


def setup(tmp_path, monkeypatch):
    home = tmp_path / "home"
    sessions = home / ".omp/agent/sessions/proj"
    sessions.mkdir(parents=True)
    (sessions / "2026_sid.jsonl").write_text(
        "\n".join(json.dumps({"type": "message", "message": m}) for m in MESSAGES))
    monkeypatch.setenv("HOME", str(home))
    return str(tmp_path / "state.sqlite3")


def run(capsys, *argv):
    code = cli.main(list(argv))
    return code, json.loads(capsys.readouterr().out)


def rows(capsys, state):
    _, payload = run(capsys, "list", "--scope", SCOPE, "--path", state)
    return {row["item_id"]: row for row in payload["items"] if row["kind"] != "tool"}


def test_prompt_and_response_hide_and_unhide(tmp_path, monkeypatch, capsys):
    state = setup(tmp_path, monkeypatch)
    listed = rows(capsys, state)
    user_id = cli._message_key(0, MESSAGES[0])
    assert user_id.startswith("msg:user:1000:") and listed[user_id]["status"] == "visible"
    ast_id = cli._message_key(3, MESSAGES[3])
    for item in (user_id, ast_id):
        code, out = run(capsys, "hide", "--scope", SCOPE, "--path", state, "--item-id", item, "--expected-version", "1")
        assert code == 0 and out["visibility"] == "hidden" and out["version"] == 2
    listed = rows(capsys, state)
    assert listed[user_id]["status"] == "hidden" and listed[ast_id]["status"] == "hidden"
    code, out = run(capsys, "unhide", "--scope", SCOPE, "--path", state, "--item-id", user_id, "--expected-version", "2")
    assert code == 0 and out["visibility"] == "visible" and out["version"] == 3
    assert rows(capsys, state)[user_id]["status"] == "unhidden"


def test_messages_reject_summarize_stale_versions_and_unknown_ids(tmp_path, monkeypatch, capsys):
    state = setup(tmp_path, monkeypatch)
    user_id = cli._message_key(0, MESSAGES[0])
    assert run(capsys, "hide", "--scope", SCOPE, "--path", state, "--item-id", user_id, "--mode", "summarize") == (
        2, {"ok": False, "error": "summarize_unsupported"})
    code, out = run(capsys, "hide", "--scope", SCOPE, "--path", state, "--item-id", user_id, "--expected-version", "5")
    assert code == 4 and out["error"] == "version_conflict"
    code, out = run(capsys, "hide", "--scope", SCOPE, "--path", state, "--item-id", "msg:user:1:abc")
    assert code == 2 and out["error"] == "not_found"


def test_batch_hides_messages_and_tools_together(tmp_path, monkeypatch, capsys):
    state = setup(tmp_path, monkeypatch)
    items = [{"item_id": cli._message_key(0, MESSAGES[0]), "expected_version": 1}, {"item_id": "c1", "expected_version": 1}]
    code, out = run(capsys, "hide", "--scope", SCOPE, "--path", state, "--items-json", json.dumps(items))
    assert code == 0 and out["applied"] == 2


def test_daemon_prepare_reports_hidden_messages(tmp_path, monkeypatch, capsys):
    state = setup(tmp_path, monkeypatch)
    user_id = cli._message_key(0, MESSAGES[0])
    run(capsys, "hide", "--scope", SCOPE, "--path", state, "--item-id", user_id)
    daemon = Daemon(store=SQLiteContextStore(state))
    reply = daemon.handle({"method": "prepare", "params": {"session_id": "sid", "snapshot_id": "t", "records": []}})
    assert reply["ok"] and reply["hidden_messages"] == [user_id]
