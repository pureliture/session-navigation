"""Replay captured fixed-campaign responses; no model calls."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import ToolResultRecord, compute_sha256, compute_invocation_digest
from session_navigation.sqlite_store import SQLiteContextStore


async def main():
    rows = json.loads(Path(sys.argv[1]).read_text())[:4]
    corrected = next(row for row in rows if row["accepted"])
    for row in rows:
        directory = tempfile.TemporaryDirectory()
        store = SQLiteContextStore(Path(directory.name) / "state.db")
        engine = SessionNavigationEngine(store)
        source = row["source"]
        invocation = {"tool_name": "read", "arguments": {"path": "audit-01.jsonl"}}
        record = ToolResultRecord(call_id="read", content=source, content_sha256=compute_sha256(source),
            invocation=invocation, invocation_digest=compute_invocation_digest(invocation))
        hidden = await engine.compact("replay", record)
        assert hidden.ok
        calls = []
        class Summary:
            async def summarize(self, *args, context=None, **kwargs):
                calls.append(context)
                return {"summary": row["summary"] if len(calls)==1 else corrected["summary"]}
        result = await engine.summarize("replay", record, Summary())
        assert result.ok, result.error
        assert result.item.compaction_source == "llm" and result.item.version == 2
        assert result.item.original == source
        assert len(calls) == (1 if row["accepted"] else 2)
        if not row["accepted"]:
            assert row["trace"]["token"] in calls[1]["validation_feedback"]
        assert engine.restore("replay", hidden.item.item_id, 2).item.original == source
        print("PASS Python captured", row["id"], "Hide -> LLM upgrade; calls", len(calls), "; restore exact")
        store.close()
        directory.cleanup()


asyncio.run(main())
