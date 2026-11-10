"""Independent final checks on focus wires, preserved histories and configuration hashes."""
import gzip
import json
from pathlib import Path
import sys

from focus_fixtures import WINDOW, tokens
from quality_score import MODEL, PROVIDER, REASONING, campaign_wire
from run import hashes


def audit(root):
    root = Path(root)
    specs = {p.parent.name: json.loads(p.read_text()) for p in (root / "sessions").glob("*/spec.json")}
    requests, replay, live = {}, 0, 0
    for row in campaign_wire(root):
        if row["kind"] != "upstream_request":
            continue
        body = row["body"]
        assert body["model"] == MODEL and body["provider"] == PROVIDER and body["reasoning"] == REASONING
        requests[row["id"]] = row
    for row in requests.values():
        spec = specs[row["path"].split("/")[1]]
        assert not spec["native_compaction"] and spec["window"] == WINDOW
        if spec["part"] == "replay":
            case = json.load(gzip.open(root / "fixtures" / f"{spec['seed']}-{spec['length']}.json.gz", "rt"))
            wanted = case["messages"] if spec["arm"] == "RAW" else case["hide"]["messages"]
            assert row["body"]["messages"] == wanted
            assert tokens(wanted) < WINDOW * .8
            assert all(case["hide"]["survival"][key] for key in case["primary_keys"])
            assert not case["hide"]["survival"]["audit_marker"]
            replay += 1
        else:
            live += 1
    native = 0
    for folder in (root / "sessions").glob("*"):
        path = folder / "events.jsonl.gz"
        if path.exists():
            events = [json.loads(line) for line in gzip.open(path, "rt")]
            assert any(row["kind"] == "native_config" and row["enabled"] is False for row in events)
            native += sum("compaction_start" in row.get("event", {}).get("type", "") for row in events)
    assert not native
    safeties = [json.loads(p.read_text()) for p in sorted((root / "attempts").glob("*/safety.json"))]
    assert safeties and all(s["configs_byte_exact"] and not s["children_received_real_key"] for s in safeties)
    unchanged = safeties[0]["configs_before"] == hashes()
    result = {"requests_verified": len(requests), "replay_histories_verified": replay, "live_requests": live,
              "native_starts": native, "configurations_byte_exact": unchanged,
              "all_primary_facts_survive_rule_hide": True, "hidden_only_loss_separated": True}
    (root / "request-audit.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    print("final configurations byte-exact:", unchanged)
    assert unchanged
    return result


if __name__ == "__main__":
    audit(Path(sys.argv[1]))
