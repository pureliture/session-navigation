"""Read-only frozen inputs, separately assembled current results, common v4 scoring."""
import argparse
import collections
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import itertools
import sqlite3

from analyze import read, read_wire, native_records, text, NAV, is_work_call
from v2_analyze import score
from v2_answer_surface import score_surfaces
from v2_cache import transitions
from v4_current import SETTINGS, PRODUCT, write


def candidates(source, historical=False, components=False, product_commit=PRODUCT):
    wire = read_wire(source)
    failures = {r["path"].split("/")[1] for r in wire if r["kind"] == "failure"}
    responses = {r["id"]: r for r in wire if r["kind"] == "response"}
    selected, excluded = [], []
    for path in sorted(source.glob("*/spec.json")):
        spec = read(path)
        if historical and spec["arm"] not in ("A", "B-new"):
            continue
        if historical and components and spec["arm"] == "A":
            continue
        expected = "37348b8" if historical and spec["arm"] != "A" else product_commit
        assert historical and spec["arm"] == "A" or spec["product_commit"].startswith(expected)
        assert spec["model"] == SETTINGS["model"] and spec["provider"] == "Relace" and spec["window"] == 65536
        folder = path.parent
        turns = read(folder / "turns.json.gz") if (folder / "turns.json.gz").exists() else []
        requests = [r for r in wire if r["kind"] == "request" and r["path"].split("/")[1] == spec["id"]]
        missing = [r["id"] for r in requests if r["id"] not in responses or
                   responses[r["id"]]["body"].get("usage", {}).get("cost") is None or
                   responses[r["id"]]["body"].get("usage", {}).get("prompt_tokens_details", {}).get("cached_tokens") is None]
        reason = None
        if spec["id"] in failures or missing:
            reason = "API/transport/missing-usage failure; excluded, not product failure"
        elif len(turns) != len(spec["turns"]):
            reason = "incomplete; inspect host log before classifying"
        if reason:
            excluded.append({"source": str(folder), "reason": reason})
            continue
        status = read(folder / "status.json")
        if status.get("returncode") != 0:
            excluded.append({"source": str(folder), "reason": "host/harness process failure; inspect log"})
            continue
        selected.append((folder, spec))
    return selected, excluded


def assemble(destination, sources, historical=False, components=False, product_commit=PRODUCT):
    destination.mkdir()
    all_selected, excluded, cells, fixture_settings, fixture_hashes = [], [], set(), {}, {}
    for source in sources:
        stage = read(source / "stage.json")
        assert all(stage[k] == SETTINGS[k] for k in SETTINGS)
        selected, rejected = candidates(source, historical, components, product_commit)
        excluded += rejected
        for folder, spec in selected:
            case = spec["component"] if components else next(c for c in ("atlas", "boreal") if f"-{c}-" in spec["id"])
            cell = (spec["host"], spec["arm"], case, spec["repetition"])
            assert cell not in cells, f"Duplicate qualifying outcome {cell}; never select on quality"
            cells.add(cell)
            fixture = {key: spec[key] for key in ("turns", "answers", "results", "canonical_test") if key in spec}
            assert fixture_settings.setdefault(case, fixture) == fixture
            fixture_hashes.setdefault(case, {})[spec["id"]] = spec.get("fixture_sha256")
            shutil.copytree(folder, destination / spec["id"])
            all_selected.append((source, spec["id"]))
    with gzip.open(destination / "wire.jsonl.gz", "wt") as output:
        for source in sources:
            wanted = {identity for directory, identity in all_selected if directory == source}
            for row in read_wire(source):
                if row["path"].split("/")[1] in wanted:
                    output.write(json.dumps(row) + "\n")
    write(destination / "stage.json", {**SETTINGS, "components": components})
    write(destination / "selection.json", {"selected": [identity for _, identity in all_selected], "excluded": excluded,
          "cells": sorted(cells), "fixtures": fixture_settings, "fixture_hashes": fixture_hashes})
    if all_selected:
        score(destination)
        score_surfaces(destination)
        write(destination / "cache-transitions.json", transitions(read_wire(destination), read(destination / "replacements.json.gz"),
                                                               read(destination / "metrics-v2.json")))
    if historical and components and (sources[0] / "judge").exists():
        shutil.copytree(sources[0] / "judge", destination / "judge")
    return {"cells": sorted(cells), "excluded": excluded, "fixtures": fixture_settings, "fixture_hashes": fixture_hashes}


def original_safety(directory, reports):
    checked, mutations, snapshots, unknown, native_checked, native_changes = 0, [], 0, [], 0, 0
    for report in reports:
        folder = directory / report["id"]
        spec = read(folder / "spec.json")
        snapshot = read(folder / "store.json.gz") if (folder / "store.json.gz").exists() else {"items": []}
        database = Path(spec["workspace"]).parent / "navigation.sqlite3"
        targets = []
        if database.exists():
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                connection.row_factory = sqlite3.Row
                targets = [dict(row) for row in connection.execute("SELECT * FROM adapter_targets")]
        turns = read(folder / "turns.json.gz")
        calls, records = native_records(turns, spec["turns"])
        seen = {}
        for turn in turns:
            for message in turn.get("messages", []):
                if message.get("role") not in ("tool", "toolResult"):
                    continue
                identity = message.get("toolCallId", message.get("tool_call_id"))
                if calls.get(identity, {}).get("name") in NAV | {"tool_call", "tool_describe", "tool_search"}:
                    continue
                original = text(message.get("content"))
                if identity in seen and seen[identity] != original:
                    native_changes += 1
                elif identity not in seen:
                    native_checked += 1
                seen[identity] = original
        checked_ids = set()
        for item in [*snapshot["items"], *targets]:
            original = item["original"]
            snapshots += 1
            digest = item.get("content_sha256")
            if digest and hashlib.sha256(original.encode()).hexdigest() != digest:
                mutations.append({"id": report["id"], "item": item["item_id"], "kind": "stored content hash mismatch"})
            native = records.get(item["tool_call_id"])
            if native is None:
                unknown.append({"id": report["id"], "item": item["item_id"]})
            elif native["original"] == original:
                if item["item_id"] not in checked_ids:
                    checked += 1
                    checked_ids.add(item["item_id"])
            else:
                mutations.append({"id": report["id"], "item": item["item_id"], "kind": "native/store original mismatch"})
    return {"originals_compared": checked, "stored_items": snapshots, "original_mismatches": len(mutations),
            "mismatch_details": mutations, "unmatched_native_items": len(unknown), "native_originals_checked": native_checked,
            "native_tool_content_transitions": native_changes}


def metrics(directory, reports):
    if not reports:
        return {}
    surfaces = {r["id"]: r for r in read(directory / "answer-surface.json")["sessions"]}
    usage = [u for r in reports for u in r["usage"]]
    status = [read(directory / r["id"] / "status.json") for r in reports]
    data = {"sessions": len(reports), "final_only_success": sum(surfaces[r["id"]]["final_message_success"] for r in reports),
            "task_success": sum(r["task_success"] for r in reports),
            "visible_unit_success": sum(surfaces[r["id"]]["visible_unit_success"] for r in reports),
            "canonical_tests_pass": sum(s.get("canonical_tests_pass", False) for s in status),
            "canonical_tests_applicable": sum("canonical_tests_pass" in s for s in status),
            "announced_recall": sum(r["announced_recall_correct"] for r in reports),
            "surprise_recovery": sum(r["surprise_recall_correct"] for r in reports),
            "navigation_calls": sum(len(r["operations"]) for r in reports),
            "sessions_using_navigation": sum(bool(r["operations"]) for r in reports),
            "list_calls": sum(op["name"] == "list_context_items" for r in reports for op in r["operations"]),
            "literal_ids_valid": sum(r["literal_ids_valid"] for r in reports),
            "literal_ids_selected": sum(r["literal_ids_selected"] for r in reports),
            "cleanup_boundaries": sum(len(r["successful_cleanup_boundaries"]) for r in reports),
            "sessions_with_2_boundaries": sum(len(r["successful_cleanup_boundaries"]) >= 2 for r in reports),
            "native_compactions": sum(len(r["native_compactions"]) for r in reports),
            "requests": len(usage), "prompt_tokens": sum(u["prompt"] for u in usage),
            "cached_tokens": sum(u["cached"] or 0 for u in usage), "output_tokens": sum(u["completion"] for u in usage),
            "peak_prompt": max((u["prompt"] for u in usage), default=0),
            "reported_usd": None if any(u["cost"] is None for u in usage) else sum(u["cost"] for u in usage),
            "missing_cost": sum(u["cost"] is None for u in usage), "missing_cached": sum(u["cached"] is None for u in usage),
            "summary_requests": sum(u["summary"] for u in usage),
            "reference_cost": sum(u["gpt41_reference_usd"] for u in usage),
            "reference_no_cache": sum(u["gpt41_uncached_upper_usd"] for u in usage),
            "final_backreferences": sum(len(surfaces[r["id"]]["final_backreferences"]) for r in reports)}
    for field in ("eligible_disposable_observed", "eligible_disposable_unique_selected", "eligible_selected", "selected_eligible_disposable",
                  "explicit_hide_eligible", "explicit_hide_disposable", "keep_lines_calls"):
        data[field] = sum(r[field] for r in reports)
    data["successful_unhide"] = sum(op["name"] == "unhide_context" and op["result"].get("ok") is True for r in reports for op in r["operations"])
    rereads = read(directory / "rereads.json")
    wanted = {r["id"] for r in reports}
    available = [r for r in rereads["sessions"] if r["id"] in wanted]
    for field in ("after_compaction", "repeat_visible", "same_turn", "later_turn", "unhide_calls"):
        data["rereads_" + field] = sum(r[field] for r in available) if len(available) == len(reports) else None
    for tool in ("read", "bash"):
        for field in ("after_compaction", "repeat_visible", "new"):
            data[f"rereads_{tool}_{field}"] = sum(r[tool][field] for r in available) if len(available) == len(reports) else None
    if (directory / "cache-transitions.json").exists():
        events = [r for r in read(directory / "cache-transitions.json")["events"] if r["run"] in wanted]
        data["cache_transitions"] = len(events)
        for field in ("uncached_growth", "reported_cost_delta", "native_growth_sensitivity_usd", "reference_growth_sensitivity_usd"):
            data["transition_" + field] = None if any(r[field] is None for r in events) else sum(r[field] for r in events)
    data.update({k: v for k, v in original_safety(directory, reports).items() if not isinstance(v, list)})
    return data


def is_original_tool_execution(call):
    if call.get("name") in NAV | {"tool_search", "tool_describe"}:
        return False
    if call.get("name") == "tool_call" and isinstance(call.get("args", {}).get("calls"), list):
        return any(is_original_tool_execution({"name": item.get("name"), "args": item.get("arguments", {})})
                   for item in call["args"]["calls"])
    return is_work_call(call)


def component_metrics(directory, host):
    reports = [r for r in read(directory / "metrics-v2.json") if r["host"] == host]
    replacements = read(directory / "replacements.json.gz")
    result = {"trials": len(reports), "strict_success": sum(r["task_success"] for r in reports),
              "successful_unhide": sum(op["name"] == "unhide_context" and op["result"].get("ok") is True for r in reports for op in r["operations"])}
    restored_without_rerun, restored_original_sent, third_turn_work = 0, 0, 0
    wire = read_wire(directory)
    for report in reports:
        spec = read(directory / report["id"] / "spec.json")
        turns = read(directory / report["id"] / "turns.json.gz")
        calls, _ = native_records(turns, spec["turns"])
        work = [c for c in calls.values() if c["turn"] >= 3 and is_original_tool_execution(c)]
        third_turn_work += len(work)
        restored = any(op["name"] == "unhide_context" and op["result"].get("ok") is True for op in report["operations"])
        restored_without_rerun += restored and not work
        outgoing = [r for r in wire if r["kind"] == "request" and r["path"].split("/")[1] == report["id"]]
        if restored and outgoing:
            originals = [r["original"] for r in replacements if r["run"] == report["id"]]
            final_tools = "\n".join(text(m.get("content")) for m in outgoing[-1]["body"].get("messages", []) if m["role"] == "tool")
            restored_original_sent += bool(originals) and all(original in final_tools for original in originals)
    result.update(restores_without_work_rerun=restored_without_rerun,
                  restored_original_in_final_request=restored_original_sent, third_turn_work_calls=third_turn_work)
    for action in ("hide", "summarize"):
        rows = [r for r in reports if r["component"] == action]
        wanted = {r["id"] for r in rows}
        sent = [r for r in replacements if r["run"] in wanted and r["actually_sent"]]
        expected = "rule" if action == "hide" else "llm"
        pure = sum(bool([r for r in sent if r["run"] == report["id"]]) and
                   all(r["source"] == expected for r in sent if r["run"] == report["id"]) for report in rows)
        result.update({action + "_trials": len(rows), action + "_pure_replacement_trials": pure,
                       action + "_sent_replacements": len(sent),
                       action + "_pure_replacements": sum(r["source"] == expected for r in sent),
                       action + "_facts_present": sum(len(r["facts_retained"]) for r in sent),
                       action + "_facts_retained": sum(sum(r["facts_retained"]) for r in sent),
                       action + "_wrong_source": sum(r["source"] != expected for r in sent)})
    result["sent_replacements"] = result["hide_sent_replacements"] + result["summarize_sent_replacements"]
    result["wrong_source"] = result["hide_wrong_source"] + result["summarize_wrong_source"]
    result.update({k: v for k, v in original_safety(directory, reports).items() if not isinstance(v, list)})
    result.update({k: v for k, v in metrics(directory, reports).items() if k in
                   ("requests", "prompt_tokens", "cached_tokens", "output_tokens", "reported_usd")})
    scores_path = directory / "judge/scores.json"
    scores = read(scores_path) if scores_path.exists() else {}
    eligible = {}
    for replacement in replacements:
        if replacement["run"] not in {r["id"] for r in reports} or not replacement["actually_sent"]:
            continue
        content = {"original": replacement["original"], "replacement": replacement["replacement"], "key_facts": replacement["facts_present"]}
        identity = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
        eligible[identity] = scores.get(identity, {})
    judgements = [entry["judgement"]["score"] for entry in eligible.values() if "judgement" in entry]
    result.update(judge_distinct_eligible=len(eligible), judge_scored=len(judgements),
                  judge_mean=sum(judgements) / len(judgements) if judgements else None)
    return result


def ratio(numerator, denominator):
    return numerator / denominator if numerator is not None and denominator not in (None, 0) else None


def compare(output, historical, currents, product_commit=PRODUCT):
    output.mkdir()
    selection = {}
    for kind in ("long", "components"):
        old = historical / ("2026-11-09-v4-deepseek" if kind == "long" else "2026-11-09-v4-quality")
        selection["historical-" + kind] = assemble(output / ("historical-" + kind), [old], True, kind == "components")
        selection["current-" + kind] = assemble(output / ("current-" + kind), [p / kind for p in currents], False, kind == "components", product_commit)
        assert selection["historical-" + kind]["fixtures"] == selection["current-" + kind]["fixtures"], "Fixture drift"
        cases = ("hide", "summarize") if kind == "components" else ("atlas", "boreal")
        expected = set(itertools.product(("omp", "hermes"), ("B-new",), cases, (1, 2)))
        assert set(map(tuple, selection["current-" + kind]["cells"])) == expected, "Missing current cells; retain exclusions and retry API failures only"
    return refresh(output, selection)


def refresh(output, selection=None):
    selection = selection or {folder: read(output / folder / "selection.json") for folder in
                              ("historical-long", "current-long", "historical-components", "current-components")}
    groups, fixtures, components = {}, {}, {}
    for host in ("omp", "hermes"):
        groups[host], fixtures[host] = {}, {}
        for column, folder, arm in (("A", "historical-long", "A"), ("B-old", "historical-long", "B-new"), ("B-current", "current-long", "B-new")):
            directory = output / folder
            reports = [r for r in read(directory / "metrics-v2.json") if r["host"] == host and r["arm"] == arm]
            groups[host][column] = metrics(directory, reports)
            for case in ("atlas", "boreal"):
                fixtures[host].setdefault(case, {})[column] = metrics(directory, [r for r in reports if f"-{case}-" in r["id"]])
        components[host] = {"B-old": component_metrics(output / "historical-components", host),
                            "B-current": component_metrics(output / "current-components", host)}
    result = {"groups": groups, "fixtures": fixtures, "components": components, "selection": selection}
    write(output / "comparison.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--historical", type=Path)
    parser.add_argument("--current", type=Path, action="append")
    parser.add_argument("--refresh", action="store_true", help="Recompute tables on assembled inputs, e.g. after judging")
    parser.add_argument("--product-commit", default=PRODUCT)
    args = parser.parse_args()
    if args.refresh:
        refresh(args.output)
    elif args.historical and args.current:
        compare(args.output, args.historical, args.current, args.product_commit)
    else:
        parser.error("Supply frozen/current inputs, or --refresh for an assembled comparison")
