"""Pilot-gated fixed-history focus replay plus autonomous no-compaction OMP sanity check."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import urllib.request

from focus_fixtures import COMMIT, LENGTHS, SEEDS, WINDOW, fixture, hide_history
from focus_score import analyze
from proxy import serve
from quality_score import MODEL, PROVIDER, REASONING, campaign_wire, total_cost
from run import hashes
from v2_archive import archive
from campaign_support import child_environment, source_snapshot

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 1.50


def schedule():
    rng = random.Random(20261111)
    pairs = [(seed, length, rep) for seed in SEEDS for length in LENGTHS for rep in range(1, 4)]
    rng.shuffle(pairs)
    pilot = next(pair for pair in pairs if pair[1] == "long")
    pairs.remove(pilot)
    pairs.insert(0, pilot)
    jobs = []
    for seed, length, rep in pairs:
        arms = ["RAW", "PLUGIN-HIDE"]
        rng.shuffle(arms)
        jobs.extend({"part": "replay", "seed": seed, "length": length, "rep": rep, "arm": arm} for arm in arms)
    live = list(SEEDS[:3])
    rng.shuffle(live)
    for seed in live:
        arms = ["A", "B-new"]
        rng.shuffle(arms)
        jobs.extend({"part": "live", "seed": seed, "length": "long", "rep": 1, "arm": arm} for arm in arms)
    return jobs


def key(job):
    return tuple(job[k] for k in ("part", "seed", "length", "rep", "arm"))


def budget(result, jobs):
    selected = {key(row): row for row in result["sessions"] if row["eligible"]}
    pilot_jobs = jobs[:2] + jobs[60:62]
    ready = all(key(job) in selected for job in pilot_jobs)
    rates = {}
    for part in ("replay", "live"):
        rows = [selected[key(job)] for job in pilot_jobs if job["part"] == part and key(job) in selected]
        rates[part] = sum(row["cost"] for row in rows) / len(rows) if rows else None
    estimate = result["total_cost"] + sum((rates[job["part"]] or 0) * 1.5 for job in jobs if key(job) not in selected)
    return {"pilot_ready": ready, "continue": ready and estimate <= LIMIT, "spent": result["total_cost"],
            "projected_total": estimate if ready else None, "limit": LIMIT, "safety_factor": 1.5,
            "eligible_sessions": len(selected), "planned_sessions": len(jobs)}


def dump(path, value):
    path.write_text(json.dumps(value, indent=2))


def source_hashes():
    names = ("focus_fixtures.py", "focus_score.py", "focus_run.py", "v2_omp.ts", "proxy.py")
    return {name: hashlib.sha256((ROOT / "eval" / name).read_bytes()).hexdigest() for name in names}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phase", choices=("pilot", "rest", "retry"), required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--job", type=int)
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY must be provisioned in the proxy parent's environment")
    if not args.label.replace("-", "").isalnum():
        parser.error("Use an alphanumeric label with optional hyphens")
    root = args.output.resolve()
    jobs = schedule()
    stage = {"product_commit": COMMIT, "model": MODEL, "provider": PROVIDER, "reasoning": REASONING,
             "window": WINDOW, "native_compaction": False, "schedule": jobs, "randomization_seed": 20261111,
             "source_hashes": source_hashes(), "primary": "11 reachable fields; audit_marker is separately scored hidden-only loss",
             "selection_rule": "Hide tool results of all eight finished subtasks, never keep_lines; fail-open refusals retained",
             "summary_arm": "Omitted; main contrast is deterministic rule Hide without auxiliary model calls",
             "inference": "Paired exact-vector McNemar plus seed-cluster bootstrap; five independent synthetic seeds",
             "replay_tools": "Historical read calls; final response cannot call tools or restore hidden-only facts"}
    if args.phase == "pilot":
        if root.exists():
            parser.error("Evidence root already exists")
        root.mkdir(parents=True)
        for name in ("fixtures", "sessions", "attempts"):
            (root / name).mkdir()
        dump(root / "stage.json", stage)
        for seed in SEEDS:
            for length in LENGTHS:
                case = fixture(seed, length)
                hidden = hide_history(case)
                if not all(hidden["survival"][key] for key in case["primary_keys"]):
                    raise RuntimeError("Primary facts are not reachable after Hide")
                if hidden["survival"]["audit_marker"] or not all(row["ok"] for row in hidden["mutations"]):
                    raise RuntimeError("Fixture does not exercise actual rule Hide and separate loss category")
                if not (.30 if length == "short" else .60) <= case["offline_raw_tokens"] / WINDOW <= (.40 if length == "short" else .80):
                    raise RuntimeError("Fixture length outside preregistered range")
                case["hide"] = hidden
                with gzip.open(root / "fixtures" / f"{seed}-{length}.json.gz", "wt") as stream:
                    json.dump(case, stream)
        chosen = jobs[:2] + jobs[60:62]
    else:
        if json.loads((root / "stage.json").read_text()) != stage:
            parser.error("Settings or source drift; do not alter preregistration")
        previous = json.loads((root / "scorecard.json").read_text())
        done = {key(row) for row in previous["sessions"] if row["eligible"]}
        if args.phase == "rest":
            if not budget(previous, jobs)["continue"]:
                parser.error("Pilot incomplete or projected total exceeds budget")
            chosen = [job for job in jobs if key(job) not in done]
        else:
            if args.job is None or not 0 <= args.job < len(jobs) or key(jobs[args.job]) in done:
                parser.error("Retry needs an unfinished --job schedule index")
            chosen = [jobs[args.job]]
    attempt = root / "attempts" / args.label
    if attempt.exists():
        parser.error("Attempt exists; use a fresh label")
    attempt.mkdir()
    base = Path.home() / ".session-navigation-eval-v2"
    source = source_snapshot(base, COMMIT)
    for path in (source / "src/session_navigation").glob("*.py"):
        if path.read_bytes() != (ROOT / "src/session_navigation" / path.name).read_bytes():
            raise RuntimeError("Replay product implementation drift from pinned commit")
    before = hashes()
    server = serve(attempt, model=MODEL, provider="Relace", reasoning=REASONING)
    completed = []
    try:
        for job in chosen:
            if total_cost(campaign_wire(root)) >= LIMIT:
                raise RuntimeError("Spend limit reached")
            if args.phase == "pilot" and job["part"] == "live":
                replay_cost = total_cost(campaign_wire(root))
                if replay_cost * 30 * 1.5 > LIMIT:
                    print("STOP replay-only projection exceeds $1.50 before live pilot", flush=True)
                    break
            identity = "focus-" + "-".join(map(str, key(job))) + "-" + args.label
            output, work = root / "sessions" / identity, base / identity
            if output.exists() or work.exists():
                raise RuntimeError("Existing session evidence/workspace")
            output.mkdir()
            case = json.load(gzip.open(root / "fixtures" / f"{job['seed']}-{job['length']}.json.gz", "rt"))
            spec = {**job, "id": identity, "host": "omp", "repo": str(source), "product_commit": COMMIT,
                    "home": str(work / "home"), "workspace": str(work / "workspace"), "output": str(output),
                    "model": MODEL, "window": WINDOW, "native_compaction": False,
                    "proxy": f"http://127.0.0.1:{server.server_port}"}
            print("START", identity, flush=True)
            if job["part"] == "replay":
                messages = case["messages"] if job["arm"] == "RAW" else case["hide"]["messages"]
                body = {"model": MODEL, "messages": messages, "max_tokens": 4096, "stream": False}
                dump(output / "spec.json", spec)
                request = urllib.request.Request(spec["proxy"] + "/" + identity + "/v1/chat/completions",
                    data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=600) as response:
                        result = json.load(response)
                    dump(output / "response.json", result)
                except Exception as error:
                    dump(output / "status.json", {"error": type(error).__name__})
                    break
            else:
                work.mkdir()
                (work / "home").mkdir()
                (work / "workspace").mkdir()
                for name, content in case["files"].items():
                    (work / "workspace" / name).write_text(content)
                intro = ("Review this build/incident audit. Only generation 42 signed-live values are current; "
                         "generation 41 archive exports and earlier assertions are obsolete even if newer-dated. "
                         "Retain current facts for a final multi-part handover. Notes and ordinary tools are allowed. ")
                spec["turns"] = [(intro if index == 0 else "") +
                    f"Work unit {index + 1}: read the complete {name} using read (paginate if necessary). "
                    "Review the legacy/current configuration and build assertions. Report the component and any signed-live "
                    "fields concisely, without copying the telemetry dump." for index, name in enumerate(case["files"])]
                spec["turns"].append(case["messages"][-1]["content"] + " Notes, source re-reads and ordinary tools remain available.")
                dump(output / "spec.json", spec)
                env = child_environment(work / "home", source, work, work / "workspace")
                assert "OPENROUTER_API_KEY" not in env
                with (output / "host.log").open("w") as log:
                    try:
                        result = subprocess.run(["bun", str(ROOT / "eval/v2_omp.ts"), str(output / "spec.json")],
                            cwd=work / "workspace", env=env, stdout=log, stderr=subprocess.STDOUT, timeout=10800)
                        dump(output / "status.json", {"returncode": result.returncode})
                    except subprocess.TimeoutExpired:
                        dump(output / "status.json", {"error": "session timeout"})
                for name in ("events.jsonl", "turns.json"):
                    path = output / name
                    if path.exists():
                        with path.open("rb") as original, gzip.open(str(path) + ".gz", "wb") as packed:
                            shutil.copyfileobj(original, packed)
                        path.unlink()
            completed.append(identity)
            print("DONE", identity, flush=True)
            wire = campaign_wire(root)
            if any(row["kind"] == "failure" or row["kind"] == "response" and row["body"].get("error")
                   for row in wire if row.get("path", "").startswith("/" + identity + "/")):
                print("STOP persistent API failure; preserve evidence and resume only with new labels", flush=True)
                break
            if args.phase != "pilot":
                previous = json.loads((root / "scorecard.json").read_text())
                spent = total_cost(wire)
                old_gate = budget(previous, jobs)
                if old_gate["projected_total"] is not None and spent + old_gate["projected_total"] - previous["total_cost"] > LIMIT:
                    print("STOP conservative projected budget exceeded", flush=True)
                    break
    finally:
        server.shutdown()
        server.server_close()
        after = hashes()
        dump(attempt / "safety.json", {"configs_before": before, "configs_after": after,
                                     "configs_byte_exact": before == after, "children_received_real_key": False})
        assert before == after
    if (attempt / "wire.jsonl.gz").exists():
        archive(attempt)
    result = analyze(root)
    gate = budget(result, jobs)
    dump(root / "budget.json", gate)
    dump(attempt / "budget.json", gate)
    print("BUDGET", json.dumps(gate), flush=True)


if __name__ == "__main__":
    main()
