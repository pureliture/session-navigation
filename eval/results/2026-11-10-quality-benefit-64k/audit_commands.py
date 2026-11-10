"""Rebuild read-only-wire campaign summaries and configuration-restore evidence."""
import collections
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
EVAL = ROOT.parent.parent
sys.path.insert(0, str(EVAL))
from quality_score import campaign_wire, MODEL, PROVIDER, REASONING, percentile
from run import hashes

stage = json.loads((ROOT / "stage.json").read_text())
score = json.loads((ROOT / "scorecard.json").read_text())
sessions = score["sessions"]
included = [row for row in sessions if row["eligible"]]
assert len({(row["seed"], row["arm"]) for row in included}) == len(included)
wire = campaign_wire(ROOT)
requests = [row for row in wire if row["kind"] == "upstream_request"]
responses = [row for row in wire if row["kind"] == "response"]
source_matches = all(hashlib.sha256((EVAL / name).read_bytes()).hexdigest() == digest
                     for name, digest in stage["source_hashes"].items())
assert source_matches
settings_match = all(row["body"].get("model") == MODEL and row["body"].get("provider") == PROVIDER
                     and row["body"].get("reasoning") == REASONING for row in requests)
assert settings_match
providers = collections.Counter(row["body"].get("provider") for row in responses)
reasoning = collections.Counter(row["body"].get("usage", {}).get("completion_tokens_details", {}).get("reasoning_tokens") for row in responses)
b_functions = collections.Counter()
b_context_arguments = []
for row in responses:
    if "B-new" not in row["path"]:
        continue
    for call in (row["body"].get("choices") or [{}])[0].get("message", {}).get("tool_calls") or []:
        function = call["function"]
        b_functions[function["name"]] += 1
        if "context" in function.get("arguments", "").lower():
            b_context_arguments.append({"request_id": row["id"], "function": function})
groups = {}
for arm in ("A", "B-new"):
    rows = [row for row in included if row["arm"] == arm]
    group = {key: sum(row[key] for row in rows) for key in (
        "final_success", "visible_success", "final_late_success", "visible_late_success", "prompt_tokens", "output_tokens",
        "native_starts", "native_changed", "native_sent", "nav_calls", "requests", "cost",
        "final_stale", "visible_stale", "final_unsupported", "visible_unsupported")}
    group["sessions"] = len(rows)
    group["final_checks"] = sum(check["final"]["success"] for row in rows for check in row["checks"])
    group["visible_checks"] = sum(check["visible"]["success"] for row in rows for check in row["checks"])
    measures = [measure for row in rows for measure in row["measurements"]]
    group["tool_token_share_median"] = percentile([m["tool_token_share"] for m in measures], .5)
    group["tool_token_share_p90"] = percentile([m["tool_token_share"] for m in measures], .9)
    group["maximum_reported_prompt_tokens"] = max(m["prompt_tokens"] for m in measures)
    groups[arm] = group
missing = [entry for entry in stage["schedule"] if not any(
    row["seed"] == entry["seed"] and row["arm"] == entry["arm"] for row in included)]
summary = {"status": "partial_api_blocked" if missing else "complete", "benefit": "not_shown",
           "mechanism_exercised": any(row["nav_calls"] for row in included if row["arm"] == "B-new"),
           "included_ids": [row["id"] for row in included], "missing_qualifying_cells": missing,
           "groups": groups, "captured_total_cost": score["total_cost"],
           "qualifying_cost": sum(row["cost"] for row in included),
           "excluded_cost": sum(row["cost"] for row in sessions if not row["eligible"]),
           "excluded_setup_cost": stage["excluded_setup_cost"],
           "limitation": "No cleanup was invoked. This does not establish Hide/Summarize efficacy. Requested JSON fields only; arbitrary prose is not semantically adjudicated."}
audit = {"upstream_attempts": len(requests), "unique_requests": len({row["id"] for row in requests}),
         "responses": len(responses), "reported_providers": dict(providers), "reported_reasoning_tokens": dict(reasoning),
         "settings_match": settings_match, "source_hashes_match": source_matches,
         "B_raw_wire_function_counts": dict(b_functions), "B_calls_with_context_arguments": b_context_arguments,
         "exhausted_requests": [{key: row.get(key) for key in ("id", "path", "status", "attempt")}
                                for row in wire if row["kind"] == "failure"]}
failures = [{"id": row["id"], "checks": [check for check in row["checks"] if not check["final"]["success"] or not check["visible"]["success"]]}
            for row in included if not row["final_success"] or not row["visible_success"]]
causality = {"scored_product_failures": failures,
             "excluded_api_attempts": [{"id": row["id"], "all_answers_pass": row["final_success"] and row["visible_success"],
                                        "missing_usage_ids": [m["id"] for m in row["measurements"] if m["cost"] is None],
                                        "classification": "Native summary exhausted Relace 429 backoff; not a product failure."}
                                       for row in sessions if not row["eligible"]],
             "diagnostic_replays": 0,
             "conclusion": "No scored failure needs a context-loss/stale-value/reasoning/output-budget attribution. API errors cannot establish a quality benefit. A used ordinary source recovery successfully; no B cleanup mechanism was exercised."}
safety = [json.loads(path.read_text()) for path in (ROOT / "attempts").glob("*/safety.json")]
safety += [json.loads(path.read_text()) for path in Path(stage["setup_evidence"]).glob("attempts/*/safety.json")]
baseline = safety[0]["configs_before"]
restore = {"attempts_checked": len(safety), "baseline": baseline, "current": hashes(),
           "byte_exact": all(row["configs_before"] == baseline == row["configs_after"] for row in safety) and hashes() == baseline}
assert restore["byte_exact"]
for name, value in (("summary.json", summary), ("request-audit.json", audit), ("causal-inspection.json", causality), ("config-restore.json", restore)):
    (ROOT / name).write_text(json.dumps(value, indent=2))
print(json.dumps(summary, indent=2))
print(json.dumps(audit, indent=2))
print("final configurations byte-exact:", restore["byte_exact"])
