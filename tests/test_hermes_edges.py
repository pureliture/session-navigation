"""S5 synthetic tests: edge conditions and the summarizer-path decision.

No live Hermes, no network. Covers compression rotation, subagent
isolation, session/engine expiry, disabled toggle, and documents the
rule-only first-version decision with a direct assertion.
"""

from __future__ import annotations
import pytest
import os, tempfile

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from _adapter_loader import hermes_adapter as _load_hermes_adapter
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope
from session_navigation.store import MemoryContextStore

_adapter = _load_hermes_adapter()
plugin = _adapter.plugin
handlers = _adapter.handlers
_session_mod = _adapter.session
SessionTranscriptStore = _session_mod.SessionTranscriptStore


def _long_body(suffix: str = "") -> str:
    lines = [f"Output row {i:03d} details" for i in range(80)]
    lines.extend([
        "id: 01234567-89ab-cdef-0123-456789abcdef",
        "results/output.json generated successfully",
    ])
    if suffix:
        lines.append(suffix)
    return "\n".join(lines)


def _codex_request(body: str, call_id: str = "call_1") -> dict:
    return {
        "input": [
            {"type": "function_call", "call_id": call_id, "name": "read_file",
             "arguments": json.dumps({"path": "results/output.json"})},
            {"type": "function_call_output", "call_id": call_id, "output": body},
        ]
    }


class FakeCtx:
    def __init__(self, config: dict | None = None, profile: str = "default"):
        self.profile_name = profile
        self.config = dict(config or {})
        self.tools: dict[str, dict] = {}
        self.middlewares: dict[str, list] = {}
        self.hooks: dict[str, object] = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def get_config(self, key: str, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, description="", **_extra):
        self.tools[name] = {"handler": handler, "schema": schema}

    def register_middleware(self, kind, callback):
        self.middlewares.setdefault(kind, []).append(callback)


def _enabled_pair(**overrides):
    ctx = FakeCtx(config={"enabled": True, **overrides})
    state = plugin.register(ctx)
    return ctx, state


def _mw(state, body: str, session: str, call_id: str = "call_1") -> dict:
    mw = plugin.make_middleware(state)
    return mw(request=_codex_request(body, call_id), session_id=session,
              api_mode="codex_responses")



@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))

def test_compression_rotation_starts_fresh_scope():
    ctx, state = _enabled_pair()
    compact = ctx.tools["hide_context"]["handler"]
    restore = ctx.tools["unhide_context"]["handler"]
    body = _long_body()

    _mw(state, body, "sess-before")
    before_item = json.loads(compact({"tool_call_id": "call_1"},
                                   session_id="sess-before"))["item_id"]

    # Compression rotated the session id: the old compacted state does NOT
    # carry over, so the new scope's request passes the original body.
    rotated = _mw(state, body, "sess-after")
    assert rotated["request"]["input"][1]["output"] == body

    # The new scope manages its own independent compacted set.
    after_item = json.loads(compact({"tool_call_id": "call_1"},
                                  session_id="sess-after"))["item_id"]
    assert after_item != before_item
    assert _mw(state, body, "sess-after")["request"]["input"][1][
        "output"] != body

    # Unhiding the old scope leaves the new scope compacted (isolation).
    restore_result = json.loads(restore({"item_id": before_item},
                                       session_id="sess-before"))
    assert restore_result["ok"] is True
    assert _mw(state, body, "sess-before")["request"]["input"][1][
        "output"] == body
    assert _mw(state, body, "sess-after")["request"]["input"][1][
        "output"] != body


def test_subagent_scopes_are_managed_and_linked_but_isolated():
    ctx, state = _enabled_pair()
    compact = ctx.tools["hide_context"]["handler"]
    body = _long_body()

    _mw(state, body, "sess-parent")
    parent_item = json.loads(compact({"tool_call_id": "call_1"},
                                   session_id="sess-parent"))["item_id"]

    ctx.middlewares["tool_request"][0](tool_name="delegate_task", tool_call_id="delegate", session_id="sess-parent")
    ctx.hooks["subagent_start"](parent_session_id="sess-parent", child_session_id="sess-child", child_subagent_id="sa-child")
    child = _mw(state, body, "sess-child")
    assert child["request"]["input"][1]["output"] == body
    rows = state.engine.store.child_scopes("hermes:default:sess-parent:unknown")
    assert len(rows) == 1
    assert rows[0]["scope_key"] == "hermes:default:sess-child:unknown"
    assert rows[0]["tool_call_id"] == "delegate"
    assert rows[0]["subagent_id"] == "sa-child"

    # Each scope compacts its own copy under its own item id.
    child_item = json.loads(compact({"tool_call_id": "call_1"},
                                  session_id="sess-child"))["item_id"]
    assert child_item != parent_item

    parent = _mw(state, body, "sess-parent")
    assert parent["request"]["input"][1]["output"] != body


def test_delegation_context_isolated_across_concurrent_batch_and_nested_children():
    ctx, state = _enabled_pair()
    capture = ctx.middlewares["tool_request"][0]
    start = ctx.hooks["subagent_start"]
    def batch(index):
        capture(tool_name="delegate_task", tool_call_id=f"call-{index}", session_id=f"parent-{index}")
        contexts = [copy_context() for _ in range(2)]
        for child, context in enumerate(contexts):
            context.run(start, parent_session_id=f"parent-{index}",
                child_session_id=f"child-{index}-{child}", child_subagent_id=f"sa-{index}-{child}")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(batch, range(4)))
    for index in range(4):
        rows = state.engine.store.child_scopes(f"hermes:default:parent-{index}:unknown")
        assert len(rows) == 2
        assert {row["tool_call_id"] for row in rows} == {f"call-{index}"}
    capture(tool_name="delegate_task", tool_call_id="nested", session_id="child-0-0")
    start(parent_session_id="child-0-0", child_session_id="grandchild", child_subagent_id="sa-nested")
    assert state.engine.store.child_scopes("hermes:default:child-0-0:unknown")[0]["tool_call_id"] == "nested"
    start(parent_session_id="unrelated", child_session_id="unbound", child_subagent_id="sa-unbound")
    assert state.engine.store.child_scopes("hermes:default:unrelated:unknown")[0]["tool_call_id"] is None


@pytest.mark.parametrize("mode", ["chat_completions", "codex_responses"])
@pytest.mark.parametrize("enabled", [True, False])
def test_child_requests_have_no_navigation_tools_guidance_or_reminders(mode, enabled):
    ctx, state = _enabled_pair()
    state.is_enabled = lambda: enabled
    ctx.hooks["subagent_start"](parent_session_id="parent", child_session_id="child", child_subagent_id="sa")
    SUPERVISION_SECTION_TEXT = _adapter.schemas.SUPERVISION_SECTION_TEXT
    request = {"tools": [{"type": "function", "function": {"name": "manage_context"}},
                         {"type": "function", "name": "hide_context"},
                         {"type": "function", "function": {"name": "read_file"}}],
               "instructions": SUPERVISION_SECTION_TEXT,
               "messages": [{"role": "system", "content": SUPERVISION_SECTION_TEXT}, {"role": "user", "content": "go"}],
               "input": [{"role": "user", "content": "go"}]}
    original = copy.deepcopy(request)
    state.reminders.note = lambda *args: (_ for _ in ()).throw(AssertionError("child reminder"))
    result = plugin.make_middleware(state)(request=request, session_id="child", api_mode=mode)
    assert request == original
    assert len(result["request"]["tools"]) == 1
    assert result["request"]["instructions"] == ""
    assert result["request"]["messages"][0]["content"] == ""
    assert len(result["request"]["messages"]) == 2


def test_session_expiry_forgets_quiet_scopes():
    # Every new request refreshes the "last transmission" record, so
    # expiry only bites after silence: a late compact finds nothing, while
    # a fresh request re-records and compacting works again.
    now = [1000.0]
    store = SessionTranscriptStore(ttl_seconds=60, time_func=lambda: now[0])
    state = plugin.PluginState(store=store,
                               is_enabled=lambda: True,
                               count_middlewares=lambda: 0)  # sole middleware
    scope = plugin.scope_for(state, "sess-ttl")
    assert scope is not None
    body = _long_body()

    handlers.middleware_step(state.engine, store, scope, "codex_responses",
                             _codex_request(body))
    assert handlers.compact(state.engine, store, scope, "call_1").ok is True

    now[0] += 61.0
    # Silence longer than the TTL: the tool path finds no record.
    assert store.entries(scope.scope_key()) == []
    late = handlers.compact(state.engine, store, scope, "call_1")
    assert late.ok is False and late.error == "not_found"

    # A new request re-records, so compacting works again on the fresh entry.
    handlers.middleware_step(state.engine, store, scope, "codex_responses",
                             _codex_request(body))
    assert handlers.compact(state.engine, store, scope, "call_1").ok is True



def test_disable_returns_to_original_and_reenable_applies():
    ctx = FakeCtx(config={"enabled": True})
    state = plugin.register(ctx)
    mw = ctx.middlewares["llm_request"][0]
    compact = ctx.tools["hide_context"]["handler"]
    body = _long_body()
    kwargs = dict(session_id="sess-toggle", api_mode="codex_responses")

    mw(request=_codex_request(body), **kwargs)
    assert json.loads(compact({"tool_call_id": "call_1"},
                            session_id="sess-toggle"))["ok"] is True
    applied = mw(request=_codex_request(body), **kwargs)
    assert applied["request"]["input"][1]["output"] != body

    ctx.config["enabled"] = False
    assert mw(request=_codex_request(body), **kwargs) is None
    untouched = _codex_request(body)
    snapshot = copy.deepcopy(untouched)
    assert mw(request=untouched, **kwargs) is None
    assert untouched == snapshot

    ctx.config["enabled"] = True
    again = mw(request=_codex_request(body), **kwargs)
    assert again["request"]["input"][1]["output"] != body


def test_first_version_is_rule_only_no_external_call():
    ctx, state = _enabled_pair()
    compact = ctx.tools["hide_context"]["handler"]
    list_items = ctx.tools["list_context_items"]["handler"]
    body = _long_body()

    plugin.make_middleware(state)(request=_codex_request(body),
                                  session_id="sess-rule",
                                  api_mode="codex_responses")
    assert json.loads(compact({"tool_call_id": "call_1"},
                            session_id="sess-rule"))["ok"] is True
    listed = json.loads(list_items({}, session_id="sess-rule"))
    assert listed["count"] == 1
    assert listed["items"][0]["source"] == "rule"


def test_default_middleware_counter_degrades_to_no_others() -> None:
    # Outside a Hermes process the lazy host import fails and must fall
    # back to 0 ("no evidence of others") instead of raising.
    assert plugin._default_count_llm_middlewares() == 0


def test_allowlist_single_definition_and_safety_invariants() -> None:
    allowlist = _adapter.allowlist
    AdapterRejected = allowlist.AdapterRejected
    filter_invocation = allowlist.filter_invocation

    assert allowlist.ALLOWED_TOOLS == tuple(allowlist.FIELDS)

    for tool in ("hide_context", "summarize_context", "list_context_items", "unhide_context", "manage_context"):
        with pytest.raises(AdapterRejected) as exc:
            filter_invocation(tool, {"tool_call_id": "c1"})
        assert exc.value.code == "internal_target"

    for tool in ("write_file", "patch", "edit_file", "evil_tool", "mcp__brain__delete", "mcp_write_file", "mcp__github__create_issue"):
        with pytest.raises(AdapterRejected) as exc:
            filter_invocation(tool, {"path": "a.txt"})
        assert exc.value.code == "unsupported_tool"

    for flag in ("background", "pty", "persist_on_release", "notify"):
        for val in (True, 1, "yes"):
            with pytest.raises(AdapterRejected) as exc:
                filter_invocation("terminal", {"command": "ls", flag: val})
            assert exc.value.code == "unsupported_arguments"

    for bad_timeout in (0, -1, "30", True, 1.5):
        with pytest.raises(AdapterRejected) as exc:
            filter_invocation("terminal", {"command": "ls", "timeout": bad_timeout})
        assert exc.value.code == "unsupported_arguments"

    for bad_tool, bad_args in (
        ("", {}),
        ("   ", {}),
        ("read_file", "not-json{"),
        ("read_file", '{"path":"a.txt","x":NaN}'),
        ("read_file", ["not", "a", "dict"]),
        ("read_file", {"path": "   "}),
        ("read_file", {"path": "a.txt", "offset": 0}),
        ("read_file", {"path": "a.txt", "limit": True}),
        ("search_files", {"pattern": ""}),
        ("web_search", {"query": "  "}),
        ("web_extract", {}),
        ("web_extract", {"urls": []}),
        ("web_extract", {"url": "https://a.com", "urls": []}),
        ("execute_code", {"code": ""}),
        ("vision_analyze", {"prompt": "describe"}),
        ("skill_view", {"name": ""}),
        ("tool_describe", {"name": 123}),
        ("tool_describe", {"names": ["ok", 99]}),
        ("browser_snapshot", {"browserId": 42}),
    ):
        with pytest.raises(AdapterRejected) as exc:
            filter_invocation(bad_tool, bad_args)
        assert exc.value.code == "invalid_invocation", (bad_tool, bad_args)


def test_allowlist_permissive_options_omitted_and_extended_tools() -> None:
    allowlist = _adapter.allowlist
    filter_invocation = allowlist.filter_invocation

    # search_files: defaults ignored, non-default options placed in omitted
    inv_default, om_default = filter_invocation(
        "search_files",
        {"pattern": "Router", "target": "content", "path": "src", "file_glob": "*.py",
         "limit": 50, "offset": 0, "order": "discovery", "output_mode": "content",
         "context": 0, "case_insensitive": False},
    )
    assert inv_default == {
        "tool_name": "search_files",
        "arguments": {"file_glob": "*.py", "path": "src", "pattern": "Router", "target": "content"},
    }
    assert om_default == {}

    inv_custom, om_custom = filter_invocation(
        "search_files",
        {"pattern": "Router", "limit": 100, "offset": 10, "context": 3,
         "order": "mtime", "output_mode": "files_with_matches", "case_insensitive": True},
    )
    assert inv_custom == {"tool_name": "search_files", "arguments": {"pattern": "Router"}}
    assert om_custom == {
        "case_insensitive": True, "context": 3, "limit": 100,
        "offset": 10, "order": "mtime", "output_mode": "files_with_matches",
    }

    # read_file & terminal extra options
    inv_rf, om_rf = filter_invocation("read_file", {"path": "a.py", "offset": 1, "limit": 50, "encoding": "utf-8", "line_numbers": True})
    assert inv_rf == {"tool_name": "read_file", "arguments": {"limit": 50, "offset": 1, "path": "a.py"}}
    assert om_rf == {"encoding": "utf-8", "line_numbers": True}

    inv_term, om_term = filter_invocation(
        "terminal",
        {"command": "pytest", "workdir": "/app", "background": False, "pty": False,
         "persist_on_release": False, "notify": False, "heartbeat": 0, "timeout": 30, "label": "tests"},
    )
    assert inv_term == {"tool_name": "terminal", "arguments": {"command": "pytest", "workdir": "/app"}}
    assert om_term == {"label": "tests", "timeout": 30}

    # Extended tools
    assert filter_invocation("web_search", {"query": "hermes", "num_results": 5}) == (
        {"tool_name": "web_search", "arguments": {"query": "hermes"}}, {"num_results": 5},
    )
    assert filter_invocation("web_extract", {"urls": ["https://a.com", "https://b.com"], "format": "markdown"}) == (
        {"tool_name": "web_extract", "arguments": {"urls": ["https://a.com", "https://b.com"]}}, {"format": "markdown"},
    )
    assert filter_invocation("execute_code", {"code": "print(1)", "language": "python", "timeout": 10}) == (
        {"tool_name": "execute_code", "arguments": {"code": "print(1)", "language": "python"}}, {"timeout": 10},
    )
    assert filter_invocation("vision_analyze", {"image_path": "shot.png", "prompt": "describe"}) == (
        {"tool_name": "vision_analyze", "arguments": {"image_path": "shot.png"}}, {"prompt": "describe"},
    )
    assert filter_invocation("skill_view", {"name": "debug"}) == (
        {"tool_name": "skill_view", "arguments": {"name": "debug"}}, {},
    )
    assert filter_invocation("tool_describe", {}) == ({"tool_name": "tool_describe", "arguments": {}}, {})
    assert filter_invocation("tool_describe", {"names": ["read_file", "search_files"], "verbose": True}) == (
        {"tool_name": "tool_describe", "arguments": {"names": ["read_file", "search_files"]}}, {"verbose": True},
    )

    inspection_tools = (
        "browser_snapshot", "browser_console", "browser_logs", "browser_vision", "browser_list_tabs",
        "get_agent_activity", "get_agent_status", "list_agents", "list_workspaces", "list_hosts",
        "list_models", "list_providers", "list_profiles", "inspect_provider",
        "list_terminals", "capture_terminal", "list_schedules", "inspect_schedule", "schedule_logs",
        "memory_authority_pack_read", "brain_memory_search", "brain_context_resolve",
    )
    for tool in inspection_tools:
        assert filter_invocation(tool, {}) == ({"tool_name": tool, "arguments": {}}, {})

    assert filter_invocation("browser_snapshot", {"browserId": "b1", "selector": "#app", "fullPage": True}) == (
        {"tool_name": "browser_snapshot", "arguments": {"browserId": "b1", "selector": "#app"}}, {"fullPage": True},
    )
    assert filter_invocation("mcp__brain__query", {"z": [1, {"b": 2, "a": 1}], "a": "x", "flag": True}) == (
        {"tool_name": "mcp__brain__query", "arguments": {"a": "x", "flag": True, "z": [1, {"a": 1, "b": 2}]}}, {},
    )
    assert filter_invocation("mcp_read_status", {"id": "s1"}) == (
        {"tool_name": "mcp_read_status", "arguments": {"id": "s1"}}, {},
    )


def test_search_files_non_default_options_set_invocation_options_omitted(tmp_path) -> None:
    from types import SimpleNamespace

    ctx = FakeCtx(config={"enabled": True})
    ctx.llm = SimpleNamespace(complete=lambda **_kw: SimpleNamespace(
        text=json.dumps({"summary": "Output row details for Router match."})
    ))
    state = plugin.register(ctx)
    body = _long_body()
    req = {
        "input": [
            {"type": "function_call", "call_id": "call_sf", "name": "search_files",
             "arguments": json.dumps({"pattern": "Router", "limit": 100, "context": 3})},
            {"type": "function_call_output", "call_id": "call_sf", "output": body},
        ]
    }
    plugin.make_middleware(state)(request=req, session_id="sess-sf", api_mode="codex_responses")
    res = json.loads(ctx.tools["summarize_context"]["handler"]({"tool_call_id": "call_sf"}, session_id="sess-sf"))
    assert res["ok"] is True
    scope = plugin.scope_for(state, "sess-sf")
    assert scope is not None
    item = state.engine.store.get(scope, res["item_id"])
    assert item is not None
    assert item.invocation_options_omitted is True


def test_python_ts_allowlist_parity_and_hermes_history_budget(tmp_path) -> None:
    import shutil
    import subprocess
    from pathlib import Path

    bun = shutil.which("bun")
    if not bun:
        pytest.skip("bun is required for TypeScript hermesHistory verification")

    repo = Path(__file__).resolve().parents[1]
    allowlist = _adapter.allowlist

    cases = [
        ("search_files", {"pattern": "Router", "limit": 100, "context": 3, "offset": 0}),
        ("search_files", {"pattern": "Router", "limit": 50, "case_insensitive": False}),
        ("read_file", {"path": "a.py", "offset": 1, "limit": 20, "encoding": "utf-8"}),
        ("terminal", {"command": "pytest", "workdir": "/app", "timeout": 30, "background": False}),
        ("terminal", {"command": "sleep 5", "background": True}),
        ("terminal", {"command": "ls", "timeout": 0}),
        ("web_search", {"query": "session nav", "top_k": 5}),
        ("web_extract", {"urls": ["https://example.com"], "depth": "basic"}),
        ("execute_code", {"code": "1+1", "language": "python", "sandbox": True}),
        ("vision_analyze", {"url": "https://img/a.png", "prompt": "read"}),
        ("skill_view", {"name": "debug"}),
        ("tool_describe", {"names": ["read_file"], "full": True}),
        ("browser_snapshot", {"browserId": "b1", "full": True}),
        ("memory_authority_pack_read", {"pack_id": "p1", "verbose": True}),
        ("mcp__brain__query", {"z": [1, {"b": 2, "a": 1}], "a": "ok"}),
        ("mcp__brain__delete", {"id": "1"}),
        ("write_file", {"path": "x.txt", "content": "hi"}),
        ("hide_context", {"tool_call_id": "c1"}),
    ]
    py_expected = []
    for name, args in cases:
        try:
            inv, om = allowlist.filter_invocation(name, args)
            entry = {"invocation": inv}
            if om:
                entry["omitted"] = om
            py_expected.append(entry)
        except allowlist.AdapterRejected:
            py_expected.append(None)

    script = f"""
import {{ DatabaseSync }} from "node:sqlite";
import {{ mkdirSync }} from "node:fs";
import {{ join }} from "node:path";
import {{ hermesFilterInvocation, loadHermesTimeline }} from {json.dumps(str(repo / "paseo-plugin/server/hermesHistory.ts"))};

const cases = {json.dumps(cases)};
const expected = {json.dumps(py_expected)};
const actual = cases.map(([name, args]) => hermesFilterInvocation(name, args));
if (JSON.stringify(actual) !== JSON.stringify(expected)) {{
  console.error("PARITY_MISMATCH", JSON.stringify({{ actual, expected }}));
  process.exit(1);
}}

// Verify 5000 / 32 MiB newest-first cap & recordsCapped=true
const home = {json.dumps(str(tmp_path / "home"))};
mkdirSync(join(home, ".hermes"), {{ recursive: true }});
const db = new DatabaseSync(join(home, ".hermes/state.db"));
db.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    codex_message_items TEXT,
    api_content TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0
  );
`);
const insSess = db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)");
const insMsg = db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?, ?)");

// Case A: 5005 tools -> newest 5000 stay manageable, oldest 5 capped out
insSess.run("s-count", "{{}}");
for (let i = 0; i < 5005; i++) {{
  const cid = "c_" + i;
  insMsg.run("s-count", "assistant", "", null, JSON.stringify([{{ id: cid, type: "function", function: {{ name: "read_file", arguments: '{{"path":"f.txt"}}' }} }}]), null);
  insMsg.run("s-count", "tool", "out " + i, cid, null, "read_file");
}}
const tlCount = loadHermesTimeline(home, "hermes:default:s-count:unknown");
if (!tlCount || tlCount.records.size !== 5000 || tlCount.history.recordsCapped !== true) {{
  console.error("COUNT_CAP_FAIL", tlCount?.records.size, tlCount?.history.recordsCapped);
  process.exit(2);
}}
if (tlCount.rows[0].manageable !== false || tlCount.rows.at(-1).manageable !== true) {{
  console.error("NEWEST_FIRST_FAIL", tlCount.rows[0].manageable, tlCount.rows.at(-1).manageable);
  process.exit(3);
}}

// Case B: two 17 MiB tools -> only newest fits in 32 MiB budget
insSess.run("s-bytes", "{{}}");
const big = "x".repeat(17 * 1024 * 1024);
for (const cid of ["old_big", "new_big"]) {{
  insMsg.run("s-bytes", "assistant", "", null, JSON.stringify([{{ id: cid, type: "function", function: {{ name: "read_file", arguments: '{{"path":"big.txt"}}' }} }}]), null);
  insMsg.run("s-bytes", "tool", big, cid, null, "read_file");
}}
const tlBytes = loadHermesTimeline(home, "hermes:default:s-bytes:unknown");
if (!tlBytes || tlBytes.records.has("old_big") || !tlBytes.records.has("new_big") || tlBytes.history.recordsCapped !== true) {{
  console.error("BYTES_CAP_FAIL", tlBytes?.records.has("old_big"), tlBytes?.records.has("new_big"), tlBytes?.history.recordsCapped);
  process.exit(4);
}}
db.close();
"""
    proc = subprocess.run([bun, "-e", script], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_codex_strict_schema_null_optional_args_and_integer_ids_parity() -> None:
    import shutil, subprocess
    filter_invocation = _adapter.allowlist.filter_invocation

    # Codex strict tool schemas emit explicit null for omitted optional parameters
    inv_rf, om_rf = filter_invocation("read_file", '{"path": "src/app.py", "offset": null, "limit": null}')
    assert inv_rf == {"tool_name": "read_file", "arguments": {"path": "src/app.py"}} and om_rf == {}
    inv_tm, om_tm = filter_invocation("terminal", '{"command": "ls -la", "workdir": null, "timeout": null}')
    assert inv_tm == {"tool_name": "terminal", "arguments": {"command": "ls -la"}} and om_tm == {}
    inv_bs, om_bs = filter_invocation("browser_snapshot", '{"tab_id": 2, "selector": null}')
    assert inv_bs == {"tool_name": "browser_snapshot", "arguments": {"tab_id": 2}} and om_bs == {}

    bun = shutil.which("bun")
    if bun:
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


def test_python_payload_ts_hermes_history_message_key_parity_both_modes(tmp_path) -> None:
    import shutil
    import subprocess
    from pathlib import Path

    bun = shutil.which("bun")
    if not bun:
        pytest.skip("bun is required for TypeScript hermesHistory verification")

    repo = Path(__file__).resolve().parents[1]
    payload_mod = _adapter.payload

    chat_payload = {
        "messages": [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Run status check"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_chat_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path":"a.txt"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": " call_chat_1 ", "content": "contents of a.txt"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_chat_2",
                        "type": "function",
                        "function": {"name": "terminal", "arguments": '{"command":"ls"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_chat_2", "content": "file1\nfile2"},
            {"role": "assistant", "content": "Both checks finished."},
            {"role": "user", "content": "Thanks!"},
        ]
    }
    chat_expected = [key for key, _role, _idx, text in payload_mod.message_keys("chat_completions", chat_payload) if text.strip()]

    codex_payload = {
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Inspect pods"}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Running kubectl"}]},
            {"type": "function_call", "call_id": "call_cx_1", "name": "terminal", "arguments": '{"command":"kubectl get pods"}'},
            {"type": "function_call_output", "call_id": " call_cx_1 ", "output": "pod-1 Running"},
            {"type": "function_call", "call_id": "call_cx_2", "name": "read_file", "arguments": '{"path":"b.txt"}'},
            {"type": "function_call_output", "call_id": "call_cx_2", "output": "b-body"},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Pods are healthy."}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Great"}]},
        ]
    }
    codex_expected = [key for key, _role, _idx, text in payload_mod.message_keys("codex_responses", codex_payload) if text.strip()]

    script = f"""
import {{ DatabaseSync }} from "node:sqlite";
import {{ mkdirSync }} from "node:fs";
import {{ join }} from "node:path";
import {{ loadHermesTimeline }} from {json.dumps(str(repo / "paseo-plugin/server/hermesHistory.ts"))};

const home = {json.dumps(str(tmp_path / "parity-home"))};
mkdirSync(join(home, ".hermes"), {{ recursive: true }});
const db = new DatabaseSync(join(home, ".hermes/state.db"));
db.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    codex_message_items TEXT,
    api_content TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0
  );
`);
const insSess = db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)");
const insMsg = db.prepare(`
  INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, codex_message_items, api_content)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// 1. chat_completions with empty-string and null-content tool_calls assistant rows + trimmed call_id
insSess.run("s-chat", JSON.stringify({{ gateway_runtime: {{ api_mode: "chat_completions" }} }}));
insMsg.run("s-chat", "user", "Run status check", null, null, null, null, null);
insMsg.run("s-chat", "assistant", "", null, JSON.stringify([{{ id: "call_chat_1", type: "function", function: {{ name: "read_file", arguments: '{{"path":"a.txt"}}' }} }}]), null, null, null);
insMsg.run("s-chat", "tool", "contents of a.txt", " call_chat_1 ", null, "read_file", null, null);
insMsg.run("s-chat", "assistant", null, null, JSON.stringify([{{ id: "call_chat_2", type: "function", function: {{ name: "terminal", arguments: '{{"command":"ls"}}' }} }}]), null, null, null);
insMsg.run("s-chat", "tool", "file1\\nfile2", "call_chat_2", null, "terminal", null, null);
insMsg.run("s-chat", "assistant", "Both checks finished.", null, null, null, null, null);
insMsg.run("s-chat", "user", "Thanks!", null, null, null, null, null);

const tlChat = loadHermesTimeline(home, "hermes:default:s-chat:unknown");
if (!tlChat) throw new Error("missing chat timeline");
const chatActual = tlChat.rows.filter((r) => r.kind === "user" || r.kind === "assistant").map((r) => r.item_id);
const chatExpected = {json.dumps(chat_expected)};
if (JSON.stringify(chatActual) !== JSON.stringify(chatExpected)) {{
  console.error("CHAT_PARITY_MISMATCH", JSON.stringify({{ chatActual, chatExpected }}));
  process.exit(1);
}}
const trimmedTool = tlChat.rows.find((r) => r.tool_call_id === "call_chat_1");
if (!trimmedTool || !trimmedTool.manageable || !tlChat.records.has("call_chat_1")) {{
  console.error("TRIM_CALL_ID_FAIL", trimmedTool);
  process.exit(2);
}}

// 2. codex_responses with codex_message_items and tool-only assistant row without message item
insSess.run("s-codex", JSON.stringify({{ gateway_runtime: {{ api_mode: "codex_responses" }} }}));
insMsg.run("s-codex", "user", "Inspect pods", null, null, null, null, "Inspect pods");
insMsg.run(
  "s-codex",
  "assistant",
  "",
  null,
  JSON.stringify([{{ call_id: "call_cx_1", type: "function", function: {{ name: "terminal", arguments: '{{"command":"kubectl get pods"}}' }} }}]),
  null,
  JSON.stringify([{{ type: "message", role: "assistant", content: [{{ type: "output_text", text: "Running kubectl" }}] }}]),
  null,
);
insMsg.run("s-codex", "tool", "pod-1 Running", " call_cx_1 ", null, "terminal", null, null);
insMsg.run(
  "s-codex",
  "assistant",
  "",
  null,
  JSON.stringify([{{ call_id: "call_cx_2", type: "function", function: {{ name: "read_file", arguments: '{{"path":"b.txt"}}' }} }}]),
  null,
  null,
  null,
);
insMsg.run("s-codex", "tool", "b-body", "call_cx_2", null, "read_file", null, null);
insMsg.run("s-codex", "assistant", "Pods are healthy.", null, null, null, null, null);
insMsg.run("s-codex", "user", "Great", null, null, null, null, "Great");

const tlCodex = loadHermesTimeline(home, "hermes:default:s-codex:unknown");
if (!tlCodex) throw new Error("missing codex timeline");
const codexActual = tlCodex.rows.filter((r) => r.kind === "user" || r.kind === "assistant").map((r) => r.item_id);
const codexExpected = {json.dumps(codex_expected)};
if (JSON.stringify(codexActual) !== JSON.stringify(codexExpected)) {{
  console.error("CODEX_PARITY_MISMATCH", JSON.stringify({{ codexActual, codexExpected }}));
  process.exit(3);
}}
db.close();
"""
    proc = subprocess.run([bun, "-e", script], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
