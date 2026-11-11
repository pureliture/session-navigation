import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v4_fixed_report import table


class FixedReportTests(unittest.TestCase):
    def test_four_columns_and_both_ratios(self):
        previous = {"A": {"requests": 10}, "B-old": {"requests": 4}, "B-current": {"requests": 8}}
        result = table(previous, {"B-current": {"requests": 12}})
        self.assertIn("| 10 | 4 | 8 | 12 | 3 | 1.5 |", result)
        self.assertIn("pre: RCA: >25% difference", result)

    def test_empty_baseline_and_unavailable_metrics_are_not_zero(self):
        result = table({"B-old": {"requests": 0}, "B-current": {"requests": None}},
                       {"B-current": {"requests": 2}})
        self.assertIn("| N/A | 0 | N/A | 2 | N/A | N/A |", result)

    def test_retention_and_safety_regressions_are_not_hidden(self):
        baseline = {"summarize_facts_retained": 3, "summarize_facts_present": 3, "original_mismatches": 0}
        current = {"summarize_facts_retained": 2, "summarize_facts_present": 3, "original_mismatches": 1}
        result = table({"B-old": baseline, "B-current": baseline}, {"B-current": current})
        self.assertIn("REGRESSION: retained fraction", result)
        self.assertIn("SAFETY REGRESSION", result)
