import json

import pytest

from session_navigation import cli
from session_navigation.model import ContextItem
from session_navigation.sqlite_store import SQLiteContextStore


@pytest.mark.parametrize("output", ["", "a\nb\n" + "x" * 827, "한" * 5000])
@pytest.mark.parametrize("name,arguments", [
    ("read", {"path": "/work/file.txt", "offset": 10, "limit": 20}),
    ("bash", {"command": "cat file.txt", "cwd": "/work"}),
])
def test_omp_preview_original_survives_hide(tmp_path, monkeypatch, capsys, output, name, arguments):
    session = tmp_path / "session.jsonl"
    session.write_text("\n".join(json.dumps(message) for message in [
        {"role": "assistant", "content": [
            {"type": "toolCall", "id": "call-preview", "name": name, "arguments": arguments},
        ]},
        {"role": "toolResult", "toolCallId": "call-preview", "toolName": name,
         "isError": False, "content": [{"type": "text", "text": output}]},
    ]))
    monkeypatch.setattr(cli.glob, "glob", lambda *args, **kwargs: [str(session)])
    scope = "pi:default:preview:default"
    state = str(tmp_path / "state.sqlite3")
    expected = cli._preview_text(output)
    for hidden in (False, True):
        if hidden:
            assert cli.main(["hide", "--scope", scope, "--path", state,
                             "--item-id", "call-preview"]) == 0
            capsys.readouterr()
        assert cli.main(["list", "--scope", scope, "--path", state]) == 0
        row = json.loads(capsys.readouterr().out)["items"][0]
        assert json.loads(row["tool_input"]) == arguments
        assert row["tool_output"] == expected
        assert row["bytes_size"] == len(output.encode("utf-8"))
        assert row["visibility"] == ("hidden" if hidden else "visible")
    if len(output.encode("utf-8")) > 8192:
        assert expected.endswith("\n… [truncated]")
        assert len(expected.removesuffix("\n… [truncated]").encode("utf-8")) <= 8192
    else:
        assert expected == output


def test_stored_preview_without_timeline(tmp_path, capsys):
    state = str(tmp_path / "state.sqlite3")
    store = SQLiteContextStore(state)
    assert store.put("scope", ContextItem(
        item_id="preview", tool_call_id="preview-call", content_sha256="sha",
        original="full original output\nthird line", compacted="hidden summary",
        excerpt_lines=(), visibility="hidden", version=2,
        invocation_snapshot={"tool_name": "read", "arguments": {"path": "original.txt"}},
    )).ok
    store.close()
    assert cli.main(["list", "--scope", "scope", "--path", state]) == 0
    row = json.loads(capsys.readouterr().out)["items"][0]
    assert json.loads(row["tool_input"]) == {"path": "original.txt"}
    assert row["tool_output"] == "full original output\nthird line"
    assert row["summary_line"] != row["tool_output"]


def test_preview_missing_and_malformed_session(tmp_path, monkeypatch):
    session = tmp_path / "broken.jsonl"
    session.write_text("invalid json\n{}\n")
    monkeypatch.setattr(cli.glob, "glob", lambda *args, **kwargs: [str(session)])
    assert cli._load_omp_session_timeline("pi:default:preview:default") == ([], {})
    monkeypatch.setattr(cli.glob, "glob", lambda *args, **kwargs: [])
    assert cli._load_omp_session_timeline("pi:default:preview:default") == ([], {})


def test_preview_bounds_input_and_output():
    fields = cli._tool_preview({"command": "a" * 10000}, "b" * 10000)
    assert all(text.endswith("\n… [truncated]") for text in fields.values())
    assert cli._tool_preview(None, "") == {"tool_output": ""}
