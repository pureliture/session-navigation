import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v4_report import render, table, verdict


class ReportTests(unittest.TestCase):
    def test_normal_ratios_and_regression(self):
        columns = {"A": {"requests": 10, "final_only_success": 4},
                   "B-old": {"requests": 8, "final_only_success": 4},
                   "B-current": {"requests": 12, "final_only_success": 3}}
        output = table(columns)
        self.assertIn("| 1.5 | 1.2 | RCA: >25% difference", output)
        self.assertIn("REGRESSION", output)
        report = render({"groups": {}, "components": {}, "fixtures": {"omp": {"atlas": columns}}})
        self.assertIn("OMP/atlas", report)

    def test_empty_component_baseline_and_missing_measurement(self):
        columns = {"B-old": {"requests": 0}, "B-current": {"requests": 3, "rereads": None}}
        self.assertIn("N/A", table(columns))
        self.assertEqual(verdict("rereads", columns), "Unavailable; not zero")
        self.assertIn("Per-fixture breakdown", render({"groups": {}, "components": {}, "fixtures": {}}))

    def test_empty_retention_is_not_perfect_and_wrong_source_is_not_pass(self):
        columns = {"A": {}, "B-old": {"hide_facts_present": 6, "hide_facts_retained": 6},
                   "B-current": {"hide_facts_present": 0, "hide_facts_retained": 0, "hide_wrong_source": 1}}
        self.assertTrue(verdict("hide_facts_retained", columns).startswith("UNVERIFIED"))
        self.assertEqual(verdict("hide_wrong_source", columns), "REVIEW")


if __name__ == "__main__":
    unittest.main()
