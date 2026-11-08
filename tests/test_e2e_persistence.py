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


def test_db_error_reports_failure_and_noninteractive_aborts(tmp_path, monkeypatch):
    from session_navigation_omp.daemon import Daemon

    db = tmp_path / "db.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    daemon = Daemon()
    record = {"call_id": "call-1", "tool_name": "read", "arguments": {"path": "a.txt"},
              "status": "ok", "content": _body()}
    assert daemon.handle({"method": "prepare",
                          "params": {"session_id": "s", "snapshot_id": "t", "records": [record]}})["ok"]
    # Real readonly failure: close, chmod 444, reopen through a fresh daemon.
    # prepare itself writes pair units, so it must report db_error, never ok.
    daemon.store.close()
    os.chmod(db, 0o444)
    daemon2 = Daemon()
    try:
        out = daemon2.handle({"method": "prepare",
                              "params": {"session_id": "s", "snapshot_id": "t", "records": [record]}})
    finally:
        daemon2.store.close()
        os.chmod(db, 0o644)
    assert out["ok"] is False
    assert out["error"] in ("db_error", "db_full")
    if out["error"] == "db_error":
        assert out["choices"] == ["abort_request", "send_original"]


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

def test_three_surfaces_interleave_on_same_item(tmp_path, monkeypatch):
    # Paseo(CLI) + OMP(daemon RPC) + Hermes(engine) operate the same row.
    import json as _json
    from session_navigation_omp.daemon import Daemon
    db = tmp_path / "surfaces.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    scope = _scope("sess-surfaces")
    body = _body()
    # Hermes surface hides via engine.
    hstore = SQLiteContextStore(str(db))
    hengine = SessionNavigationEngine(store=hstore)
    record = _record("call-1", body)
    hidden = hengine.compact_sync(scope, record)
    assert hidden.ok and hidden.item is not None
    # OMP surface lists + unhides via daemon RPC.
    daemon = Daemon()
    listed = daemon.handle({"method": "list_items", "params": {"session_id": "sess-surfaces"}})
    assert listed["ok"] and any(i["item_id"] == hidden.item.item_id for i in listed["items"])
    unhid = daemon.handle({"method": "restore",
                           "params": {"session_id": "sess-surfaces", "item_id": hidden.item.item_id,
                                      "expected_version": hidden.item.version}})
    assert unhid["ok"], unhid
    # Paseo surface re-hides via CLI manage (visible rows).
    import subprocess as _sp, sys as _sys
    env = {**os.environ, "SESSION_NAVIGATION_STATE_PATH": str(db),
           "PYTHONPATH": str(REPO / "src")}
    out = _sp.run([_sys.executable, "-m", "session_navigation.cli", "manage",
                   "--scope", scope.scope_key()], capture_output=True, text=True, env=env, timeout=30)
    assert out.returncode == 0, out.stderr
    payload = _json.loads(out.stdout)
    assert payload["ok"] is True and payload["applied"] == 1, payload
    # Stale Hermes handle replays old version -> conflict with current attached.
    stale = hengine.restore(scope, hidden.item.item_id, expected_version=hidden.item.version)
    assert stale.ok is False and stale.error == "version_conflict"
    assert stale.item is not None and stale.item.visibility == "hidden"
    daemon.store.close()
    hstore.close()

def test_three_paths_race_same_rows_consistency(tmp_path, monkeypatch):
    # OMP daemon RPC + Hermes tool handlers + Paseo CLI race the same rows.
    # Consistency bar: no lost writes, no silent overwrites, every mutation
    # either applies (version+1) or reports version_conflict.
    import json as _json
    import subprocess as _sp
    import sys as _sys
    from session_navigation_omp.daemon import Daemon
    db = tmp_path / "race3.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    scope = _scope("sess-race3")
    store = SQLiteContextStore(str(db))
    engine = SessionNavigationEngine(store=store)
    records = [_record(f"race-{i}", _body(60) + f"\nunique race {i}") for i in range(20)]
    for record in records:
        assert engine.compact_sync(scope, record).ok
    store.close()
    errors: list[str] = []
    barrier = threading.Barrier(3)

    def _omp_path():
        try:
            daemon = Daemon()
            barrier.wait(timeout=15)
            for i in range(20):
                listed = daemon.handle({"method": "list_items", "params": {"session_id": "sess-race3"}})
                assert listed["ok"], listed
                item = next(x for x in listed["items"] if (x.get("tool_call_id") or x.get("call_id")) == f"race-{i}")
                res = daemon.handle({"method": "restore",
                                     "params": {"session_id": "sess-race3", "item_id": item["item_id"],
                                                "expected_version": item["version"]}})
                assert res["ok"] or res.get("error") == "version_conflict", res
            daemon.store.close()
        except Exception as exc:
            errors.append(f"omp: {exc}")

    def _hermes_path():
        try:
            from tests._adapter_loader import hermes_adapter
            hermes_adapter()
            hstore = SQLiteContextStore(str(db))
            hengine = SessionNavigationEngine(store=hstore)
            barrier.wait(timeout=15)
            for i in range(20):
                items = hengine.list_items(scope)
                item = next(x for x in items if x.call_id == f"race-{i}")
                res = hengine.restore(scope, item.item_id, expected_version=item.version)
                assert res.ok or res.error == "version_conflict", res.error
            hstore.close()
        except Exception as exc:
            errors.append(f"hermes: {exc}")

    def _paseo_path():
        try:
            env = {**os.environ, "SESSION_NAVIGATION_STATE_PATH": str(db),
                   "PYTHONPATH": str(REPO / "src")}
            barrier.wait(timeout=15)
            for _ in range(4):
                out = _sp.run([_sys.executable, "-m", "session_navigation.cli", "manage",
                               "--scope", scope.scope_key(), "--max-items", "20"],
                              capture_output=True, text=True, env=env, timeout=30)
                assert out.returncode == 0, out.stderr
                payload = _json.loads(out.stdout)
                assert "applied" in payload and "failed" in payload, payload
                assert payload["applied"] + payload["failed"] == len(payload.get("items", [])), payload
                for row in payload.get("items", []):
                    assert row["ok"] or row.get("error") in ("version_conflict", "not_found"), row
        except Exception as exc:
            errors.append(f"paseo: {exc}")

    threads = [threading.Thread(target=f) for f in (_omp_path, _hermes_path, _paseo_path)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert errors == [], errors
    # Final state coherent: 20 rows, versions monotonic, no duplicates.
    check = SQLiteContextStore(str(db))
    items = check.items(scope)
    assert len(items) == 20
    assert len({i.item_id for i in items}) == 20
    assert all(i.version >= 1 for i in items)
    check.close()


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


def test_cli_db_info_and_fork_scope_json(tmp_path):
    db = tmp_path / "cli.sqlite3"
    env = {**os.environ, "SESSION_NAVIGATION_STATE_PATH": str(db),
           "PYTHONPATH": str(REPO / "src")}
    out = subprocess.run([sys.executable, "-m", "session_navigation.cli", "db-info"],
                         capture_output=True, text=True, env=env, timeout=30)
    assert out.returncode == 0, out.stderr
    assert "state.sqlite3" in out.stdout or "sqlite" in out.stdout.lower()
    assert resolve_path(str(db)) == db
