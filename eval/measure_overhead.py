"""Comparable OFFLINE token estimates, not OpenRouter billing/native GLM counts.

Run with: uv run --no-sync --with tiktoken python eval/measure_overhead.py CAPTURE.json
The capture comes from bun eval/capture_overhead.ts CAPTURE.json (loopback only).
"""
import copy
import gzip
import importlib
import json
from pathlib import Path
import re
import sys

import tiktoken

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from session_navigation.reminders import BoundaryReminders

sys.path.insert(0, str(ROOT / "tests"))
from _adapter_loader import hermes_adapter
schemas = importlib.import_module(f"{hermes_adapter().__name__}.schemas")
encoding = tiktoken.get_encoding("o200k_base")


def count(body):
    visible = {key: body[key] for key in ("messages", "tools")}
    return len(encoding.encode(json.dumps(visible, ensure_ascii=False, separators=(",", ":")), disallowed_special=()))


old = {}
with gzip.open(ROOT / "eval/results/2026-11-09-glm/wire.jsonl.gz", "rt") as stream:
    for line in stream:
        record = json.loads(line)
        if record["kind"] != "request":
            continue
        name = record["path"].split("/")[1]
        if name in ("omp-01-explore-A-1", "omp-01-explore-B-1", "hermes-03-logs-A-1", "hermes-03-logs-B-1"):
            old.setdefault(name.split("-")[0] + "-" + name.split("-")[-2], record["body"])

new_omp = json.loads(Path(sys.argv[1]).read_text())
new_hermes = copy.deepcopy(old["hermes-B"])
system = new_hermes["messages"][0]["content"]
start = system.index("<!-- hermes-plugin-section-chars:")
header_end = system.index("-->", start) + 3
end = system.index("<!-- hermes-plugin-sections:end -->", header_end)
old_text = system[header_end:end]
leading = old_text[:len(old_text) - len(old_text.lstrip())]
trailing = old_text[len(old_text.rstrip()):]
system = (system[:start] + f"<!-- hermes-plugin-section-chars:{len(schemas.SUPERVISION_SECTION_TEXT)} -->"
          + leading + schemas.SUPERVISION_SECTION_TEXT + trailing + system[end:])
new_hermes["messages"][0]["content"] = system


def short_description(text):
    text = " ".join(text.split())
    first = re.search(r"[.!?](?:\s|$)", text)
    text = text[:first.start() + 1] if first else text
    if len(text) <= 80:
        return text
    clipped = text[:80]
    return (clipped.rsplit(" ", 1)[0] if " " in clipped else clipped).rstrip(",;: ") + "…"


for tool in new_hermes["tools"]:
    if tool["function"]["name"] == "tool_search":
        description = tool["function"]["description"]
        for name, schema in schemas.TOOL_SCHEMAS.items():
            description, matched = re.subn(r"(?m)^- " + re.escape(name) + r": .*", lambda m: f"- {name}: {short_description(schema['description'])}", description)
            assert matched == 1
        tool["function"]["description"] = description

items = [{"tool_call_id": f"chatcmpl-tool-{i:016x}", "tool_name": "read", "hint": "phase-1.txt", "bytes_size": 16489, "turn": 1} for i in range(20)]
note = BoundaryReminders().note("s", "1", 64000, 128000, items)
output = {
    "method": "o200k_base over identical JSON messages/tools serialization; offline estimate, NOT native GLM billing",
    "omp": {"before": count(old["omp-B"]) - count(old["omp-A"]), "after": count(new_omp["B"]) - count(new_omp["A"])},
    "hermes": {"before": count(old["hermes-B"]) - count(old["hermes-A"]), "after": count(new_hermes) - count(old["hermes-A"])},
    "typical_note": {"bytes": len(note.encode()), "tokens": len(encoding.encode(note)), "displayed": 3, "eligible": 20},
    "native_before": {"omp": 853, "hermes": "869-871"},
    "native_after": "unmeasured: phase 1 forbids live model runs",
}
print(json.dumps(output, ensure_ascii=False, indent=2))
