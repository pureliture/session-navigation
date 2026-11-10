"""Render all three-version metrics; interpretation remains in the report's discussion."""
import argparse
import json
from pathlib import Path

from v4_compare import ratio


CORRECTNESS = {"final_only_success", "visible_unit_success", "task_success", "canonical_tests_pass",
               "announced_recall", "surprise_recovery", "strict_success"}
RESOURCES = {"requests", "prompt_tokens", "cached_tokens", "output_tokens", "reported_usd",
             "reference_gpt41_large_cache_usd", "native_compactions"}


def value(number):
    if number is None:
        return "N/A"
    if isinstance(number, int):
        return f"{number:,}"
    return f"{number:.6f}".rstrip("0").rstrip(".")


def verdict(key, columns):
    current, old = columns["B-current"].get(key), columns["B-old"].get(key)
    if current is None:
        return "Unavailable; not zero"
    if key in CORRECTNESS:
        return "PASS: no observed regression" if current >= old else "REGRESSION"
    if key == "original_mismatches":
        return "PASS: no observed mutation" if current == 0 else "SAFETY REGRESSION"
    if key.endswith("wrong_source") or key == "missing_response_cost":
        return "PASS" if current == 0 else "REVIEW"
    if "facts_retained" in key:
        action = key.split("_")[0]
        denominators = [columns[arm][action + "_facts_present"] for arm in ("B-current", "B-old")]
        rates = [ratio(n, d) for n, d in zip((current, old), denominators)]
        return "UNVERIFIED: no eligible facts" if None in rates else ("PASS: retained fraction" if rates[0] >= rates[1] else "REGRESSION: retained fraction")
    r = ratio(current, old)
    if key in RESOURCES:
        return "RCA: >25% difference" if r is not None and abs(r - 1) > .25 else "Reported ratio; no equivalence claim"
    return "Descriptive / coverage" if r is None or abs(r - 1) <= .25 else "Behavior differs >25%; see discussion"


def table(columns, keys=None):
    keys = keys or [key for key in columns["B-current"] if key != "mismatch_details"]
    lines = ["| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |",
             "|---|---:|---:|---:|---:|---:|---|"]
    for key in keys:
        a, old, current = (columns.get(arm, {}).get(key) for arm in ("A", "B-old", "B-current"))
        lines.append(f"| `{key}` | {value(a)} | {value(old)} | {value(current)} | {value(ratio(current, old))} | {value(ratio(current, a))} | {verdict(key, columns)} |")
    return "\n".join(lines)


def render(comparison):
    lines = ["## Complete long-session metrics", "",
             "Counts are observed outcomes, not statistical equivalence. Both final-only and visible-unit correctness are scored by the unchanged historical answer-surface evaluator. Resource ratios are dimensionless; N/A means unavailable or a zero denominator, not zero consumption.", ""]
    for host, columns in comparison["groups"].items():
        lines += [f"### {host.upper()}", "", table(columns), ""]
    lines += ["## Commanded Hide/Summarize trials", "",
              "A did not have navigation tools and has no component baseline. There are two Hide and two Summarize trials per host. Fact retention is assessed only on facts actually present in a sent replacement's original. A trial with no replacement is a coverage failure, not perfect retention. Pure means every sent replacement in the trial used the expected rule/LLM source. Judge scores use the historical prompt and active DeepSeek/Relace model; they are auxiliary, not a correctness gate.", ""]
    for host, columns in comparison["components"].items():
        lines += [f"### {host.upper()}", "", table(columns), ""]
    keys = ["sessions", "final_only_success", "visible_unit_success", "canonical_tests_pass", "announced_recall", "surprise_recovery",
            "navigation_calls", "sessions_with_nav", "list_calls", "literal_selected_ids", "literal_valid_ids", "successful_cleanup_boundaries",
            "native_compactions", "rereads_repeat_visible", "rereads_after_compaction", "requests", "prompt_tokens", "cached_tokens", "output_tokens", "reported_usd"]
    lines += ["## Per-fixture breakdown", "", "Two repetitions per host/fixture. No new A or B-old model calls were made.", ""]
    for host, fixtures in comparison["fixtures"].items():
        for fixture, columns in fixtures.items():
            lines += [f"### {host.upper()}/{fixture}", "", table(columns, keys), ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("comparison", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(render(json.loads(args.comparison.read_text())))
