"""E2E persistence tests for the OMP daemon over SQLite."""
import os

import pytest

from session_navigation_omp.daemon import Daemon


def record(call_id="call-1", text=None, tool_name="read", arguments=None):
    if arguments is None:
        arguments = {"path": "sample.txt"}
    return {
        "call_id": call_id,
        "tool_name": tool_name,
        "arguments": arguments,
        "status": "ok",
        "content": text or "\n".join(f"Output row {i:03} details" for i in range(100)),
    }


def call(daemon, method, **params):
    return daemon.handle({"method": method, "params": {"session_id": "a", **params}})


def test_restart_keeps_patches(tmp_path, monkeypatch):
    db = tmp_path / "state.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    result = call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")
    assert result["ok"]

    daemon2 = Daemon()
    res = call(daemon2, "prepare", snapshot_id="two", records=[record()])
    assert res["ok"]
    assert res["patches"] and res["patches"][0]["call_id"] == "call-1"


def test_fork_carries_state(tmp_path, monkeypatch):
    db = tmp_path / "state.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    assert call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")["ok"]

    fork = daemon.handle(
        {"method": "fork_scope", "params": {"src_session_id": "a", "dst_session_id": "b"}}
    )
    assert fork["ok"]

    daemon2 = Daemon()
    res = daemon2.handle(
        {"method": "prepare", "params": {"session_id": "b", "snapshot_id": "fork", "records": [record()]}}
    )
    assert res["ok"]
    assert res["patches"] and res["patches"][0]["call_id"] == "call-1"


def test_readonly_error_and_duplicate_rejected(tmp_path, monkeypatch):
    db = tmp_path / "state.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    daemon = Daemon()
    assert not call(daemon, "prepare", snapshot_id="one", records=[{**record(), "status": "error"}])["ok"]
    assert not call(daemon, "prepare", snapshot_id="two", records=[record(), record()])["ok"]
    bash_record = {**record(), "tool_name": "bash", "arguments": {"command": "echo hi"}}
    assert call(daemon, "prepare", snapshot_id="three", records=[bash_record])["ok"]


def test_summarize_without_summary_text_unavailable(tmp_path, monkeypatch):
    db = tmp_path / "state.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    res = call(daemon, "summarize", snapshot_id="one", tool_call_id="call-1")
    assert res["error"] == "summarizer_unavailable"


def test_cas_stale_rejected(tmp_path, monkeypatch):
    db = tmp_path / "state.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(db))
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    r = call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")
    assert r["ok"]
    item_id = r["item_id"]
    version = r["version"]
    # stale restore
    res = call(daemon, "restore", item_id=item_id, expected_version=version + 999)
    assert res["ok"] is False
    assert res["error"] == "version_conflict"
