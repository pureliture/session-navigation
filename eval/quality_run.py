"""Pilot-first, paired Hermes quality campaign; only this process holds the real key."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sqlite3
import subprocess

from proxy import serve
from quality_fixtures import fixture, SEEDS, WINDOW
from quality_score import analyze, campaign_wire, total_cost, MODEL, PROVIDER, REASONING
from run import hashes
from campaign_support import child_environment, source_snapshot, HERMES

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "37348b89faf82ced7510fe09e2a97a893fbcc8a3"
LIMIT = 1.50


def schedule():
    rng = random.Random(20261110)
    seeds = list(SEEDS)
    rng.shuffle(seeds)
    result = []
    for seed in seeds:
        arms = ["A", "B-new"]
        rng.shuffle(arms)
        result.extend({"seed": seed, "arm": arm} for arm in arms)
    return result


def budget(result, order):
    selected = {}
    for row in result["sessions"]:
        if row["eligible"]:
            selected[row["seed"], row["arm"]] = row
    pilot = [selected.get((entry["seed"], entry["arm"])) for entry in order[:2]]
    ready = all(pilot) and all(row["native_sent"] > 0 for row in pilot if row["arm"] == "A")
    average = sum(row["cost"] for row in pilot if row) / 2
    projected = result["total_cost"] + max(0, 8 - len(selected)) * average * 1.5
    return {"pilot_ready": bool(ready), "continue": bool(ready) and projected <= LIMIT,
            "spent": result["total_cost"], "projected_total": projected, "limit": LIMIT,
            "remaining_session_safety_factor": 1.5, "qualifying_sessions": len(selected)}


def snapshot_store(work, output):
    path = work / "navigation.sqlite3"
    if not path.exists():
        return
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        snapshot = {name: [dict(row) for row in connection.execute(f"SELECT * FROM {name}")]
                    for name in ("items", "units")}
    finally:
        connection.close()
    with gzip.open(output / "store.json.gz", "wt") as stream:
        json.dump(snapshot, stream)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--phase", choices=("pilot", "rest", "retry"), required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--seed", type=int, choices=SEEDS)
    parser.add_argument("--arm", choices=("A", "B-new"))
    parser.add_argument("--setup-evidence", type=Path)
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY environment variable required")
    if not args.label.replace("-", "").isalnum():
        parser.error("Use an alphanumeric label with optional hyphens")
    directory = args.output.resolve()
    source_hashes = {name: hashlib.sha256((ROOT / "eval" / name).read_bytes()).hexdigest()
                     for name in ("quality_fixtures.py", "quality_hermes.py", "quality_run.py", "quality_score.py")}
    order = schedule()
    stage = {"model": MODEL, "provider": PROVIDER, "reasoning": REASONING, "window": WINDOW,
             "product_commit": COMMIT, "randomization_seed": 20261110, "schedule": order,
             "source_hashes": source_hashes,
             "primary": "Matched late announced/surprise/canonical success on both final-only and visible-unit surfaces; "
             "separate stale and unsupported values. Benefit requires B better than A and supported context-loss causality.",
             "pressure": "Every A must transmit at least one changed, size-reducing native compaction; B may avoid compaction.",
             "scoring_scope": "Requested JSON fields only; arbitrary prose and extra fields are not semantically adjudicated.",
             "equal_capabilities": "Both arms retain source files, notes, file/terminal tools and native recovery. Only B has navigation.",
             "resource_budget": {"max_iterations_per_turn": 20, "max_tokens": 4096, "turn_budget_seconds": 600}}
    stage_path = directory / "stage.json"
    setup = args.setup_evidence
    if setup is None and stage_path.exists():
        previous_stage = json.loads(stage_path.read_text())
        setup = Path(previous_stage["setup_evidence"]) if previous_stage.get("setup_evidence") else None
    stage.update(setup_evidence=str(setup.resolve()) if setup else None,
                 excluded_setup_cost=total_cost(campaign_wire(setup)) if setup else 0)
    if args.phase == "pilot":
        if directory.exists():
            parser.error("Pilot output already exists; never overwrite evidence")
        directory.mkdir(parents=True)
        (directory / "sessions").mkdir()
        (directory / "attempts").mkdir()
        (directory / "fixtures").mkdir()
        stage_path.write_text(json.dumps(stage, indent=2))
        for seed in SEEDS:
            case = fixture(seed)
            folder = directory / "fixtures" / str(seed)
            folder.mkdir()
            for name, content in case["files"].items():
                (folder / name).write_text(content)
        jobs = order[:2]
    else:
        if json.loads(stage_path.read_text()) != stage:
            parser.error("Settings/source drift from preregistered pilot")
        previous = json.loads((directory / "scorecard.json").read_text())
        if args.phase == "rest":
            if not budget(previous, order)["continue"]:
                parser.error("Pilot has not qualified or projected total exceeds $1.50")
            jobs = [entry for entry in order[2:] if not any(row["eligible"] and row["seed"] == entry["seed"] and
                    row["arm"] == entry["arm"] for row in previous["sessions"])]
        else:
            if args.seed is None or args.arm is None:
                parser.error("Retry requires --seed and --arm, with a new label")
            if any(row["eligible"] and row["seed"] == args.seed and row["arm"] == args.arm for row in previous["sessions"]):
                parser.error("Do not retry a qualifying product outcome")
            jobs = [{"seed": args.seed, "arm": args.arm}]
    attempt = directory / "attempts" / args.label
    if attempt.exists():
        parser.error("Attempt label exists; choose a new label")
    attempt.mkdir()
    before = hashes()
    base = Path.home() / ".session-navigation-eval-v2"
    base.mkdir(exist_ok=True)
    source = source_snapshot(base, COMMIT)
    server = serve(attempt, model=MODEL, provider="Relace", reasoning=REASONING)
    try:
        for entry in jobs:
            if total_cost(campaign_wire(directory)) >= LIMIT:
                raise RuntimeError("Campaign spending reached budget; stopped")
            seed, arm = entry["seed"], entry["arm"]
            identity = f"quality-hermes-{seed}-{arm}-{args.label}"
            work, output = base / identity, directory / "sessions" / identity
            if work.exists() or output.exists():
                raise RuntimeError("Existing session workspace/output; use a new label")
            work.mkdir()
            output.mkdir()
            home, workspace = work / "home", work / "workspace"
            home.mkdir()
            shutil.copytree(directory / "fixtures" / str(seed), workspace)
            case = fixture(seed)
            spec = {key: value for key, value in case.items() if key != "files"}
            spec.update(id=identity, arm=arm, host="hermes", repo=str(source), product_commit=COMMIT,
                        home=str(home), workspace=str(workspace), output=str(output), window=WINDOW,
                        model=MODEL, provider="Relace", proxy=f"http://127.0.0.1:{server.server_port}",
                        hermes_source=os.environ.get("HERMES_SOURCE", HERMES))
            (output / "spec.json").write_text(json.dumps(spec, indent=2))
            if arm != "A":
                plugin = home / "plugins/session-navigation"
                plugin.mkdir(parents=True)
                for name in ("__init__.py", "plugin.yaml"):
                    shutil.copyfile(source / name, plugin / name)
                shutil.copytree(source / "vendor", plugin / "vendor", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            (home / "config.yaml").write_text("plugins:\n  enabled: " + ("[]" if arm == "A" else "[session-navigation]") +
                "\n  entries:\n    session-navigation:\n      settings:\n        enabled: true\n")
            env = child_environment(home, source, work, workspace)
            assert "OPENROUTER_API_KEY" not in env
            command = [os.environ.get("HERMES_PYTHON", str(Path(spec["hermes_source"]).parent / "venv/bin/python")),
                       str(ROOT / "eval/quality_hermes.py"), str(output / "spec.json")]
            print("START", identity, flush=True)
            with (output / "host.log").open("w") as log:
                try:
                    result = subprocess.run(command, cwd=workspace, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=14400)
                    status = {"returncode": result.returncode}
                except subprocess.TimeoutExpired:
                    status = {"error": "session deadline 14400s"}
            snapshot_store(work, output)
            (output / "status.json").write_text(json.dumps(status))
            print("DONE", identity, status, flush=True)
            if status.get("returncode") != 0:
                break
    finally:
        server.shutdown()
        server.server_close()
        after = hashes()
        (attempt / "safety.json").write_text(json.dumps({"configs_before": before, "configs_after": after,
            "configs_byte_exact": before == after, "children_received_real_key": False}, indent=2))
        assert before == after, "Configuration changed"
    result = analyze(directory)
    gate = budget(result, order)
    (directory / "budget.json").write_text(json.dumps(gate, indent=2))
    print("BUDGET", json.dumps(gate), flush=True)


if __name__ == "__main__":
    main()
