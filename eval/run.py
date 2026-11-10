"""Isolated, resumable real-host A/B runs. Only this controller/proxy receives the real key."""
import argparse
import datetime
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from proxy import serve

ROOT = Path(__file__).resolve().parents[1]


def hashes():
    paths = [Path.home() / ".omp/agent/models.yml", Path.home() / ".omp/agent/models.json",
        Path.home() / "hermes-nav-live/config.yaml", Path.home() / "hermes-nav-live/auth.json"]
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None for p in paths}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "eval/results" / datetime.date.today().isoformat())
    parser.add_argument("--hosts", default="omp,hermes")
    parser.add_argument("--cases", default="")
    parser.add_argument("--arms", default="A,B")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise SystemExit("OPENROUTER_API_KEY environment variable required")
    args.output.mkdir(parents=True, exist_ok=True)
    before = hashes()
    server = serve(args.output)
    cases = json.loads((ROOT / "eval/fixtures/cases.json").read_text())
    root = Path.home() / ".session-navigation-eval"
    root.mkdir(exist_ok=True)
    omp_package = os.environ.get("OMP_PACKAGE", "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent")
    hermes_source = os.environ.get("HERMES_SOURCE", "/Users/devin/hermes-nav-live/installs/a6031367d5037fff/environments/3be5d82bc8954afa9633eb60c0780749/workspace")
    hermes_python = os.environ.get("HERMES_PYTHON", str(Path(hermes_source).parent / "venv/bin/python"))
    try:
        for repetition in range(1, args.repetitions + 1):
            for host in args.hosts.split(","):
                for case in cases:
                    if args.cases and case["id"] not in args.cases.split(","):
                        continue
                    if host == "hermes" and case["id"] not in ["03-logs", "05-protected"]:
                        continue
                    arms = args.arms.split(",")
                    if repetition % 2 == 0:
                        arms.reverse()
                    for arm in arms:
                        identity = f"{args.label}{host}-{case['id']}-{arm}-{repetition}"
                        output = args.output / identity
                        if (output / "status.json").exists():
                            continue
                        output.mkdir(exist_ok=True)
                        work = root / identity
                        if work.exists():
                            raise RuntimeError(f"Unfinished workspace exists: {work}; use a new --label, do not silently overwrite")
                        work.mkdir()
                        home = work / "home"
                        home.mkdir()
                        workspace = work / "workspace"
                        shutil.copytree(ROOT / "eval/fixtures" / case["id"], workspace)
                        spec = {**case, "id": identity, "host": host, "arm": arm, "repetition": repetition,
                            "repo": str(ROOT), "home": str(home), "workspace": str(workspace), "output": str(output.resolve()),
                            "proxy": f"http://127.0.0.1:{server.server_port}", "hermes_source": hermes_source}
                        (output / "spec.json").write_text(json.dumps(spec, indent=2))
                        env = {k: v for k, v in os.environ.items() if k in ["PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SYSTEMROOT", "SSL_CERT_FILE", "SSL_CERT_DIR"]}
                        env.update(HOME=str(home), HERMES_HOME=str(home), OMP_PACKAGE=omp_package,
                            SESSION_NAVIGATION_DAEMON=str(ROOT / ".venv/bin/session-navigation-daemon"),
                            SESSION_NAVIGATION_STATE_PATH=str(work / "navigation.sqlite3"), TERMINAL_CWD=str(workspace), HERMES_YOLO="1")
                        if host == "hermes":
                            plugins = home / "plugins"
                            plugins.mkdir()
                            if arm == "B":
                                plugin = plugins / "session-navigation"
                                plugin.mkdir()
                                for name in ["__init__.py", "plugin.yaml"]:
                                    shutil.copyfile(ROOT / name, plugin / name)
                                shutil.copytree(ROOT / "vendor", plugin / "vendor", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
                            (home / "config.yaml").write_text("plugins:\n  enabled: " + ("[session-navigation]" if arm == "B" else "[]") + "\n  entries:\n    session-navigation:\n      settings:\n        enabled: true\n")
                        command = ["bun", str(ROOT / "eval/omp.ts"), str(output.resolve() / "spec.json")] if host == "omp" else [hermes_python, str(ROOT / "eval/hermes.py"), str(output.resolve() / "spec.json")]
                        print("START", identity, flush=True)
                        with (output / "host.log").open("w") as log:
                            try:
                                result = subprocess.run(command, cwd=workspace, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
                                status = {"returncode": result.returncode}
                            except subprocess.TimeoutExpired:
                                status = {"error": "session deadline 1800s"}
                        if case["id"] == "02-bugfix":
                            shutil.copyfile(ROOT / "eval/fixtures/02-bugfix/test_ledger.py", workspace / "test_ledger.py")
                            tested = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=workspace, capture_output=True)
                            status["canonical_tests_pass"] = tested.returncode == 0
                            (output / "canonical-tests.log").write_bytes(tested.stdout + tested.stderr)
                        for name in ["turns.json", "events.jsonl"]:
                            path = output / name
                            if path.exists():
                                with gzip.open(str(path) + ".gz", "wb") as packed:
                                    packed.write(path.read_bytes())
                                path.unlink()
                        (output / "status.json").write_text(json.dumps(status))
                        print("DONE", identity, status, flush=True)
    finally:
        server.shutdown()
        after = hashes()
        key = os.environ["OPENROUTER_API_KEY"].encode()
        leaks = []
        for path in args.output.rglob("*"):
            if path.is_file():
                raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
                if key in raw:
                    leaks.append(str(path.relative_to(args.output)))
        (args.output / "safety.json").write_text(json.dumps({"config_hashes_before": before, "config_hashes_after": after,
            "configs_byte_exact": before == after, "secret_matches": leaks, "children_received_real_key": False}, indent=2))
        assert before == after and not leaks, "Safety audit failed"


if __name__ == "__main__":
    main()
