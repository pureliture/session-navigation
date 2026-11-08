"""Hermes TUI path: /nav text command (official; graphic widget deferred)."""

from __future__ import annotations

import copy
import os

from _adapter_loader import hermes_adapter


class FakeCtx:
    def __init__(self, profile="default", config=None):
        self.profile_name = profile
        self.config = dict(config or {})
        self.tools = {}
        self.middlewares = {}
        self.commands = {}

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, description="", **_extra):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}

    def register_middleware(self, kind, callback):
        self.middlewares.setdefault(kind, []).append(callback)

    def register_command(self, name, handler, description="", args_hint="", **_extra):
        self.commands[name] = handler
        return name


def _seeded_session_id():
    return "sess-cmd"


def _seed(ctx):
    mw = ctx.middlewares["llm_request"][0]
    lines = ["Output row %03d details" % i for i in range(80)]
    lines.extend(["id: 01234567-89ab-cdef-0123-456789abcdef", "results/output.json generated successfully"])
    body = "\n".join(lines)
    req = {"input": [
        {"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": '{"path":"results/output.json"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": body},
    ]}
    mw(**{
        "request": req,
        "original_request": copy.deepcopy(req),
        "telemetry_schema_version": "t",
        "middleware_schema_version": "m",
        "task_id": "task-1",
        "session_id": _seeded_session_id(),
        "turn_id": "turn-1",
        "api_request_id": "req-1",
        "provider": "foundry",
        "model": "m",
        "api_mode": "codex_responses",
    })
    ctx.tools["hide_context"]["handler"]({"tool_call_id": "call_1"}, session_id=_seeded_session_id())
    os.environ["HERMES_SESSION_ID"] = _seeded_session_id()


def _register():
    adapter = hermes_adapter()
    ctx = FakeCtx(config={"enabled": True})
    adapter.plugin.register(ctx)
    return ctx


def test_nav_registered_and_output_shape(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))
    ctx = _register()
    assert "nav" in ctx.commands
    out = ctx.commands["nav"]("")
    assert isinstance(out, str)
    assert "Session navigation items" in out
    assert "Hints:" in out
    assert "hide" in out
    assert "unhide" in out
    assert "manage" in out


def test_nav_lists_seeded_rows(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))
    ctx = _register()
    _seed(ctx)
    out = ctx.commands["nav"](_seeded_session_id())
    assert isinstance(out, str)
    assert "items (1)" in out


def test_nav_hide_unhide_rehide_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))
    ctx = _register()
    sid = _seeded_session_id()
    # Record a transmission without hiding yet.
    mw = ctx.middlewares["llm_request"][0]
    lines = ["Output row %03d details" % i for i in range(80)]
    lines.extend(["id: 01234567-89ab-cdef-0123-456789abcdef", "results/output.json generated successfully"])
    body = "\n".join(lines)
    req = {"input": [
        {"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": '{"path":"results/output.json"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": body},
    ]}
    import copy as _copy
    mw(**{"request": req, "original_request": _copy.deepcopy(req), "session_id": sid, "api_mode": "codex_responses"})
    os.environ["HERMES_SESSION_ID"] = sid
    # Hide via /nav itself.
    out = ctx.commands["nav"](f"hide call_1 {sid}")
    assert "hidden" in out.lower() and "failed" not in out.lower(), out
    listed = ctx.commands["nav"](sid)
    assert "items (1)" in listed and "[hidden]" in listed, listed
    assert "call_1" in listed and "item_" in listed
    # Unhide by displayed number with CAS; version must advance.
    out = ctx.commands["nav"](f"unhide 1 {sid}")
    assert "unhidden" in out.lower(), out
    assert "(v2)" in out, out
    assert "[visible]" in ctx.commands["nav"](sid)
    # Rehide by number; hidden again with version 3.
    out = ctx.commands["nav"](f"rehide 1 {sid}")
    assert "re-hidden" in out.lower(), out
    listed = ctx.commands["nav"](sid)
    assert "[hidden]" in listed and "version=3" in listed, listed


def test_nav_manage_reports_counts(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))
    ctx = _register()
    _seed(ctx)
    sid = _seeded_session_id()
    # Unhide first so manage has a visible row to re-hide.
    ctx.commands["nav"](f"unhide 1 {sid}")
    out = ctx.commands["nav"](f"manage auto {sid}")
    assert "applied" in out.lower(), out
    assert "[hidden]" in ctx.commands["nav"](sid)
