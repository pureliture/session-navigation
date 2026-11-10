import contextlib
import gzip
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quality_fixtures import fixture, SEEDS, WINDOW
from quality_run import schedule, budget
from quality_score import analyze, canonical, objects, prompt_share, score_answer, total_cost, MODEL, PROVIDER, REASONING


class QualityTests(unittest.TestCase):
    def test_fixtures_are_matched_and_have_real_obsolete_values(self):
        self.assertEqual(WINDOW, 65536)
        self.assertGreaterEqual(WINDOW, 64000)
        for seed in SEEDS:
            case = fixture(seed)
            self.assertEqual(case, fixture(seed))
            self.assertEqual((len(case["files"]), len(case["turns"])), (15, 17))
            self.assertEqual([check["kind"] for check in case["checks"][-3:]], ["announced", "surprise", "canonical"])
            for index in range(1, 15):
                rows = [json.loads(line) for line in case["files"][f"report-{index:02}.jsonl"].splitlines()]
                current = next(row for row in rows if row["event"] == "effective_config")
                failures = sum(row.get("generation") == 42 and row.get("result") == "FAIL" for row in rows)
                self.assertEqual(current["failed_jobs"], failures)
                self.assertEqual(len([row for row in rows if row["event"] == "archived_config"]), 3)
            report = [json.loads(line) for line in case["files"]["report-03.jsonl"].splitlines()]
            cap = next(row for row in report if row["event"] == "effective_config")
            report = [json.loads(line) for line in case["files"]["report-04.jsonl"].splitlines()]
            load = next(row for row in report if row["event"] == "effective_config")
            self.assertEqual(case["plan"]["safe_parallel"], min(cap["worker_limit"], (cap["capacity"] - load["load"]) // load["worker_cost"]))
        self.assertNotEqual(fixture(SEEDS[0]), fixture(SEEDS[1]))

    def test_schedule_is_randomized_reproducible_and_paired(self):
        self.assertEqual(schedule(), schedule())
        self.assertEqual(len({(entry["seed"], entry["arm"]) for entry in schedule()}), 8)
        for index in range(0, 8, 2):
            self.assertEqual(schedule()[index]["seed"], schedule()[index + 1]["seed"])
            self.assertEqual({entry["arm"] for entry in schedule()[index:index + 2]}, {"A", "B-new"})

    def test_scoring_normal_empty_malformed_stale_and_unsupported(self):
        check = {"expected": {"owner": "Orchid", "count": 3}, "stale": {"owner": ["Old"]}}
        self.assertTrue(score_answer('```json\n{"owner":"Orchid","count":3}\n```', check)["success"])
        for answer in ("", "reported above", "{broken", '{"owner":"Orchid"}', '{"owner":"Orchid","count":true}'):
            self.assertFalse(score_answer(answer, check)["success"])
        self.assertEqual(len(score_answer('{"owner":"Old","count":3}', check)["stale_claims"]), 1)
        self.assertEqual(len(score_answer('{"owner":"Invented","count":3}', check)["unsupported_values"]), 1)
        self.assertFalse(score_answer('{"owner":"Orchid","count":3} then {"owner":"Old","count":3}', check)["success"])
        self.assertEqual(objects(""), [])

    def test_canonical_normal_empty_wrong_and_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "decision.json"
            self.assertFalse(canonical(path, {"a": 3}))
            for content, success in (('{"a":3}', True), ('{}', False), ('invalid', False), ('[]', False), ('null', False), ('{"a":false}', False)):
                path.write_text(content)
                self.assertEqual(canonical(path, {"a": 3}), success)

    def test_wire_shares_and_cost_deduplication(self):
        self.assertEqual(prompt_share({"messages": [], "tools": []})["tool_token_share"], 0)
        self.assertGreater(prompt_share({"messages": [{"role": "tool", "content": "log " * 1000}]})["tool_token_share"], .9)
        body = {"id": "gen-one", "usage": {"cost": .1}}
        rows = [{"kind": "response", "id": "req-one", "body": body}, {"kind": "response", "id": "req-two", "body": body}]
        self.assertAlmostEqual(total_cost(rows), .1)
        self.assertEqual(total_cost([{"kind": "failure"}]), 0)

    def test_budget_requires_complete_pilot_actual_native_compaction_and_limit(self):
        order = schedule()
        self.assertFalse(budget({"sessions": [], "total_cost": 0}, order)["continue"])
        sessions = [{**entry, "eligible": True, "native_sent": 1, "cost": .05} for entry in order[:2]]
        self.assertTrue(budget({"sessions": sessions, "total_cost": .1}, order)["continue"])
        self.assertFalse(budget({"sessions": sessions, "total_cost": 1.49}, order)["continue"])
        for row in sessions:
            row["native_sent"] = 0
        self.assertFalse(budget({"sessions": sessions, "total_cost": .1}, order)["continue"])

    def test_campaign_excludes_transport_and_missing_usage_not_product_budget_failures(self):
        for mode in ("normal", "product_incomplete", "api_failure", "missing_cost", "no_requests"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                folder = root / "sessions/unit"
                folder.mkdir(parents=True)
                attempt = root / "attempts/first"
                attempt.mkdir(parents=True)
                (root / "stage.json").write_text("{}")
                expected = {"owner": "Orchid"}
                spec = {"id": "unit", "seed": 71, "arm": "A", "turns": ["Unit 1"], "plan": expected,
                        "checks": [{"kind": "canonical", "expected": expected, "stale": {}, "sources": []}]}
                (folder / "spec.json").write_text(json.dumps(spec))
                (folder / "status.json").write_text('{"returncode":0}')
                (folder / "events.jsonl").write_text("")
                (folder / "decision.json").write_text(json.dumps(expected))
                messages = [{"role": "user", "content": "Unit 1"}, {"role": "assistant", "content": json.dumps(expected)}]
                with gzip.open(folder / "turns.json.gz", "wt") as stream:
                    json.dump([{"prompt": "Unit 1", "turn": 1, "answer": json.dumps(expected),
                                "completed": mode != "product_incomplete", "messages": messages}], stream)
                rows = [{"kind": "upstream_request", "id": "req", "time": 1, "path": "/unit/v1/chat/completions",
                         "body": {"model": MODEL, "provider": PROVIDER, "reasoning": REASONING, "messages": messages[:1]}}]
                if mode == "api_failure":
                    rows.append({"kind": "failure", "id": "req", "path": "/unit/v1/chat/completions", "status": 429})
                else:
                    rows.append({"kind": "response", "id": "req", "path": "/unit/v1/chat/completions",
                                 "body": {"id": "gen", "usage": {} if mode == "missing_cost" else {"cost": .001}}})
                with gzip.open(attempt / "wire.jsonl.gz", "wt") as stream:
                    stream.write("" if mode == "no_requests" else "\n".join(json.dumps(row) for row in rows))
                with contextlib.redirect_stdout(io.StringIO()):
                    result = analyze(root)["sessions"][0]
                self.assertEqual(result["eligible"], mode in ("normal", "product_incomplete"))
                self.assertEqual(result["final_success"], mode != "product_incomplete")


if __name__ == "__main__":
    unittest.main()
