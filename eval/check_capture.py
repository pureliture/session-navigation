"""Verify real-host activation, balanced cells, and the sole upstream model."""
import collections
import gzip
import hashlib
import json
import sys
from pathlib import Path

from proxy import MODEL


def check(directory):
    metrics = json.loads((directory / "metrics.json").read_text())
    wire = list(map(json.loads, gzip.open(directory / "wire.jsonl.gz", "rt")))
    requests = [r for r in wire if r["kind"] == "request"]
    upstream = [r for r in wire if r["kind"] == "upstream_request"]
    responses = [r for r in wire if r["kind"] == "response"]
    assert len(metrics) == 48
    cells = collections.Counter((r["host"], r["id"].split("-")[1], r["arm"]) for r in metrics)
    assert len(cells) == 16 and set(cells.values()) == {3}
    assert all(r["body"]["model"] == MODEL for r in requests + upstream + responses)
    assert {r["id"] for r in requests} == {r["id"] for r in responses}
    assert all(r["body"].get("usage", {}).get("cost") is not None and
        r["body"]["usage"].get("prompt_tokens_details", {}).get("cached_tokens") is not None for r in responses)
    nav = {"manage_context", "list_context_items", "hide_context", "summarize_context", "unhide_context"}
    for row in metrics:
        folder = directory / row["id"]
        first = next(r["body"] for r in requests if r["path"].split("/")[1] == row["id"])
        names = {t.get("function", {}).get("name") for t in first.get("tools", [])}
        system = json.dumps(first["messages"][0].get("content"))
        if row["host"] == "omp":
            assert (nav <= names and "After completing a unit of work" in system) if row["arm"] == "B" else not nav & names
        else:
            plugins = json.loads((folder / "plugins.json").read_text())
            assert any(p["enabled"] and p["tools"] == 5 and p["middleware"] == 1 for p in plugins) if row["arm"] == "B" else not plugins
        if row["arm"] == "B":
            assert row["state_snapshot_available"] and row["recorded_units"] > 0
    spec = json.loads((directory / "hermes-03-logs-B-1/spec.json").read_text())
    source = Path(spec["hermes_source"]) / "run_agent.py"
    judge_path = directory / "judge/wire.jsonl.gz"
    judge_wire = list(map(json.loads, gzip.open(judge_path, "rt"))) if judge_path.exists() else []
    assert all(r["body"]["model"] == MODEL for r in judge_wire if r["kind"] in ["request", "upstream_request", "response"])
    output = {"sessions": len(metrics), "cells": len(cells), "repetitions_per_cell": 3,
        "requests": len(requests), "responses": len(responses), "upstream_attempts": len(upstream), "model": MODEL,
        "activation_verified": True, "all_usage_reported": True,
        "judge_requests": sum(r["kind"] == "request" for r in judge_wire),
        "hermes_run_agent_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "blocked_paths": dict(collections.Counter(r["path"].rsplit("/", 2)[-2] + "/" + r["path"].rsplit("/", 1)[-1] for r in wire if r["kind"] == "blocked"))}
    (directory / "capture-audit.json").write_text(json.dumps(output, indent=2))
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    check(Path(sys.argv[1]))
