import json

from session_navigation import cli

MODELS = """providers:
  other:
    models:
      - id: local-small
        contextWindow: 1000
  llamacpp:
    baseUrl: http://127.0.0.1:8080/v1
    models:
      - id: big
        contextWindow: 9999
      - id: local-small
        name: Qwen3
        contextWindow: 32768
"""


def assistant(ts, prompt, content, non_message=1000, output=1):
    return {"role": "assistant", "provider": "llamacpp", "model": "local-small", "timestamp": ts,
            "content": content,
            "usage": {"input": 0, "output": output, "cacheRead": prompt, "cacheWrite": 0,
                      "totalTokens": prompt + output},
            "contextSnapshot": {"promptTokens": prompt, "nonMessageTokens": non_message}}


MESSAGES = [
    {"role": "user", "content": "hello"},
    assistant(1000, 1100, [{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "pwd"}}]),
    {"role": "toolResult", "toolCallId": "c1", "toolName": "bash", "isError": False,
     "content": [{"type": "text", "text": "x" * 300}]},
    assistant(2000, 1300, [{"type": "text", "text": "done"}]),
    {"role": "user", "content": "next"},
    assistant(3000, 1310, [{"type": "text", "text": "ok"}]),
]


def write_session(tmp_path, monkeypatch, messages, models=MODELS):
    home = tmp_path / "home"
    sessions = home / ".omp/agent/sessions/proj"
    sessions.mkdir(parents=True)
    (sessions / "2026_sid.jsonl").write_text(
        "\n".join(json.dumps({"type": "message", "message": m}) for m in messages))
    (home / ".omp/agent/models.yml").write_text(models)
    monkeypatch.setenv("HOME", str(home))


def test_list_reports_measured_row_tokens_and_session_context(tmp_path, monkeypatch, capsys):
    write_session(tmp_path, monkeypatch, MESSAGES)
    assert cli.main(["list", "--scope", "pi:default:sid:default", "--path", str(tmp_path / "s.db")]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["context"] == {"used_tokens": 1311, "max_tokens": 32768, "source": "omp_session_usage"}
    tokens = {row["item_id"] if row["kind"] != "tool" else row["tool_call_id"]: row.get("tokens")
              for row in payload["items"]}
    # first request carries host preamble; the last assistant output is not yet in any prompt
    assert tokens == {"usr_0": None, "c1": 200, "ast_3": 5, "usr_4": 5, "ast_5": None}
    tool = next(row for row in payload["items"] if row["kind"] == "tool")
    assert tool["tokens_display"] == "200 tok" and tool["tokens_source"] == "실측 배분"


def test_segment_with_hide_compaction_or_shrink_is_unmeasured():
    tokens, _ = cli._measured_tokens(MESSAGES, [], [1.5])
    assert "c1" not in tokens and tokens["usr_4"] == 5
    tokens, _ = cli._measured_tokens(MESSAGES, [2], [])
    assert "c1" not in tokens
    shrunk = MESSAGES[:3] + [assistant(2000, 1050, [{"type": "text", "text": "done"}])] + MESSAGES[4:]
    tokens, _ = cli._measured_tokens(shrunk, [], [])
    assert "c1" not in tokens


def test_injected_reminder_takes_its_share_without_a_row():
    tokens, _ = cli._measured_tokens(MESSAGES, [], [], injected=[(4, 2)])
    assert tokens == {"c1": 200, "ast_3": 4, "usr_4": 4}


def test_no_usage_means_no_tokens_and_no_context(tmp_path, monkeypatch, capsys):
    write_session(tmp_path, monkeypatch, [{**m, "usage": None} if m["role"] == "assistant" else m for m in MESSAGES])
    assert cli.main(["list", "--scope", "pi:default:sid:default", "--path", str(tmp_path / "s.db")]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert "context" not in payload and all("tokens" not in row for row in payload["items"])


def test_context_window_lookup(tmp_path, monkeypatch):
    write_session(tmp_path, monkeypatch, MESSAGES)
    assert cli._omp_context_window("llamacpp", "local-small") == 32768
    assert cli._omp_context_window("other", "local-small") == 1000
    assert cli._omp_context_window("llamacpp", "missing") is None
    assert cli._omp_context_window("nope", "local-small") is None


def test_zero_weight_row_gets_zero_tokens():
    messages = list(MESSAGES)
    messages[3] = assistant(2000, 1300, [{"type": "text", "text": ""}])
    tokens, _ = cli._measured_tokens(messages, [], [])
    assert tokens["ast_3"] == 0 and tokens["usr_4"] == 10
