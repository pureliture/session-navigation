"""Replay captured RCA cases locally; no provider calls or historical daemon."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import ToolResultRecord, compute_sha256, compute_invocation_digest
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation.summary import summary_source, validate_summary_text


def record(raw):
    invocation = {"tool_name": raw["tool_name"], "arguments": raw["arguments"]}
    return ToolResultRecord(call_id=raw["call_id"], content=raw["content"],
        content_sha256=compute_sha256(raw["content"]), invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation), status="ok")


async def main(directory):
    load = lambda name: json.loads((directory / name).read_text())
    evidence, requests = load("replay-input.json"), load("summary.json")
    assert len(requests) == 5
    for request in requests:
        assert request["prompt_length"] == 12086
        assert request["prompt_sha"] == "3ddbb298cf90241284560feb5b0dd76f92386b031c4cc1ddbe8ad67c54c5c871"
        assert evidence["source"].index("latency_budget_ms=") == 15601
        assert summary_source(evidence["source"]) == evidence["source"]
        assert "latency_budget_ms=151" in summary_source(evidence["source"])
    print("PASS Python: 5/5 captured summary sources retain the full tail including latency_budget_ms=151")
    assert validate_summary_text(evidence["source"], {"summary": evidence["retry_summary"]}, ())
    with tempfile.TemporaryDirectory() as temporary:
        store = SQLiteContextStore(Path(temporary) / "state.db")
        engine = SessionNavigationEngine(store)
        original = record({"call_id": "actual-read", "tool_name": "read_file", "arguments": {"path": "audit-01.jsonl"}, "content": evidence["source"]})
        class Summary:
            async def summarize(self, source, *args, **kwargs):
                assert source == evidence["source"]
                return {"summary": evidence["retry_summary"]}
        result = await engine._apply("scope", original, Summary(), allow_fallback=False)
        assert result.ok, result.error
        assert engine.list_items("scope", "audit-01") == []
        assert store.items("scope")[0].original == evidence["source"]
        print("PASS Python: captured comma-formatted retry accepted; filtered listing empty; original unchanged")
        keep = load("keep-failed-replay.json")
        assert len(keep["records"]) == 3
        for raw in keep["records"]:
            result = await engine._apply("keep", record(raw), keep_lines=keep["keep_lines"])
            assert result.error == "keep_lines_too_broad", result.error
        print("PASS Python: 3/3 captured minute-substring requests return explicit keep_lines_too_broad, not verification_failed")
        store.close()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
