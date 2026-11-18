import copy
from dataclasses import replace
import json

import pytest

from _adapter_loader import hermes_adapter
from session_navigation.engine import SessionNavigationEngine
from session_navigation.pending_summary import settle_summary
from session_navigation.sqlite_store import SQLiteContextStore

adapter = hermes_adapter()


def setup_state(tmp_path, summarizer=None):
    engine = SessionNavigationEngine(store=SQLiteContextStore(tmp_path / "s.db"))
    state = adapter.factories.PluginState(engine=engine, summarizer=summarizer,
        is_enabled=lambda: True, count_middlewares=lambda: 0)
    body = "alpha details available\n" * 200
    request = {"input": [
        {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": json.dumps({"path": "source.txt"})},
        {"type": "function_call_output", "call_id": "c1", "output": body}]}
    kwargs = {"request": request, "api_mode": "codex_responses", "session_id": "s"}
    return state, kwargs, adapter.factories.scope_for(state, "s")


def pending(state, scope):
    entry = state.store.entries(scope.scope_key())[0]
    record = state.engine.store.adapter_targets(scope)[0]
    from session_navigation.model import ToolResultRecord
    result = state.engine.compact_sync(scope, ToolResultRecord(entry.call_id,
        content=entry.content, content_sha256=entry.content_sha256,
        invocation=json.loads(record["invocation_snapshot"]), invocation_digest=record["invocation_digest"]))
    assert result.ok, result.error
    item = replace(result.item, compaction_source="summarize_pending", invocation_snapshot=json.loads(record["invocation_snapshot"]), version=result.item.version + 1)
    assert state.engine.store.put(scope, item, expected_version=result.item.version).ok
    return item


class Summary:
    def __init__(self, text="alpha details available.", callback=None):
        self.text = text
        self.calls = 0
        self.callback = callback

    async def summarize(self, original, evidence, **kwargs):
        self.calls += 1
        if self.callback:
            self.callback()
        if self.text is None:
            raise RuntimeError("local model unavailable")
        return {"summary": self.text}


@pytest.mark.parametrize("text,source", [("alpha details available.", "llm_summary"), ("Invented unrelated facts", "explicit_user_hide"), (None, "explicit_user_hide")])
def test_middleware_consumes_pending_and_projects_current_version(tmp_path, text, source):
    summarizer = Summary(text)
    state, kwargs, scope = setup_state(tmp_path, summarizer)
    middleware = adapter.factories.make_middleware(state)
    original = copy.deepcopy(kwargs["request"])
    middleware(**kwargs)
    item = pending(state, scope)
    response = middleware(**kwargs)
    saved = state.engine.store.get(scope, item.item_id)
    assert saved.compaction_source == source
    assert saved.version == item.version + 1
    assert response["request"]["input"][1]["output"] == saved.compacted
    assert kwargs["request"] == original
    middleware(**kwargs)
    assert summarizer.calls == 1
    assert scope.branch_scope == "unknown"
    assert state.engine.store.adapter_targets("hermes:default:s:default")
    state.engine.store.close()


def test_summary_cas_cannot_overwrite_unhide(tmp_path):
    summary = Summary()
    state, kwargs, scope = setup_state(tmp_path, summary)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    item = pending(state, scope)
    remote = SQLiteContextStore(tmp_path / "s.db")
    summary.callback = lambda: remote.restore(scope, item.item_id, expected_version=item.version)
    response = middleware(**kwargs)
    assert state.engine.store.get(scope, item.item_id).visibility == "visible"
    assert response["request"] == kwargs["request"]
    assert not settle_summary(state.engine.store, scope, item.item_id, item.version, summary.text).ok
    remote.close()
    state.engine.store.close()


def test_pending_without_session_model_keeps_rule_hide(tmp_path):
    state, kwargs, scope = setup_state(tmp_path)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    item = pending(state, scope)
    middleware(**kwargs)
    saved = state.engine.store.get(scope, item.item_id)
    assert saved.compaction_source == "explicit_user_hide"
    assert saved.compacted == item.compacted
    state.engine.store.close()


def test_pending_uses_host_ctx_llm(tmp_path):
    from types import SimpleNamespace
    calls = []
    def complete(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text=json.dumps({"summary": "alpha details available."}))
    summarizer = adapter.llm.CtxLlmSummarizer(SimpleNamespace(llm=SimpleNamespace(complete=complete)))
    state, kwargs, scope = setup_state(tmp_path, summarizer)
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    item = pending(state, scope)
    middleware(**kwargs)
    assert state.engine.store.get(scope, item.item_id).compaction_source == "llm_summary"
    assert len(calls) == 1 and calls[0]["purpose"] == "session-navigation-summarize"
    state.engine.store.close()


def test_coexistence_preserves_capabilities_and_disable_revokes(tmp_path):
    import hashlib

    state, kwargs, scope = setup_state(tmp_path)
    kwargs["request"]["input"].insert(
        0, {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello user"}]}
    )
    middleware = adapter.factories.make_middleware(state)
    middleware(**kwargs)
    assert state.engine.store.adapter_can(scope, "hide")
    assert not state.engine.store.adapter_can(scope, "summarize")

    item = pending(state, scope)
    msg_key, role, _idx, text = adapter.payload.message_keys("codex_responses", kwargs["request"])[0]
    assert msg_key.startswith("msg:user:p0:")
    assert state.engine.store.set_message_visibility(
        scope,
        msg_key,
        kind=role,
        content_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        char_count=len(text),
        visibility="hidden",
    )["ok"] is True

    state.count_middlewares = lambda: 1
    response = middleware(**kwargs)
    assert state.engine.store.adapter_can(scope, "hide")
    assert state.engine.store.adapter_can(scope, "unhide")
    assert all(entry.get("role") != "user" for entry in response["request"]["input"])
    assert response["request"]["input"][1]["output"] == item.compacted

    state.count_middlewares = lambda: 0
    middleware(**kwargs)
    state.is_enabled = lambda: False
    assert middleware(**kwargs) is None
    assert not state.engine.store.adapter_can(scope, "hide")
    state.engine.store.close()


@pytest.mark.parametrize("kind", ["duplicate_call", "duplicate_result", "destructive", "protected", "unsupported_mode"])
def test_unsafe_or_ambiguous_targets_are_not_published(tmp_path, kind):
    state, kwargs, scope = setup_state(tmp_path)
    request = kwargs["request"]
    if kind == "duplicate_call":
        request["input"].insert(0, copy.deepcopy(request["input"][0]))
    elif kind == "duplicate_result":
        request["input"].append(copy.deepcopy(request["input"][1]))
    elif kind == "destructive":
        request["input"][0].update(name="terminal", arguments=json.dumps({"command": "rm -rf workspace"}))
    elif kind == "protected":
        request["input"][1]["output"] = "Error: permission denied\n" * 200
    else:
        kwargs["api_mode"] = "anthropic_messages"
    adapter.factories.make_middleware(state)(**kwargs)
    assert state.engine.store.adapter_targets(scope) == []
    state.engine.store.close()


def test_host_identity_fixture_contract_python_and_ts_parity(tmp_path):
    import hashlib
    import shutil
    import subprocess
    from pathlib import Path
    from session_navigation.model import (
        canonical,
        compute_invocation_digest,
        compute_sha256,
        _item_id,
    )

    repo = Path(__file__).resolve().parents[1]
    fixture = json.loads((repo / "contracts/fixtures/host_identity.json").read_text(encoding="utf-8"))
    assert fixture["version"] == 1

    # 1. OMP message keys & tool identities (Python core reference check)
    omp_scope = fixture["omp"]["scope"]
    for msg_case in fixture["omp"]["messages"]:
        msg = msg_case["message"]
        content = msg["content"]
        if isinstance(content, list):
            text = "".join(b["text"] for b in content if b.get("type") == "text")
        else:
            text = content
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        assert f"msg:{msg['role']}:{msg['timestamp']}:{digest}" == msg_case["expected_key"]

    for tool_case in fixture["omp"]["tools"]:
        text = "\n".join(
            b["text"] for b in tool_case["result_content"] if b.get("type") == "text"
        )
        assert text == tool_case["expected_text"]
        inv = json.loads(tool_case["expected_invocation_json"])
        csha = compute_sha256(text)
        dig = compute_invocation_digest(inv)
        iid = _item_id(omp_scope, tool_case["call_id"], csha, dig, 0)
        assert canonical(inv) == tool_case["expected_invocation_json"]
        assert csha == tool_case["expected_content_sha256"]
        assert dig == tool_case["expected_invocation_digest"]
        assert iid == tool_case["expected_item_id"]

    # 2. Hermes allowlist & invocation_digest parity (including __proto__, Codex null, int IDs)
    for inv_case in fixture["hermes"]["invocations"]:
        raw_args = json.loads(inv_case["raw_arguments_json"])
        inv, om = adapter.allowlist.filter_invocation(inv_case["tool_name"], raw_args)
        assert canonical(inv) == inv_case["expected_invocation_json"], inv_case["name"]
        assert canonical(om) == inv_case["expected_omitted_json"], inv_case["name"]
        dig = compute_invocation_digest(inv, om or None)
        assert dig == inv_case["expected_invocation_digest"], inv_case["name"]

    # 3. Hermes chat_completions & codex_responses message keys + tool identities
    for mode in ("chat_completions", "codex_responses"):
        section = fixture["hermes"][mode]
        keys = [
            key
            for key, _role, _idx, text in adapter.payload.message_keys(mode, section["payload"])
            if text.strip()
        ]
        assert keys == section["expected_message_keys"]
        transcript = adapter.session.SessionTranscriptStore()
        stored, skipped, err = transcript.record_request(section["scope"], mode, section["payload"])
        assert err is None and not skipped
        assert len(stored) == 1
        entry = stored[0]
        assert entry.call_id == section["expected_tool"]["call_id"]
        inv, om = adapter.allowlist.filter_invocation(entry.tool_name, entry.raw_arguments)
        dig = compute_invocation_digest(inv, om or None)
        assert dig == section["expected_tool"]["invocation_digest"]
        assert (
            _item_id(section["scope"], entry.call_id, entry.content_sha256, dig, entry.result_position)
            == section["expected_tool"]["expected_item_id"]
        )

    # 4. Hermes multi_result with whitespace call_id & result_position 0, 1
    multi = fixture["hermes"]["multi_result"]
    transcript = adapter.session.SessionTranscriptStore()
    stored, skipped, err = transcript.record_request(multi["scope"], "codex_responses", multi["payload"])
    assert err is None and not skipped
    assert [s.call_id for s in stored] == [multi["call_id"], multi["call_id"]]
    assert [s.result_position for s in stored] == [r["result_position"] for r in multi["expected_results"]]
    for entry, exp in zip(stored, multi["expected_results"]):
        inv, om = adapter.allowlist.filter_invocation(entry.tool_name, entry.raw_arguments)
        dig = compute_invocation_digest(inv, om or None)
        assert dig == multi["expected_invocation_digest"]
        assert entry.content == exp["content"]
        assert (
            _item_id(multi["scope"], entry.call_id, entry.content_sha256, dig, entry.result_position)
            == exp["expected_item_id"]
        )

    # 5. Cross-check TS OMP context + Paseo history.ts + Paseo hermesHistory.ts via bun if available
    bun = shutil.which("bun")
    if bun:
        ts_home = tmp_path / "ts-parity"
        ts_script = f"""
import {{ DatabaseSync }} from "node:sqlite";
import {{ mkdirSync, readFileSync, writeFileSync }} from "node:fs";
import {{ join }} from "node:path";
import {{ invocationDigest, itemId, sha256 }} from {json.dumps(str(repo / "packages/core/src/index.ts"))};
import {{ messageKey as ompMessageKey, ompInvocationArgs, toolResultText }} from {json.dumps(str(repo / "packages/omp/src/context.ts"))};
import {{ loadTimeline, messageKey as paseoMessageKey }} from {json.dumps(str(repo / "paseo-plugin/server/history.ts"))};
import {{ hermesFilterInvocation, loadHermesTimeline }} from {json.dumps(str(repo / "paseo-plugin/server/hermesHistory.ts"))};

const fixture = JSON.parse(readFileSync({json.dumps(str(repo / "contracts/fixtures/host_identity.json"))}, "utf8"));
const home = {json.dumps(str(ts_home))};

// OMP JSONL check
const ompSessions = join(home, ".omp/agent/sessions/fixture");
mkdirSync(ompSessions, {{ recursive: true }});
const ompLines = [];
for (const m of fixture.omp.messages) {{
  if (ompMessageKey(m.message) !== m.expected_key) throw new Error("omp key mismatch " + m.name);
  if (paseoMessageKey(0, m.message) !== m.expected_key) throw new Error("paseo key mismatch " + m.name);
  ompLines.push(JSON.stringify({{ type: "message", message: m.message }}));
}}
for (const t of fixture.omp.tools) {{
  const rawArgs = JSON.parse(t.raw_arguments_json);
  const filteredArgs = ompInvocationArgs(t.tool_name, rawArgs);
  if (!filteredArgs) throw new Error("ompInvocationArgs returned null for " + t.name);
  const inv = {{ tool_name: t.tool_name, arguments: filteredArgs }};
  if (invocationDigest(inv) !== t.expected_invocation_digest) throw new Error("omp digest mismatch " + t.name);
  ompLines.push(JSON.stringify({{ type: "message", message: {{ role: "assistant", content: [{{ type: "toolCall", id: t.call_id, name: t.tool_name, arguments: rawArgs }}] }} }}));
  ompLines.push(JSON.stringify({{ type: "message", message: {{ role: "toolResult", toolCallId: t.call_id, toolName: t.tool_name, isError: false, content: t.result_content }} }}));
}}
writeFileSync(join(ompSessions, "2026_fixture-omp-sid.jsonl"), ompLines.join("\\n"));
const ompTl = loadTimeline(home, fixture.omp.scope);
for (const m of fixture.omp.messages) {{
  const row = ompTl.rows.find((r) => r.item_id === m.expected_key);
  if (!row || row.summary_line !== m.expected_summary_line) throw new Error("omp timeline msg mismatch " + m.name);
}}
for (const t of fixture.omp.tools) {{
  const rec = ompTl.records.get(t.call_id);
  const row = ompTl.rows.find((r) => r.tool_call_id === t.call_id);
  if (!rec || !row) throw new Error("missing omp tool " + t.name);
  if (rec.content !== t.expected_text || rec.content_sha256 !== t.expected_content_sha256) throw new Error("omp content mismatch " + t.name);
  if (rec.invocation_digest !== t.expected_invocation_digest || row.item_id !== t.expected_item_id) throw new Error("omp id mismatch " + t.name);
}}

// Hermes invocations & DB check
for (const invCase of fixture.hermes.invocations) {{
  const filtered = hermesFilterInvocation(invCase.tool_name, invCase.raw_arguments_json);
  if (!filtered) throw new Error("hermesFilterInvocation null " + invCase.name);
  const dig = invocationDigest(filtered.invocation, filtered.omitted);
  if (dig !== invCase.expected_invocation_digest) throw new Error("hermes digest mismatch " + invCase.name);
}}
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
const insS = db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)");
const insM = db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, codex_message_items, api_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
for (const mode of ["chat_completions", "codex_responses"]) {{
  const sec = fixture.hermes[mode];
  insS.run(sec.session_id, JSON.stringify({{ gateway_runtime: {{ api_mode: mode }} }}));
  for (const r of sec.db_rows) {{
    insM.run(sec.session_id, r.role, r.content ?? null, r.tool_call_id ?? null, r.tool_calls ? JSON.stringify(r.tool_calls) : null, r.tool_name ?? null, r.codex_message_items ? JSON.stringify(r.codex_message_items) : null, r.api_content ?? null);
  }}
  const tl = loadHermesTimeline(home, sec.scope);
  if (!tl) throw new Error("missing hermes tl " + mode);
  const msgKeys = tl.rows.filter((r) => r.kind === "user" || r.kind === "assistant").map((r) => r.item_id);
  if (JSON.stringify(msgKeys) !== JSON.stringify(sec.expected_message_keys)) throw new Error("hermes msg keys mismatch " + mode);
  const tRow = tl.rows.find((r) => r.tool_call_id === sec.expected_tool.call_id);
  const tRec = tl.records.get(sec.expected_tool.call_id);
  if (!tRow || !tRec || tRec.invocation_digest !== sec.expected_tool.invocation_digest || tRow.item_id !== sec.expected_tool.expected_item_id) {{
    throw new Error("hermes tool mismatch " + mode);
  }}
}}
const multi = fixture.hermes.multi_result;
insS.run(multi.session_id, JSON.stringify({{ gateway_runtime: {{ api_mode: "codex_responses" }} }}));
for (const r of multi.db_rows) {{
  insM.run(multi.session_id, r.role, r.content ?? null, r.tool_call_id ?? null, r.tool_calls ? JSON.stringify(r.tool_calls) : null, r.tool_name ?? null, null, null);
}}
const storedMulti = multi.expected_results.map((er) => ({{
  item_id: er.expected_item_id,
  tool_call_id: multi.call_id,
  result_position: er.result_position,
  content_sha256: sha256(er.content),
  invocation_digest: multi.expected_invocation_digest,
  original: er.content,
  compacted: "[hidden]",
  excerpt_lines: [],
  visibility: "hidden",
  version: 2,
  tool_name: "read_file",
  compaction_source: "explicit_user_hide",
  invocation_snapshot: {{ tool_name: "read_file", arguments: {{ path: "multi.txt" }} }},
  context_hint: null,
  invocation_options_omitted: false,
  created_at: 0,
  updated_at: 0,
}}));
const tlMulti = loadHermesTimeline(home, multi.scope, storedMulti);
if (!tlMulti) throw new Error("missing multi tl");
if (JSON.stringify(tlMulti.rows.filter((r) => r.kind === "tool").map((r) => r.item_id)) !== JSON.stringify(multi.expected_results.map((e) => e.expected_item_id))) {{
  throw new Error("multi item_ids mismatch");
}}
db.close();
"""
        proc = subprocess.run([bun, "-e", ts_script], capture_output=True, text=True, timeout=60)
        assert proc.returncode == 0, proc.stdout + proc.stderr
