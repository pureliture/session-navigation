"""B2 + B12 regression tests: protection-only supervision strip, list DBError,
chat_completions pause/alias parity, explicit bun skip."""

import copy
import json

import pytest

from _adapter_loader import hermes_adapter as _load_hermes_adapter
from session_navigation.model import Scope

_adapter = _load_hermes_adapter()
plugin = _adapter.plugin

class FakeCtx:
    def __init__(self, config=None, profile="default"):
        self.profile_name = profile
        self.config = dict(config or {})
        self.tools = {}
        self.middlewares = {}
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, description="", **_extra):
        self.tools[name] = {"handler": handler, "schema": schema}

    def register_middleware(self, kind, callback):
        self.middlewares.setdefault(kind, []).append(callback)


def _long_body(suffix=""):
    lines = [f"Output row {i:03d} details" for i in range(80)]
    lines.extend([
        "id: 01234567-89ab-cdef-0123-456789abcdef",
        "results/output.json generated successfully",
    ])
    if suffix:
        lines.append(suffix)
    return "\n".join(lines)


def _codex_request(body, call_id="call_1"):
    return {
        "input": [
            {"type": "function_call", "call_id": call_id, "name": "read_file",
             "arguments": json.dumps({"path": "results/output.json"})},
            {"type": "function_call_output", "call_id": call_id, "output": body},
        ]
    }


def _chat_request_with_tool(body: str, call_id: str = "call_1") -> dict:
    return {"messages": [
        {"role": "user", "content": "please read the file"},
        {"role": "assistant", "content": "calling",
         "tool_calls": [{"id": call_id, "type": "function",
                         "function": {"name": "read_file",
                                      "arguments": json.dumps({"path": "results/output.json"})}}]},
        {"role": "tool", "tool_call_id": call_id, "content": body},
    ]}


def _tool_contents(request: dict, mode: str) -> list:
    if mode == "chat_completions":
        return [m.get("content") for m in request["messages"] if m.get("role") == "tool"]
    return [item.get("output") for item in request["input"]
            if item.get("type") == "function_call_output"]


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
def test_protection_only_strips_supervision_section(mode):
    """B2: the startup-registered guidance must not steer the model while
    protection-only (tools would only answer `disabled`)."""
    from _adapter_loader import hermes_adapter as _reload
    section = _reload().schemas.SUPERVISION_SECTION_TEXT
    ctx = FakeCtx(config={"enabled": True})
    state = plugin.register(ctx)
    state.count_middlewares = lambda: 0
    mw = ctx.middlewares["llm_request"][0]

    if mode == "chat_completions":
        request = {"instructions": section,
                   "messages": [{"role": "system", "content": section},
                                {"role": "user", "content": "go"}]}
    else:
        request = {"instructions": section,
                   "input": [{"type": "message", "role": "system",
                              "content": [{"type": "input_text", "text": section}]},
                             {"type": "message", "role": "user",
                              "content": [{"type": "input_text", "text": "go"}]}]}
    snapshot = copy.deepcopy(request)
    out = mw(request=request, session_id="sess-sup-on", api_mode=mode)
    assert out is None or section in json.dumps(out.get("request", {}), ensure_ascii=False)
    assert request == snapshot

    # Protection-only: the outgoing copy loses the guidance, the original
    # request object is never mutated.
    state.is_enabled = lambda: False
    request = copy.deepcopy(snapshot)
    out = mw(request=request, session_id="sess-sup-off", api_mode=mode)
    assert out is not None
    assert out["reason"] == "protection_only (supervision disabled)"
    assert section not in json.dumps(out["request"], ensure_ascii=False)
    assert request == snapshot

    # No guidance present: pass through untouched, as before.
    if mode == "chat_completions":
        plain = {"messages": [{"role": "user", "content": "go"}]}
    else:
        plain = {"input": [{"type": "message", "role": "user",
                            "content": [{"type": "input_text", "text": "go"}]}]}
    assert mw(request=plain, session_id="sess-sup-plain", api_mode=mode) is None


def test_list_handler_reports_db_error_instead_of_throwing(tmp_path, monkeypatch):
    """B2: list_context_items must surface DBError through the pending-error
    payload instead of throwing past the db_error_pending path."""
    from session_navigation.db import DBError

    ctx = FakeCtx(config={"enabled": True})
    state = plugin.register(ctx)
    mw = ctx.middlewares["llm_request"][0]
    list_items = ctx.tools["list_context_items"]["handler"]
    compact = ctx.tools["hide_context"]["handler"]
    body = _long_body()
    sid = "sess-list-err"
    mw(request=_codex_request(body), session_id=sid, api_mode="codex_responses")
    assert json.loads(compact({"tool_call_id": "call_1"}, session_id=sid))["ok"] is True

    real_items = state.engine.store.items
    calls = {"n": 0}

    def flaky(scope):
        calls["n"] += 1
        if calls["n"] == 1:
            return real_items(scope)
        raise DBError("database is locked")

    monkeypatch.setattr(state.engine.store, "items", flaky)
    listed = json.loads(list_items({}, session_id=sid))
    assert listed["ok"] is True and listed["count"] == 1
    assert listed["db_error_pending"] is True
    assert listed["db_error_choices"] == ["abort_request", "send_original"]
    assert state.db_error_pending is False

    monkeypatch.setattr(state.engine.store, "items",
                        lambda scope: (_ for _ in ()).throw(DBError("database is locked")))
    failed = json.loads(list_items({}, session_id=sid))
    assert failed == {"ok": False, "error": "db_error", "db_error_pending": True,
                      "db_error_choices": ["abort_request", "send_original"]}
    assert state.db_error_pending is True


def test_pause_and_adapter_control_off_protect_chat_completions():
    """B12: pause/protection-only coverage for chat_completions (was codex-only)."""
    ctx = FakeCtx(config={"enabled": True})
    state = plugin.register(ctx)
    state.count_middlewares = lambda: 0
    mw = ctx.middlewares["llm_request"][0]
    hide = ctx.tools["hide_context"]["handler"]
    summarize = ctx.tools["summarize_context"]["handler"]
    manage = ctx.tools["manage_context"]["handler"]
    list_items = ctx.tools["list_context_items"]["handler"]
    unhide = ctx.tools["unhide_context"]["handler"]
    body = _long_body()
    sid = "sess-chat-ctrl"
    kwargs = dict(session_id=sid, api_mode="chat_completions")

    mw(request=_chat_request_with_tool(body), **kwargs)
    compacted = json.loads(hide({"tool_call_id": "call_1"}, session_id=sid))
    assert compacted["ok"] is True
    applied = mw(request=_chat_request_with_tool(body), **kwargs)
    contents = _tool_contents(applied["request"], "chat_completions")
    assert contents != [body] and compacted["item_id"] in contents[0]

    # Pause via the enabled toggle: redaction continues, mutations stop.
    ctx.config["enabled"] = False
    protected = mw(request=_chat_request_with_tool(body), **kwargs)
    assert protected is not None
    assert protected["reason"].startswith("protection_only")
    assert body not in json.dumps(protected["request"], ensure_ascii=False)
    assert compacted["item_id"] in _tool_contents(protected["request"], "chat_completions")[0]
    assert json.loads(hide({"tool_call_id": "call_1"}, session_id=sid)) == {"ok": False, "error": "disabled"}
    assert json.loads(summarize({"tool_call_id": "call_1"}, session_id=sid)) == {"ok": False, "error": "disabled"}
    assert json.loads(manage({"tool_call_ids": ["call_1"], "action": "hide"}, session_id=sid)) == {
        "ok": False, "error": "disabled"}
    listed = json.loads(list_items({}, session_id=sid))
    assert listed["ok"] is True and listed["compacted_count"] == 1 and listed["paused"] is True
    ctx.config["enabled"] = True

    # Pause via adapter_control: same protection contract in chat mode.
    state.engine.store.set_adapter_control("hermes", False)
    state.store._sessions.clear()
    off = mw(request=_chat_request_with_tool(body), **kwargs)
    assert off is not None
    assert off["reason"] == "protection_only (applied 1)"
    assert body not in json.dumps(off["request"], ensure_ascii=False)
    assert json.loads(hide({"tool_call_id": "call_1"}, session_id=sid)) == {"ok": False, "error": "disabled"}
    assert json.loads(unhide({"item_id": compacted["item_id"]}, session_id=sid))["ok"] is True
    state.engine.store.set_adapter_control("hermes", True)
    resumed = mw(request=_chat_request_with_tool(body), **kwargs)
    assert resumed is not None and "protection_only" not in resumed.get("reason", "")


def test_branch_alias_redacts_chat_completions():
    """B12: alias-scope redaction coverage for chat_completions (was codex-only)."""
    import hashlib
    from session_navigation.model import ContextItem, compute_invocation_digest

    body = _long_body()
    content_sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    inv = {"tool_name": "read_file", "arguments": {"path": "results/output.json"}}
    digest = compute_invocation_digest(inv)
    alias_scope = Scope(adapter_id="hermes", host_profile="default",
                        session_id="sess-chat-alias", branch_scope="default")
    alias_item_id = _adapter.factories._item_id(
        alias_scope.scope_key(), "call_1", content_sha, digest, 0)
    ctx = FakeCtx(config={"enabled": True})
    state = plugin.register(ctx)
    state.count_middlewares = lambda: 0
    state.engine.store.put(
        alias_scope,
        ContextItem(item_id=alias_item_id, tool_call_id="call_1", content_sha256=content_sha,
                    invocation_digest=digest, original=body, compacted=f"[hidden:{alias_item_id}]",
                    excerpt_lines=(), visibility="hidden", version=1, tool_name="read_file",
                    compaction_source="explicit_user_hide", invocation_snapshot=inv, result_position=0),
    )
    req = _chat_request_with_tool(body)
    msg_key, role, _idx, msg_text = _adapter.payload.message_keys("chat_completions", req)[0]
    assert state.engine.store.set_message_visibility(
        alias_scope, msg_key, kind=role,
        content_sha256=hashlib.sha256(msg_text.encode("utf-8")).hexdigest(),
        char_count=len(msg_text), visibility="hidden")["ok"] is True

    out = plugin.make_middleware(state)(request=req, session_id="sess-chat-alias",
                                        api_mode="chat_completions")
    assert out is not None
    contents = _tool_contents(out["request"], "chat_completions")
    assert contents == [f"[hidden:{alias_item_id}]"]
    assert body not in json.dumps(out["request"], ensure_ascii=False)
    assert all(m.get("role") != "user" for m in out["request"]["messages"])


def test_codex_strict_schema_parity_with_ts_hermes_history() -> None:
    """B12: TS parity half of the strict-schema test; skips loudly without bun."""
    import shutil
    import subprocess

    bun = shutil.which("bun")
    if not bun:
        pytest.skip("bun is required for TypeScript hermesHistory verification")

    proc = subprocess.run(
        [
            bun,
            "-e",
            'import { hermesFilterInvocation } from "./paseo-plugin/server/hermesHistory.ts";'
            'const a = hermesFilterInvocation("read_file", \'{"path":"src/app.py","offset":null,"limit":null}\');'
            'const b = hermesFilterInvocation("terminal", \'{"command":"ls -la","workdir":null,"timeout":null}\');'
            'const c = hermesFilterInvocation("browser_snapshot", \'{"tab_id":2,"selector":null}\');'
            'if (JSON.stringify(a?.invocation?.arguments) !== \'{"path":"src/app.py"}\') process.exit(2);'
            'if (JSON.stringify(b?.invocation?.arguments) !== \'{"command":"ls -la"}\') process.exit(3);'
            'if (JSON.stringify(c?.invocation?.arguments) !== \'{"tab_id":2}\') process.exit(4);',
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
