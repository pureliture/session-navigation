"""Deterministic, semantically distinct service audit documents and private answer keys."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "fixtures-v2"


def document(campaign, phase):
    digest = hashlib.sha256(f"{campaign}:{phase}".encode()).hexdigest()
    owner = f"{campaign}-team-{phase}"
    seal = f"{campaign}-{digest[:10]}"
    facts = [f"owner={owner}", f"audit_seal={seal}", f"latency_budget_ms={150 + phase}"]
    rows = [f"# {campaign} service telemetry audit {phase}: distinct minute/region measurements"]
    for sample in range(100):
        n = int(hashlib.sha256(f"{campaign}:{phase}:{sample}".encode()).hexdigest()[:8], 16)
        row = {"minute": f"2026-10-{phase:02d}T{sample // 60:02d}:{sample % 60:02d}:00Z",
               "region": ["us-east", "eu-west", "ap-south"][sample % 3], "service": f"{campaign}-svc-{sample % 7}",
               "requests": 1200 + n % 9000, "p50_ms": 12 + n % 43, "p99_ms": 90 + n % 140,
               "cpu_pct": 15 + n % 70, "queue_depth": n % 32, "cache_hit_pct": 70 + n % 28,
               "worker_pool": f"pool-{sample % 5}", "payload_bytes": 500 + n % 4500}
        rows.append(json.dumps(row, separators=(",", ":")))
        if sample in (17, 43, 71):
            rows.append(facts[(17, 43, 71).index(sample)])
    rows.append(f"audited_regions=us-east,eu-west,ap-south; document={campaign}-{phase}")
    return "\n".join(rows) + "\n", facts


def build(root=ROOT):
    root.mkdir(exist_ok=True)
    cases = []
    for campaign in ("atlas", "boreal"):
        folder = root / campaign
        folder.mkdir(exist_ok=True)
        turns, answers, labels = [], [], []
        for phase in range(1, 21):
            name = f"audit-{phase:02d}.jsonl"
            content, facts = document(campaign, phase)
            (folder / name).write_text(content)
            retain = phase in (1, 8, 15)
            obligation = " This contract is required for the final release memo: retain its owner, audit seal and latency budget." if retain else ""
            turns.append(f"Work unit {phase}: review {name} in full, including all regions/minutes. Report the owning team, exact audit seal, latency budget, and which regions are represented. The full observation is required for this audit; do not substitute a filtered or precomputed summary for the initial read. Keep your answer concise." + obligation)
            answers.append([fact.split("=", 1)[1] for fact in facts])
            labels.append({"match": name, "label": "needed-later" if retain else "disposable", "protected": False,
                           "announced": retain, "surprise_probe": phase == 2, "facts": facts})
            if phase == 10:
                turns.append("Inspect incident.log in full. Is it resolved? State the exact error, operational state, exit code and retry instruction. This safety obligation is required in the final memo.")
                answers.append(["checksum mismatch", "blocked", "23", "do not retry"])
        incident = "ERROR: checksum mismatch\nstatus=blocked\nexit_code: 23\nDO NOT RETRY\n" + document(campaign, 21)[0]
        (folder / "incident.log").write_text(incident)
        labels.append({"match": "incident.log", "label": "needed-later", "protected": True,
                       "announced": True, "facts": ["ERROR: checksum mismatch", "status=blocked", "exit_code: 23", "DO NOT RETRY"]})
        (folder / "ledger.py").write_text("def discounted(cents, percent):\n    return cents * (100 - percent) // 100 + 1\n")
        (folder / "test_ledger.py").write_text("import unittest\nfrom ledger import discounted\nclass Discount(unittest.TestCase):\n    def test_rounding(self):\n        for cents in range(101, 131):\n            with self.subTest(cents=cents):\n                self.assertEqual(discounted(cents, 17), cents * 83 // 100)\n")
        turns += ["Run python3 -m unittest -v and inspect ledger.py. Diagnose the rounding bug, then fix only ledger.py and rerun the tests. Do not modify tests. Report the result.",
                  "Prepare the final release memo. Recall the exact owner, audit seal and latency budget for audit-01, audit-08 and audit-15. Is the incident resolved? Repeat its error/state/exit/retry facts.",
                  "Recovery probe: what was the exact audit seal in audit-02? Recover the original if needed; do not invent the seal.",
                  "Perform the final independent verification: run python3 -m unittest -v and state whether every test passes. Do not modify any files."]
        answers += [["pass"], [value.split("=", 1)[1] for phase in (1, 8, 15) for value in document(campaign, phase)[1]] + ["checksum mismatch", "blocked", "23", "do not retry"],
                    [document(campaign, 2)[1][1].split("=", 1)[1]], ["pass"]]
        assert len(turns) == 25
        cases.append({"id": campaign, "turns": turns, "answers": answers, "results": labels,
                      "announced_recall_turn": 23, "surprise_recall_turn": 24, "canonical_test": True,
                      "fixture_sha256": hashlib.sha256("".join(p.read_text() for p in sorted(folder.iterdir())).encode()).hexdigest()})
    (root / "cases.json").write_text(json.dumps(cases, indent=2) + "\n")
    return cases


def component(action):
    text, facts = document("component", 1)
    instruction = ("Hide the transmitted audit-01.jsonl result using rule-based Hide only, never Summarize/auto. Preserve these exact substrings if keep_lines is supported: "
                   if action == "hide" else "Summarize the transmitted audit-01.jsonl result using the session LLM, not rule Hide/auto. Preserve these facts: ")
    return {"id": f"command-{action}", "turns": ["Read audit-01.jsonl in full and identify its owner, audit seal and budget. Do not clean any results until the next explicit instruction.",
             instruction + ", ".join(facts), "State the owner, audit seal and latency budget, then restore the original result without re-executing the read if supported."],
            "answers": [[f.split("=", 1)[1] for f in facts], [], [f.split("=", 1)[1] for f in facts]],
            "results": [{"match": "audit-01.jsonl", "label": "needed-later", "protected": False, "facts": facts}],
            "component": action, "content": text}


if __name__ == "__main__":
    print(f"Built {len(build())} v2 campaigns, 25 turns each")
