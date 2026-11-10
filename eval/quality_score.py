"""Deterministic pressure-experiment scoring and actual outgoing-wire measurements."""
import bisect
import gzip
import json
from pathlib import Path
import sys

import tiktoken

from analyze import native_operations, native_records, read_wire, text
from v2_answer_surface import unit_answer

ENCODING = tiktoken.get_encoding("o200k_base")
MODEL = "deepseek/deepseek-v4.1-flash-1017"
PROVIDER = {"order": ["Relace"], "allow_fallbacks": False}
REASONING = {"enabled": False, "exclude": True}


def objects(answer):
    decoder = json.JSONDecoder()
    found = []
    for index, char in enumerate(answer):
        if char == "{":
            try:
                value, _ = decoder.raw_decode(answer[index:])
                if isinstance(value, dict):
                    found.append(value)
            except ValueError:
                pass
    return found


def same(actual, expected):
    return actual == expected and not (isinstance(actual, bool) != isinstance(expected, bool))


def score_answer(answer, check):
    expected = check["expected"]
    candidates = [obj for obj in objects(answer) if set(obj) & set(expected)]
    stale, unsupported = [], []
    for obj in candidates:
        for key, value in obj.items():
            if key in expected and not same(value, expected[key]):
                target = stale if any(same(value, old) for old in check.get("stale", {}).get(key, [])) else unsupported
                target.append({"key": key, "value": value})
    exact = any(all(key in obj and same(obj[key], value) for key, value in expected.items()) for obj in candidates)
    return {"success": exact and not stale and not unsupported, "facts_correct": exact,
            "stale_claims": stale, "unsupported_values": unsupported, "parsed_objects": candidates,
            "missing": [key for key, value in expected.items() if not any(key in obj and same(obj[key], value) for obj in candidates)]}


def prompt_share(body):
    parts, starts, roles, position = [], [], [], 0
    def add(value, role):
        nonlocal position
        parts.append(value)
        starts.append(position)
        roles.append(role)
        position += len(value)
    add('{"messages":[', "other")
    for index, message in enumerate(body.get("messages", [])):
        if index:
            add(",", "other")
        add(json.dumps(message, ensure_ascii=False, separators=(",", ":")),
            "tool" if message.get("role") in ("tool", "toolResult") else "other")
    add('],"tools":' + json.dumps(body.get("tools", []), ensure_ascii=False, separators=(",", ":")) + "}", "other")
    serialized = "".join(parts)
    tokens = ENCODING.encode(serialized, disallowed_special=())
    _, offsets = ENCODING.decode_with_offsets(tokens)
    tool_tokens = sum(roles[bisect.bisect_right(starts, offset) - 1] == "tool" for offset in offsets)
    tool_bytes = sum(len(part.encode()) for part, role in zip(parts, roles) if role == "tool")
    return {"offline_tokens": len(tokens), "tool_tokens": tool_tokens,
            "tool_token_share": tool_tokens / len(tokens), "tool_bytes": tool_bytes,
            "prompt_bytes": len(serialized.encode()), "tool_byte_share": tool_bytes / len(serialized.encode())}


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    lo = int(index)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (index - lo)


def campaign_wire(directory):
    rows = []
    for attempt in sorted((directory / "attempts").glob("*")):
        if (attempt / "wire.jsonl.gz").exists() or (attempt / "wire.jsonl.xz").exists():
            rows.extend(read_wire(attempt))
    return rows


def total_cost(wire):
    seen, cost = set(), 0
    for row in wire:
        if row.get("kind") != "response":
            continue
        body = row["body"]
        identity = body.get("id") or row["id"]
        if identity not in seen:
            cost += body.get("usage", {}).get("cost") or 0
            seen.add(identity)
    return cost


def canonical(path, expected):
    try:
        value = json.loads(path.read_text())
        return set(value) == set(expected) and all(same(value[key], wanted) for key, wanted in expected.items())
    except (OSError, ValueError, TypeError):
        return False


def analyze(directory):
    directory = Path(directory)
    wire = campaign_wire(directory)
    sessions = []
    for folder in sorted((directory / "sessions").glob("*")):
        spec = json.loads((folder / "spec.json").read_text())
        status = json.loads((folder / "status.json").read_text()) if (folder / "status.json").exists() else {}
        rows = [row for row in wire if row.get("path", "").split("/")[1:2] == [spec["id"]]]
        requests = {row["id"]: row for row in rows if row["kind"] == "upstream_request"}
        responses = {row["id"]: row for row in rows if row["kind"] == "response"}
        turns = json.load(gzip.open(folder / "turns.json.gz", "rt")) if (folder / "turns.json.gz").exists() else []
        events = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines()] if (folder / "events.jsonl").exists() else []
        checks = []
        for index, check in enumerate(spec["checks"]):
            turn = turns[index] if index < len(turns) else {"prompt": spec["turns"][index]}
            visible, boundary = unit_answer(turn)
            checks.append({"turn": index + 1, "kind": check["kind"], "expected": check["expected"],
                           "sources": check["sources"], "visible_boundary": boundary,
                           "final": score_answer(turn.get("answer", ""), check),
                           "visible": score_answer(visible, check)})
        native = [event for event in events if event["kind"] == "native_end"]
        sent = []
        for event in native:
            if not event.get("changed") or event.get("after_chars", 0) >= event.get("before_chars", 0):
                continue
            sequence = event["sequence"]
            before = json.load(gzip.open(folder / f"native-{sequence:02}-before.json.gz", "rt"))
            after = json.load(gzip.open(folder / f"native-{sequence:02}-after.json.gz", "rt"))
            additions = [text(message.get("content")) for message in after if message not in before and message.get("role") != "tool"]
            transmitted = [row["id"] for row in requests.values() if row["time"] > event["time"] and any(
                len(addition) > 100 and addition in text(message.get("content"))
                for addition in additions for message in row["body"].get("messages", []))]
            sent.append({"sequence": sequence, "transmitted_request_ids": transmitted})
        measures = []
        for identity, row in requests.items():
            body = row["body"]
            assert body["model"] == MODEL and body["provider"] == PROVIDER and body["reasoning"] == REASONING
            usage = responses.get(identity, {}).get("body", {}).get("usage", {})
            measures.append({"id": identity, **prompt_share(body), "prompt_tokens": usage.get("prompt_tokens"),
                             "output_tokens": usage.get("completion_tokens"), "cost": usage.get("cost"),
                             "reasoning_tokens": usage.get("completion_tokens_details", {}).get("reasoning_tokens")})
        complete = len(turns) == len(spec["turns"]) and all(turn.get("completed") for turn in turns) and status.get("returncode") == 0
        api_errors = [row for row in rows if row["kind"] == "failure" or row["kind"] == "response" and row["body"].get("error")]
        eligible = status.get("returncode") == 0 and bool(measures) and not api_errors and all(measure["cost"] is not None for measure in measures)
        calls, records = native_records(turns, spec["turns"])
        operations = native_operations(calls, records)
        canonical_pass = canonical(folder / "decision.json", spec["plan"])
        report = {"id": spec["id"], "seed": spec["seed"], "arm": spec["arm"], "eligible": eligible,
                  "complete": complete, "api_errors": len(api_errors), "turns": len(turns), "checks": checks,
                  "canonical_pass": canonical_pass, "native_starts": sum(event["kind"] == "native_start" for event in events),
                  "native_changed": sum(bool(event.get("changed")) for event in native),
                  "native_failed": sum(not event.get("success") for event in native),
                  "native_sent": sum(bool(event["transmitted_request_ids"]) for event in sent), "native_evidence": sent,
                  "nav_calls": len(operations), "nav_operations": operations, "requests": len(requests),
                  "prompt_tokens": sum(measure["prompt_tokens"] or 0 for measure in measures),
                  "output_tokens": sum(measure["output_tokens"] or 0 for measure in measures),
                  "cost": total_cost(rows), "tool_share_median": percentile([measure["tool_token_share"] for measure in measures], .5),
                  "tool_share_p90": percentile([measure["tool_token_share"] for measure in measures], .9),
                  "measurements": measures}
        for surface in ("final", "visible"):
            report[surface + "_success"] = complete and canonical_pass and all(check[surface]["success"] for check in checks)
            report[surface + "_late_success"] = complete and canonical_pass and all(check[surface]["success"] for check in checks if check["kind"] != "work")
            report[surface + "_stale"] = sum(len(check[surface]["stale_claims"]) for check in checks)
            report[surface + "_unsupported"] = sum(len(check[surface]["unsupported_values"]) for check in checks)
        sessions.append(report)
    stage = json.loads((directory / "stage.json").read_text())
    result = {"sessions": sessions, "captured_campaign_cost": total_cost(wire),
              "total_cost": total_cost(wire) + stage.get("excluded_setup_cost", 0)}
    (directory / "scorecard.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"total_cost": result["total_cost"], "sessions": [
        {key: row[key] for key in ("id", "eligible", "final_success", "visible_success", "canonical_pass", "native_sent", "nav_calls", "requests", "cost")}
        for row in sessions]}, indent=2), flush=True)
    return result


if __name__ == "__main__":
    analyze(Path(sys.argv[1]))
