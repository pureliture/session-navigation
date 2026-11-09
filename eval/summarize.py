"""Aggregate captured per-run measurements without treating missing costs as zero."""
import collections
import json
import statistics
import sys
from pathlib import Path


def aggregate(rows):
    usage = [u for row in rows for u in row["usage"]]
    operations = [op for row in rows for op in row["operations"]]
    return {"sessions": len(rows), "success": sum(row["task_success"] for row in rows),
        "recall": sum(row["recall_correct"] for row in rows), "turns": sum(row["user_turns"] for row in rows),
        "requests": len(usage), "calls": dict(collections.Counter(op["name"] for op in operations)),
        "boundary_calls": sum(op["at_subtask_boundary"] is True for op in operations),
        "rejected": sum(sum(row["rejections"].values()) for row in rows), "selected": sum(len(row["chosen"]) for row in rows),
        "observed_disposable": sum(row["disposable_observed"] for row in rows),
        "selected_disposable": sum(row["selected_disposable_unique"] for row in rows),
        "labelled_selections": sum(row["labelled_selections"] for row in rows),
        "unknown_selections": sum(row["unknown_selections"] for row in rows),
        "hidden": sum(row["hidden"] for row in rows), "later_rereads": sum(row["later_turn_rereads"] for row in rows),
        "prompt": sum(u["prompt"] for u in usage), "cached": sum(u["cached"] or 0 for u in usage),
        "completion": sum(u["completion"] for u in usage), "peak_prompt": max([u["prompt"] for u in usage] or [0]),
        "cost": sum(u["cost"] for u in usage if u["cost"] is not None),
        "summary_requests": sum(u["summary"] for u in usage), "summary_prompt": sum(u["prompt"] for u in usage if u["summary"]),
        "reference_gpt41": sum(u["gpt41_reference_usd"] for u in usage),
        "mean_cost": statistics.mean([sum(u["cost"] for u in row["usage"]) for row in rows]) if rows and not any(row["missing_cost"] for row in rows) else None,
        "missing_cost": sum(row["missing_cost"] for row in rows), "missing_cached": sum(row["missing_cached"] for row in rows),
        "retries": sum(row["retries"] for row in rows), "guard_denials": sum(row["guard_denials"] for row in rows)}


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    rows = json.loads((directory / "metrics.json").read_text())
    groups = {f"{host}-{arm}": aggregate([r for r in rows if r["host"] == host and r["arm"] == arm])
        for host in ["omp", "hermes"] for arm in ["A", "B"]}
    cases = {f"{host}-{case}-{arm}": aggregate([r for r in rows if r["host"] == host and r["arm"] == arm and case in r["id"]])
        for host in ["omp", "hermes"] for case in ["01-explore", "02-bugfix", "03-logs", "04-distractors", "05-protected", "06-long"]
        for arm in ["A", "B"] if any(r["host"] == host and case in r["id"] for r in rows)}
    (directory / "summary.json").write_text(json.dumps({"groups": groups, "cases": cases}, indent=2))
    print(json.dumps(groups, indent=2))
