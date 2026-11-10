import copy
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from focus_fixtures import SEEDS, WINDOW, fixture, hide_history, tokens
from focus_run import budget, key, schedule
from focus_score import mcnemar, paired, score


class FocusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case = fixture(SEEDS[0], "short")
        cls.hidden = hide_history(cls.case)

    def test_real_hide_has_no_keep_lines_and_preserves_primary_not_buried_fact(self):
        self.assertEqual(len(self.hidden["mutations"]), 8)
        self.assertTrue(all(row["ok"] and row["replacement"].startswith("[hidden:") for row in self.hidden["mutations"]))
        self.assertTrue(all(self.hidden["survival"][key] for key in self.case["primary_keys"]))
        self.assertFalse(self.hidden["survival"]["audit_marker"])
        self.assertLess(self.hidden["offline_hidden_tokens"], self.case["offline_raw_tokens"] / 10)
        self.assertNotIn("[hidden:", str(self.case["messages"]))

    def test_lengths_and_determinism_and_matched_non_tool_messages(self):
        self.assertEqual(self.case, fixture(SEEDS[0], "short"))
        self.assertTrue(.30 < self.case["offline_raw_tokens"] / WINDOW < .40)
        long = fixture(SEEDS[0], "long")
        self.assertTrue(.60 < long["offline_raw_tokens"] / WINDOW < .80)
        self.assertEqual(self.case["check"], long["check"])
        for raw, hidden in zip(self.case["messages"], self.hidden["messages"]):
            self.assertEqual(raw.keys(), hidden.keys())
            if raw["role"] != "tool":
                self.assertEqual(raw, hidden)
        calls = [m["tool_calls"][0]["id"] for m in self.case["messages"] if m.get("tool_calls")]
        self.assertEqual(calls, [m["tool_call_id"] for m in self.case["messages"] if m["role"] == "tool"])

    def test_score_normal_empty_malformed_stale_unsupported_and_conflict(self):
        import json
        expected = self.case["check"]["expected"]
        self.assertEqual(score(json.dumps(expected), self.case)["primary_correct"], 11)
        for answer in ("", "reported above", "{malformed", "[]"):
            self.assertFalse(score(answer, self.case)["primary_success"])
        stale = {**expected, "capacity": self.case["check"]["stale"]["capacity"][0]}
        self.assertEqual(score(json.dumps(stale), self.case)["stale"], 1)
        invented = {**expected, "owner": "Invented"}
        self.assertEqual(score(json.dumps(invented), self.case)["unsupported"], 1)
        self.assertFalse(score(json.dumps(expected) + json.dumps(invented), self.case)["primary_success"])
        no_loss = {key: value for key, value in expected.items() if key != "audit_marker"}
        self.assertTrue(score(json.dumps(no_loss), self.case)["primary_success"])
        self.assertEqual(score(json.dumps(no_loss), self.case)["loss_correct"], 0)

    def test_randomization_pairs_repetitions_and_unreachable_native_threshold(self):
        jobs = schedule()
        self.assertEqual(jobs, schedule())
        self.assertEqual(len(jobs), 66)
        self.assertEqual(len({key(job) for job in jobs}), 66)
        self.assertEqual({job["seed"] for job in jobs[:60]}, set(SEEDS))
        self.assertEqual(jobs[0]["length"], "long")
        for index in range(0, 66, 2):
            self.assertEqual(key(jobs[index])[:-1], key(jobs[index + 1])[:-1])
        script = Path(__file__).resolve().parents[1] / "v2_omp.ts"
        self.assertIn('"compaction.enabled": spec.native_compaction !== false', script.read_text())

    def test_pilot_gate_normal_missing_and_expensive(self):
        jobs = schedule()
        rows = [{**job, "eligible": True, "cost": .01} for job in jobs[:2] + jobs[60:62]]
        self.assertTrue(budget({"sessions": rows, "total_cost": .04}, jobs)["continue"])
        self.assertFalse(budget({"sessions": rows[:-1], "total_cost": .03}, jobs)["continue"])
        self.assertFalse(budget({"sessions": rows, "total_cost": 1}, jobs)["continue"])

    def test_exact_test_and_empty_unpaired_api_excluded_and_cluster_intervals(self):
        self.assertEqual(mcnemar(0, 0), 1)
        self.assertEqual(mcnemar(0, 3), .25)
        self.assertEqual(mcnemar(1, 1), 1)
        self.assertEqual(paired([])["pairs"], 0)
        import json
        scored = score(json.dumps(self.case["check"]["expected"]), self.case)
        rows = [{"part": "replay", "seed": 317, "length": "short", "rep": 1, "arm": arm,
                 "eligible": True, "score": copy.deepcopy(scored)} for arm in ("RAW", "PLUGIN-HIDE")]
        self.assertEqual(paired(rows)["seed_cluster_bootstrap_95"], [0, 0])
        rows[1]["eligible"] = False
        self.assertEqual(paired(rows)["pairs"], 0)


if __name__ == "__main__":
    unittest.main()
