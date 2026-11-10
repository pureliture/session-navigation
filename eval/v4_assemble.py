"""Assemble v4 without modifying v3 evidence or counting API-error sessions."""
import argparse
import gzip
import hashlib
import itertools
import json
import lzma
from pathlib import Path
import shutil
import subprocess

from v2_run import COMMITS, DEEPSEEK_REASONING, STAGES

SETTINGS = {"model": STAGES["deepseek"][0],
            "provider": {"order": ["Relace"], "allow_fallbacks": False},
            "reasoning": DEEPSEEK_REASONING, "window": 65536}


def check_settings(stage):
    assert {key: stage[key] for key in SETTINGS} == SETTINGS, "Different campaign settings"


def wire_lines(directory):
    archived = directory / "wire.jsonl.xz"
    active = directory / "wire.jsonl.gz"
    assert archived.exists() != active.exists(), "Exactly one wire is required"
    with (lzma.open(archived, "rt") if archived.exists() else gzip.open(active, "rt")) as stream:
        yield from stream


def case_name(spec):
    return next(case for case in ("atlas", "boreal") if f"-{case}-" in spec["id"])


def assemble(output, sources, reuse):
    assert not output.exists(), "Never overwrite evidence"
    root = Path(__file__).resolve().parents[1]
    unchanged = ["eval/v2_omp.ts", "eval/v2_hermes.py", "eval/v2_fixtures.py", "eval/proxy.py"]
    assert not subprocess.check_output(["git", "diff", "5e2f033", "--", *unchanged], cwd=root), "Host/fixture/proxy changed"
    selected, excluded, canonical, identities = [], [], {}, set()
    for directory in [reuse, *sources]:
        stage = json.loads((directory / "stage.json").read_text())
        check_settings(stage)
        candidates = {}
        for spec_path in sorted(directory.glob("*/spec.json")):
            spec = json.loads(spec_path.read_text())
            if directory == reuse and spec["arm"] not in ("A", "B-old"):
                continue
            folder = spec_path.parent
            if not (folder / "status.json").exists() or not (folder / "turns.json.gz").exists():
                excluded.append({"source": str(folder), "reason": "incomplete"})
                continue
            turns = json.load(gzip.open(folder / "turns.json.gz", "rt"))
            if len(turns) != len(spec["turns"]):
                excluded.append({"source": str(folder), "reason": "incomplete turns"})
                continue
            assert spec["product_commit"].startswith(COMMITS[spec["arm"]])
            assert spec["model"] == SETTINGS["model"] and spec["provider"] == "Relace"
            assert spec["window"] == SETTINGS["window"]
            case = case_name(spec)
            fixture = {key: spec[key] for key in ("turns", "answers", "labels", "canonical_test") if key in spec}
            assert canonical.setdefault(case, fixture) == fixture, "Different fixture settings"
            candidates[spec["id"]] = (folder, spec)
        failures = set()
        for line in wire_lines(directory):
            row = json.loads(line)
            identity = row["path"].split("/")[1]
            if identity not in candidates:
                continue
            if row["kind"] == "failure":
                failures.add(identity)
            if row["kind"] == "upstream_request":
                body = row["body"]
                assert all(body[key] == SETTINGS[key] for key in ("model", "provider", "reasoning"))
        for identity, (folder, spec) in candidates.items():
            if identity in failures:
                excluded.append({"source": str(folder), "reason": "API/transport failure; not a product failure"})
                continue
            key = (spec["host"], spec["arm"], case_name(spec), spec["repetition"])
            assert key not in identities, f"Duplicate valid cell {key}"
            identities.add(key)
            selected.append({"source": str(folder), "id": identity, "cell": key, "reused": directory == reuse})
    expected = set(itertools.product(("omp", "hermes"), ("A", "B-old", "B-new"), ("atlas", "boreal"), (1, 2)))
    assert identities == expected, f"Missing cells: {sorted(expected - identities)}; unexpected: {sorted(identities - expected)}; excluded: {excluded}"
    output.mkdir()
    for row in selected:
        shutil.copytree(row["source"], output / row["id"])
    checksum = hashlib.sha256()
    with gzip.open(output / "wire.jsonl.gz", "wt") as stream:
        for directory in [reuse, *sources]:
            wanted = {row["id"] for row in selected if Path(row["source"]).parent == directory}
            for line in wire_lines(directory):
                if json.loads(line)["path"].split("/")[1] in wanted:
                    stream.write(line)
                    checksum.update(line.encode())
    (output / "stage.json").write_text(json.dumps({**SETTINGS, "product_commits": COMMITS,
        "repetitions": 2, "components": False}, indent=2))
    manifest = {"settings": SETTINGS, "settings_byte_exact": True,
        "host_fixture_proxy_unchanged_since": "5e2f033",
        "host_fixture_proxy_sha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in unchanged},
        "selected": selected, "excluded": excluded, "wire_decompressed_sha256": checksum.hexdigest(),
        "reused_sessions": sum(row["reused"] for row in selected),
        "new_sessions": sum(not row["reused"] for row in selected)}
    (output / "reuse.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({key: manifest[key] for key in ("settings_byte_exact", "reused_sessions", "new_sessions", "excluded")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse", type=Path, required=True)
    parser.add_argument("--source", type=Path, action="append", required=True)
    args = parser.parse_args()
    assemble(args.output, args.source, args.reuse)
