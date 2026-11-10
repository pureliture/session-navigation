import json

from session_navigation import cli


def test_every_tool_result_is_listed_and_only_read_bash_are_manageable(tmp_path, monkeypatch, capsys):
    messages = [
        {"role": "user", "content": "go", "timestamp": 1},
        {"role": "assistant", "timestamp": 2, "content": [
            {"type": "toolCall", "id": "b1", "name": "bash", "arguments": {"command": "ls"}},
            {"type": "toolCall", "id": "e1", "name": "edit", "arguments": {"path": "a.py"}},
            {"type": "toolCall", "id": "x1", "name": "bash", "arguments": {"command": "false"}}]},
        {"role": "toolResult", "toolCallId": "b1", "toolName": "bash", "isError": False, "content": [{"type": "text", "text": "a.py"}]},
        {"role": "toolResult", "toolCallId": "e1", "toolName": "edit", "isError": False, "content": [{"type": "text", "text": "edited"}]},
        {"role": "toolResult", "toolCallId": "x1", "toolName": "bash", "isError": True, "content": [{"type": "text", "text": "exit 1"}]},
    ]
    home = tmp_path / "home"
    (home / ".omp/agent/sessions/p").mkdir(parents=True)
    (home / ".omp/agent/sessions/p/2026_sid.jsonl").write_text("\n".join(json.dumps({"type": "message", "message": m}) for m in messages))
    monkeypatch.setenv("HOME", str(home))
    assert cli.main(["list", "--scope", "pi:default:sid:default", "--path", str(tmp_path / "s.db")]) == 0
    tools = [r for r in json.loads(capsys.readouterr().out)["items"] if r["kind"] == "tool"]
    assert [(r["tool_call_id"], r["tool_name"], r.get("manageable", True)) for r in tools] == [
        ("b1", "bash", True), ("e1", "edit", False), ("x1", "bash", False)]
    assert tools[2]["summary_line"] == "[error] exit 1" and tools[1]["compaction_source"] == "display_only"
