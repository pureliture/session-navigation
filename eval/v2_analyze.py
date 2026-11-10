"""Eligibility-aware v2 scoring; immutable raw inputs and separate v1 reports."""
import collections
import gzip
import json
import re
from pathlib import Path
import sys

from analyze import analyze, contains, is_work_call, label, native_records, read, read_wire
from v2_rereads import rereads
from session_navigation.model import EngineConfig, ToolResultRecord, compute_invocation_digest, compute_sha256
from session_navigation.policy import refusal_reason


def eligible(record):
    info = record.get("label_info")
    if not info or info["protected"]:
        return False
    invocation = {"tool_name": record.get("name", "read"), "arguments": record.get("args", {})}
    source = record["original"]
    item = ToolResultRecord(call_id=record["id"], result_position=0, content=source, content_sha256=compute_sha256(source),
        invocation=invocation, invocation_digest=compute_invocation_digest(invocation), status="ok")
    return refusal_reason(item, EngineConfig()) is None


def match_fact(answer, fact):
    if str(fact).isdigit():
        return bool(re.search(r"(?<![\w.])" + re.escape(str(fact)) + r"(?=(?:ms\b)|[^\w.]|\.(?!\d)|$)", answer, re.I))
    return contains(answer, str(fact))


def boundary_index(op, calls):
    order = {identity: index for index, identity in enumerate(calls)}
    if op["id"] not in order:
        return None
    position = order[op["id"]]
    work = [order[identity] for identity, call in calls.items() if call["turn"] == op["turn"] and is_work_call(call)]
    before, after = any(index < position for index in work), any(index > position for index in work)
    if before and not after:
        return op["turn"]
    if not before and op["turn"] > 1:
        return op["turn"] - 1
    return None


def score(directory):
    analyze(directory, model=read(directory / "stage.json")["model"])
    reports = read(directory / "metrics.json")
    wire = read_wire(directory)
    responses = {r["id"]: r for r in wire if r["kind"] == "response"}
    for report in reports:
        folder = directory / report["id"]
        spec = read(folder / "spec.json")
        turns = read(folder / "turns.json.gz") if (folder / "turns.json.gz").exists() else []
        calls, records = native_records(turns, spec["turns"])
        for record in records.values():
            record["label_info"] = label(record.get("args", {}), record["original"], spec, min_chars=800)
        allowed = {identity for identity, record in records.items() if eligible(record)}
        disposable = {identity for identity in allowed if records[identity]["label_info"]["label"] == "disposable"}
        selected = []
        hide_selected = []
        boundary_turns = set()
        for op in report["operations"]:
            boundary = boundary_index(op, calls)
            op["boundary_index"] = boundary
            op["at_subtask_boundary"] = boundary is not None
            if op["name"] in ("list_context_items", "unhide_context"):
                continue
            ids = op["args"].get("tool_call_ids", [op["args"].get("tool_call_id")])
            selected.extend(identity for identity in (ids if isinstance(ids, list) else []) if identity)
            if op["name"] == "hide_context" or op["args"].get("action") == "hide":
                hide_selected.extend(identity for identity in (ids if isinstance(ids, list) else []) if identity in allowed)
            result = op["result"]
            success = result.get("applied", 0) > 0 or result.get("ok") is True
            if success and op["at_subtask_boundary"]:
                boundary_turns.add(boundary)
        selected_eligible = [identity for identity in selected if identity in allowed]
        selected_disposable = disposable & set(selected_eligible)
        events = [json.loads(line) for line in gzip.open(folder / "events.jsonl.gz", "rt")] if (folder / "events.jsonl.gz").exists() else []
        compactions = [row for row in events if row.get("kind") == "host_event" and
                       row.get("event", {}).get("type") in ("auto_compaction_start", "manual_compaction_start", "native_compaction_start")]
        compaction_ends = [{"turn": row["turn"], **{key: row["event"][key] for key in ("type", "action", "skipped", "aborted", "success", "error") if key in row["event"]}}
                           for row in events if row.get("kind") == "host_event" and row.get("event", {}).get("type") in ("auto_compaction_end", "manual_compaction_end", "native_compaction_end")]
        checks = [{"turn": index + 1, "facts": facts,
                   "matched": [match_fact(turns[index]["answer"], fact) if index < len(turns) else False for fact in facts]}
                  for index, facts in enumerate(spec["answers"]) if facts]
        report["answer_checks"] = checks
        report["task_success"] = len(turns) == len(spec["turns"]) and all(all(row["matched"]) for row in checks)
        def recall(turn):
            check = next((row for row in checks if row["turn"] == turn), None)
            return bool(check and all(check["matched"]))
        reported = [responses.get(req["id"], {}).get("body", {}) for req in wire
                    if req["kind"] == "request" and req["path"].split("/")[1] == spec["id"]]
        peak = max((u["prompt"] for u in report["usage"]), default=0)
        usage_events = [r["usage"] for r in events if r.get("kind") == "context_usage" and r.get("usage")]
        host_peak = max((u.get("tokens") or 0 for u in usage_events), default=0)
        report.update(component=spec.get("component"), product_commit=spec["product_commit"],
            eligible_observed=len(allowed), eligible_disposable_observed=len(disposable),
            eligible_selected=len(selected_eligible), selected_eligible_disposable=sum(i in disposable for i in selected_eligible),
            explicit_hide_eligible=len(hide_selected), explicit_hide_disposable=sum(i in disposable for i in hide_selected),
            eligible_disposable_unique_selected=len(selected_disposable), literal_ids_selected=len(selected),
            literal_ids_valid=sum(i in records for i in selected), successful_cleanup_boundaries=sorted(boundary_turns),
            keep_lines_calls=sum("keep_lines" in op["args"] for op in report["operations"]),
            native_compactions=[{"turn": row["turn"], "type": row["event"]["type"]} for row in compactions],
            native_compaction_ends=compaction_ends,
            announced_recall_correct=recall(spec.get("announced_recall_turn", len(spec["turns"]))),
            surprise_recall_correct=recall(spec.get("surprise_recall_turn", len(spec["turns"]))),
            pressure={"window": spec["window"], "reported_peak": peak, "host_peak": host_peak,
                      "reported_tiers": [tier for tier in (50, 75, 90) if peak >= tier * spec["window"] / 100]},
            response_providers=dict(collections.Counter(body.get("provider", "unreported") for body in reported)))
        report["failure_kinds"] = dict(collections.Counter(
            row["failure_kind"] for row in report["usage"] if row.get("failure_kind")
        ))
        if spec.get("canonical_test"):
            report["task_success"] = report["task_success"] and report["status"].get("canonical_tests_pass", False)
    (directory / "metrics-v2.json").write_text(json.dumps(reports, indent=2))
    groups = {}
    for host in ("omp", "hermes"):
        for arm in ("A", "B-old", "B-new"):
            runs = [r for r in reports if r["host"] == host and r["arm"] == arm]
            if not runs:
                continue
            usage = [u for r in runs for u in r["usage"]]
            groups[f"{host}/{arm}"] = {"n": len(runs), "complete": sum(r["user_turns"] == len(read(directory / r["id"] / "spec.json")["turns"]) for r in runs),
                "task_success": sum(r["task_success"] for r in runs), "announced_recall": sum(r["announced_recall_correct"] for r in runs),
                "surprise_recovery": sum(r["surprise_recall_correct"] for r in runs),
                "nav_calls": sum(len(r["operations"]) for r in runs), "successful_boundaries": sum(len(r["successful_cleanup_boundaries"]) for r in runs),
                "sessions_with_2_boundaries": sum(len(r["successful_cleanup_boundaries"]) >= 2 for r in runs),
                "literal_ids_valid": sum(r["literal_ids_valid"] for r in runs), "literal_ids_selected": sum(r["literal_ids_selected"] for r in runs),
                "eligible_disposable": sum(r["eligible_disposable_observed"] for r in runs), "selected_disposable": sum(r["eligible_disposable_unique_selected"] for r in runs),
                "eligible_selections": sum(r["eligible_selected"] for r in runs), "disposable_selections": sum(r["selected_eligible_disposable"] for r in runs),
                "explicit_hide_eligible": sum(r["explicit_hide_eligible"] for r in runs), "explicit_hide_disposable": sum(r["explicit_hide_disposable"] for r in runs),
                "keep_lines_calls": sum(r["keep_lines_calls"] for r in runs), "native_compactions": sum(len(r["native_compactions"]) for r in runs),
                "failure_kinds": dict(collections.Counter(kind for r in runs for kind, count in r["failure_kinds"].items() for _ in range(count))),
                "prompt_tokens": sum(u["prompt"] for u in usage), "output_tokens": sum(u["completion"] for u in usage),
                "cached_tokens": sum(u["cached"] or 0 for u in usage), "missing_cached": sum(u["cached"] is None for u in usage),
                "cost": sum(u["cost"] or 0 for u in usage), "missing_cost": sum(u["cost"] is None for u in usage),
                "peak_prompt": max((u["prompt"] for u in usage), default=0),
                "reference_cost": sum(u["gpt41_reference_usd"] for u in usage), "reference_no_cache": sum(u["gpt41_uncached_upper_usd"] for u in usage)}
    gate = adoption_gate(reports)
    result = {"groups": groups, "deepseek_gate": gate}
    result["rereads"] = rereads(directory)["groups"]
    (directory / "summary-v2.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return result


def adoption_gate(reports):
    new = [r for r in reports if r["arm"] == "B-new" and not r["component"]]
    valid, selected = sum(r["literal_ids_valid"] for r in new), sum(r["literal_ids_selected"] for r in new)
    active = sum(len(r["successful_cleanup_boundaries"]) >= 2 for r in new)
    return {"eligible_sessions": len(new), "sessions_with_2_boundaries": active, "valid_ids": valid, "selected_ids": selected,
            "pass": bool(new and active >= len(new) / 2 and selected and valid / selected >= .9)}


if __name__ == "__main__":
    score(Path(sys.argv[1]))
