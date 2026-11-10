"""Reproducible incident-review pressure fixtures; no answers are stored in workspaces."""
import hashlib
import json
import random

WINDOW = 65536
SEEDS = (71, 103, 149, 211)


def fixture(seed):
    rng = random.Random(seed)
    files, turns, checks = {}, [], []
    owner = rng.choice(["Orchid", "Juniper", "Cobalt", "Saffron"])
    release = f"r2026.11.{seed}-signed"
    capacity, load, cost, limit = 900 + seed, 310 + seed % 43, 11 + seed % 7, 60 + seed % 13
    drain, rollback = 17 + seed % 9, f"r2026.10.{seed}-stable"
    receipt = hashlib.sha256(f"receipt:{seed}".encode()).hexdigest()[:24]
    canary = hashlib.sha256(f"canary:{seed}".encode()).hexdigest()[:24]
    effective = {"owner": owner, "release": release, "capacity": capacity, "load": load,
                 "worker_cost": cost, "worker_limit": limit, "drain_minutes": drain,
                 "rollback": rollback, "receipt": receipt, "canary": canary}
    obsolete = {"owner": "Legacy-NOC", "release": f"r2026.09.{seed}-candidate", "capacity": capacity + 150,
                "load": load - 100, "worker_cost": cost + 4, "worker_limit": limit + 20,
                "drain_minutes": drain + 15, "rollback": f"r2026.08.{seed}-archived",
                "receipt": "deadbeef0000000000000000", "canary": "badcafe00000000000000000"}
    groups = [("release-control", ["owner", "release", "receipt"]),
              ("rollback-safety", ["drain_minutes", "rollback"]),
              ("capacity-planning", ["capacity", "worker_limit"]),
              ("traffic-replay", ["load", "worker_cost"]),
              ("canary-validation", ["canary"])]
    groups += [(name, []) for name in ("compiler", "integration", "migration", "cache", "routing",
                                      "rate-limit", "database", "deploy", "recovery")]
    manifest = {"incident": f"INC-{seed}", "authority_rule": "Only generation 42 signed-live entries are effective. "
                "Generation 41 archive entries are obsolete even when their export timestamp is newer.",
                "reports": [f"report-{i:02}.jsonl" for i in range(1, 15)]}
    files["manifest.json"] = json.dumps(manifest, indent=2) + "\n"
    for index, (component, fields) in enumerate(groups, 1):
        failed = 2 + (seed + index) % 5
        rows = [{"event": "report_header", "component": component, "incident": f"INC-{seed}", "format": "build-test-incident-v1"}]
        for job in range(104):
            rows.append({"event": "test_result", "job": f"{component}/shard-{job:03}",
                         "generation": 42 if job % 3 else 41, "duration_ms": rng.randrange(80, 9000),
                         "result": "FAIL" if (job % 3 and job // 3 * 2 + job % 3 - 1 < failed) or
                         (not job % 3 and job // 3 < failed + 8) else "PASS",
                         "trace": hashlib.sha256(f"{seed}:{index}:{job}".encode()).hexdigest()[:16],
                         "detail": "retry budget stable; dependency graph scanned; checkpoint checksum verified"})
            if job == 29:
                rows.append({"event": "effective_config", "generation": 42, "source": "signed-live", "component": component,
                             "failed_jobs": failed, **{field: effective[field] for field in fields}})
            if job in (9, 88, 101):
                rows.append({"event": "archived_config", "generation": 41, "source": "archive-export", "component": component,
                             "exported_at": "2026-11-10T23:59:00Z", "failed_jobs": failed + 8,
                             **{field: obsolete[field] for field in fields}})
        name = f"report-{index:02}.jsonl"
        files[name] = "\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n"
        prefix = ("Review INC-%s. Read manifest.json first. Both notes and ordinary tools/recovery are available; "
                  "retain the effective owner, release, rollback and drain_minutes for the later handover. " % seed) if index == 1 else ""
        turns.append(prefix + f"Work unit {index}: inspect the complete {name} using read_file (paginate if needed), "
                     "including the build/test rows and legacy/current configuration entries. Other tools and notes are allowed. "
                     "Report the effective component and failed_jobs from the signed-live entry. "
                     "End your answer with a JSON object containing exactly component and failed_jobs; no raw log dump.")
        checks.append({"kind": "work", "expected": {"component": component, "failed_jobs": failed},
                       "stale": {"failed_jobs": [failed + 8]}, "sources": [name]})
    late = [
        ("announced", "Handover: give the effective owner, release, rollback and drain_minutes retained from the earlier review.",
         {key: effective[key] for key in ("owner", "release", "rollback", "drain_minutes")}, [1, 2]),
        ("surprise", "New incident question, not announced earlier: report the signed-live receipt and canary, "
         "plus spare_capacity=capacity-load and safe_parallel=min(worker_limit, floor((capacity-load)/worker_cost)). "
         "Use the effective configuration, not archived exports.",
         {"receipt": receipt, "canary": canary, "spare_capacity": capacity - load,
          "safe_parallel": min(limit, (capacity - load) // cost)}, [1, 3, 4, 5]),
    ]
    plan = {"release": release, "rollback": rollback, "drain_seconds": drain * 60,
            "safe_parallel": min(limit, (capacity - load) // cost), "receipt": receipt}
    late.append(("canonical", "Create decision.json for the executable handover gate: exactly release, rollback, "
                 "drain_seconds=drain_minutes*60, safe_parallel=min(worker_limit, floor((capacity-load)/worker_cost)), "
                 "and receipt, all from effective records. Also return that complete JSON object in your final answer.", plan, [1, 2, 3, 4]))
    for kind, prompt, expected, sources in late:
        turns.append(prompt + " Notes, source re-reads, native recovery and ordinary tools remain available. "
                     "Return a JSON object with exactly these requested keys and values.")
        stale = {key: [obsolete[key]] for key in expected if key in obsolete}
        stale.update({"spare_capacity": [obsolete["capacity"] - obsolete["load"]],
                      "safe_parallel": [min(obsolete["worker_limit"], (obsolete["capacity"] - obsolete["load"]) // obsolete["worker_cost"])],
                      "drain_seconds": [obsolete["drain_minutes"] * 60]})
        checks.append({"kind": kind, "expected": expected, "stale": stale,
                       "sources": [f"report-{i:02}.jsonl" for i in sources]})
    return {"seed": seed, "files": files, "turns": turns, "checks": checks, "plan": plan}
