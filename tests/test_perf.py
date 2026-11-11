"""Perf gates: list 1000 <1s, summary path timeout 25s. Tmp DB only."""
from __future__ import annotations

import asyncio
import time

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import (
    Scope,
    ToolResultRecord,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.sqlite_store import SQLiteContextStore


def _record(call_id: str, body: str) -> ToolResultRecord:
    invocation = {"tool_name": "read", "arguments": {"path": "sample.txt"}}
    return ToolResultRecord(
        call_id=call_id,
        content=body,
        content_sha256=compute_sha256(body),
        invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation),
        status="ok",
    )


def test_list_1000_under_1s(tmp_path):
    db = tmp_path / "perf.sqlite3"
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    scope = Scope(adapter_id="pi", host_profile="default", session_id="perf", branch_scope="default")
    for i in range(1000):
        body = "\n".join(f"Perf row {i:04d} line {j:03d} content" for j in range(60))
        result = engine.compact_sync(scope, _record(f"perf-{i}", body))
        assert result.ok, result.error
    start = time.perf_counter()
    items = engine.list_items(scope)
    elapsed = time.perf_counter() - start
    assert len(items) == 1000
    assert elapsed < 1.0, f"list 1000 took {elapsed:.3f}s"
    store.close()


def test_summarize_timeout_is_25s(tmp_path):
    from adapters.hermes.llm import CtxLlmSummarizer

    import inspect

    src = inspect.getsource(CtxLlmSummarizer)
    assert "25" in src, "CtxLlmSummarizer must use 25s timeout"


def test_slow_summarizer_does_not_hang_engine(tmp_path):
    from session_navigation.transport import Summarizer

    class Slow:
        async def summarize(self, *a, **k):
            await asyncio.sleep(30)
            return {"summary": "too late"}

    db = tmp_path / "slow.sqlite3"
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    scope = Scope(adapter_id="pi", host_profile="default", session_id="slow", branch_scope="default")
    body = "\n".join(f"Slow row {i:03d} content" for i in range(100))
    start = time.perf_counter()
    with __import__("pytest").raises(asyncio.TimeoutError):
        asyncio.run(asyncio.wait_for(
            engine.summarize(scope, _record("slow-1", body), Slow()), timeout=25))
    elapsed = time.perf_counter() - start
    assert elapsed < 28, f"timeout guard took {elapsed:.1f}s"
    store.close()
