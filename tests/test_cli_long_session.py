import json

from session_navigation import cli


def test_outline_lists_every_result_past_the_manageable_cap(tmp_path, monkeypatch, capsys):
    messages = [{"role": "user", "timestamp": 0, "content": [{"type": "text", "text": "first prompt"}]}]
    for i in range(1005):
        messages.append({"role": "assistant", "timestamp": i + 1, "content": [
            {"type": "toolCall", "id": f"c{i}", "name": "bash", "arguments": {"command": f"echo {i}"}}]})
        messages.append({"role": "toolResult", "toolCallId": f"c{i}", "toolName": "bash", "isError": False,
                         "content": [{"type": "text", "text": f"out {i}"}]})
    home = tmp_path / "home"
    (home / ".omp/agent/sessions/p").mkdir(parents=True)
    (home / ".omp/agent/sessions/p/2026_sid.jsonl").write_text(
        "\n".join(json.dumps({"type": "message", "message": m}) for m in messages))
    monkeypatch.setenv("HOME", str(home))
    assert cli.main(["list", "--scope", "pi:default:sid:default", "--path", str(tmp_path / "s.db")]) == 0
    out = json.loads(capsys.readouterr().out)
    rows = out["items"]
    tools = [r for r in rows if r.get("kind") == "tool"]
    assert len(tools) == 1005
    assert tools[-1]["manageable"] is False and tools[0].get("manageable") is not False
    assert any(r.get("summary_line", "").startswith("first prompt") for r in rows)
