"""Materialize deterministic fixtures; answer keys stay outside agent workspaces."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def build():
    cases = []

    def case(name, turns, answers, entries):
        files = {}
        results = []
        for filename, facts, label, protected in entries:
            suffix = Path(filename).suffix
            prefix = "# " if suffix == ".py" else ""
            lines = [f"{prefix}fixture row {i:04d}: component inventory detail value={i * 17 % 997:03d}" for i in range(420)]
            for index, fact in enumerate(facts):
                lines[12 + index * 19] = fact
            if suffix == ".py":
                lines.extend(["", "def configuration():", "    return {name: value for name, value in globals().items() if name.isupper()}"])
            files[filename] = "\n".join(lines) + "\n"
            results.append({"match": filename, "label": label, "protected": protected, "facts": facts})
        cases.append({"id": name, "turns": turns, "answers": answers, "results": results, "files": files})

    case("01-explore", [
        "Inspect router.py in full. Explain its retry settings and report the jitter cap and routing mode.",
        "Inspect storage.py in full. Report its flush interval and consistency mode.",
        "Inspect worker.py in full. Report its concurrency and batch limit.",
        "Recall the exact retry jitter cap from the first subtask, in milliseconds. What was the routing mode?",
    ], [["137", "sticky"], ["240", "quorum"], ["6", "48"], ["137", "sticky"]], [
        ("router.py", ["RETRY_JITTER_CAP_MS = 137", "ROUTING_MODE = 'sticky'"], "needed-later", False),
        ("storage.py", ["FLUSH_INTERVAL_MS = 240", "CONSISTENCY_MODE = 'quorum'"], "disposable", False),
        ("worker.py", ["CONCURRENCY = 6", "BATCH_LIMIT = 48"], "disposable", False),
    ])
    case("02-bugfix", [
        "Run python3 -m unittest -v and inspect ledger.py. Diagnose the discount calculation bug; do not edit yet. Do not modify tests.",
        "Fix the diagnosed bug in ledger.py. Check at least one non-divisible example. Do not modify tests.",
        "Run python3 -m unittest -v again. Report whether every test passes and explain the rounding rule.",
    ], [[], [], ["pass"]], [])
    bug = cases[-1]
    bug["files"] = {"ledger.py": "def discounted(cents, percent):\n    return cents * (100 - percent) // 100 + 1\n",
        "test_ledger.py": "import unittest\nfrom ledger import discounted\n\nclass Discounts(unittest.TestCase):\n    pass\n\nfor i in range(80):\n    cents, percent = 101 + i * 7, (i * 13) % 90\n    def check(self, cents=cents, percent=percent):\n        self.assertEqual(discounted(cents, percent), cents * (100 - percent) // 100)\n    setattr(Discounts, f'test_discount_{i:03d}', check)\n"}
    bug["results"] = [{"match": "unittest", "label": "disposable", "protected": True, "facts": ["FAILED", "80"]},
        {"match": "ledger.py", "label": "disposable", "protected": False, "facts": ["// 100"]}]
    case("03-logs", [
        "Use bash/terminal to print bootstrap.log in full. Identify the recovery marker and the shard that required recovery.",
        "Print traffic.log in full using bash/terminal. Report the measured p99 latency and total requests.",
        "Print rollout.log in full using bash/terminal. Report the deployed release and whether rollout completed.",
        "Without changing files, report the exact recovery marker and affected shard from the initial bootstrap analysis.",
    ], [["violet-27", "7"], ["182", "9100"], ["r18", "complete"], ["violet-27", "7"]], [
        ("bootstrap.log", ["RECOVERY_MARKER=violet-27", "recovered sequence mismatch on shard 7"], "needed-later", False),
        ("traffic.log", ["p99_latency_ms=182", "total_requests=9100"], "disposable", False),
        ("rollout.log", ["deployed_release=r18", "rollout=complete"], "disposable", False),
    ])
    case("04-distractors", [
        "Inspect truth.txt. Report the archive retention and active product family.",
        "Inspect inventory-a.txt, inventory-b.txt and inventory-c.txt in full. Determine which contains a feature-switch implementation; list any matches.",
        "Inspect inventory-d.txt, inventory-e.txt and inventory-f.txt in full. Determine which contains a feature-switch implementation; list any matches.",
        "What is the exact archive retention from the initial product configuration, and what product family is active?",
    ], [["43", "alpine"], [], [], ["43", "alpine"]], [
        ("truth.txt", ["ARCHIVE_RETENTION_DAYS=43", "PRODUCT_FAMILY=alpine"], "needed-later", False),
        *[(f"inventory-{letter}.txt", ["TYPE=warehouse inventory only; no executable code"], "disposable", False) for letter in "abcdef"],
    ])
    case("05-protected", [
        "Inspect incident.log and report the error, status, exit code and whether retry is safe.",
        "Inspect metrics.txt and catalog.txt in full. Report the metrics region and catalog owner.",
        "Is the incident resolved? Repeat its exact error phrase, status, exit code and retry instruction from the first analysis.",
    ], [["checksum mismatch", "blocked", "23", "do not retry"], ["west-2", "Mira"], ["checksum mismatch", "blocked", "23", "do not retry"]], [
        ("incident.log", ["ERROR: checksum mismatch", "status=blocked", "exit_code: 23", "DO NOT RETRY"], "needed-later", True),
        ("metrics.txt", ["metrics_region=west-2"], "disposable", False),
        ("catalog.txt", ["catalog_owner=Mira"], "disposable", False),
    ])
    case("06-long", [*[f"Subtask {i}: inspect phase-{i}.txt in full and report its owner and completion code." for i in range(1, 6)],
        "Recall the owner and exact seal of phase 1. Also report how many phases were inspected."],
        [[owner, f"done-{i}"] for i, owner in enumerate(["Orchid", "Maple", "Birch", "Cedar", "Aspen"], 1)] + [["Orchid", "harbor-91", "5"]],
        [(f"phase-{i}.txt", [f"owner={owner}", f"completion_code=done-{i}", f"seal={'harbor-91' if i == 1 else f'canal-{i}'}"],
            "needed-later" if i == 1 else "disposable", False) for i, owner in enumerate(["Orchid", "Maple", "Birch", "Cedar", "Aspen"], 1)])
    for value in cases:
        folder = ROOT / value["id"]
        folder.mkdir(exist_ok=True)
        for name, content in value.pop("files").items():
            (folder / name).write_text(content)
    (ROOT / "cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")
    return cases


if __name__ == "__main__":
    print(f"Built {len(build())} deterministic cases")
