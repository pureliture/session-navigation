"""Re-reads after Hide: file touches whose earlier result was compacted.

Classification is post-hoc from captured host events and scored operations; it
counts file references, not causally proven re-reads.
"""
import collections
import gzip
import json
import re
from pathlib import Path
import sys

FILE_PATTERN = re.compile(r"[\w./-]*\w+\.(?:jsonl|json|log|py|txt|md|csv)")
STEM_PATTERN = re.compile(r"\b[A-Za-z][\w]*-\d+\b")
WORK_TOOLS = {"read", "bash"}


def canonical(name):
    return Path(str(name)).stem


def files_in(tool_name, args):
    if not isinstance(args, dict):
        return set()
    if tool_name == "read":
        path = args.get("path") or args.get("file_path") or ""
        return {canonical(path)} if path else set()
    command = str(args.get("command") or "")
    names = {canonical(match.group()) for match in FILE_PATTERN.finditer(command)}
    return names | {match.group() for match in STEM_PATTERN.finditer(command)}


def work_calls(events):
    calls = []
    for row in events:
        if row.get("kind") != "host_event":
            continue
        event = row.get("event", {})
        if event.get("type") != "tool_execution_start" or event.get("toolName") not in WORK_TOOLS:
            continue
        calls.append({"time": row["time"], "turn": row["turn"], "id": event.get("toolCallId"),
                      "tool": event["toolName"], "files": files_in(event["toolName"], event.get("args"))})
    return sorted(calls, key=lambda call: call["time"])


def compaction_events(events, operations):
    times = {row["id"]: row["time"] for row in events if row.get("kind") == "nav_end"}
    order = {op["id"]: index for index, op in enumerate(operations)}
    out = []
    for op in operations:
        result = op.get("result") or {}
        if not (result.get("ok") is True or result.get("applied", 0) > 0):
            continue
        args = op.get("args") or {}
        action = args.get("action")
        name = op["name"]
        targets = [t for t in (args.get("tool_call_ids") or []) if t]
        if args.get("tool_call_id"):
            targets.append(args["tool_call_id"])
        kind = None
        if name in ("hide_context", "summarize_context") or (name == "manage_context" and action in ("hide", "summarize", "auto")):
            kind = "compact"
        elif name == "unhide_context":
            kind = "restore"
            targets = [args.get("item_id")] if args.get("item_id") else []
        items = result.get("items") or []
        if kind == "compact" and items:
            successful = {item.get("tool_call_id"): item.get("item_id") for item in items
                          if isinstance(item, dict) and item.get("ok") is True}
            targets = [target for target in targets if target in successful]
        else:
            successful = {target: result.get("item_id") for target in targets}
        if not kind or not targets:
            continue
        out.append({"kind": kind, "targets": targets, "turn": op["turn"],
                    "time": times.get(op["id"], 0), "order": order.get(op["id"], 0),
                    "item_ids": successful})
    return sorted(out, key=lambda row: (row["time"], row["order"]))


def session_rereads(events, operations):
    calls = work_calls(events)
    compactions = compaction_events(events, operations)
    produced = {call["id"]: call for call in calls}
    hidden_targets, item_owner = {}, {}
    counts = collections.Counter()
    gaps = []
    detail = []
    pending = list(compactions)
    seen_files = set()
    for call in calls:
        while pending and pending[0]["time"] <= call["time"]:
            event = pending.pop(0)
            if event["kind"] == "compact":
                for target in event["targets"]:
                    source = produced.get(target)
                    if not source:
                        continue
                    item_id = event["item_ids"].get(target)
                    if item_id:
                        item_owner[item_id] = target
                    hidden_targets.setdefault(target, event["turn"])
            else:
                for item_id in event["targets"]:
                    hidden_targets.pop(item_owner.get(item_id, ""), None)
        hidden_files = {}
        for target, turn in hidden_targets.items():
            for name in produced[target]["files"]:
                hidden_files[name] = min(turn, hidden_files.get(name, turn))
        touched_hidden = [name for name in call["files"] if name in hidden_files]
        if touched_hidden:
            kind = "after_compaction"
            gap = call["turn"] - min(hidden_files[name] for name in touched_hidden)
            gaps.append(gap)
            detail.append({"turn": call["turn"], "tool": call["tool"],
                           "files": sorted(touched_hidden), "gap": gap})
        elif call["files"] & seen_files:
            kind = "repeat_visible"
        else:
            kind = "new"
        counts[kind] += 1
        counts[call["tool"] + "_" + kind] += 1
        seen_files |= call["files"]
    summary = {"work_calls": len(calls), "after_compaction": counts["after_compaction"],
               "repeat_visible": counts["repeat_visible"], "new": counts["new"],
               "same_turn": sum(gap == 0 for gap in gaps), "later_turn": sum(gap >= 1 for gap in gaps),
               "unhide_calls": sum(event["kind"] == "restore" for event in compactions),
               "details": detail}
    for tool in sorted(WORK_TOOLS):
        summary[tool] = {kind: counts[tool + "_" + kind]
                         for kind in ("after_compaction", "repeat_visible", "new")}
    return summary


def rereads(directory):
    directory = Path(directory)
    reports = json.loads((directory / "metrics-v2.json").read_text())
    rows = []
    unavailable = []
    for report in reports:
        folder = directory / report["id"]
        path = folder / "events.jsonl.gz"
        if not path.exists():
            continue
        events = [json.loads(line) for line in gzip.open(path, "rt")]
        if not work_calls(events):
            unavailable.append({"id": report["id"], "host": report["host"], "arm": report["arm"],
                                "reason": "No tool_execution_start events captured; not a zero count"})
            continue
        summary = session_rereads(events, report["operations"])
        summary.update(id=report["id"], host=report["host"], arm=report["arm"])
        rows.append(summary)
    groups = {}
    for row in rows:
        key = row["host"] + "/" + row["arm"]
        group = groups.setdefault(key, collections.Counter())
        group["sessions"] += 1
        for field in ("after_compaction", "repeat_visible", "new", "same_turn", "later_turn", "unhide_calls"):
            group[field] += row[field]
        for tool in ("bash", "read"):
            for field in ("after_compaction", "repeat_visible", "new"):
                group[tool + "_" + field] += row[tool][field]
    result = {"groups": {key: dict(value) for key, value in groups.items()},
              "unavailable": unavailable,
              "sessions": [{key: value for key, value in row.items() if key != "details"} for row in rows],
              "details": {row["id"]: row["details"] for row in rows}}
    (directory / "rereads.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result["groups"], indent=2))
    return result


if __name__ == "__main__":
    rereads(sys.argv[1])
