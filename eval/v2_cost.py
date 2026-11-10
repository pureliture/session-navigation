"""Offline DeepSeek pilot budget report; missing usage is never a free run."""
import json
from pathlib import Path
import sys


def projection(summary, planned_sessions=8, prior_cost=0):
    groups = [g for key, g in summary["groups"].items() if key in ("omp/A", "omp/B-new")]
    sessions = sum(g["n"] for g in groups)
    complete = sum(g["complete"] for g in groups)
    missing = sum(g["missing_cost"] for g in groups)
    cost = sum(g["cost"] for g in groups)
    projected = cost * planned_sessions / sessions * 1.5 + prior_cost if sessions else None
    return {"pilot_sessions": sessions, "completed": complete, "observed_cost": cost,
            "arms": {key: {field: group[field] for field in ("prompt_tokens", "output_tokens", "cached_tokens", "cost")}
                     for key, group in summary["groups"].items() if key in ("omp/A", "omp/B-new")},
            "observed_output_tokens": sum(g["output_tokens"] for g in groups),
            "missing_cost": missing, "planned_sessions_including_pilot": planned_sessions,
            "prior_nonqualifying_cost_usd": prior_cost,
            "safety_multiplier": 1.5, "projected_total_usd": projected,
            "continue": bool(len(groups) == 2 and sessions == 2 and complete == sessions and not missing and projected <= 3)}


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    prior_cost = float(sys.argv[2]) if len(sys.argv) > 2 else 0
    report = projection(json.loads((directory / "summary-v2.json").read_text()), prior_cost=prior_cost)
    (directory / "pilot-budget.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
