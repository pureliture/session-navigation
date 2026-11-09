"""Isolated v2 campaign controller. One pinned model per invocation."""
import argparse
import concurrent.futures
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

from proxy import serve
from run import hashes
from v2_fixtures import ROOT as FIXTURES, build, component

ROOT = Path(__file__).resolve().parents[1]
STAGES = {"crouton": ("stealth/crouton-alpha", "Stealth"),
          "deepseek": ("deepseek/deepseek-v4.1-flash-1017", "Relace")}
COMMITS = {"A": "5017b97", "B-old": "b1a524e", "B-new": "5017b97"}
HERMES = "/Users/devin/hermes-nav-live/installs/a6031367d5037fff/environments/3be5d82bc8954afa9633eb60c0780749/workspace"


def source_snapshot(base, commit):
    target = base / "sources" / commit
    if not target.exists():
        target.mkdir(parents=True)
        archive = subprocess.check_output(["git", "archive", commit], cwd=ROOT)
        import io
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(target, filter="data")
    return target


def child_environment(home, source, work, workspace):
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR")}
    env.update(HOME=str(home), HERMES_HOME=str(home), PYTHONPATH=str(source / "src"),
               OMP_PACKAGE=os.environ.get("OMP_PACKAGE", "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent"),
               SESSION_NAVIGATION_DAEMON=str(ROOT / ".venv/bin/session-navigation-daemon"),
               SESSION_NAVIGATION_STATE_PATH=str(work / "navigation.sqlite3"), TERMINAL_CWD=str(workspace), HERMES_YOLO="1")
    return env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=STAGES, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hosts", default="omp,hermes")
    parser.add_argument("--arms", default="A,B-old,B-new")
    parser.add_argument("--cases", default="atlas,boreal")
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--components", action="store_true")
    parser.add_argument("--label", default="v2-")
    args = parser.parse_args()
    if args.stage == "deepseek" and ("B-old" in args.arms or args.components):
        parser.error("DeepSeek is A/B-new cost only")
    model, provider = STAGES[args.stage]
    args.output.mkdir(parents=True, exist_ok=True)
    before = hashes()
    base = Path.home() / ".session-navigation-eval-v2"
    base.mkdir(exist_ok=True)
    sources = {arm: source_snapshot(base, COMMITS[arm]) for arm in args.arms.split(",")}
    cases = build()
    if args.components:
        cases = [component(action) for action in ("hide", "summarize")]
    cases = [case for case in cases if args.components or case["id"] in args.cases.split(",")]
    server = serve(args.output, model=model, provider=provider)
    (args.output / "stage.json").write_text(json.dumps({"model": model, "provider": {"order": [provider], "allow_fallbacks": False},
        "product_commits": COMMITS, "window": 65536, "repetitions": args.repetitions, "components": args.components}, indent=2))

    def run(host, case, arm, rep):
        identity = f"{args.label}{host}-{case['id']}-{arm}-{rep}"
        output = args.output / identity
        if (output / "status.json").exists():
            return
        work = base / identity
        if work.exists():
            raise RuntimeError(f"Unfinished workspace {identity}; use a new label, never overwrite")
        work.mkdir()
        output.mkdir()
        home, workspace = work / "home", work / "workspace"
        home.mkdir()
        if case.get("component"):
            workspace.mkdir()
            (workspace / "audit-01.jsonl").write_text(case["content"])
        else:
            shutil.copytree(FIXTURES / case["id"], workspace)
        source = sources[arm]
        spec = {k: v for k, v in case.items() if k != "content"}
        spec.update(id=identity, host=host, arm=arm, repetition=rep, repo=str(source), product_commit=COMMITS[arm],
            home=str(home), workspace=str(workspace), output=str(output.resolve()), model=model, provider=provider,
            proxy=f"http://127.0.0.1:{server.server_port}", window=65536, hermes_source=os.environ.get("HERMES_SOURCE", HERMES))
        (output / "spec.json").write_text(json.dumps(spec, indent=2))
        env = child_environment(home, source, work, workspace)
        if host == "hermes":
            if arm != "A":
                plugin = home / "plugins/session-navigation"
                plugin.mkdir(parents=True)
                for name in ("__init__.py", "plugin.yaml"):
                    shutil.copyfile(source / name, plugin / name)
                shutil.copytree(source / "vendor", plugin / "vendor", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            (home / "config.yaml").write_text("plugins:\n  enabled: " + ("[session-navigation]" if arm != "A" else "[]") +
                "\n  entries:\n    session-navigation:\n      settings:\n        enabled: true\n")
        command = (["bun", str(ROOT / "eval/v2_omp.ts")] if host == "omp" else
                   [os.environ.get("HERMES_PYTHON", str(Path(spec["hermes_source"]).parent / "venv/bin/python")), str(ROOT / "eval/v2_hermes.py")]) + [str(output.resolve() / "spec.json")]
        print("START", identity, flush=True)
        with (output / "host.log").open("w") as log:
            try:
                result = subprocess.run(command, cwd=workspace, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=14400)
                status = {"returncode": result.returncode}
            except subprocess.TimeoutExpired:
                status = {"error": "session deadline 14400s"}
        if case.get("canonical_test"):
            shutil.copyfile(FIXTURES / case["id"] / "test_ledger.py", workspace / "test_ledger.py")
            check = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=workspace, capture_output=True)
            status["canonical_tests_pass"] = check.returncode == 0
            (output / "canonical-tests.log").write_bytes(check.stdout + check.stderr)
        for name in ("turns.json", "events.jsonl"):
            path = output / name
            if path.exists():
                with gzip.open(str(path) + ".gz", "wb") as packed:
                    packed.write(path.read_bytes())
                path.unlink()
        (output / "status.json").write_text(json.dumps(status))
        print("DONE", identity, status, flush=True)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs = []
            for rep in range(1, args.repetitions + 1):
                arms = args.arms.split(",")
                if rep % 2 == 0:
                    arms.reverse()
                for host in args.hosts.split(","):
                    for case in cases:
                        for arm in arms:
                            jobs.append(pool.submit(run, host, case, arm, rep))
            for job in jobs:
                job.result()
    finally:
        server.shutdown()
        server.server_close()
        after = hashes()
        key = os.environ["OPENROUTER_API_KEY"].encode()
        leaks = []
        for path in args.output.rglob("*"):
            if path.is_file():
                raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
                if key in raw:
                    leaks.append(str(path.relative_to(args.output)))
        (args.output / "safety.json").write_text(json.dumps({"configs_before": before, "configs_after": after,
            "configs_byte_exact": before == after, "secret_matches": leaks, "children_received_real_key": False}, indent=2))
        assert before == after and not leaks


if __name__ == "__main__":
    main()
