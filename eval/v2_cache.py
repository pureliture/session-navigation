"""First-sent replacement transitions, not a causal cache-invalidation estimate."""
import gzip
import json
from pathlib import Path
import sys

from analyze import read_wire, text


def sent(request, replacement):
    forms = [replacement, json.dumps(replacement, ensure_ascii=False)[1:-1], json.dumps(replacement)[1:-1]]
    return any(form in text(message.get("content")) for form in forms
               for message in request["body"].get("messages", []) if message.get("role") == "tool")


def transitions(wire, replacements, reports):
    events = []
    for report in reports:
        usage = {u["id"]: u for u in report["usage"]}
        requests = [r for r in wire if r["kind"] == "request" and r["path"].split("/")[1] == report["id"] and r["body"].get("tools")]
        candidates = [r for r in replacements if r["run"] == report["id"] and r["actually_sent"]]
        seen = set()
        for index, request in enumerate(requests):
            new = [r for r in candidates if r["item_id"] not in seen and sent(request, r["replacement"])]
            seen.update(r["item_id"] for r in new)
            if not new or not index or request["id"] not in usage or requests[index - 1]["id"] not in usage:
                continue
            before, after = usage[requests[index - 1]["id"]], usage[request["id"]]
            growth = None if before["cached"] is None or after["cached"] is None else after["prompt"] - after["cached"] - before["prompt"] + before["cached"]
            events.append({"run": report["id"], "arm": report["arm"], "before": before, "after": after,
                "items": [r["item_id"] for r in new], "uncached_growth": growth,
                "reported_cost_delta": None if before["cost"] is None or after["cost"] is None else after["cost"] - before["cost"],
                "native_growth_sensitivity_usd": None if growth is None else max(0, growth) * .001 / 1e6,
                "reference_growth_sensitivity_usd": None if growth is None else max(0, growth) * 1.5 / 1e6})
    groups = {}
    for arm in sorted({r["arm"] for r in reports}):
        rows = [r for r in events if r["arm"] == arm]
        groups[arm] = {"transitions": len(rows), "missing_cache": sum(r["uncached_growth"] is None for r in rows)}
        for field in ("reported_cost_delta", "native_growth_sensitivity_usd", "reference_growth_sensitivity_usd"):
            groups[arm][field] = None if any(r[field] is None for r in rows) else sum(r[field] for r in rows)
    return {"method": "First outgoing use of each final stored replacement; batched changes deduplicated by request. Positive uncached growth times price gap is sensitivity, not causal loss. Ordinary new content, outputs, native maintenance and cache TTL are uncontrolled.",
            "groups": groups, "events": events}


if __name__ == "__main__":
    root = Path(sys.argv[1])
    result = transitions(read_wire(root), json.load(gzip.open(root / "replacements.json.gz", "rt")), json.loads((root / "metrics-v2.json").read_text()))
    (root / "cache-transitions.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result["groups"], indent=2))
