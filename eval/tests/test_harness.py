import gzip
import http.client
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import analyze
import proxy


class HarnessTests(unittest.TestCase):
    def test_matching_and_native_records(self):
        turns = [{"turn": 1, "messages": [{"role": "assistant", "content": [{"type": "toolCall", "id": "r", "name": "read", "arguments": {"path": "a"}}]},
            {"role": "toolResult", "toolCallId": "r", "content": [{"type": "text", "text": "original"}]}]}]
        calls, records = analyze.native_records(turns)
        self.assertEqual((calls["r"]["name"], records["r"]["original"], analyze.contains("1370", "137"), analyze.contains("five", "5")), ("read", "original", False, True))

    def test_failed_empty_run_does_not_become_free_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run = root / "omp-01-empty-A-1"
            run.mkdir()
            spec = {"id": run.name, "host": "omp", "arm": "A", "workspace": str(root / "workspace"), "results": [], "turns": ["question"], "answers": [["yes"]]}
            (run / "spec.json").write_text(json.dumps(spec))
            (run / "status.json").write_text('{"returncode":1}')
            with gzip.open(root / "wire.jsonl.gz", "wt") as handle:
                handle.write(json.dumps({"kind": "request", "id": "r", "time": 0, "path": "/" + run.name + "/v1", "body": {"model": proxy.MODEL, "messages": []}}) + "\n")
            analyze.analyze(root)
            result = json.loads((root / "metrics.json").read_text())[0]
            self.assertEqual((result["task_success"], result["missing_cost"], result["usage"][0]["cost"]), (False, 1, None))

    def test_shared_history_uses_user_boundaries_not_snapshot_index(self):
        messages = [{"role": "user", "content": "first"},
            {"role": "assistant", "content": [{"type": "toolCall", "id": "a", "name": "read", "arguments": {}}]},
            {"role": "toolResult", "toolCallId": "a", "content": "one"},
            {"role": "user", "content": [{"type": "text", "text": "second"}]},
            {"role": "assistant", "content": [{"type": "toolCall", "id": "b", "name": "read", "arguments": {}}]},
            {"role": "toolResult", "toolCallId": "b", "content": "two"}]
        calls, records = analyze.native_records([{"turn": 1, "messages": messages}, {"turn": 2, "messages": messages}], ["first", "second"])
        self.assertEqual((calls["a"]["turn"], calls["b"]["turn"], records["b"]["first_turn"]), (1, 2, 2))

    def test_guard_usage_streaming_and_secret_audit(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-secret-not-a-real-key"}):
            directory = Path(temp)
            server = proxy.serve(directory)
            try:
                def post(body):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", "/unit/v1/chat/completions", body=json.dumps(body), headers={"Content-Type": "application/json"})
                    response = connection.getresponse()
                    value = response.read()
                    connection.close()
                    return response.status, value
                with patch("urllib.request.urlopen") as upstream:
                    self.assertEqual(post({"model": "not-allowed"})[0], 400)
                    upstream.assert_not_called()
                    payload = {"model": proxy.MODEL, "choices": [{"message": {"content": ""}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "cost": .1}}
                    upstream.return_value.__enter__.return_value.read.return_value = json.dumps(payload).encode()
                    status, value = post({"model": proxy.MODEL, "messages": [], "stream": True})
                    self.assertEqual(status, 200)
                    self.assertIn(b"[DONE]", value)
                    self.assertEqual(json.loads(upstream.call_args.args[0].data)["usage"], {"include": True})
                raw = gzip.decompress((directory / "wire.jsonl.gz").read_bytes())
                self.assertNotIn(b"test-secret-not-a-real-key", raw)
                self.assertIn(b'"cost": 0.1', raw)
            finally:
                server.shutdown()
                server.server_close()

    def test_retry_records_backoff(self):
        import urllib.error
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-secret"}):
            server = proxy.serve(Path(temp))
            try:
                response = unittest.mock.MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()
                error = urllib.error.HTTPError("https://example.invalid", 429, "limited", {}, io.BytesIO(b"limited"))
                with patch("urllib.request.urlopen", side_effect=[error, response]), patch("time.sleep") as sleep:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", "/unit", json.dumps({"model": proxy.MODEL, "messages": []}))
                    self.assertEqual(connection.getresponse().status, 200)
                    sleep.assert_called_once_with(2)
                    connection.close()
                rows = [json.loads(line) for line in gzip.open(Path(temp) / "wire.jsonl.gz", "rt")]
                self.assertEqual(sum(row["kind"] == "retry" for row in rows), 1)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
