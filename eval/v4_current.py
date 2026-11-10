"""Current-product-only v4 controller; historical arms are never executed."""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from unittest.mock import patch

from campaign_support import child_environment, DEEPSEEK_REASONING, ROOT, STAGES
from current_budget import Budget
from proxy import serve
from run import hashes
from v2_fixtures import build, component

PRODUCT = "8902a41"
MODEL = STAGES["deepseek"][0]
SETTINGS = {"model": MODEL, "provider": {"order": ["Relace"], "allow_fallbacks": False},
            "reasoning": DEEPSEEK_REASONING, "window": 65536}


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def schedule(fixtures):
    cases = build(fixtures) + [component(action) for action in ("hide", "summarize")]
    return [(host, case, repetition) for repetition in (1, 2) for host in ("omp", "hermes") for case in cases]


def fingerprint(hermes, omp):
    files = [hermes / "run_agent.py", hermes / "uv.lock", hermes / "pyproject.toml"]
    files += [omp / name for name in ("package.json", "src/sdk.ts", "src/session/agent-session.ts",
                                    "src/extensibility/extensions/runner.ts")]
    files += [ROOT / name for name in ("eval/v2_omp.ts", "eval/v2_hermes.py", "eval/v2_fixtures.py",
                                      "eval/proxy.py", "packages/omp/dist/worker.js", "packages/omp/dist/extension.js")]
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def run_one(base, server, host, case, rep, attempt, args):
    identity = f"current-{host}-{case['id']}-B-new-{rep}-try{attempt}"
    output = base / ("components" if case.get("component") else "long") / identity
    work = base / "work" / identity
    output.mkdir()
    work.mkdir()
    home, workspace = work / "home", work / "workspace"
    home.mkdir()
    if case.get("component"):
        workspace.mkdir()
        (workspace / "audit-01.jsonl").write_text(case["content"])
    else:
        shutil.copytree(base / "fixtures" / case["id"], workspace)
    spec = {k: v for k, v in case.items() if k != "content"}
    spec.update(id=identity, host=host, arm="B-new", display_arm="B-current", repetition=rep,
                repo=str(ROOT), product_commit=PRODUCT, harness_commit=args.harness_commit,
                home=str(home), workspace=str(workspace), output=str(output), model=MODEL,
                provider="Relace", proxy=f"http://127.0.0.1:{server.server_port}", window=65536,
                hermes_source=str(args.hermes_source))
    write(output / "spec.json", spec)
    env = child_environment(home, ROOT, work, workspace)
    env["OMP_PACKAGE"] = str(args.omp_package)
    env["NODE_PATH"] = str(args.omp_package / "node_modules")
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT / "src"), *args.python_paths])
    if host == "hermes":
        plugin = home / "plugins/session-navigation"
        plugin.mkdir(parents=True)
        for name in ("__init__.py", "plugin.yaml"):
            shutil.copyfile(ROOT / name, plugin / name)
        shutil.copytree(ROOT / "vendor", plugin / "vendor", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (home / "config.yaml").write_text("plugins:\n  enabled: [session-navigation]\n  entries:\n    session-navigation:\n      settings:\n        enabled: true\n")
    command = (["bun", str(ROOT / "eval/v2_omp.ts")] if host == "omp" else
               [str(args.hermes_python), str(ROOT / "eval/v2_hermes.py")]) + [str(output / "spec.json")]
    print("START", identity, flush=True)
    with (output / "host.log").open("w") as log:
        try:
            process = subprocess.run(command, cwd=workspace, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=14400)
            status = {"returncode": process.returncode}
        except subprocess.TimeoutExpired:
            status = {"error": "session deadline 14400s"}
    if case.get("canonical_test"):
        shutil.copyfile(base / "fixtures" / case["id"] / "test_ledger.py", workspace / "test_ledger.py")
        check = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=workspace, capture_output=True)
        status["canonical_tests_pass"] = check.returncode == 0
        (output / "canonical-tests.log").write_bytes(check.stdout + check.stderr)
    for name in ("turns.json", "events.jsonl"):
        path = output / name
        if path.exists():
            with gzip.open(str(path) + ".gz", "wb") as packed:
                packed.write(path.read_bytes())
            path.unlink()
    write(output / "status.json", status)
    turns = json.load(gzip.open(output / "turns.json.gz", "rt")) if (output / "turns.json.gz").exists() else []
    print("DONE", identity, status, "turns", len(turns), flush=True)
    return {"id": identity, "folder": str(output), "expected_turns": len(case["turns"]),
            "turns": len(turns), "status": status}


def campaign(args):
    product_paths = ["src", "adapters", "vendor", "packages/core", "packages/omp", "extensions/pi", "__init__.py", "plugin.yaml"]
    if subprocess.check_output(["git", "diff", PRODUCT, "--", *product_paths], cwd=ROOT):
        raise ValueError("Product differs from approved commit")
    if args.output.exists():
        raise ValueError("Never overwrite an invocation; use a fresh output and shared budget")
    args.output.mkdir(parents=True)
    jobs = schedule(args.output / "fixtures")
    if not args.stub and args.historical is None:
        raise ValueError("Frozen v4 evidence required before paid calls")
    if args.historical:
        for _, case, _ in jobs:
            kind = "2026-11-09-v4-quality" if case.get("component") else "2026-11-09-v4-deepseek"
            matched = []
            for path in (args.historical / kind).glob("*/spec.json"):
                old = json.loads(path.read_text())
                if old["arm"] == "B-new" and f"-{case['id']}-" in old["id"]:
                    matched.append(old)
            if not matched:
                raise ValueError("Missing frozen fixture")
            for old in matched:
                for field in ("turns", "answers", "results", "canonical_test", "fixture_sha256"):
                    assert old.get(field) == case.get(field), f"Frozen fixture drift: {case['id']}/{field}"
    for kind in ("long", "components", "work"):
        (args.output / kind).mkdir()
    if args.cell:
        jobs = [job for job in jobs if f"{job[0]}/{job[1]['id']}/{job[2]}" in args.cell]
        if len(jobs) != len(set(args.cell)):
            raise ValueError("Unknown or duplicate cell")
    budget = Budget(args.budget, "5")
    before = hashes()
    write(args.output / "provenance.json", {"product_commit": PRODUCT, "harness_commit": args.harness_commit,
          "started": time.time(), "stub": args.stub, "fingerprints": fingerprint(args.hermes_source, args.omp_package),
          "hermes_python": str(args.hermes_python), "python_paths": args.python_paths,
          "host_hermes_commit": subprocess.check_output(["git", "-C", str(args.hermes_source), "rev-parse", "HEAD"], text=True).strip(),
          "budget": str(args.budget), "cells": [[h, c['id'], r] for h, c, r in jobs]})
    for kind in ("long", "components"):
        write(args.output / kind / "stage.json", {**SETTINGS, "product_commits": {"B-new": PRODUCT},
              "display_arms": {"B-new": "B-current"}, "repetitions": 2, "components": kind == "components"})
    manifests = []
    try:
        for kind in ("components", "long"):
            selected = [job for job in jobs if bool(job[1].get("component")) == (kind == "components")]
            server = serve(args.output / kind, model=MODEL, provider="Relace", reasoning=DEEPSEEK_REASONING, budget=budget)
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(run_one, args.output, server, h, c, r, args.attempt, args) for h, c, r in selected]
                    for future in futures:
                        manifests.append(future.result())
                        write(args.output / "manifest.json", manifests)
            finally:
                server.shutdown()
                server.server_close()
    finally:
        after = hashes()
        key = os.environ["OPENROUTER_API_KEY"].encode()
        leaks = []
        for path in args.output.rglob("*"):
            if path.is_file():
                raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
                if key in raw:
                    leaks.append(str(path.relative_to(args.output)))
        write(args.output / "safety.json", {"configs_before": before, "configs_after": after,
              "configs_byte_exact": before == after, "secret_matches": leaks, "children_received_real_key": False})
        assert before == after and not leaks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--budget", type=Path, required=True)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--hermes-python", type=Path, required=True)
    parser.add_argument("--python-path", action="append", dest="python_paths", default=[])
    parser.add_argument("--omp-package", type=Path, default=Path("/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent"))
    parser.add_argument("--harness-commit", required=True)
    parser.add_argument("--historical", type=Path)
    parser.add_argument("--cell", action="append")
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--stub", action="store_true")
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY required")
    if args.stub:
        from v4_stub import respond
        with patch("proxy.urllib.request.urlopen", respond):
            campaign(args)
    else:
        campaign(args)


if __name__ == "__main__":
    main()
