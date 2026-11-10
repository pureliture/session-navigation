"""E2E: restart/fork/DB-error/non-interactive/concurrent/large. Tmp DB only."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from session_navigation.db import resolve_path
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import (
    Scope,
    ToolResultRecord,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.sqlite_store import SQLiteContextStore

REPO = Path(__file__).resolve().parents[1]


def _record(call_id: str, body: str, tool: str = "read", args: dict | None = None) -> ToolResultRecord:
    invocation = {"tool_name": tool, "arguments": args or {"path": "sample.txt"}}
    return ToolResultRecord(
        call_id=call_id,
        content=body,
        content_sha256=compute_sha256(body),
        invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation),
        status="ok",
    )


def _body(n: int = 100) -> str:
    return "\n".join(f"Output row {i:03d} details for persistence" for i in range(n))


def _scope(session: str) -> Scope:
    return Scope(adapter_id="pi", host_profile="default", session_id=session, branch_scope="default")


def test_restart_keeps_hidden_state_and_patches(tmp_path):
    db = tmp_path / "restart.sqlite3"
    scope = _scope("sess-restart")
    body = _body()
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    record = _record("call-1", body)
    result = engine.compact_sync(scope, record)
    assert result.ok and result.plan is not None
    store.fence_set(scope, "call-1", record.content_sha256, record.invocation_digest,
                    record.result_position, result.plan.item_id)
    store.close()

    # Simulate process restart: fresh objects on the same file.
    store2 = SQLiteContextStore(str(db))
    engine2 = SessionNavigationEngine(store=store2)
    plans = engine2.project(scope, [record])
    assert len(plans) == 1
    assert plans[0].replacement_text == result.plan.replacement_text
    assert store2.fence_get(scope, "call-1", record.content_sha256,
                            record.invocation_digest, record.result_position) is not None
    store2.close()


def test_fork_carries_state_to_child_scope(tmp_path):
    db = tmp_path / "fork.sqlite3"
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    parent = _scope("sess-parent")
    record = _record("call-9", _body())
    result = engine.compact_sync(parent, record)
    assert result.ok
    child_key = _scope("sess-child").scope_key()
    counts = store.fork_scope(parent.scope_key(), child_key)
    assert counts.items >= 1
    child_items = store.items(child_key)
    assert len(child_items) == 1
    plans = engine.project(_scope("sess-child"), [record])
    assert len(plans) == 1
    assert plans[0].item_id == child_items[0].item_id
    assert plans[0].replacement_text == result.plan.replacement_text
    store.close()




def test_concurrent_writers_stale_rejected_ui_refreshes(tmp_path):
    db = tmp_path / "cas.sqlite3"
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    scope = _scope("sess-cas")
    result = engine.compact_sync(scope, _record("call-1", _body()))
    assert result.ok and result.item is not None
    v1 = result.item.version
    # First writer (UI A) restores with correct version.
    first = engine.restore(scope, result.item.item_id, expected_version=v1)
    assert first.ok
    # Stale writer (UI B) replays old version -> rejected with current attached.
    stale = engine.restore(scope, result.item.item_id, expected_version=v1)
    assert stale.ok is False
    assert stale.error == "version_conflict"
    assert stale.item is not None and stale.item.version > v1
    store.close()

def test_concurrent_cas_race_one_winner(tmp_path):
    import time as _time
    from dataclasses import replace as _replace
    db = tmp_path / "race.sqlite3"
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    scope = _scope("sess-race")
    result = engine.compact_sync(scope, _record("call-1", _body()))
    assert result.ok and result.item is not None
    v1 = result.item.version
    item_id = result.item.item_id
    barrier = threading.Barrier(2)
    outcomes: list[bool] = []

    def _racer():
        s = SQLiteContextStore(str(db))
        try:
            cur = s.get(scope, item_id)
            assert cur is not None
            barrier.wait(timeout=10)
            flipped = _replace(cur, visibility="visible" if cur.visibility == "hidden" else "hidden",
                               version=cur.version + 1)
            res = s.put(scope, flipped, expected_version=v1)
            outcomes.append(res.ok)
        finally:
            s.close()

    threads = [threading.Thread(target=_racer) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    # Exactly one winner: atomic WHERE version=? guarantees no double-apply.
    assert sorted(outcomes) == [False, True], outcomes
    final = store.get(scope, item_id)
    assert final is not None and final.version == v1 + 1
    store.close()


def test_three_ui_threads_share_one_db_without_loss(tmp_path):
    db = tmp_path / "shared.sqlite3"
    scope = _scope("sess-shared")
    errors: list[str] = []

    def _worker(tag: str):
        try:
            store = SQLiteContextStore(str(db))
            engine = SessionNavigationEngine(store=store)
            for i in range(10):
                record = _record(f"{tag}-{i}", _body(90) + f"\nunique {tag} {i}")
                result = engine.compact_sync(scope, record)
                assert result.ok, result.error
            store.close()
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(f"{tag}: {exc}")

    threads = [threading.Thread(target=_worker, args=(f"ui{n}",)) for n in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    store = SQLiteContextStore(str(db))
    assert len(store.items(scope)) == 30
    store.close()




def test_large_snapshot_survives_restart(tmp_path):
    db = tmp_path / "large.sqlite3"
    scope = _scope("sess-large")
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    for i in range(200):
        record = _record(f"big-{i}", _body(60) + f"\nunique large {i}")
        result = engine.compact_sync(scope, record)
        assert result.ok, result.error
    store.close()
    store2 = SQLiteContextStore(str(db))
    engine2 = SessionNavigationEngine(store=store2)
    items = engine2.list_items(scope)
    assert len(items) == 200
    store2.close()


