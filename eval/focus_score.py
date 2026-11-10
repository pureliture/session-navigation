"""Exact paired replay scoring; seed-cluster uncertainty and independent-item caveats."""
import collections
import gzip
import json
import math
from pathlib import Path
import random
import sys

from analyze import native_operations, native_records, read_wire
from quality_score import MODEL, PROVIDER, REASONING, campaign_wire, objects, same, total_cost
from v2_answer_surface import unit_answer


def score(answer, case):
    expected = case["check"]["expected"]
    candidates = [obj for obj in objects(answer) if set(obj) & set(expected)]
    fields = {}
    for key, wanted in expected.items():
        values = [obj[key] for obj in candidates if key in obj]
        wrong = [value for value in values if not same(value, wanted)]
        fields[key] = {"correct": bool(values) and not wrong,
                       "stale": sum(any(same(value, old) for old in case["check"]["stale"].get(key, [])) for value in wrong),
                       "unsupported": sum(not any(same(value, old) for old in case["check"]["stale"].get(key, [])) for value in wrong),
                       "missing": not values}
    return {"fields": fields, "primary_success": all(fields[key]["correct"] for key in case["primary_keys"]),
            "primary_correct": sum(fields[key]["correct"] for key in case["primary_keys"]),
            "loss_correct": sum(fields[key]["correct"] for key in case["loss_keys"]),
            "stale": sum(fields[key]["stale"] for key in case["primary_keys"]),
            "unsupported": sum(fields[key]["unsupported"] for key in case["primary_keys"])}


def mcnemar(raw_only, hide_only):
    n = raw_only + hide_only
    return 1.0 if not n else min(1.0, 2 * sum(math.comb(n, k) for k in range(min(raw_only, hide_only) + 1)) / 2 ** n)


def paired(rows):
    trials = collections.defaultdict(dict)
    for row in rows:
        if row["eligible"] and row["part"] == "replay":
            trials[(row["seed"], row["length"], row["rep"])][row["arm"]] = row
    pairs = [group for group in trials.values() if set(group) == {"RAW", "PLUGIN-HIDE"}]
    raw_only = sum(p["RAW"]["score"]["primary_success"] and not p["PLUGIN-HIDE"]["score"]["primary_success"] for p in pairs)
    hide_only = sum(p["PLUGIN-HIDE"]["score"]["primary_success"] and not p["RAW"]["score"]["primary_success"] for p in pairs)
    clusters = collections.defaultdict(list)
    for p in pairs:
        n = len(p["RAW"]["score"]["fields"]) - 1
        clusters[p["RAW"]["seed"]].append((p["PLUGIN-HIDE"]["score"]["primary_correct"] - p["RAW"]["score"]["primary_correct"]) / n)
    means = [sum(values) / len(values) for values in clusters.values()]
    rng = random.Random(20261111)
    samples = sorted(sum(rng.choices(means, k=len(means))) / len(means) for _ in range(5000)) if means else []
    return {"pairs": len(pairs), "raw_only_trials": raw_only, "hide_only_trials": hide_only,
            "exact_mcnemar_p": mcnemar(raw_only, hide_only),
            "accuracy_difference_hide_minus_raw": sum(means) / len(means) if means else None,
            "seed_cluster_bootstrap_95": [samples[124], samples[4874]] if samples else None,
            "seeds": len(means), "bootstrap_replicates": 5000,
            "caveat": "Exact test treats trial vectors as independent; repeated histories/facts are dependent. "
                      "Seed-cluster bootstrap is primary uncertainty, only five independent synthetic seeds."}


def analyze(directory):
    directory = Path(directory)
    wire = campaign_wire(directory)
    sessions = []
    response_providers = collections.Counter()
    reasoning = collections.Counter()
    for folder in sorted((directory / "sessions").glob("*")):
        spec = json.loads((folder / "spec.json").read_text())
        case = json.load(gzip.open(directory / "fixtures" / f"{spec['seed']}-{spec['length']}.json.gz", "rt"))
        rows = [row for row in wire if row.get("path", "").startswith("/" + spec["id"] + "/")]
        requests = {row["id"]: row for row in rows if row["kind"] == "upstream_request"}
        responses = {row["id"]: row for row in rows if row["kind"] == "response"}
        for row in requests.values():
            body = row["body"]
            assert body["model"] == MODEL and body["provider"] == PROVIDER and body["reasoning"] == REASONING
        for row in responses.values():
            response_providers[row["body"].get("provider", "missing")] += 1
            reasoning[str(row["body"].get("usage", {}).get("completion_tokens_details", {}).get("reasoning_tokens"))] += 1
        api_errors = sum(row["kind"] == "failure" or row["kind"] == "response" and bool(row["body"].get("error")) for row in rows)
        eligible = bool(requests) and not api_errors and all(identity in responses and
            responses[identity]["body"].get("usage", {}).get("cost") is not None for identity in requests)
        usages = [row["body"].get("usage", {}) for row in responses.values()]
        answer, visible = "", ""
        nav, native, completed = 0, 0, False
        if spec["part"] == "replay":
            path = folder / "response.json"
            if path.exists():
                result = json.loads(path.read_text())
                answer = ((result.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                completed = bool(result.get("choices"))
            visible = answer
        else:
            path = folder / "turns.json.gz"
            if path.exists():
                turns = json.load(gzip.open(path, "rt"))
                completed = len(turns) == len(spec["turns"])
                if completed:
                    answer = turns[-1].get("answer", "")
                    visible = unit_answer(turns[-1])[0]
                calls, records = native_records(turns, spec["turns"])
                nav = len(native_operations(calls, records))
            events = [json.loads(line) for line in gzip.open(folder / "events.jsonl.gz", "rt")] if (folder / "events.jsonl.gz").exists() else []
            native = sum("compaction_start" in row.get("event", {}).get("type", "") for row in events)
            assert not native, "No-compaction experiment emitted native compaction"
        scored = score(answer, case)
        sessions.append({key: spec[key] for key in ("id", "part", "seed", "length", "rep", "arm")} |
            {"eligible": eligible, "complete": completed, "api_errors": api_errors, "answer": answer,
             "score": scored, "visible_score": score(visible, case), "nav_calls": nav, "native_starts": native,
             "requests": len(requests), "prompt_tokens": sum(u.get("prompt_tokens", 0) for u in usages),
             "output_tokens": sum(u.get("completion_tokens", 0) for u in usages), "cost": total_cost(rows)})
    groups = {}
    for part in ("replay", "live"):
        for length in ("short", "long"):
            for arm in ("RAW", "PLUGIN-HIDE") if part == "replay" else ("A", "B-new"):
                subset = [s for s in sessions if s["eligible"] and s["part"] == part and s["length"] == length and s["arm"] == arm]
                if not subset:
                    continue
                groups[f"{part}/{length}/{arm}"] = {"sessions": len(subset),
                    "exact_trials": sum(s["complete"] and s["score"]["primary_success"] for s in subset),
                    "primary_correct": sum(s["score"]["primary_correct"] for s in subset), "primary_total": len(subset) * 11,
                    "loss_correct": sum(s["score"]["loss_correct"] for s in subset), "loss_total": len(subset),
                    **{key: sum(s[key] for s in subset) for key in ("prompt_tokens", "output_tokens", "requests", "nav_calls", "native_starts", "cost")},
                    **{key: sum(s["score"][key] for s in subset) for key in ("stale", "unsupported")}}
    result = {"sessions": sessions, "groups": groups, "paired": {length: paired([s for s in sessions if s["length"] == length])
              for length in ("short", "long")}, "paired_all": paired(sessions), "total_cost": total_cost(wire),
              "providers": dict(response_providers), "reasoning_tokens": dict(reasoning)}
    (directory / "scorecard.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({key: value for key, value in result.items() if key != "sessions"}, indent=2), flush=True)
    return result


if __name__ == "__main__":
    analyze(Path(sys.argv[1]))
