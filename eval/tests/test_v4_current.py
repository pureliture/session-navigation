import http.client
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from current_budget import Budget
from proxy import serve
from v4_current import schedule, MODEL
from v4_compare import candidates, ratio
from v4_current import SETTINGS
from v4_stub import respond


class CurrentTests(unittest.TestCase):
    def test_stub_json_session_summary(self):
        import urllib.request
        body = {"model": MODEL, "messages": [{"role": "system", "content": 'Summarize the tool result. Reply with JSON only: {"summary":"text"}.'},
                                             {"role": "user", "content": "source"}]}
        response = json.load(respond(urllib.request.Request("http://unused", data=json.dumps(body).encode())))
        summary = json.loads(response["choices"][0]["message"]["content"])
        self.assertIn("component-team-1", summary["summary"])
    def test_ratio_empty_zero_and_normal(self):
        self.assertEqual(ratio(5, 4), 1.25)
        self.assertIsNone(ratio(1, 0))
        self.assertIsNone(ratio(None, 4))

    def test_empty_and_api_failed_cells_are_excluded(self):
        import gzip
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / "current-omp-atlas-B-new-1"
            folder.mkdir()
            spec = {"id": folder.name, "arm": "B-new", "host": "omp", "product_commit": "8902a41",
                    "model": MODEL, "provider": "Relace", "window": 65536, "turns": ["one"]}
            (folder / "spec.json").write_text(json.dumps(spec))
            (folder / "status.json").write_text('{"returncode":0}')
            with gzip.open(folder / "turns.json.gz", "wt") as stream:
                json.dump([{"turn": 1}], stream)
            with gzip.open(root / "wire.jsonl.gz", "wt") as stream:
                stream.write(json.dumps({"id": "r", "path": f"/{folder.name}/v1", "kind": "failure"}) + "\n")
            selected, excluded = candidates(root)
            self.assertEqual(selected, [])
            self.assertIn("not product failure", excluded[0]["reason"])
    def test_schedule_only_current_cells_and_identical_turn_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            jobs = schedule(Path(folder) / "fixtures")
            self.assertEqual(len(jobs), 16)
            self.assertEqual(sum(len(c["turns"]) == 25 for _, c, _ in jobs), 8)
            self.assertEqual(sum(len(c["turns"]) == 3 for _, c, _ in jobs), 8)
            self.assertEqual({r for _, _, r in jobs}, {1, 2})

    def test_persistent_budget_counts_uncertain_retries_and_missing_cost(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "budget.json"
            budget = Budget(path, "0.0011")
            body = {"messages": [], "max_tokens": 2048}
            budget.reserve("failed-attempt", body)
            with self.assertRaises(ValueError):
                Budget(path, "0.0011").reserve("retry", body)
            budget.settle("failed-attempt", {"cost": .0001})
            budget.reserve("retry", {"messages": [], "max_tokens": 10})
            with self.assertRaises(ValueError):
                budget.settle("retry", {})
            with self.assertRaises(ValueError):
                Budget(path, "0.0011").reserve("next", {"max_tokens": 1})

    def test_default_native_output_bound_and_three_dollar_milestone(self):
        with tempfile.TemporaryDirectory() as folder:
            budget = Budget(Path(folder) / "budget.json")
            budget.state["spent"] = "2.9999"
            budget.reserve("native", {"messages": []})
            budget.settle("native", {"cost": .001})
            self.assertEqual(budget.state["over_3"]["spent"], "3.0009")
            with self.assertRaises(ValueError):
                budget.reserve("image", {"messages": [{"content": [{"type": "image_url"}]}]})

    def test_proxy_guards_provider_prices_and_charges_all_attempts(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, OPENROUTER_API_KEY="test-only-key"):
            budget = Budget(Path(folder) / "budget.json")
            observed = []
            def upstream(request, **kwargs):
                observed.append(json.loads(request.data))
                return io.BytesIO(json.dumps({"model": MODEL, "choices": [], "usage": {"cost": .00001}}).encode())
            with patch("proxy.urllib.request.urlopen", upstream):
                server = serve(Path(folder), model=MODEL, provider="Relace", reasoning={"enabled": False, "exclude": True}, budget=budget)
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", "/test/v1/chat/completions", json.dumps({"model": MODEL, "messages": [], "max_tokens": 100}))
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    self.assertEqual(budget.state["spent"], "0.00001")
                    self.assertFalse(observed[0]["provider"]["allow_fallbacks"])
                    self.assertEqual(observed[0]["provider"]["max_price"], {"prompt": .006, "completion": .5})
                    self.assertEqual(observed[0]["reasoning"], {"enabled": False, "exclude": True})
                finally:
                    server.shutdown()
                    server.server_close()


if __name__ == "__main__":
    unittest.main()
