"""Deterministic scoring of captured real-host runs; no network calls."""
import collections
import gzip
import json
import re
import sqlite3
import sys
from pathlib import Path

from proxy import MODEL

NAV = {"manage_context", "hide_context", "summarize_context", "unhide_context", "list_context_items"}


def read(path):
    return json.loads(gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes())


def text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(str(block.get("text", "")) if isinstance(block, dict) else str(block) for block in value)
    return json.dumps(value, ensure_ascii=False)


def contains(answer, fact):
    if fact == "unresolved":
        return bool(re.search(r"not[\s*]+(?:(?:yet|been)[\s*]+)?resolved|unresolved|still[\s*]+blocked|^\s*(?:\*\*)?no\b", answer, re.I))
    if fact == "pass":
        return bool(re.search(r"pass|success|\bOK\b", answer, re.I))
    if fact == "5":
        return bool(re.search(r"\b(?:5|five)\b", answer, re.I))
    return bool(re.search(r"(?<!\w)" + re.escape(fact) + r"(?!\w)", answer, re.I))


def fact_value(fact):
    return re.split(r"[=:]", fact, maxsplit=1)[-1].strip().strip("'\"")


def label(args, original, spec, min_chars=1000):
    if len(original) < min_chars:
        return None
    matching = [entry for entry in spec["results"] if entry["match"] in json.dumps(args)]
    if not matching:
        return None
    return {"label": "needed-later" if any(e["label"] == "needed-later" for e in matching) else "disposable",
        "protected": any(e["protected"] for e in matching), "facts": [f for e in matching for f in e["facts"]],
        "matches": [e["match"] for e in matching]}


def native_records(turns, user_prompts=None):
    calls, records = {}, {}
    prompts = {text(prompt): i + 1 for i, prompt in enumerate(user_prompts or [])}
    prompts.update({text(t["prompt"]): t["turn"] for t in turns if t.get("prompt")})
    for turn in turns:
        current_turn = turn["turn"]
        for message in turn.get("messages", []):
            if message.get("role") == "user":
                current_turn = prompts.get(text(message.get("content")), current_turn)
            if message.get("role") == "assistant":
                blocks = message.get("content", [])
                if isinstance(blocks, list):
                    for block in blocks:
                        if block.get("type") == "toolCall":
                            calls.setdefault(block["id"], {"name": block["name"], "args": block.get("arguments", {}), "turn": current_turn})
                for call in message.get("tool_calls") or []:
                    function = call["function"]
                    try:
                        args = json.loads(function.get("arguments") or "{}")
                    except ValueError:
                        args = {"unparsed": function.get("arguments")}
                    calls.setdefault(call["id"], {"name": function["name"], "args": args, "turn": current_turn})
            if message.get("role") in ["tool", "toolResult"]:
                identity = message.get("toolCallId", message.get("tool_call_id"))
                records.setdefault(identity, {**calls.get(identity, {}), "id": identity,
                    "original": text(message.get("content")), "first_turn": current_turn})
    return calls, records


def operation(call):
    name, args = call.get("name"), call.get("args", {})
    if name in ["tool_call", "tool"]:
        name = args.get("name", args.get("tool_name", args.get("tool")))
        args = args.get("arguments", args.get("parameters", {}))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {}
    return (name, args) if name in NAV else (None, {})


def analyze(directory):
    with gzip.open(directory / "wire.jsonl.gz", "rt") as handle:
        wire = [json.loads(line) for line in handle]
    requests = {row["id"]: row for row in wire if row["kind"] == "request"}
    assert all(row["body"].get("model") == MODEL for row in requests.values()), "Mixed models cannot be scored"
    responses = {row["id"]: row for row in wire if row["kind"] == "response"}
    reports, replacements = [], []
    for folder in sorted(directory.iterdir()):
        if not folder.is_dir() or not (folder / "status.json").exists() or not (folder / "spec.json").exists():
            continue
        spec, status = read(folder / "spec.json"), read(folder / "status.json")
        turns = read(folder / "turns.json.gz") if (folder / "turns.json.gz").exists() else []
        calls, records = native_records(turns, spec["turns"])
        for record in records.values():
            record["label_info"] = label(record.get("args", {}), record["original"], spec)
        operations = []
        if (folder / "events.jsonl.gz").exists():
            events = [json.loads(line) for line in gzip.open(folder / "events.jsonl.gz", "rt")]
            for row in events:
                if row["kind"] == "nav_end":
                    result = row["result"].get("details", {})
                    operations.append({"id": row["id"], "name": row["name"], "args": row["args"], "turn": row["turn"], "result": result})
        else:
            for identity, call in calls.items():
                name, args = operation(call)
                if name:
                    try:
                        result = json.loads(records.get(identity, {}).get("original", "{}"))
                    except ValueError:
                        result = {"unparsed": True}
                    operations.append({"id": identity, "name": name, "args": args, "turn": call["turn"], "result": result})
        items = []
        db = Path(spec["workspace"]).parent / "navigation.sqlite3"
        snapshot_path = folder / "store.json.gz"
        if snapshot_path.exists():
            snapshot = read(snapshot_path)
            items = snapshot["items"]
        elif db.exists():
            connection = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            try:
                items = [dict(row) for row in connection.execute("SELECT * FROM items")]
                units = [dict(row) for row in connection.execute("SELECT * FROM units")]
            finally:
                connection.close()
            snapshot = {"available": True, "items": items, "units": units}
            with gzip.open(snapshot_path, "wt") as handle:
                json.dump(snapshot, handle)
        else:
            snapshot = {"available": False, "items": [], "units": []}
        item_ids = {row["item_id"]: row["tool_call_id"] for row in items}
        chosen = []
        for op in operations:
            if op["name"] in ["list_context_items", "unhide_context"]:
                continue
            args = op["args"]
            identities = args.get("tool_call_ids", [])
            if args.get("tool_call_id"):
                identities = [*identities, args["tool_call_id"]]
            if args.get("item_id"):
                identities = [*identities, item_ids.get(args["item_id"], args["item_id"])]
            for identity in identities:
                info = records.get(identity, {}).get("label_info")
                chosen.append({"id": identity, "turn": op["turn"], "name": op["name"], "action": args.get("action"), "label": info})
        disposable = {identity for identity, record in records.items() if record["label_info"] and record["label_info"]["label"] == "disposable"}
        selected_disposable = {row["id"] for row in chosen if row["label"] and row["label"]["label"] == "disposable"}
        labelled = [row for row in chosen if row["label"]]
        checks = [{"turn": i + 1, "facts": facts, "matched": [contains(turns[i]["answer"], fact) if i < len(turns) else False for fact in facts]}
            for i, facts in enumerate(spec["answers"]) if facts]
        recall = checks[-1] if checks else {"matched": []}
        if "05-protected" in spec["id"]:
            recall["facts"].append("unresolved")
            recall["matched"].append(contains(turns[-1]["answer"], "unresolved") if turns else False)
        successful = all(all(check["matched"]) for check in checks) and len(turns) == len(spec["turns"])
        if spec["id"].split("-")[1:3] == ["02", "bugfix"]:
            successful = status.get("canonical_tests_pass", False)
        run_requests = [row for row in requests.values() if row["path"].split("/")[1] == spec["id"]]
        usage_rows = []
        previous = b""
        for request in sorted(run_requests, key=lambda r: r["time"]):
            body = request["body"]
            messages = body.get("messages", [])
            system = " ".join(text(m.get("content")) for m in messages if m.get("role") in ["system", "developer"])
            summary = "Summarize this tool result" in text(messages[0].get("content")) if messages else False
            summary = summary or system.startswith("Summarize the tool result.")
            usage = responses.get(request["id"], {}).get("body", {}).get("usage", {})
            canonical = json.dumps({"messages": messages, "tools": body.get("tools", [])}, sort_keys=True, ensure_ascii=False).encode()
            common = 0
            for a, b in zip(previous, canonical):
                if a != b:
                    break
                common += 1
            prompt = usage.get("prompt_tokens", 0)
            cached = usage.get("prompt_tokens_details", {}).get("cached_tokens")
            estimate = prompt * common / len(canonical) if canonical else 0
            output = usage.get("completion_tokens", 0)
            usage_rows.append({"id": request["id"], "summary": summary, "prompt": prompt, "completion": output,
                "cached": cached, "cost": usage.get("cost"), "lcp_estimated_tokens": round(estimate),
                "gpt41_reference_usd": ((prompt - (cached if cached is not None else estimate)) * 2 + (cached if cached is not None else estimate) * .5 + output * 8) / 1e6,
                "gpt41_uncached_upper_usd": (prompt * 2 + output * 8) / 1e6})
            previous = canonical
        hidden = [item for item in items if item["visibility"] == "hidden"]
        rereads = []
        for item in [item for item in items if item["compacted"]]:
            identity = item["tool_call_id"]
            record = records.get(identity, {})
            info = record.get("label_info")
            if not info:
                invocation = json.loads(item.get("invocation_snapshot") or "{}")
                info = label(invocation, item["original"], spec)
            applied_turns = [op["turn"] for op in chosen if op["id"] == identity]
            applied_turn = min(applied_turns) if applied_turns else 999
            if info:
                related = [r for r in records.values() if r["id"] != identity and r["first_turn"] > applied_turn and
                    r.get("label_info") and set(r["label_info"]["matches"]) & set(info["matches"])]
                if info["label"] == "needed-later":
                    rereads.extend(r["id"] for r in related)
                forms = [item["compacted"], json.dumps(item["compacted"], ensure_ascii=False)[1:-1], json.dumps(item["compacted"])[1:-1]]
                actual_sent = any(any(form in text(message.get("content")) for form in forms) for req in run_requests
                    for message in req["body"].get("messages", []) if message.get("role") == "tool")
                replacements.append({"run": spec["id"], "item_id": item["item_id"], "tool_call_id": identity,
                    "source": item["compaction_source"], "original": item["original"], "replacement": item["compacted"],
                    "label": info, "actually_sent": actual_sent, "original_bytes": len(item["original"].encode()),
                    "replacement_bytes": len(item["compacted"].encode()),
                    "facts_present": [f for f in info["facts"] if contains(item["original"], fact_value(f))],
                    "facts_retained": [contains(item["compacted"], fact_value(f)) for f in info["facts"] if contains(item["original"], fact_value(f))]})
        errors = collections.Counter()
        for op in operations:
            result = op["result"]
            if result.get("error"):
                errors[result["error"]] += 1
            for entry in result.get("items", []):
                if entry.get("error"):
                    errors[entry["error"]] += 1
        order = {identity: i for i, identity in enumerate(calls)}
        for op in operations:
            op["at_subtask_boundary"] = None if op["id"] not in order else not any(
                call["turn"] == op["turn"] and order[identity] > order[op["id"]] and not operation(call)[0]
                for identity, call in calls.items())
        first_seen = {}
        later_reads = 0
        for record in records.values():
            reread_info = label(record.get("args", {}), record["original"], spec, min_chars=1)
            if reread_info:
                for match in reread_info["matches"]:
                    if match in first_seen and record["first_turn"] > first_seen[match]:
                        later_reads += 1
                    first_seen.setdefault(match, record["first_turn"])
        reports.append({"id": spec["id"], "host": spec["host"], "arm": spec["arm"], "status": status,
            "state_snapshot_available": snapshot["available"], "recorded_units": len(snapshot["units"]),
            "task_success": successful, "answer_checks": checks, "recall_correct": all(recall["matched"]),
            "user_turns": len(turns), "operations": operations, "chosen": chosen, "disposable_observed": len(disposable),
            "selected_disposable_unique": len(selected_disposable), "labelled_selections": len(labelled),
            "disposable_selections": sum(row["label"]["label"] == "disposable" for row in labelled),
            "unknown_selections": sum(row["label"] is None for row in chosen), "rejections": dict(errors),
            "hidden": len(hidden), "rereads_after_hidden_needed": len(set(rereads)), "usage": usage_rows,
            "later_turn_rereads": later_reads,
            "missing_usage": sum(not responses.get(request["id"], {}).get("body", {}).get("usage") for request in run_requests),
            "missing_cost": sum(row["cost"] is None for row in usage_rows),
            "missing_cached": sum(row["cached"] is None for row in usage_rows),
            "guard_denials": sum(row["kind"] == "blocked" and row["path"].split("/")[1] == spec["id"] for row in wire),
            "retries": sum(row["kind"] == "retry" and row["path"].split("/")[1] == spec["id"] for row in wire)})
    (directory / "metrics.json").write_text(json.dumps(reports, indent=2))
    with gzip.open(directory / "replacements.json.gz", "wt") as handle:
        json.dump(replacements, handle)
    print(f"Scored {len(reports)} completed runs, {len(replacements)} labelled replacements")
    for host in ["omp", "hermes"]:
        for arm in ["A", "B"]:
            group = [r for r in reports if r["host"] == host and r["arm"] == arm]
            usage = [u for r in group for u in r["usage"]]
            print(host, arm, "n", len(group), "success", sum(r["task_success"] for r in group), "recall", sum(r["recall_correct"] for r in group),
                "calls", sum(len(r["operations"]) for r in group), "prompt", sum(u["prompt"] for u in usage),
                "cached", sum(u["cached"] or 0 for u in usage), "cost", round(sum(u["cost"] or 0 for u in usage), 6))


if __name__ == "__main__":
    analyze(Path(sys.argv[1]))
