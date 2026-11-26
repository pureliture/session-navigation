"""Tests for batch unit upserts and Hermes safe performance diagnostics."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))
if str(ROOT / "adapters") not in sys.path:
    sys.path.insert(0, str(ROOT / "adapters"))

from session_navigation.db import DBError
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope
from session_navigation.sqlite_store import SQLiteContextStore
from hermes.diagnostics import clear_perf, recent_perf, record_perf, sanitize_error_code
from hermes.handlers import middleware_step
from hermes.session import SessionTranscriptStore


def test_sqlite_store_upsert_units_batch_and_rollback(tmp_path: Path) -> None:
    store = SQLiteContextStore(str(tmp_path / "state.sqlite3"))
    scope = Scope("hermes", "default", "s1", "default")
    units = [
        {
            "unit_id": f"pair:c{i}:sha{i}",
            "kind": "tool_result",
            "tool_call_id": f"c{i}",
            "content_sha256": f"sha{i}",
            "char_count": 100 + i,
        }
        for i in range(50)
    ]
    store.upsert_units(scope, [])
    store.upsert_units(scope, units)
    stored = store.list_units(scope)
    assert len(stored) == 50
    by_id = {u["unit_id"]: u for u in stored}
    assert by_id["pair:c0:sha0"]["tool_call_id"] == "c0"
    assert by_id["pair:c49:sha49"]["char_count"] == 149

    # Updating an existing unit in a batch matches single upsert_unit semantics
    updated_unit = dict(units[0], char_count=999, visibility="hidden")
    store.upsert_units(scope, [updated_unit])
    rechecked = [u for u in store.list_units(scope) if u["unit_id"] == "pair:c0:sha0"][0]
    assert rechecked["visibility"] == "hidden"
    assert rechecked["char_count"] == 999

    # Bad batch row fails atomically with DBError without partial inserts
    with pytest.raises(DBError):
        store.upsert_units(
            scope,
            [
                {
                    "unit_id": "pair:new_ok:x",
                    "kind": "tool_result",
                    "tool_call_id": "new_ok",
                    "content_sha256": "x",
                    "char_count": 10,
                },
                {
                    "unit_id": None,  # violates NOT NULL primary key
                    "kind": "tool_result",
                },
            ],
        )
    ids = {u["unit_id"] for u in store.list_units(scope)}
    assert "pair:new_ok:x" not in ids
    store.close()


def test_hermes_middleware_step_uses_batch_upsert_units(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clear_perf()
    engine = SessionNavigationEngine(SQLiteContextStore(str(tmp_path / "hermes.sqlite3")))
    tstore = SessionTranscriptStore()
    scope = Scope("hermes", "default", "s-batch", "default")
    calls = 0
    orig_batch = engine.store.upsert_units

    def spy_batch(s: Scope, units):
        nonlocal calls
        calls += 1
        return orig_batch(s, units)

    monkeypatch.setattr(engine.store, "upsert_units", spy_batch)
    payload = {
        "messages": [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": f"c_{i}",
                        "function": {"name": "read_file", "arguments": f'{{"path":"/tmp/f{i}.txt"}}'},
                    }
                    for i in range(10)
                ],
            },
            *[
                {
                    "role": "tool",
                    "tool_call_id": f"c_{i}",
                    "name": "read_file",
                    "content": f"body {i}",
                }
                for i in range(10)
            ],
        ]
    }
    res = middleware_step(engine, tstore, scope, "chat_completions", payload)
    assert res["trace"]["found"] == 10
    assert calls == 1
    assert len(engine.store.list_units(scope)) == 10
    perf = recent_perf(5)
    ops = [entry["op"] for entry in perf]
    assert "record_request" in ops
    assert "middleware_step" in ops
    engine.store.close()


def test_hermes_diagnostics_sanitize_errors_and_never_write_stdout(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    clear_perf()
    monkeypatch.setenv("SESSION_NAVIGATION_PERF_DIAG", "verbose")
    assert sanitize_error_code(RuntimeError("sensitive body /Users/foo token=abc")) == "runtimeerror"
    entry = record_perf(
        "middleware_step",
        duration_ms=5.25,
        ok=False,
        error_code="secret user payload",
        row_count=12,
        unit_count=12,
    )
    assert entry["error_code"] == "error"
    assert set(entry.keys()).issubset(
        {"plugin", "op", "ts", "duration_ms", "ok", "error_code", "row_count", "unit_count", "byte_count", "cache_hit", "batch_size"}
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "[session-nav:perf]" in captured.err
    assert "sensitive" not in captured.err
    clear_perf()
