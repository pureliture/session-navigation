"""Render fixed-product results alongside frozen historical and pre-fix results."""
import argparse
import json
from pathlib import Path

from v4_compare import ratio
from v4_report import value, verdict


def table(previous, repaired):
    columns = [previous.get("A", {}), previous["B-old"], previous["B-current"], repaired["B-current"]]
    lines = ["| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |",
             "|---|---:|---:|---:|---:|---:|---:|---|"]
    for key in dict.fromkeys(key for column in columns for key in column):
        numbers = [column.get(key) for column in columns]
        old_verdict = verdict(key, {"B-old": columns[1], "B-current": columns[3]})
        pre_verdict = verdict(key, {"B-old": columns[2], "B-current": columns[3]})
        ratios = [ratio(numbers[3], number) for number in numbers[1:3]]
        lines.append("| `" + key + "` | " + " | ".join(value(number) for number in numbers + ratios)
                     + f" | old: {old_verdict}; pre: {pre_verdict} |")
    return "\n".join(lines)


def render(previous, repaired):
    lines = ["## Fixed-product four-version metrics", "",
             "Historical and pre-fix cells are reused, not rerun. Ratios are descriptive with two repetitions per fixture, not equivalence estimates. N/A denotes unavailable metrics or zero denominators. Component A is N/A because the plugin was off. Retention verdicts compare fractions, not raw retained-fact counts.", ""]
    for section in ("groups", "components"):
        lines += ["### " + ("Long sessions" if section == "groups" else "Commanded components"), ""]
        for host in repaired[section]:
            lines += [f"#### {host.upper()}", "", table(previous[section][host], repaired[section][host]), ""]
    lines += ["### Per-fixture metrics", ""]
    for host, fixtures in repaired["fixtures"].items():
        for case, columns in fixtures.items():
            lines += [f"#### {host.upper()}/{case}", "", table(previous["fixtures"][host][case], columns), ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pre-fix", type=Path, required=True)
    parser.add_argument("--fixed", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(render(json.loads(args.pre_fix.read_text()), json.loads(args.fixed.read_text())) + "\n")
