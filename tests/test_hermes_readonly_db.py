"""P0-5 + P1-7 regression tests: fail-closed middleware on DB errors, pause/resume capabilities.

P0-5: `_register_adapter` used to write before the protection-only rewrite, so
a DB exception (read-only/locked/disk-full) skipped the rewrite and the
middleware sent the original request (fail-open). Registration writes are now
guarded and the rewrite runs first; only read failures still raise loudly.

P1-7: a paused turn overwrote the registration with capabilities False; after
resume the row stayed stale with no warning. Tool/list use now refreshes the
row on resume, and the list handler warns while paused.

No live Hermes, no network. Temporary DBs only.
"""

from __future__ import annotations

import copy
import json
import os
import sqlite3
import stat

import pytest

from _adapter_loader import hermes_adapter
from session_navigation.engine import SessionNavigationEngine
from session_navigation.sqlite_store import SQLiteContextStore

adapter = hermes_adapter()


def _codex_request(body: str) -> dict:
    return {"input": [
        {"type": "function_call", "call_id": "c1", "name": "read_file",
         "arguments": json.dumps({"path": "source.txt"})},
        {"type": "function_call_output", "call_id": "c1", "output": body},
    ]}


@pytest.fixture
def flag():
    return {"enabled": True}


def setup_state(tmp_path, flag, summarizer=None):
    engine = SessionNavigationEngine(store=SQLiteContextStore(tmp_path / "s.db"))
    state = adapter.factories.PluginState(
        engine=engine, summarizer=summarizer,
        is_enabled=lambda: flag["enabled"], count_middlewares=lambda: 0)
    return state


def hide_first_result(state, session_id="s"):
    hide = adapter.factories.make_hide_handler(state)
    raw = json.loads(hide({"tool_call_id": "c1"}, session_id=session_id))
    assert raw["ok"] is True, raw
    return raw


def reopen_readonly(state, tmp_path):
    """Close the store, remount the DB file read-only, and reattach the engine."""
    state.engine.store.close()
    path = tmp_path / "s.db"
    os.chmod(path, 0o444)
    engine = SessionNavigationEngine(store=SQLiteContextStore(path))
    state.engine = engine
    return state


def test_disabled_middleware_readonly_db_still_rewrites(tmp_path, flag):
    """P0-5: paused turn on a read-only DB must redact, not send originals."""
    body = "alpha details available\n" * 200
    state = setup_state(tmp_path, flag)
    middleware = adapter.factories.make_middleware(state)
    request = _codex_request(body)
    middleware(request=request, api_mode="codex_responses", session_id="s")
    scope = adapter.factories.scope_for(state, "s")
    hide_first_result(state)
    assert state.engine.store.adapter_can(scope, "hide")

    reopen_readonly(state, tmp_path)
    assert not (stat.S_IMODE(os.stat(tmp_path / "s.db").st_mode) & stat.S_IWUSR)
    flag["enabled"] = False
    protected = middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")

    assert protected is not None
    assert protected["reason"].startswith("protection_only")
    dumped = json.dumps(protected["request"], ensure_ascii=False)
    assert body not in dumped
    assert state.db_error_pending is True
    state.engine.store.close()


def test_enabled_middleware_readonly_db_falls_back_to_protection(tmp_path, flag):
    """P0-5: enabled turn on a read-only DB must fail closed via fallback."""
    body = "alpha details available\n" * 200
    state = setup_state(tmp_path, flag)
    middleware = adapter.factories.make_middleware(state)
    request = _codex_request(body)
    middleware(request=request, api_mode="codex_responses", session_id="s")
    hide_first_result(state)

    reopen_readonly(state, tmp_path)
    response = middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")

    assert response is not None
    dumped = json.dumps(response["request"], ensure_ascii=False)
    assert body not in dumped
    assert response.get("pending") is True
    assert state.db_error_pending is True
    state.engine.store.close()


def test_enabled_middleware_survives_registration_write_failure(tmp_path, flag, monkeypatch):
    """P0-5: registration failure alone must not skip the rewrite (locked DB)."""
    body = "alpha details available\n" * 200
    state = setup_state(tmp_path, flag)
    middleware = adapter.factories.make_middleware(state)
    middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")
    hide_first_result(state)

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(state.engine.store, "register_adapter", locked)
    response = middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")

    assert response is not None
    assert json.dumps(response["request"], ensure_ascii=False).count(body) == 0
    assert state.db_error_pending is True
    state.engine.store.close()


def test_enabled_middleware_step_write_failure_uses_protection_fallback(tmp_path, flag, monkeypatch):
    """P0-5: step write failure falls back to protection-only instead of raising."""
    body = "alpha details available\n" * 200
    state = setup_state(tmp_path, flag)
    middleware = adapter.factories.make_middleware(state)
    middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")
    hide_first_result(state)

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("attempt to write a readonly database")

    monkeypatch.setattr(state.engine.store, "publish_targets", locked)
    response = middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")

    assert response is not None
    assert body not in json.dumps(response["request"], ensure_ascii=False)
    assert response.get("pending") is True
    assert state.db_error_pending is True
    state.engine.store.close()


def test_pause_turn_resume_refreshes_capabilities_with_warning(tmp_path, flag):
    """P1-7: pause -> turn -> resume heals capabilities; pause warns."""
    body = "alpha details available\n" * 200
    state = setup_state(tmp_path, flag)
    middleware = adapter.factories.make_middleware(state)
    list_items = adapter.factories.make_list_handler(state)
    middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")
    scope = adapter.factories.scope_for(state, "s")
    hide_first_result(state)
    assert state.engine.store.adapter_can(scope, "hide") is True

    # Pause: the turn redacts but revokes the stored capabilities.
    flag["enabled"] = False
    protected = middleware(request=_codex_request(body), api_mode="codex_responses", session_id="s")
    assert protected is not None
    assert protected["reason"] == "protection_only (applied 1)"
    assert state.engine.store.adapter_can(scope, "hide") is False
    paused_listed = json.loads(list_items({}, session_id="s"))
    assert paused_listed["paused"] is True
    assert "paused_warning" in paused_listed and paused_listed["paused_warning"]

    # Resume: the next list use refreshes the row instead of staying stale.
    flag["enabled"] = True
    listed = json.loads(list_items({}, session_id="s"))
    assert "paused" not in listed
    assert state.engine.store.adapter_can(scope, "hide") is True
    state.engine.store.close()
