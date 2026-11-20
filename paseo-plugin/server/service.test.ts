import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireHermesToggleLock, inspectHermesPluginInstall, inspectHermesToggle, patchHermesConfigYaml, readHermesPluginEnabled } from "./adapterToggles.ts";
import {
  Store,
  EngineError,
  canonical,
  sha256,
  invocationDigest,
  itemId,
  refusalReason,
  type Item,
} from "../../packages/core/src/index.ts";
import { BunDriver } from "../../packages/core/src/drivers/bun.ts";
import {
  messageKey as ompMessageKey,
  ompInvocationArgs,
  toolResultText,
} from "../../packages/omp/src/context.ts";
import { OmpService } from "../../packages/omp/src/service.ts";
import { PaseoService } from "./service.ts";
import {
  loadTimeline,
  measuredTokens,
  messageKey,
  preview,
  type Message,
} from "./history.ts";
import { hermesFilterInvocation, loadHermesTimeline } from "./hermesHistory.ts";
import { MAX_HISTORY_BYTES } from "./historyLimits.ts";
import { bindAgents } from "./mapping.ts";
import {
  DbChoiceResultSchema,
  ListResultSchema,
  MutationResultSchema,
  dbChoiceRpc,
  type Row,
} from "../shared/sessionNav.ts";

const scope = "omp:default:sid:default";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function fixture(messages: Message[] = [], registered = true) {
  const home = mkdtempSync(join(tmpdir(), "paseo-service-"));
  const sessions = join(home, ".omp/agent/sessions/project");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "2026_sid.jsonl"),
    messages
      .map((message) => JSON.stringify({ type: "message", message }))
      .join("\n"),
  );
  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  const service = new PaseoService(store, home);
  const register = (
    key = scope,
    capabilities = { hide: true, summarize: true, unhide: true },
    protocol = 1,
    enabled = true,
  ) =>
    store.register(key, {
      adapter_id: key.split(":")[0],
      adapter_protocol: protocol,
      capabilities,
      enabled,
      instance_id: "test",
    });
  if (registered) register();
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const call = (method: string, input: Record<string, any> = {}) =>
    service.handle(method, { scope_key: scope, ...input });
  return { home, store, service, register, call };
}
test("backend scope listings expose child linkage and registered child targets without a main JSONL", async () => {
  const { store, service } = fixture();
  const child = "omp:default:child:default";
  const adapter = new OmpService(store);
  await adapter.handle("prepare", { session_id: "child", snapshot_id: "child-snapshot",
    parent_scope: scope, subagent_id: "ChildBird", tool_call_id: "parent-task",
    records: [{ call_id: "read-child", tool_name: "read", arguments: { path: "sample.txt" }, status: "ok",
      content: Array.from({ length: 100 }, () => "Routine catalog annotation").join("\n") }] });
  const result = await service.handle("scopes", { parent_scope: scope });
  expect(result.scopes).toHaveLength(1);
  expect(result.scopes[0]).toMatchObject({ scope_key: child, parent_scope: scope, tool_call_id: "parent-task", subagent_id: "ChildBird" });
  expect((await service.handle("scopes", { parent_scope: child })).scopes).toEqual([]);
  expect((await service.handle("scopes", { parent_scope: 1 })).error).toBe("invalid_params");
  const listed = await service.handle("list", { scope_key: child });
  const row = listed.items.find((row: any) => row.tool_call_id === "read-child");
  expect(row.manageable).toBe(true);
  const hidden = await service.handle("hide", { scope_key: child, item_id: row.item_id, expected_version: row.version });
  expect(hidden.ok).toBe(true);
  const projected = await adapter.handle("prepare", { session_id: "child", snapshot_id: "next",
    records: [...adapter.snapshots.get("child")!.records.values()].map((record) => ({
      call_id: record.call_id, tool_name: record.invocation.tool_name,
      arguments: record.invocation.arguments, status: record.status, content: record.content })) });
  expect(projected.patches[0].text).toContain("[hidden:");
});

function toolMessages(
  output = "x".repeat(1500),
  name = "read",
  arguments_ = { path: "file.txt" } as Record<string, any>,
): Message[] {
  return [
    { role: "user", timestamp: 1000, content: "please check" },
    {
      role: "assistant",
      timestamp: 2000,
      content: [
        { type: "text", text: "Running it" },
        { type: "toolCall", id: "c1", name, arguments: arguments_ },
      ],
    },
    {
      role: "toolResult",
      timestamp: 2500,
      toolCallId: "c1",
      toolName: name,
      isError: false,
      content: [{ type: "text", text: output }],
    },
    {
      role: "assistant",
      timestamp: 3000,
      content: [{ type: "text", text: "All done" }],
    },
  ];
}
function seed(store: Store, id: string, key = scope): Item {
  const item: Item = {
    item_id: id,
    tool_call_id: `call-${id}`,
    result_position: 0,
    content_sha256: sha256(`original ${id}`),
    invocation_digest: id,
    original: `original ${id}`,
    compacted: `summary ${id}`,
    excerpt_lines: [],
    visibility: "visible",
    version: 1,
    tool_name: "read",
    compaction_source: "rule",
    invocation_snapshot: null,
    context_hint: null,
    invocation_options_omitted: false,
    created_at: 0,
    updated_at: 0,
  };
  expect(store.put(key, item).ok).toBe(true);
  return item;
}

test("single tool mutations satisfy the RPC response schema, including conflicts and missing targets", async () => {
  const { call } = fixture(toolMessages());
  const row = (await call("list")).items.find((item: any) => item.tool_call_id === "c1");
  for (const [method, input, ok] of [
    ["hide", { item_id: row.item_id, expected_version: 1 }, true],
    ["hide", { item_id: row.item_id, expected_version: 0 }, false],
    ["unhide", { item_id: row.item_id }, true],
    ["hide", { item_id: row.item_id, mode: "summarize" }, true],
    ["hide", { item_id: "missing" }, false],
    ["unhide", { item_id: "" }, false],
  ] as const) {
    const response = await call(method, input);
    expect(MutationResultSchema.parse(response).ok).toBe(ok);
    if (response.item) expect(response.item.tokens_display).toBe("—");
  }
});

for (const mode of ["hide", "summarize"])
  test(`batch ${mode} commits independently, CAS-checks even idempotent hides and restores originals`, async () => {
    const { call, store } = fixture();
    for (const id of ["a", "b", "c"]) seed(store, id);
    const result = await call("hideBatch", {
      mode,
      items: [
        { item_id: "a", expected_version: 0 },
        { item_id: "b", expected_version: 1 },
        { item_id: "missing" },
        { item_id: "c", expected_version: 1 },
      ],
    });
    expect([result.ok, result.applied, result.failed]).toEqual([false, 2, 2]);
    expect(result.items.map((item: any) => item.error)).toEqual([
      "version_conflict",
      undefined,
      "not_found",
      undefined,
    ]);
    expect(store.get(scope, "b")?.compaction_source).toBe(
      mode === "summarize" ? "summarize_pending" : "explicit_user_hide",
    );
    expect(
      (await call("hide", { item_id: "b", expected_version: 1, mode })).error,
    ).toBe("version_conflict");
    expect(
      (
        await call("unhideBatch", {
          items: [
            { item_id: "b", expected_version: 2 },
            { item_id: "c", expected_version: 2 },
          ],
        })
      ).applied,
    ).toBe(2);
    expect(
      (await call("list")).items.find((row: any) => row.item_id === "b"),
    ).toMatchObject({
      status: "unhidden",
      summary_line: "original b",
      tool_output: "original b",
      version: 3,
    });
  });

test("empty, malformed and duplicate batches have deterministic results", async () => {
  const { call, store } = fixture();
  seed(store, "a");
  for (const method of ["hideBatch", "unhideBatch"]) {
    expect(await call(method, { items: [] })).toEqual({
      ok: true,
      applied: 0,
      failed: 0,
      items: [],
    });
    for (const items of [
      {},
      [{}],
      [{ item_id: "a", expected_version: true }],
      "invalid",
    ])
      expect((await call(method, { items })).error).toBe("invalid_items");
  }
  expect(
    (await call("hideBatch", { items: [{ item_id: "a" }, { item_id: "a" }] }))
      .applied,
  ).toBe(1);
});

test("a mid-batch disk failure reports earlier commits and stops later writes", async () => {
  const { call, store } = fixture();
  for (const id of ["a", "b", "c"]) seed(store, id);
  const put = store.put.bind(store);
  store.put = ((key: any, item: Item, ...args: any[]) => {
    if (item.item_id === "b") throw new EngineError("db_full");
    return put(key, item, ...args);
  }) as typeof store.put;
  const result = await call("hideBatch", {
    items: ["a", "b", "c"].map((item_id) => ({ item_id })),
  });
  expect(result).toMatchObject({
    ok: false,
    error: "db_full",
    applied: 1,
    failed: 1,
  });
  expect(store.get(scope, "a")?.visibility).toBe("hidden");
  expect(store.get(scope, "c")?.visibility).toBe("visible");
});

for (const output of ["", "a\nb\n" + "x".repeat(827), "한".repeat(5000)])
  for (const [name, args] of [
    ["read", { path: "/work/file.txt", offset: 10, limit: 20 }],
    ["bash", { command: "cat file.txt", cwd: "/work" }],
  ] as const)
    test(`original ${name} preview survives hide/unhide (${output.length} chars)`, async () => {
      const { call } = fixture(toolMessages(output, name, args));
      const before = (await call("list")).items.find(
        (row: any) => row.kind === "tool",
      );
      expect(before.tool_input).toBe(preview(args));
      expect(before.tool_output).toBe(preview(output));
      expect(
        (await call("hide", { item_id: before.item_id, expected_version: 1 }))
          .ok,
      ).toBe(true);
      const hidden = (await call("list")).items.find(
        (row: any) => row.kind === "tool",
      );
      expect(hidden).toMatchObject({
        tool_input: before.tool_input,
        tool_output: before.tool_output,
        status: "hidden",
        summary_pending: false,
      });
      expect(typeof hidden.replacement_text).toBe("string");
      expect(
        (
          await call("unhide", {
            item_id: hidden.item_id,
            expected_version: hidden.version,
          })
        ).ok,
      ).toBe(true);
      expect(
        (await call("list")).items.find((row: any) => row.kind === "tool")
          .replacement_text,
      ).toBeUndefined();
    });

test("message hide/unhide, version fences and unsupported summary preserve original text and OMP projection", async () => {
  const messages = toolMessages("/work");
  const { call, store } = fixture(messages);
  const id = messageKey(0, messages[0])!;
  expect((await call("hide", { item_id: id, mode: "summarize" })).error).toBe(
    "summarize_unsupported",
  );
  expect((await call("hide", { item_id: id, expected_version: 5 })).error).toBe(
    "version_conflict",
  );
  expect(
    (
      await call("hideBatch", {
        items: [
          { item_id: id, expected_version: 1 },
          { item_id: "c1", expected_version: 1 },
        ],
      })
    ).applied,
  ).toBe(2);
  expect((await call("list")).items[0]).toMatchObject({
    status: "hidden",
    message_text: "please check",
    version: 2,
  });
  const projected = await new OmpService(store).handle("prepare", {
    session_id: "sid",
    snapshot_id: "token",
    records: [],
  });
  expect(projected.hidden_messages).toEqual([id]);
  expect(
    (await call("unhide", { item_id: id, expected_version: 2 })).version,
  ).toBe(3);
  expect((await call("hide", { item_id: "msg:user:1:abc" })).error).toBe(
    "not_found",
  );
});

test("every tool is displayed, but unsupported, duplicate, ambiguous and failed results stay read-only", async () => {
  const messages = toolMessages("out");
  messages.splice(
    3,
    0,
    ...toolMessages("edited", "edit", { path: "a.py" })
      .slice(1, 3)
      .map((message) =>
        JSON.parse(JSON.stringify(message).replaceAll("c1", "edit")),
      ),
  );
  const { call } = fixture(messages);
  const rows = (await call("list")).items.filter(
    (row: any) => row.kind === "tool",
  );
  expect(rows.map((row: any) => [row.tool_name, row.manageable])).toEqual([
    ["read", true],
    ["edit", false],
  ]);
  expect((await call("hide", { item_id: rows[1].item_id })).error).toBe(
    "not_found",
  );
  for (const variant of [
    "duplicate",
    "error",
    "result",
    "order",
    "image_only",
  ]) {
    const changed = toolMessages("out");
    if (variant === "duplicate") changed[1].content.push(changed[1].content[1]);
    if (variant === "error") changed[2].isError = true;
    if (variant === "result") changed.push(changed[2]);
    if (variant === "order")
      [changed[1], changed[2]] = [changed[2], changed[1]];
    if (variant === "image_only")
      changed[2].content = [{ type: "image", data: "x" }];
    const current = fixture(changed);
    expect(
      (await current.call("list")).items
        .filter((row: any) => row.kind === "tool")
        .every((row: any) => !row.manageable),
    ).toBe(true);
  }
  // Multi-block text+image toolResult IS now manageable
  const multiBlock = toolMessages("a".repeat(900));
  multiBlock[2].content.push({ type: "image", data: "x" });
  const mbFixture = fixture(multiBlock);
  const mbTools = (await mbFixture.call("list")).items.filter((row: any) => row.kind === "tool");
  expect(mbTools.every((row: any) => row.manageable)).toBe(true);
});

test("a huge outline prioritizes newest results within the 5000-record and 32MiB management caps and surfaces records_capped", async () => {
  const messages: Message[] = [];
  for (let index = 0; index < 5005; index++)
    messages.push(
      ...toolMessages(`out ${index}`)
        .slice(1, 3)
        .map((message) =>
          JSON.parse(JSON.stringify(message).replaceAll("c1", `call-${index}`)),
        ),
    );
  const { home, call } = fixture(messages);
  const timeline = loadTimeline(home, scope);
  const toolRows = timeline.rows.filter((row) => row.kind === "tool");
  expect(toolRows).toHaveLength(5005);
  expect(timeline.records.size).toBe(5000);
  expect(timeline.history.recordsCapped).toBe(true);
  // Newest results stay manageable; oldest excess results age out to read-only!
  expect(toolRows.at(-1)?.manageable).toBe(true);
  expect(toolRows[0]?.manageable).toBe(false);
  const listed = await call("list");
  expect(listed.records_capped).toBe(true);
  const huge = fixture(toolMessages("x".repeat(32 * 1024 * 1024 + 1)));
  const hugeTimeline = loadTimeline(huge.home, scope);
  expect(hugeTimeline.records.size).toBe(0);
  expect(hugeTimeline.history.recordsCapped).toBe(true);
});
test("preview truncation preserves UTF-8, empty originals and malformed/missing histories", async () => {
  expect(preview("한".repeat(5000))).toEndWith("\n… [truncated]");
  expect(preview("한".repeat(5000))).not.toContain("�");
  const { home, call } = fixture();
  writeFileSync(
    join(home, ".omp/agent/sessions/project/2026_sid.jsonl"),
    "invalid\n{}\nnull\n",
  );
  expect((await call("list")).items).toEqual([]);
  expect(loadTimeline(home, "omp:default:missing:default").rows).toEqual([]);
  expect(
    (await call("list", { scope_key: "omp:default:../../escape:default" }))
      .items,
  ).toEqual([]);
});

function assistant(
  timestamp: number,
  prompt: number,
  content: any[],
  nonMessage = 1000,
) {
  return {
    role: "assistant",
    provider: "llamacpp",
    model: "local-small",
    timestamp,
    content,
    usage: {
      input: 0,
      output: 1,
      cacheRead: prompt,
      cacheWrite: 0,
      totalTokens: prompt + 1,
    },
    contextSnapshot: { promptTokens: prompt, nonMessageTokens: nonMessage },
  };
}
function measuredMessages(): Message[] {
  return [
    { role: "user", content: "hello" },
    assistant(1000, 1100, [
      {
        type: "toolCall",
        id: "c1",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ]),
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "x".repeat(300) }],
    },
    assistant(2000, 1300, [{ type: "text", text: "done" }]),
    { role: "user", content: "next" },
    assistant(3000, 1310, [{ type: "text", text: "ok" }]),
  ];
}
test("measured allocation and model windows match the Python CLI fixtures", async () => {
  const messages = measuredMessages();
  const { call, home } = fixture(messages);
  writeFileSync(
    join(home, ".omp/agent/models.yml"),
    "providers:\n  other:\n    models:\n      - id: local-small\n        contextWindow: 1000\n  llamacpp:\n    models:\n      - id: big\n        contextWindow: 9999\n      - id: local-small\n        contextWindow: 32768\n",
  );
  const result = await call("list");
  expect(result.context).toEqual({
    used_tokens: 1311,
    max_tokens: 32768,
    source: "omp_session_usage",
  });
  expect(result.items.map((row: any) => row.tokens)).toEqual([
    undefined,
    200,
    5,
    5,
    undefined,
  ]);
  const history = {
    messages,
    boundaries: [],
    injected: [] as [number, number][],
  };
  expect(measuredTokens(home, history, [[1.5, 1.5]]).tokens.has("c1")).toBe(
    false,
  );
  expect(
    measuredTokens(home, { ...history, boundaries: [2] }, []).tokens.has("c1"),
  ).toBe(false);
  const shrunk = structuredClone(messages);
  shrunk[3] = assistant(2000, 1050, [{ type: "text", text: "done" }]);
  expect(
    measuredTokens(home, { ...history, messages: shrunk }, []).tokens.has("c1"),
  ).toBe(false);
  expect([
    ...measuredTokens(
      home,
      { ...history, injected: [[4, 2]] },
      [],
    ).tokens.values(),
  ]).toEqual([200, 4, 4]);
  expect(measuredTokens(home, history, [[1.5, 2.5]]).tokens.size).toBe(0);
  const zero = structuredClone(messages);
  zero[3] = assistant(2000, 1300, [{ type: "text", text: "" }]);
  expect(
    measuredTokens(home, { ...history, messages: zero }, []).tokens.get(
      "usr_4",
    ),
  ).toBe(10);
  expect(
    measuredTokens(
      home,
      {
        ...history,
        messages: messages.map((message) => ({ ...message, usage: null })),
      },
      [],
    ),
  ).toEqual({ tokens: new Map() });
});

test("scope counts are real and include zero-item registrations; absent/disabled/incompatible capabilities block every mutation surface", async () => {
  const { call, store, register } = fixture(toolMessages(), false);
  const listed = await call("list");
  expect(listed.capabilities.state).toBe("adapter_not_detected");
  expect((await call("scopes")).scopes).toEqual([]);
  for (const status of ["absent", "disabled", "incompatible", "bits"]) {
    if (status === "disabled") register(scope, undefined, 1, false);
    if (status === "incompatible") register(scope, undefined, 99);
    if (status === "bits")
      register(scope, { hide: false, summarize: false, unhide: true });
    for (const [method, input] of [
      ["hide", { item_id: listed.items[0].item_id }],
      ["hideBatch", { items: [{ item_id: "c1" }] }],
      ["hideBatch", { mode: "summarize", items: [{ item_id: "c1" }] }],
      ["manage", { tool_call_ids: ["c1"] }],
      ["fork", { dst_scope_key: scope }],
    ] as const)
      expect((await call(method, input)).ok).toBe(false);
    expect(store.items(scope)).toHaveLength(0);
  }
  register();
  expect((await call("scopes")).scopes[0].items).toBe(0);
  expect((await call("hide", { item_id: "c1" })).ok).toBe(true);
  const hidden = store.items(scope)[0];
  store.driver.run("DELETE FROM adapter_sessions WHERE scope_key=?", [scope]);
  expect(
    (
      await call("unhide", {
        item_id: hidden.item_id,
        expected_version: hidden.version,
      })
    ).ok,
  ).toBe(true);
  expect((await call("scopes")).scopes[0].items).toBe(1);
  seed(store, "legacy", "pi:default:sid:default");
  const legacy = store.get("pi:default:sid:default", "legacy")!;
  store.put("pi:default:sid:default", { ...legacy, visibility: "hidden" });
  expect(
    (
      await call("hide", {
        scope_key: "pi:default:sid:default",
        item_id: "legacy",
      })
    ).error,
  ).toBe("adapter_not_detected");
  expect(
    (
      await call("unhide", {
        scope_key: "pi:default:sid:default",
        item_id: "legacy",
      })
    ).ok,
  ).toBe(true);
});

test("Paseo upgrades a Hide through the owning session and never requeues an accepted summary", async () => {
  const {store,call,register}=fixture();
  const key="hermes:default:upgrade:unknown";
  register(key);
  const invocation={tool_name:"read_file",arguments:{path:"sample.txt"}};
  const source="Routine annotation details.\n".repeat(100)+"Count 42.";
  const record={call_id:"upgrade",content:source,content_sha256:sha256(source),invocation,invocation_digest:invocationDigest(invocation),result_position:0,status:"ok"};
  store.publishTargets(key,[{record}]);
  expect((await call("hide",{scope_key:key,item_id:"upgrade"})).ok).toBe(true);
  const item=store.items(key)[0];
  expect((await call("hide",{scope_key:key,item_id:item.item_id,mode:"summarize",expected_version:item.version})).ok).toBe(true);
  const pending=store.items(key)[0];
  const engine=new (await import("../../packages/core/src/engine.ts")).Engine(store);
  expect(engine.settlePending(key,pending.item_id,pending.version,"Count 42.").ok).toBe(true);
  const accepted=store.items(key)[0];
  expect(accepted.compaction_source).toBe("llm_summary");
  expect((await call("hide",{scope_key:key,item_id:item.item_id,mode:"summarize"})).ok).toBe(true);
  expect(store.items(key)[0].version).toBe(accepted.version);
  expect(store.items(key)[0].original).toBe(source);
});

test("Hermes targets and unknown/default discovery aliases use verified identity and queue session-model summaries", async () => {
  const { store, call, register } = fixture();
  const key = "hermes:default:hermes-session:unknown";
  register(key);
  const invocation = {
    tool_name: "read_file",
    arguments: { path: "file.txt" },
  };
  const original = "original output\n".repeat(100);
  const record = {
    call_id: "target",
    content: original,
    content_sha256: sha256(original),
    invocation,
    invocation_digest: invocationDigest(invocation),
    result_position: 0,
    status: "ok",
  };
  store.publishTargets(key, [{ record }]);
  const listed = await call("list", {
    scope_key: key.replace(/unknown$/, "default"),
  });
  expect(listed.scope_key).toBe(key);
  expect(listed.items[0].tool_output).toBe(original);
  expect(
    (
      await call("hide", {
        scope_key: key,
        item_id: listed.items[0].item_id,
        mode: "summarize",
      })
    ).ok,
  ).toBe(true);
  expect(store.items(key)[0].compaction_source).toBe("summarize_pending");
  expect(store.items(key.replace(/unknown$/, "default"))).toHaveLength(0);
  expect(
    (
      await call("unhide", {
        scope_key: key,
        item_id: store.items(key)[0].item_id,
      })
    ).ok,
  ).toBe(true);
});

test("explicit manage targets, fork registration gates, D9 recovery and readonly database failures", async () => {
  const { call, store, register } = fixture(toolMessages());
  expect((await call("manage", {})).error).toBe("tool_call_ids_required");
  expect(
    (await call("manage", { tool_call_ids: ["c1", "missing"] })).applied,
  ).toBe(1);
  expect(
    (await call("fork", { dst_scope_key: "omp:default:child:default" })).ok,
  ).toBe(false);
  register("omp:default:child:default");
  expect(
    (await call("fork", { dst_scope_key: "omp:default:child:default" })).counts
      .items,
  ).toBe(1);
  await call("dbChoice", { choice: "abort_request" });
  expect(
    (await call("unhide", { item_id: store.items(scope)[0].item_id })).error,
  ).toBe("db_error");
  expect((await call("list")).ok).toBe(true);
  expect(
    (await call("unhide", { item_id: store.items(scope)[0].item_id })).ok,
  ).toBe(true);
  await call("dbChoice", { choice: "send_original" });
  expect((await call("list")).ok).toBe(true);
  expect((await call("hide", { item_id: "c1" })).error).toBe("db_error");
  await call("list");
  store.driver.exec("PRAGMA query_only=ON");
  const result = await call("hide", { item_id: store.items(scope)[0].item_id });
  expect(result).toMatchObject({
    ok: false,
    error: "db_error",
    choices: ["abort_request", "send_original"],
  });
});

test("agent binding uses explicit provider, profile and third scope component, preferring registered OMP over pi history", () => {
  const { home } = fixture();
  const agents = join(home, ".paseo/agents/workspace");
  mkdirSync(agents, { recursive: true });
  for (const [id, provider, session, metadata] of [
    ["omp-agent", "omp", "sid", {}],
    [
      "hermes-agent",
      "custom-name",
      "hsid",
      { provider: "acp", profile: "work" },
    ],
    ["wrong-agent", "claude", "sid", {}],
  ])
    writeFileSync(
      join(agents, `${id}.json`),
      JSON.stringify({
        id,
        provider,
        persistence: { provider, sessionId: session, metadata },
      }),
    );
  const scopes = [
    {
      scope_key: scope,
      items: 0,
      capabilities: { state: "ready", unhide: false },
    },
    {
      scope_key: "pi:default:sid:default",
      items: 1,
      capabilities: { state: "adapter_not_detected", unhide: true },
    },
    {
      scope_key: "hermes:work:hsid:unknown",
      items: 0,
      capabilities: { state: "ready", unhide: false },
    },
  ];
  expect(bindAgents(home, scopes).map((scope: any) => scope.agent_id)).toEqual([
    "omp-agent",
    undefined,
    "hermes-agent",
  ]);
});

test("agent binding resolves Hermes custom profile providers via Paseo 0.15 agents.providers, provider suffix, and profile cwd", () => {
  const { home } = fixture();
  const paseoDir = join(home, ".paseo");
  const agentsDir = join(paseoDir, "agents/Users-test-.hermes-profiles-atlas");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(paseoDir, "config.json"),
    JSON.stringify({
      agents: {
        providers: {
          "hermes-atlas": {
            extends: "acp",
            command: ["hermes", "-p", "atlas", "acp"],
          },
        },
      },
    }),
  );
  writeFileSync(
    join(agentsDir, "atlas-agent.json"),
    JSON.stringify({
      id: "atlas-agent-1",
      provider: "hermes-atlas",
      cwd: join(home, ".hermes/profiles/atlas"),
      runtimeInfo: { provider: "acp", sessionId: "local-atlas-sid" },
      persistence: {
        provider: "hermes-atlas",
        sessionId: "local-atlas-sid",
        metadata: { provider: "acp", cwd: join(home, ".hermes/profiles/atlas") },
      },
    }),
  );
  const scopes = [
    {
      scope_key: "hermes:atlas:local-atlas-sid:unknown",
      items: 4,
      capabilities: { state: "ready", unhide: true },
    },
  ];
  expect(bindAgents(home, scopes)[0].agent_id).toBe("atlas-agent-1");
});

test("Hermes adapter_targets with options_omitted=1 remain manageable in list and preserve invocation_options_omitted + compacted_bytes_size on Hide", async () => {
  const { store, service, register } = fixture([], false);
  const hermesScope = "hermes:atlas:local-opts:unknown";
  register(hermesScope);
  const content = Array.from({ length: 40 }, (_, i) => `row ${i}: pod status running on k3s node`).join("\n");
  const contentSha = sha256(content);
  const filteredInv = { tool_name: "terminal", arguments: { command: "kubectl get pods -A" } };
  const omitted = { timeout: 30 };
  const fullDigest = invocationDigest(filteredInv, omitted);
  const id = itemId(hermesScope, "call_timeout_1", contentSha, fullDigest, 0);
  store.publishTargets(hermesScope, [
    {
      record: {
        call_id: "call_timeout_1",
        content,
        content_sha256: contentSha,
        invocation: filteredInv,
        invocation_digest: fullDigest,
        result_position: 0,
        status: "ok",
      },
      omitted,
    },
  ]);

  const listed = await service.handle("list", { scope_key: hermesScope });
  expect(listed.ok).toBe(true);
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toMatchObject({ item_id: id, tool_call_id: "call_timeout_1", manageable: true });

  const hidden = await service.handle("hide", { scope_key: hermesScope, item_id: id, mode: "hide" });
  expect(hidden.ok).toBe(true);
  expect(hidden.item.compacted_bytes_size).toBeLessThan(hidden.item.bytes_size);
  const stored = store.get(hermesScope, id);
  expect(stored?.compacted).toBe("[hidden: terminal call_timeout_1]");
  expect(stored?.invocation_digest).toBe(fullDigest);
  expect(stored?.invocation_snapshot).toBe(null);
  expect(stored?.invocation_options_omitted).toBe(false);
});

test("PASEO_HOME redirects only the real home, never an isolated fixture home", () => {
  const { home } = fixture();
  const agents = join(home, ".paseo/agents/workspace");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, "isolated.json"),
    JSON.stringify({
      id: "isolated-agent",
      provider: "omp",
      persistence: { provider: "omp", sessionId: "sid", metadata: {} },
    }),
  );
  const redirectedHome = mkdtempSync(join(tmpdir(), "paseo-redirected-"));
  const redirectedAgents = join(redirectedHome, "agents", "workspace");
  mkdirSync(redirectedAgents, { recursive: true });
  writeFileSync(
    join(redirectedAgents, "redirected.json"),
    JSON.stringify({
      id: "redirected-agent",
      provider: "omp",
      persistence: { provider: "omp", sessionId: "other", metadata: {} },
    }),
  );
  cleanup.push(() => rmSync(redirectedHome, { recursive: true, force: true }));
  const scopes = (session: string): {
    scope_key: string;
    items: number;
    capabilities: { state: string; unhide: boolean };
    agent_id?: string;
  }[] => [{
    scope_key: `omp:default:${session}:default`,
    items: 0,
    capabilities: { state: "ready", unhide: false },
  }];
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = redirectedHome;
  try {
    expect(bindAgents(home, scopes("sid"))[0].agent_id).toBe("isolated-agent");
    expect(bindAgents(home, scopes("other"))[0].agent_id).toBeUndefined();
    expect(bindAgents(homedir(), scopes("other"))[0].agent_id).toBe("redirected-agent");
    expect(bindAgents("/unused-home", scopes("other"), redirectedHome)[0].agent_id).toBe("redirected-agent");
    expect(bindAgents("/unused-home", scopes("sid"))[0].agent_id).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  }
});

test("manage_context tool calls appear in Outline, format legacy JSON output cleanly, and match tool_name search queries", async () => {
  const { service } = fixture([
    {
      role: "assistant",
      timestamp: 1000,
      content: [
        {
          type: "toolCall",
          id: "call_mc_1",
          name: "manage_context",
          arguments: { action: "hide", tool_call_ids: ["call_read_1", "call_read_2"] },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_mc_1",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            applied: 2,
            failed: 0,
            size: "420 B / 18.4 KiB",
            items: [{ tool_call_id: "call_read_1", ok: true, item_id: "item_1" }],
          }),
        },
      ],
    },
  ]);

  const listed = await service.handle("list", { scope_key: scope });
  expect(listed.ok).toBe(true);
  const mcRow = listed.items.find((r: any) => r.tool_call_id === "call_mc_1");
  expect(mcRow).toBeDefined();
  expect(mcRow.tool_name).toBe("manage_context");
  expect(mcRow.manageable).toBe(false);
  expect(mcRow.summary_line).toBe("2 managed · 420 B / 18.4 KiB");

  const searched = await service.handle("list", { scope_key: scope, query: "manage" });
  expect(searched.ok).toBe(true);
  expect(searched.items.map((r: any) => r.tool_call_id)).toContain("call_mc_1");
});

test("Hermes local state.db loads full chronological timeline on the server, enables msg:* prompt hide/unhide, and preserves options_omitted on tool hide", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home, store, service } = fixture([]);
  const hermesSession = "local-hermes-unified-test";
  const hermesScope = `hermes:atlas:${hermesSession}:unknown`;
  store.register(hermesScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "hermes-test",
  });

  const profileDir = join(home, ".hermes/profiles/atlas");
  mkdirSync(profileDir, { recursive: true });
  const hdb = new DatabaseSync(join(profileDir, "state.db"));
  try {
    hdb.exec(`
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
    hdb
      .prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)")
      .run(
        hermesSession,
        JSON.stringify({
          gateway_runtime: { api_mode: "codex_responses" },
          _usage_anchor: { prompt_tokens: 42000, completion_tokens: 800 },
        }),
      );
    const ins = hdb.prepare(`
      INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, codex_message_items, api_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    ins.run(hermesSession, "user", "Pre-interruption user prompt", null, null, null, null, "Pre-interruption user prompt\n<session_context>");
    ins.run(
      hermesSession,
      "assistant",
      "",
      null,
      JSON.stringify([
        {
          call_id: "call_h_term",
          type: "function",
          function: {
            name: "terminal",
            arguments: JSON.stringify({ command: "kubectl get pods -n neurons", timeout: 30 }),
          },
        },
      ]),
      null,
      JSON.stringify([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Checking neurons pods before interrupt" }],
        },
      ]),
      null,
    );
    const longOut = Array.from({ length: 40 }, (_, i) => `neurons-pod-${i}   1/1   Running   0   5d`).join("\n");
    ins.run(hermesSession, "tool", longOut, "call_h_term", null, "terminal", null, null);
    ins.run(
      hermesSession,
      "user",
      '<paseo-system version="1" kind="agent-notification" source-agent-id="sub-1" source-agent-title="Audit pods" event="finished">done</paseo-system>',
      null,
      null,
      null,
      null,
      null,
    );
    ins.run(hermesSession, "assistant", "Operation interrupted: waiting for model response (3.5s elapsed).", null, null, null, null, null);
    ins.run(hermesSession, "user", "Post-interruption follow-up prompt", null, null, null, null, "Post-interruption follow-up prompt");
  } finally {
    hdb.close();
  }

  const listed = await service.handle("list", { scope_key: hermesScope });
  expect(listed.ok).toBe(true);
  expect(listed.server_timeline).toBe(true);
  expect(listed.context).toEqual({
    used_tokens: 42800,
    max_tokens: null,
    source: "hermes_session_usage",
  });
  expect(listed.items.map((r: any) => r.kind)).toEqual([
    "user",
    "assistant",
    "tool",
    "user",
    "assistant",
    "user",
  ]);
  expect(listed.items[0].summary_line).toBe("Pre-interruption user prompt");
  expect(listed.items[0].item_id).toStartWith("msg:user:p0:");
  expect(listed.items[0].manageable).toBe(true);
  expect(listed.items[1].summary_line).toBe("Checking neurons pods before interrupt");
  expect(listed.items[2].tool_call_id).toBe("call_h_term");
  expect(listed.items[2].manageable).toBe(true);
  expect(listed.items[3].summary_line).toBe("[Subagent finished] Audit pods");

  // Hide and unhide the Hermes user prompt via msg:* unit ID
  const hidePrompt = await service.handle("hide", {
    scope_key: hermesScope,
    item_id: listed.items[0].item_id,
  });
  expect(hidePrompt.ok).toBe(true);
  expect(hidePrompt.visibility).toBe("hidden");

  // Hide the Hermes terminal tool call (with timeout: 30 -> options_omitted digest is preserved; manual hide omits invocation_snapshot)
  const hideTool = await service.handle("hide", {
    scope_key: hermesScope,
    item_id: listed.items[2].item_id,
  });
  expect(hideTool.ok).toBe(true);
  const storedTool = store.get(hermesScope, listed.items[2].item_id);
  expect(storedTool?.compacted).toBe("[hidden: terminal call_h_term]");
  expect(storedTool?.invocation_digest).toBe(
    invocationDigest(
      { tool_name: "terminal", arguments: { command: "kubectl get pods -n neurons" } },
      { timeout: 30 },
    ),
  );
  expect(storedTool?.invocation_snapshot).toBe(null);
  expect(storedTool?.invocation_options_omitted).toBe(false);
});

test("unregistered Hermes custom profiles and new OMP sessions get virtual scopes and immediate server_timeline", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home, service } = fixture([], false);
  const agentsDir = join(home, ".paseo/agents/ws");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(home, ".paseo/config.json"),
    JSON.stringify({
      agents: {
        providers: {
          "hermes-ariadne": { extends: "acp", command: ["hermes", "-p", "ariadne", "acp"] },
        },
      },
    }),
  );
  // 1. Registered on disk (OMP JSONL + Hermes profile DB), but NOT in adapter_sessions/items/units
  writeFileSync(
    join(agentsDir, "omp-new.json"),
    JSON.stringify({ id: "agent-omp-new", provider: "omp", persistence: { provider: "omp", sessionId: "sid", metadata: {} } }),
  );
  writeFileSync(
    join(agentsDir, "ariadne.json"),
    JSON.stringify({
      id: "agent-ariadne",
      provider: "hermes-ariadne",
      persistence: { provider: "hermes-ariadne", sessionId: "ariadne-sid", metadata: { provider: "acp" } },
    }),
  );
  writeFileSync(
    join(agentsDir, "claude-acp.json"),
    JSON.stringify({
      id: "agent-claude-acp",
      provider: "claude",
      persistence: { provider: "acp", sessionId: "claude-sid", metadata: { provider: "acp" } },
    }),
  );
  const sessionsDir = join(home, ".omp/agent/sessions/project");
  writeFileSync(
    join(sessionsDir, "2026_sid.jsonl"),
    JSON.stringify({ type: "message", message: { role: "user", timestamp: 1, content: "hello omp" } }),
  );
  const ariadneDir = join(home, ".hermes/profiles/ariadne");
  mkdirSync(ariadneDir, { recursive: true });
  const db = new DatabaseSync(join(ariadneDir, "state.db"));
  try {
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
    db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("ariadne-sid", "{}");
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
      "ariadne-sid",
      "user",
      "hello ariadne",
    );
  } finally {
    db.close();
  }

  const scopesReply = await service.handle("scopes", {});
  expect(scopesReply.ok).toBe(true);
  const byAgent = new Map(scopesReply.scopes.map((s: any) => [s.agent_id, s]));
  expect(byAgent.get("agent-omp-new")).toMatchObject({
    scope_key: "omp:default:sid:default",
    items: 0,
  });
  expect(byAgent.get("agent-ariadne")).toMatchObject({
    scope_key: "hermes:ariadne:ariadne-sid:unknown",
    items: 0,
  });
  expect(byAgent.has("agent-claude-acp")).toBe(false);

  const ariadneList = await service.handle("list", { scope_key: "hermes:ariadne:ariadne-sid:unknown" });
  expect(ariadneList.ok).toBe(true);
  expect(ariadneList.server_timeline).toBe(true);
  expect(ariadneList.items[0].summary_line).toBe("hello ariadne");

  const { hasHermesSession } = await import("./hermesHistory.ts");
  expect(hasHermesSession(home, "ariadne", "ariadne-sid")).toBe(true);
  expect(hasHermesSession(home, "ariadne", "claude-sid")).toBe(false);
});

test("OMP summary_line normalizes <paseo-system>, <system-reminder>, <system-notice> and preserves hidden tool summaries", async () => {
  const { call, store } = fixture([
    {
      role: "user",
      timestamp: 100,
      content:
        '<system-reminder>Secret reminder block</system-reminder><paseo-system version="1" kind="agent-message" source-agent-id="sub-999999" source-agent-title="Reviewer">Please inspect the diff carefully.\nSecond line</paseo-system>',
    },
    {
      role: "user",
      timestamp: 200,
      content:
        '<system-notice>Notice text</system-notice><paseo-system version="1" kind="agent-notification" source-agent-id="sub-123" source-agent-title="Worker" event="finished">Done</paseo-system>',
    },
    {
      role: "user",
      timestamp: 300,
      content: "<system-reminder>Ignored</system-reminder>\n진행해",
    },
    {
      role: "assistant",
      timestamp: 400,
      content: [{ type: "toolCall", id: "c_short", name: "bash", arguments: { command: "ls -la" } }],
    },
    {
      role: "toolResult",
      toolCallId: "c_short",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "short" }],
    },
  ]);

  const listedBefore = await call("list");
  expect(listedBefore.items[0].summary_line).toBe("[Agent message · Reviewer] Please inspect the diff carefully.");
  expect(listedBefore.items[1].summary_line).toBe("[Subagent finished] Worker");
  expect(listedBefore.items[2].summary_line).toBe("진행해");

  const toolRow = listedBefore.items[3];
  const hidden = await call("hide", { item_id: toolRow.item_id, mode: "hide" });
  expect(hidden.ok).toBe(true);
  const stored = store.get(scope, toolRow.item_id)!;
  expect(stored.compacted).toBe("[hidden: bash c_short]");

  const listedAfter = await call("list");
  const hiddenToolRow = listedAfter.items.find((r: any) => r.item_id === toolRow.item_id);
  expect(hiddenToolRow.status).toBe("hidden");
  expect(hiddenToolRow.summary_line).toBe("short");
});

test("hermesHistory normalizes trimmed call_id and increments result_position per call occurrence", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { loadHermesTimeline } = await import("./hermesHistory.ts");
  const { home } = fixture([]);
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const db = new DatabaseSync(join(home, ".hermes/state.db"));
  try {
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
    db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("dup-pos", "{}");
    const ins = db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?, ?)");
    ins.run("dup-pos", "assistant", "", null, JSON.stringify([{ id: " call_dup ", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]), null);
    ins.run("dup-pos", "tool", "first result", " call_dup ", null, "read_file");
    ins.run("dup-pos", "tool", "second result", "call_dup", null, "read_file");
  } finally {
    db.close();
  }
  const scopeKey = "hermes:default:dup-pos:unknown";
  const inv = { tool_name: "read_file", arguments: { path: "a.txt" } };
  const digest = invocationDigest(inv);
  const item0: Item = {
    item_id: itemId(scopeKey, "call_dup", sha256("first result"), digest, 0),
    tool_call_id: "call_dup",
    result_position: 0,
    content_sha256: sha256("first result"),
    invocation_digest: digest,
    original: "first result",
    compacted: "[hidden:0]",
    excerpt_lines: [],
    visibility: "hidden",
    version: 2,
    tool_name: "read_file",
    compaction_source: "explicit_user_hide",
    invocation_snapshot: inv,
    context_hint: null,
    invocation_options_omitted: false,
    created_at: 0,
    updated_at: 0,
  };
  const item1: Item = {
    ...item0,
    item_id: itemId(scopeKey, "call_dup", sha256("second result"), digest, 1),
    result_position: 1,
    content_sha256: sha256("second result"),
    original: "second result",
    compacted: "[hidden:1]",
  };
  const tl = loadHermesTimeline(home, scopeKey, [item0, item1]);
  expect(tl).not.toBeNull();
  const toolRows = tl!.rows.filter((r) => r.kind === "tool");
  expect(toolRows.map((r) => r.item_id)).toEqual([item0.item_id, item1.item_id]);
});

test("explicit_user_hide prioritizes verified adapter_targets while strictly enforcing destructive_command and identity fencing", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home, store, service, register } = fixture([], false);
  const hScope = "hermes:atlas:target-prio:unknown";
  register(hScope);

  // Publish a verified target with options_omitted = 1 AND also put a Hermes state.db row
  const targetContent = Array.from({ length: 40 }, (_, i) => `line ${i}: ok`).join("\n");
  const targetInv = { tool_name: "terminal", arguments: { command: "echo hi" } };
  const targetOmitted = { timeout: 45 };
  const targetDigest = invocationDigest(targetInv, targetOmitted);
  const targetSha = sha256(targetContent);
  const targetItemId = itemId(hScope, "call_prio", targetSha, targetDigest, 0);
  store.publishTargets(hScope, [
    {
      record: {
        call_id: "call_prio",
        content: targetContent,
        content_sha256: targetSha,
        invocation: targetInv,
        invocation_digest: targetDigest,
        result_position: 0,
        status: "ok",
      },
      omitted: targetOmitted,
    },
  ]);

  const profileDir = join(home, ".hermes/profiles/atlas");
  mkdirSync(profileDir, { recursive: true });
  const hdb = new DatabaseSync(join(profileDir, "state.db"));
  try {
    hdb.exec(`
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
    hdb.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("target-prio", "{}");
    const ins = hdb.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?, ?)");
    // State.db has no omitted timeout, whereas adapter_targets has verified omitted timeout!
    ins.run("target-prio", "assistant", "", null, JSON.stringify([{ id: "call_prio", type: "function", function: { name: "terminal", arguments: '{"command":"echo hi"}' } }]), null);
    ins.run("target-prio", "tool", targetContent, "call_prio", null, "terminal");
    // Also add a destructive command row to verify explicit_user_hide strictly refuses destructive_command!
    ins.run("target-prio", "assistant", "", null, JSON.stringify([{ id: "call_rm", type: "function", function: { name: "terminal", arguments: '{"command":"rm -rf /tmp/evil"}' } }]), null);
    ins.run("target-prio", "tool", "deleted", "call_rm", null, "terminal");
  } finally {
    hdb.close();
  }

  // Hiding by tool_call_id keeps the verified invocation_digest. Manual hide no
  // longer stores the invocation snapshot or an excerpt: it writes a single-line
  // replacement and keeps only the original output for preview/unhide.
  const hidePrio = await service.handle("hide", { scope_key: hScope, item_id: "call_prio" });
  expect(hidePrio.ok).toBe(true);
  expect(hidePrio.item_id).toBe(targetItemId);
  expect(store.get(hScope, targetItemId)?.invocation_options_omitted).toBe(false);
  expect(store.get(hScope, targetItemId)?.invocation_snapshot).toBe(null);
  expect(store.get(hScope, targetItemId)?.excerpt_lines).toEqual([]);
  expect(store.get(hScope, targetItemId)?.compacted).toBe("[hidden: terminal call_prio]");
  expect(store.get(hScope, targetItemId)?.invocation_digest).toBe(targetDigest);

  // Destructive commands MUST still be refused even for explicit_user_hide
  const hideRm = await service.handle("hide", { scope_key: hScope, item_id: "call_rm" });
  expect(hideRm.ok).toBe(false);
  expect(hideRm.error).toBe("destructive_command");

  // Identity fencing: different invocation_digest for the same (call_id, content_sha256, result_position) -> invocation_conflict
  const altDigest = invocationDigest({ tool_name: "terminal", arguments: { command: "echo alt" } });
  const altItemId = itemId(hScope, "call_prio", targetSha, altDigest, 0);
  store.publishTargets(hScope, [
    {
      record: {
        call_id: "call_prio",
        content: targetContent,
        content_sha256: targetSha,
        invocation: { tool_name: "terminal", arguments: { command: "echo alt" } },
        invocation_digest: altDigest,
        result_position: 0,
        status: "ok",
      },
    },
  ]);
  const fenceFail = await service.handle("hide", { scope_key: hScope, item_id: altItemId });
  expect(fenceFail.ok).toBe(false);
  expect(fenceFail.error).toBe("invocation_conflict");

  // Tampered adapter_targets row fails integrity verification and cannot bypass content_tampered
  const tamperedId = itemId(hScope, "call_tampered", sha256("real"), targetDigest, 0);
  store.driver.run(
    "INSERT INTO adapter_targets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      hScope,
      tamperedId,
      "call_tampered",
      0,
      targetDigest,
      JSON.stringify(targetInv),
      "tampered body",
      sha256("real"),
      "terminal",
      0,
      0,
      999,
    ],
  );
  expect((await service.handle("hide", { scope_key: hScope, item_id: "call_tampered" })).error).toBe(
    "not_found",
  );
});

test("OMP JSONL timeline cache isolates caller mutations and invalidates immediately on file change", () => {
  const { home } = fixture(toolMessages("alpha"));
  const filePath = join(home, ".omp/agent/sessions/project/2026_sid.jsonl");

  const t1 = loadTimeline(home, scope);
  expect(t1.rows.length).toBeGreaterThan(0);
  const originalToolCount = t1.rows.length;
  const originalRecordSize = t1.records.size;

  // Mutate returned rows and records; cached entry must stay completely isolated
  t1.rows[0].summary_line = "MUTATED_SUMMARY";
  t1.rows.push({ item_id: "injected", kind: "user" });
  t1.records.clear();

  const t2 = loadTimeline(home, scope);
  expect(t2.rows).toHaveLength(originalToolCount);
  expect(t2.rows[0].summary_line).not.toBe("MUTATED_SUMMARY");
  expect(t2.records.size).toBe(originalRecordSize);

  // Update JSONL file (size + mtime change) -> cache invalidates immediately
  writeFileSync(
    filePath,
    toolMessages("beta updated output")
      .map((m) => JSON.stringify({ type: "message", message: m }))
      .join("\n"),
  );
  const t3 = loadTimeline(home, scope);
  expect(t3.records.get("c1")?.content).toBe("beta updated output");

  // Explicit mtime change with identical size also invalidates
  const bumped = new Date(Date.now() + 10_000);
  utimesSync(filePath, bumped, bumped);
  const t4 = loadTimeline(home, scope);
  expect(t4.records.get("c1")?.content).toBe("beta updated output");
});

test("Hermes state.db timeline cache invalidates within the same ms and distinguishes absent session from matched DB read error", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home } = fixture([]);
  const hermesDir = join(home, ".hermes");
  mkdirSync(hermesDir, { recursive: true });
  const dbPath = join(hermesDir, "state.db");
  const db = new DatabaseSync(dbPath);
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
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("cache-sid", "{}");
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
    "cache-sid",
    "user",
    "prompt 1",
  );

  const scopeKey = "hermes:default:cache-sid:unknown";
  const tl1 = loadHermesTimeline(home, scopeKey);
  expect(tl1).not.toBeNull();
  expect(tl1!.rows.map((r) => r.summary_line)).toEqual(["prompt 1"]);
  // Mutate returned rows to verify shallow-clone isolation
  tl1!.rows[0].summary_line = "MUTATED";
  const tl2 = loadHermesTimeline(home, scopeKey);
  expect(tl2!.rows.map((r) => r.summary_line)).toEqual(["prompt 1"]);

  // Modify DB inside the same ms (UPDATE with same byte length!) -> change counter detects immediately
  db.prepare("UPDATE messages SET content = ? WHERE session_id = ?").run("prompt 2", "cache-sid");
  const tl3 = loadHermesTimeline(home, scopeKey);
  expect(tl3!.rows.map((r) => r.summary_line)).toEqual(["prompt 2"]);

  // Absent session returns null
  expect(loadHermesTimeline(home, "hermes:default:nonexistent-sid:unknown")).toBeNull();

  // Matched session whose DB fails while reading messages distinguishes readError from null
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("broken-sid", "{}");
  db.exec("DROP TABLE messages");
  db.close();

  const broken = loadHermesTimeline(home, "hermes:default:broken-sid:unknown");
  expect(broken).not.toBeNull();
  expect(broken!.rows).toEqual([]);
  expect(typeof broken!.history.readError).toBe("string");
  expect(broken!.history.readErrorDb).toBe(dbPath);

  // If a secondary candidate DB holds a healthy copy, fallback succeeds cleanly without readError
  const fallbackDir = join(hermesDir, "profiles/backup");
  mkdirSync(fallbackDir, { recursive: true });
  const fbDb = new DatabaseSync(join(fallbackDir, "state.db"));
  try {
    fbDb.exec(`
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
    fbDb.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("broken-sid", "{}");
    fbDb.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
      "broken-sid",
      "user",
      "recovered prompt",
    );
  } finally {
    fbDb.close();
  }
  const recovered = loadHermesTimeline(home, "hermes:default:broken-sid:unknown");
  expect(recovered).not.toBeNull();
  expect(recovered!.history.readError).toBeUndefined();
  expect(recovered!.rows.map((r) => r.summary_line)).toEqual(["recovered prompt"]);

  // WAL mode same-ms write invalidation check + service list surfacing timeline_read_error
  const walDir = join(hermesDir, "profiles/walprof");
  mkdirSync(walDir, { recursive: true });
  const wdb = new DatabaseSync(join(walDir, "state.db"));
  try {
    wdb.exec("PRAGMA journal_mode=WAL");
    wdb.exec(`
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
    wdb.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("wal-sid", "{}");
    wdb.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
      "wal-sid",
      "user",
      "wal initial",
    );
    expect(loadHermesTimeline(home, "hermes:walprof:wal-sid:unknown")!.rows.map((r) => r.summary_line)).toEqual([
      "wal initial",
    ]);
    wdb.prepare("UPDATE messages SET content = ? WHERE session_id = ?").run("wal updated", "wal-sid");
    expect(loadHermesTimeline(home, "hermes:walprof:wal-sid:unknown")!.rows.map((r) => r.summary_line)).toEqual([
      "wal updated",
    ]);
  } finally {
    wdb.close();
  }

  const { home: errHome, service } = fixture([]);
  const errHermesDir = join(errHome, ".hermes/profiles/onlybroken");
  mkdirSync(errHermesDir, { recursive: true });
  const errDb = new DatabaseSync(join(errHermesDir, "state.db"));
  errDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT)");
  errDb.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("only-broken", "{}");
  errDb.close();
  const brokenList = await service.handle("list", {
    scope_key: "hermes:onlybroken:only-broken:unknown",
  });
  expect(brokenList.ok).toBe(true);
  expect(brokenList.server_timeline).toBe(false);
  expect(typeof brokenList.timeline_read_error).toBe("string");
});

test("shared host_identity.json v1 contract matches OMP context, history.ts, and hermesHistory.ts", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fixturePath = resolve(import.meta.dir, "../../contracts/fixtures/host_identity.json");
  const hostFix = JSON.parse(readFileSync(fixturePath, "utf8"));
  expect(hostFix.version).toBe(1);

  const { home } = fixture([]);
  const ompDir = join(home, ".omp/agent/sessions/contract");
  mkdirSync(ompDir, { recursive: true });

  const ompEntries: Message[] = [];
  for (const m of hostFix.omp.messages) {
    expect(ompMessageKey(m.message)).toBe(m.expected_key);
    expect(messageKey(0, m.message)).toBe(m.expected_key);
    ompEntries.push(m.message);
  }
  for (const t of hostFix.omp.tools) {
    const rawArgs = JSON.parse(t.raw_arguments_json);
    const filteredArgs = ompInvocationArgs(t.tool_name, rawArgs);
    expect(filteredArgs).not.toBeNull();
    const inv = { tool_name: t.tool_name, arguments: filteredArgs as any };
    expect(canonical(inv)).toBe(t.expected_invocation_json);
    expect(invocationDigest(inv)).toBe(t.expected_invocation_digest);
    const toolResultMsg = {
      role: "toolResult",
      toolCallId: t.call_id,
      toolName: t.tool_name,
      isError: false,
      content: t.result_content,
    };
    expect(toolResultText(toolResultMsg)).toBe(t.expected_text);
    ompEntries.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: t.call_id, name: t.tool_name, arguments: rawArgs }],
      },
      toolResultMsg,
    );
  }
  writeFileSync(
    join(ompDir, "2026_fixture-omp-sid.jsonl"),
    ompEntries.map((message) => JSON.stringify({ type: "message", message })).join("\n"),
  );
  const ompTl = loadTimeline(home, hostFix.omp.scope);
  for (const m of hostFix.omp.messages) {
    const row = ompTl.rows.find((r) => r.item_id === m.expected_key);
    expect(row?.summary_line).toBe(m.expected_summary_line);
  }
  for (const t of hostFix.omp.tools) {
    const rec = ompTl.records.get(t.call_id);
    const row = ompTl.rows.find((r) => r.tool_call_id === t.call_id);
    expect(rec?.content).toBe(t.expected_text);
    expect(rec?.content_sha256).toBe(t.expected_content_sha256);
    expect(rec?.invocation_digest).toBe(t.expected_invocation_digest);
    expect(row?.item_id).toBe(t.expected_item_id);
  }

  for (const invCase of hostFix.hermes.invocations) {
    const res = hermesFilterInvocation(invCase.tool_name, invCase.raw_arguments_json);
    expect(res).not.toBeNull();
    expect(canonical(res!.invocation)).toBe(invCase.expected_invocation_json);
    expect(canonical(res!.omitted ?? {})).toBe(invCase.expected_omitted_json);
    expect(invocationDigest(res!.invocation, res!.omitted)).toBe(invCase.expected_invocation_digest);
  }

  mkdirSync(join(home, ".hermes"), { recursive: true });
  const hdb = new DatabaseSync(join(home, ".hermes/state.db"));
  try {
    hdb.exec(`
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
    const insS = hdb.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)");
    const insM = hdb.prepare(
      "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, codex_message_items, api_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const mode of ["chat_completions", "codex_responses"] as const) {
      const sec = hostFix.hermes[mode];
      insS.run(sec.session_id, JSON.stringify({ gateway_runtime: { api_mode: mode } }));
      for (const r of sec.db_rows) {
        insM.run(
          sec.session_id,
          r.role,
          r.content ?? null,
          r.tool_call_id ?? null,
          r.tool_calls ? JSON.stringify(r.tool_calls) : null,
          r.tool_name ?? null,
          r.codex_message_items ? JSON.stringify(r.codex_message_items) : null,
          r.api_content ?? null,
        );
      }
      const tl = loadHermesTimeline(home, sec.scope);
      expect(tl).not.toBeNull();
      expect(
        tl!.rows.filter((r) => r.kind === "user" || r.kind === "assistant").map((r) => r.item_id),
      ).toEqual(sec.expected_message_keys);
      const tRow = tl!.rows.find((r) => r.tool_call_id === sec.expected_tool.call_id);
      const tRec = tl!.records.get(sec.expected_tool.call_id);
      expect(tRec?.invocation_digest).toBe(sec.expected_tool.invocation_digest);
      expect(tRow?.item_id).toBe(sec.expected_tool.expected_item_id);
    }

    const multi = hostFix.hermes.multi_result;
    insS.run(multi.session_id, JSON.stringify({ gateway_runtime: { api_mode: "codex_responses" } }));
    for (const r of multi.db_rows) {
      insM.run(
        multi.session_id,
        r.role,
        r.content ?? null,
        r.tool_call_id ?? null,
        r.tool_calls ? JSON.stringify(r.tool_calls) : null,
        r.tool_name ?? null,
        null,
        null,
      );
    }
    const storedMulti: Item[] = multi.expected_results.map((er: any) => ({
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
      invocation_snapshot: { tool_name: "read_file", arguments: { path: "multi.txt" } },
      context_hint: null,
      invocation_options_omitted: false,
      created_at: 0,
      updated_at: 0,
    }));
    const tlMulti = loadHermesTimeline(home, multi.scope, storedMulti);
    expect(tlMulti).not.toBeNull();
    expect(tlMulti!.rows.filter((r) => r.kind === "tool").map((r) => r.item_id)).toEqual(
      multi.expected_results.map((er: any) => er.expected_item_id),
    );
  } finally {
    hdb.close();
  }
});

test("list RPC supports limit + before_index cursor pagination, preserves contiguous tool groups across page boundaries, and keeps full-session totals", async () => {
  const messages: Message[] = [
    { role: "user", timestamp: 100, content: "First prompt" },
    {
      role: "assistant",
      timestamp: 200,
      content: [
        { type: "toolCall", id: "t_old_hidden", name: "read", arguments: { path: "old.txt" } },
      ],
    },
    {
      role: "toolResult",
      timestamp: 210,
      toolCallId: "t_old_hidden",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "old output ".repeat(120) }],
    },
    { role: "user", timestamp: 300, content: "Second prompt" },
    {
      role: "assistant",
      timestamp: 400,
      content: [
        { type: "toolCall", id: "t_grp_1", name: "bash", arguments: { command: "echo 1" } },
        { type: "toolCall", id: "t_grp_2", name: "bash", arguments: { command: "echo 2" } },
        { type: "toolCall", id: "t_grp_3", name: "bash", arguments: { command: "echo 3" } },
      ],
    },
    {
      role: "toolResult",
      timestamp: 410,
      toolCallId: "t_grp_1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "g1" }],
    },
    {
      role: "toolResult",
      timestamp: 420,
      toolCallId: "t_grp_2",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "g2" }],
    },
    {
      role: "toolResult",
      timestamp: 430,
      toolCallId: "t_grp_3",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "g3" }],
    },
    { role: "assistant", timestamp: 500, content: [{ type: "text", text: "Latest reply" }] },
  ];

  const { call } = fixture(messages);
  const full = await call("list");
  expect(full.items).toHaveLength(7); // u0, t_old_hidden, u1, t_grp_1, t_grp_2, t_grp_3, ast_latest
  expect(full.items.map((r: any) => r.timeline_index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(full.has_older).toBe(false);
  expect(full.next_before_index).toBeNull();

  // Hide the older tool call (timeline_index = 1) so it sits outside the tail slice
  const oldTool = full.items[1];
  const hidden = await call("hide", { item_id: oldTool.item_id, expected_version: oldTool.version });
  expect(hidden.ok).toBe(true);

  // Request latest 3 rows -> index 4, 5, 6 starts inside the contiguous tool group [3, 4, 5]!
  // Server must expand startIndex backward to 3 so the tool group is NEVER split across pages.
  const tailPage = await call("list", { limit: 3 });
  expect(tailPage.items.map((r: any) => r.timeline_index)).toEqual([3, 4, 5, 6]);
  expect(tailPage.has_older).toBe(true);
  expect(tailPage.next_before_index).toBe(3);
  expect(tailPage.totals).toEqual({
    total_rows: 7,
    manageable_count: 7,
    hidden_count: 1,
    saved_bytes: Math.max(0, hidden.item.bytes_size - hidden.item.compacted_bytes_size),
  });

  // Request older page using next_before_index=3 with limit=2 -> gets [1, 2], has_older=true, next_before_index=1
  const olderPage = await call("list", { limit: 2, before_index: tailPage.next_before_index });
  expect(olderPage.items.map((r: any) => r.timeline_index)).toEqual([1, 2]);
  expect(olderPage.items[0].status).toBe("hidden");
  expect(olderPage.has_older).toBe(true);
  expect(olderPage.next_before_index).toBe(1);

  // Final older page
  const firstPage = await call("list", { limit: 5, before_index: olderPage.next_before_index });
  expect(firstPage.items.map((r: any) => r.timeline_index)).toEqual([0]);
  expect(firstPage.has_older).toBe(false);
  expect(firstPage.next_before_index).toBeNull();

  // Search query returns matching older rows across the entire session without paging slice
  const searchRes = await call("list", { query: "First prompt", limit: 2 });
  expect(searchRes.items.map((r: any) => r.timeline_index)).toEqual([0]);
  expect(searchRes.has_older).toBe(false);
});

function installRepoHermesPlugin(home: string): string {
  const targetVendor = join(home, ".hermes/plugins/session-navigation/vendor");
  mkdirSync(join(home, ".hermes/plugins/session-navigation"), { recursive: true });
  cpSync(resolve(import.meta.dir, "../../hermes-plugin/vendor"), targetVendor, { recursive: true });
  const check = inspectHermesPluginInstall(home);
  expect(check.protectionSupportedOnDisk).toBe(true);
  expect(typeof check.bundleFingerprint).toBe("string");
  return check.bundleFingerprint!;
}

test("session-nav adapter toggles inspect, require verified protection before disabling, update multi-profile Hermes YAML with rollback, sync capabilities, and reject symlinks", async () => {
  const { home, store, service, register } = fixture([], true);

  // Default state before .hermes exists
  const initial = await service.handle("session-nav.get-adapter-toggles", {});
  expect(initial.ok).toBe(true);
  expect(initial.omp).toMatchObject({ installed: true, enabled: true });
  expect(initial.hermes).toMatchObject({ installed: false, enabled: false, profileCount: 0 });

  // Build default + 2 named Hermes profiles inside temp home
  const hermesRoot = join(home, ".hermes");
  const atlasDir = join(hermesRoot, "profiles", "atlas");
  const tycheDir = join(hermesRoot, "profiles", "tyche");
  mkdirSync(atlasDir, { recursive: true });
  mkdirSync(tycheDir, { recursive: true });

  const rootCfg = join(hermesRoot, "config.yaml");
  const atlasCfg = join(atlasDir, "config.yaml");
  const tycheCfg = join(tycheDir, "config.yaml");

  writeFileSync(
    rootCfg,
    [
      "# Global Hermes configuration",
      "model: claude-3-7-sonnet # keep model intact",
      "plugins:",
      "  entries:",
      "    other-plugin:",
      "      enabled: true",
      "    session-navigation:",
      "      enabled: true # still valid",
      "      settings:",
      "        enabled: true # toggle comment preserved",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    atlasCfg,
    [
      "# Atlas profile config",
      "model: gpt-5",
      "plugins:",
      "  entries:",
      "    session-navigation:",
      "      settings:",
      "        enabled: false",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    tycheCfg,
    [
      "# Tyche profile config without session-navigation entry yet",
      "model: gemini-2.5-pro",
      "",
    ].join("\n"),
    "utf8",
  );

  // Register hermes scope with a hidden message so unhide stays true when paused
  const hermesScope = "hermes:atlas:sid:main";
  register(hermesScope);
  expect(
    store.setMessageVisibility(hermesScope, "msg:user:1", "user", "sha", 4, "hidden", 1).ok,
  ).toBe(true);

  const mixed = await service.handle("session-nav.get-adapter-toggles", {});
  expect(mixed.ok).toBe(true);
  expect(mixed.hermes).toMatchObject({
    installed: true,
    enabled: true,
    mixed: true,
    profileCount: 3,
    canDisable: true,
    protectionVerified: false,
  });

  // Pausing Hermes via Settings updates shared SQLite adapter_control only while leaving config.yaml
  // intact so older/frozen Hermes processes never disable middleware protection.
  const pausedBeforeInstall = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: false,
  });
  expect(pausedBeforeInstall.ok).toBe(true);
  expect(pausedBeforeInstall.hermes).toMatchObject({
    installed: true,
    enabled: false,
    mixed: true,
    profileCount: 3,
    canDisable: true,
    protectionVerified: false,
    pluginInstalled: false,
  });
  expect(pausedBeforeInstall.hermes.warning).toContain("Hermes plugin is not installed");
  expect(readFileSync(rootCfg, "utf8")).toContain("enabled: true # toggle comment preserved");
  expect(readFileSync(atlasCfg, "utf8")).toContain("enabled: false");
  expect(store.getAdapterControl("hermes")?.enabled).toBe(false);
  expect(service.capabilities(hermesScope)).toMatchObject({
    state: "adapter_disabled",
    hide: false,
    summarize: false,
    unhide: true,
  });
  expect(service.capabilities(hermesScope).hint).toContain("D9");

  // Re-enable Hermes globally across all 3 profiles (writes config.yaml + clears mixed state)
  const enabledHermes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(enabledHermes.ok).toBe(true);
  expect(enabledHermes.hermes).toMatchObject({
    installed: true,
    enabled: true,
    profileCount: 3,
    protectionVerified: false,
    canDisable: true,
  });
  expect(enabledHermes.hermes.mixed).toBeUndefined();

  for (const cfgPath of [rootCfg, atlasCfg, tycheCfg]) {
    const content = readFileSync(cfgPath, "utf8");
    expect(content).toContain("# ");
    expect(content).toContain("model:");
    expect(content).toContain("enabled: true");
  }
  const rootAfterOn = readFileSync(rootCfg, "utf8");
  expect(rootAfterOn).toContain("# Global Hermes configuration");
  expect(rootAfterOn).toContain("model: claude-3-7-sonnet # keep model intact");
  expect(rootAfterOn).toContain("other-plugin:\n      enabled: true");
  expect(rootAfterOn).toContain("enabled: true # toggle comment preserved");
  expect(store.getAdapterControl("hermes")?.enabled).toBe(true);
  expect(service.capabilities(hermesScope).state).toBe("ready");

  // Install current Hermes plugin and register protection_only + bundle_fingerprint;
  // Pausing Off still stays DB-control-only and keeps protectionVerified=false (live process proof impossible via SQLite).
  const bundleFingerprint = installRepoHermesPlugin(home);
  const verifiedCaps = {
    hide: true,
    summarize: true,
    unhide: true,
    protection_only: true,
    bundle_fingerprint: bundleFingerprint,
  };
  register(hermesScope, verifiedCaps);
  register("hermes:default:sid-default:unknown", verifiedCaps);
  register("hermes:tyche:sid-tyche:unknown", verifiedCaps);

  const disabledHermes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: false,
  });
  expect(disabledHermes.ok).toBe(true);
  expect(disabledHermes.hermes).toMatchObject({
    installed: true,
    enabled: false,
    profileCount: 3,
    protectionSupportedOnDisk: true,
    protectionVerified: false,
    canDisable: true,
  });
  expect(disabledHermes.hermes.mixed).toBeUndefined();
  expect(readFileSync(rootCfg, "utf8")).toContain("enabled: true # toggle comment preserved");
  expect(readFileSync(atlasCfg, "utf8")).toContain("enabled: true");
  expect(readFileSync(tycheCfg, "utf8")).toContain("enabled: true");
  expect(disabledHermes.hermes.statusText).toContain("Paused via DB control");
  expect(disabledHermes.hermes.warning).toContain("Older Hermes sessions may keep running");
  expect(disabledHermes.hermes.warning).toContain("DB failures may send original content");
  expect(store.getAdapterControl("hermes")?.enabled).toBe(false);

  // Disable OMP via toggle and confirm capability state transitions cleanly
  const disabledOmp = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "omp",
    enabled: false,
  });
  expect(disabledOmp.ok).toBe(true);
  expect(disabledOmp.omp.enabled).toBe(false);
  expect(store.getAdapterControl("omp")?.enabled).toBe(false);
  expect(service.capabilities(scope).state).toBe("adapter_disabled");

  // Symlink defense: replacing a profile config with an external symlink must be rejected without touching target
  const externalTarget = join(home, "outside-secret.yaml");
  writeFileSync(externalTarget, "untouched: true\n", "utf8");
  rmSync(tycheCfg);
  symlinkSync(externalTarget, tycheCfg);

  const symlinkResult = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: false,
  });
  expect(symlinkResult.ok).toBe(false);
  expect(symlinkResult.error).toBe("unsafe_hermes_config_path");
  expect(readFileSync(externalTarget, "utf8")).toBe("untouched: true\n");
});

test("Hermes Off pauses via DB control only, preserves config.yaml for legacy processes, and never claims live-process verification", async () => {
  const { home, store, service, register } = fixture([], false);
  const hermesRoot = join(home, ".hermes");
  const atlasDir = join(hermesRoot, "profiles", "atlas");
  mkdirSync(atlasDir, { recursive: true });
  const rootCfg = join(hermesRoot, "config.yaml");
  const atlasCfg = join(atlasDir, "config.yaml");
  const enabledYaml = "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: true\n";
  writeFileSync(rootCfg, enabledYaml, "utf8");
  writeFileSync(atlasCfg, enabledYaml, "utf8");

  // 1. Legacy installed plugin (disabled middleware returns None) keeps config.yaml enabled when paused
  const legacyCore = join(hermesRoot, "plugins/session-navigation/vendor/session_navigation");
  const legacyAdapter = join(hermesRoot, "plugins/session-navigation/vendor/session_navigation_hermes");
  mkdirSync(legacyCore, { recursive: true });
  mkdirSync(legacyAdapter, { recursive: true });
  writeFileSync(join(legacyCore, "__init__.py"), "", "utf8");
  writeFileSync(join(legacyCore, "adapter_registry.py"), "class AdapterRegistryMixin:\n    pass\n", "utf8");
  writeFileSync(join(legacyAdapter, "__init__.py"), "", "utf8");
  writeFileSync(
    join(legacyAdapter, "factories.py"),
    "def make_middleware(state):\n    def on_llm_request(**kwargs):\n        return None\n    return on_llm_request\n",
    "utf8",
  );

  const legacyScope = "hermes:default:legacy-s1:unknown";
  register(legacyScope);
  const legacyInspect = await service.handle("session-nav.get-adapter-toggles", {});
  expect(legacyInspect.hermes).toMatchObject({
    pluginInstalled: true,
    protectionSupportedOnDisk: false,
    protectionVerified: false,
    canDisable: true,
  });
  const legacyOff = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: false,
  });
  expect(legacyOff.ok).toBe(true);
  expect(legacyOff.hermes.enabled).toBe(false);
  expect(legacyOff.hermes.protectionVerified).toBe(false);
  expect(legacyOff.hermes.warning).toContain("keeps config.yaml enabled");
  expect(readFileSync(rootCfg, "utf8")).toBe(enabledYaml);
  expect(readFileSync(atlasCfg, "utf8")).toBe(enabledYaml);

  // 2. Even after upgrading disk plugin AND registering current bundle_fingerprint,
  //    durable adapter_sessions rows never justify protectionVerified=true or editing config.yaml to false.
  rmSync(join(hermesRoot, "plugins"), { recursive: true, force: true });
  const bundleFingerprint = installRepoHermesPlugin(home);

  const atlasStaleScope = "hermes:atlas:stale-s2:unknown";
  store.register(legacyScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: false, unhide: true, protection_only: true, bundle_fingerprint: "stale-old-fp" },
    enabled: true,
    instance_id: "old-proc-1",
  }, 100);
  store.register(atlasStaleScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: false, unhide: true },
    enabled: true,
    instance_id: "old-proc-2",
  }, 100);
  const hiddenItem = seed(store, "item_hermes_hidden_1", atlasStaleScope);
  expect(
    store.put(atlasStaleScope, { ...hiddenItem, visibility: "hidden", version: 2 }, 1).ok,
  ).toBe(true);

  const staleInspect = await service.handle("session-nav.get-adapter-toggles", {});
  expect(staleInspect.hermes).toMatchObject({
    pluginInstalled: true,
    protectionSupportedOnDisk: true,
    protectionVerified: false,
    canDisable: true,
  });
  expect(staleInspect.hermes.unverifiedScopes).toContain(legacyScope);
  expect(staleInspect.hermes.unverifiedScopes).toContain(atlasStaleScope);

  // 3. Even after all known scopes register current capabilities, protectionVerified stays false
  //    and unhide recovery remains available while paused via DB control.
  const verifiedCaps = {
    hide: true,
    summarize: true,
    unhide: true,
    protection_only: true,
    bundle_fingerprint: bundleFingerprint,
  };
  store.register(legacyScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: verifiedCaps,
    enabled: true,
    instance_id: "new-proc-1",
  }, 1000);
  store.register(atlasStaleScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: verifiedCaps,
    enabled: true,
    instance_id: "new-proc-2",
  }, 1000);

  const originalNow = store.clock;
  (store as any).clock = () => 1500;
  try {
    const postUpdateInspect = await service.handle("session-nav.get-adapter-toggles", {});
    expect(postUpdateInspect.hermes).toMatchObject({
      enabled: false,
      protectionVerified: false,
      canDisable: true,
    });
    expect(postUpdateInspect.hermes.warning).toContain("Older Hermes sessions may keep running");
    expect(postUpdateInspect.hermes.warning).toContain("DB failures may send original content");
    expect(readFileSync(rootCfg, "utf8")).toBe(enabledYaml);
    expect(readFileSync(atlasCfg, "utf8")).toBe(enabledYaml);

    const unhidden = await service.handle("unhide", {
      scope_key: atlasStaleScope,
      item_id: hiddenItem.item_id,
    });
    expect(unhidden.ok).toBe(true);
  } finally {
    (store as any).clock = originalNow;
  }
});

test("multi-profile Hermes On toggle uses cooperative lock, crash journal, pre-validates YAML, rolls back cleanly, surfaces partial updates, and rolls back on single-tx SQLite failure", async () => {
  const { home, store, service, register } = fixture([], false);
  const hermesRoot = join(home, ".hermes");
  const atlasDir = join(hermesRoot, "profiles", "atlas");
  const tycheDir = join(hermesRoot, "profiles", "tyche");
  mkdirSync(atlasDir, { recursive: true });
  mkdirSync(tycheDir, { recursive: true });

  const rootCfg = join(hermesRoot, "config.yaml");
  const atlasCfg = join(atlasDir, "config.yaml");
  const tycheCfg = join(tycheDir, "config.yaml");

  const makeCfg = (label: string, enabled: boolean) =>
    `# ${label} header\nplugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: ${enabled} # keep comment\n`;

  writeFileSync(rootCfg, makeCfg("default", true), "utf8");
  writeFileSync(atlasCfg, makeCfg("atlas", false), "utf8");
  writeFileSync(tycheCfg, 'plugins: "scalar-invalid"\n', "utf8");

  const bundleFingerprint = installRepoHermesPlugin(home);
  const verifiedCaps = {
    hide: true,
    summarize: true,
    unhide: true,
    protection_only: true,
    bundle_fingerprint: bundleFingerprint,
  };
  register("hermes:default:s1:unknown", verifiedCaps);
  register("hermes:atlas:s2:unknown", verifiedCaps);
  register("hermes:tyche:s3:unknown", verifiedCaps);

  // 1. Pre-validation rejects malformed YAML in 3rd profile BEFORE writing any file
  const invalidYamlRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(invalidYamlRes.ok).toBe(false);
  expect(invalidYamlRes.error).toBe("hermes_invalid_config_yaml");
  expect(invalidYamlRes.hermes).toMatchObject({ rolledBack: false, partialUpdate: false });
  expect(readFileSync(rootCfg, "utf8")).toBe(makeCfg("default", true));
  expect(readFileSync(atlasCfg, "utf8")).toBe(makeCfg("atlas", false));

  // Fix tyche config for lock, commit, rollback, and SQLite transaction tests
  writeFileSync(tycheCfg, makeCfg("tyche", false), "utf8");

  // 2. Stale lock recovery (P1-9): an aged lock whose owner process is dead is
  //    recovered instead of deadlocking, while a live owner's lock still fails
  //    closed for BOTH On and Off writers with manual crash recovery guidance.
  const lockPath = join(hermesRoot, ".session-navigation-toggle.lock");
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 2147483647;
  const staleLockContent = JSON.stringify({
    pid: deadPid,
    startedAt: Date.now() - 300_000,
    nonce: "crashed-previous-toggle",
  });
  writeFileSync(lockPath, staleLockContent, "utf8");
  const pastTime = new Date(Date.now() - 300_000);
  utimesSync(lockPath, pastTime, pastTime);

  const recoveredOnRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(recoveredOnRes.ok).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
  expect(readFileSync(atlasCfg, "utf8")).toBe(makeCfg("atlas", true));
  // Reset the recovered toggle so later rollback assertions start from disabled.
  writeFileSync(atlasCfg, makeCfg("atlas", false), "utf8");
  writeFileSync(tycheCfg, makeCfg("tyche", false), "utf8");
  store.driver.run("DELETE FROM adapter_control WHERE adapter_id='hermes'");

  // A live owner's lock still fails closed for BOTH On and Off writers.
  const liveLockContent = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    nonce: "live-owner",
  });
  writeFileSync(lockPath, liveLockContent, "utf8");
  const lockedOnRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(lockedOnRes.ok).toBe(false);
  expect(lockedOnRes.error).toBe("hermes_toggle_locked");
  expect(lockedOnRes.hermes.error).toContain(".session-navigation-toggle.lock");
  expect(readFileSync(atlasCfg, "utf8")).toBe(makeCfg("atlas", false));
  expect(readFileSync(lockPath, "utf8")).toBe(liveLockContent);

  const lockedOffRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: false,
  });
  expect(lockedOffRes.ok).toBe(false);
  expect(lockedOffRes.error).toBe("hermes_toggle_locked");
  expect(lockedOffRes.hermes.error).toContain(".session-navigation-toggle.lock");
  expect(readFileSync(lockPath, "utf8")).toBe(liveLockContent);
  expect(store.getAdapterControl("hermes")).toBeNull();
  rmSync(lockPath);

  // Release ownership guard: stale lock handle A MUST NOT unlink contender B's lock after manual replacement
  const lockA = acquireHermesToggleLock(home);
  expect(lockA.ok).toBe(true);
  if (lockA.ok) {
    rmSync(lockPath);
    const lockB = acquireHermesToggleLock(home);
    expect(lockB.ok).toBe(true);
    lockA.release();
    expect(existsSync(lockPath)).toBe(true);
    const blockedByB = acquireHermesToggleLock(home);
    expect(blockedByB).toEqual({ ok: false, error: "hermes_toggle_locked" });
    if (lockB.ok) {
      lockB.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  }

  // Also verify lock stays held across YAML commit through SQLite setAdapterControl and journal cleanup
  let lockHeldDuringDbCommit = false;
  const origSetCtrlSpy = store.setAdapterControl.bind(store);
  store.setAdapterControl = ((adapterId: string, flag: boolean, now?: number) => {
    if (adapterId === "hermes") {
      lockHeldDuringDbCommit = existsSync(lockPath);
    }
    return origSetCtrlSpy(adapterId, flag, now);
  }) as typeof store.setAdapterControl;
  try {
    const spyOnRes = await service.handle("session-nav.set-adapter-toggle", {
      adapter: "hermes",
      enabled: true,
    });
    expect(spyOnRes.ok).toBe(true);
    expect(lockHeldDuringDbCommit).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    store.setAdapterControl = origSetCtrlSpy;
  }
  writeFileSync(atlasCfg, makeCfg("atlas", false), "utf8");
  writeFileSync(tycheCfg, makeCfg("tyche", false), "utf8");
  store.driver.run("DELETE FROM adapter_control WHERE adapter_id='hermes'");
  store.driver.run("UPDATE adapter_sessions SET enabled=1 WHERE adapter_id='hermes' OR scope_key LIKE 'hermes:%'");

  // 3. Commit failure on 3rd profile rolls back 1st and 2nd profiles cleanly and removes resolved journal
  const journalPath = join(hermesRoot, ".session-navigation-toggle.journal.json");
  service.hermesWriteOptions = {
    onBeforeCommitFile: (filePath) => {
      if (filePath === tycheCfg) throw new Error("injected_rename_fail");
    },
  };
  const rolledBackRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(rolledBackRes.ok).toBe(false);
  expect(rolledBackRes.error).toBe("injected_rename_fail");
  expect(rolledBackRes.hermes).toMatchObject({
    rolledBack: true,
    partialUpdate: false,
    updatedFiles: [],
    rollbackFailedFiles: [],
  });
  expect(rolledBackRes.hermes.rolledBackFiles).toEqual([atlasCfg, rootCfg]);
  expect(readFileSync(rootCfg, "utf8")).toBe(makeCfg("default", true));
  expect(readFileSync(atlasCfg, "utf8")).toBe(makeCfg("atlas", false));
  expect(readFileSync(tycheCfg, "utf8")).toBe(makeCfg("tyche", false));
  expect(existsSync(journalPath)).toBe(false);
  expect(store.getAdapterControl("hermes")).toBeNull();

  // 4. Commit failure on 3rd profile + rollback failure on 2nd profile surfaces partial update,
  //    per-profile state, and persists recovery journal across subsequent getAdapterToggles calls.
  service.hermesWriteOptions = {
    onBeforeCommitFile: (filePath) => {
      if (filePath === tycheCfg) throw new Error("disk_io_fail");
    },
    onBeforeRollbackFile: (filePath) => {
      if (filePath === atlasCfg) throw new Error("rollback_eacces");
    },
  };
  const partialRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(partialRes.ok).toBe(false);
  expect(partialRes.error).toBe("hermes_partial_update:disk_io_fail");
  expect(partialRes.hermes).toMatchObject({
    rolledBack: false,
    partialUpdate: true,
    mixed: true,
    rolledBackFiles: [rootCfg],
    rollbackFailedFiles: [atlasCfg],
  });
  expect(partialRes.hermes.profiles).toEqual([
    { profile: "default", configPath: rootCfg, enabled: true },
    { profile: "atlas", configPath: atlasCfg, enabled: true },
    { profile: "tyche", configPath: tycheCfg, enabled: false },
  ]);
  expect(partialRes.hermes.error).toContain("Partial config update");
  expect(partialRes.hermes.error).toContain(atlasCfg);
  expect(existsSync(journalPath)).toBe(true);

  const inspectedAfterPartial = await service.handle("session-nav.get-adapter-toggles", {});
  expect(inspectedAfterPartial.hermes).toMatchObject({
    partialUpdate: true,
    mixed: true,
    rollbackFailedFiles: [atlasCfg],
  });
  expect(inspectedAfterPartial.hermes.warning).toContain("journal");

  // Reconcile all profiles back to enabled=true, clearing the journal while preserving inline comments
  service.hermesWriteOptions = undefined;
  const reconciled = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(reconciled.ok).toBe(true);
  expect(reconciled.hermes.enabled).toBe(true);
  expect(reconciled.hermes.mixed).toBeUndefined();
  expect(existsSync(journalPath)).toBe(false);
  expect(readFileSync(rootCfg, "utf8")).toContain("enabled: true # keep comment");
  expect(readFileSync(atlasCfg, "utf8")).toContain("enabled: true # keep comment");

  // 5. Concurrent external writer modification before commit fails closed, rolls back earlier profiles,
  //    and preserves inline comments even when rootCfg was already enabled: true!
  const externalContent = "# external writer\nmodel: custom-external\n";
  service.hermesWriteOptions = {
    onBeforeCommitFile: (filePath) => {
      if (filePath === rootCfg) {
        writeFileSync(atlasCfg, externalContent, "utf8");
      }
    },
  };
  const concurrentRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(concurrentRes.ok).toBe(false);
  expect(concurrentRes.error).toBe("hermes_concurrent_modification");
  expect(concurrentRes.hermes.rolledBack).toBe(true);
  expect(readFileSync(rootCfg, "utf8")).toContain("enabled: true # keep comment");
  expect(readFileSync(atlasCfg, "utf8")).toBe(externalContent);

  // 6. Single-transaction SQLite failure (injected on UPDATE adapter_sessions inside setAdapterControl)
  //    rolls back both adapter_control AND committed config files so DB and disk never diverge!
  writeFileSync(atlasCfg, makeCfg("atlas", false), "utf8");
  writeFileSync(tycheCfg, makeCfg("tyche", false), "utf8");
  store.setAdapterControl("hermes", false, 500);
  service.hermesWriteOptions = undefined;
  const origDriverRun = store.driver.run.bind(store.driver);
  store.driver.run = ((sql: string, params?: unknown[]) => {
    if (sql.includes("UPDATE adapter_sessions")) {
      throw new EngineError("db_full");
    }
    return origDriverRun(sql, params);
  }) as typeof store.driver.run;
  try {
    const dbFailRes = await service.handle("session-nav.set-adapter-toggle", {
      adapter: "hermes",
      enabled: true,
    });
    expect(dbFailRes.ok).toBe(false);
    expect(dbFailRes.error).toBe("db_full");
    expect(dbFailRes.hermes.rolledBack).toBe(true);
    expect(store.getAdapterControl("hermes")?.enabled).toBe(false);
    expect(readFileSync(rootCfg, "utf8")).toContain("enabled: true # keep comment");
    expect(readFileSync(atlasCfg, "utf8")).toContain("enabled: false # keep comment");
    expect(readFileSync(tycheCfg, "utf8")).toContain("enabled: false # keep comment");
    expect(existsSync(journalPath)).toBe(false);
  } finally {
    store.driver.run = origDriverRun;
  }

  // 7. Post-DB-commit journal cleanup failure MUST NOT roll back already-committed YAML files;
  //    surfaces hermes_journal_cleanup_failed + residual journal while keeping SQLite and YAML enabled=true.
  service.hermesWriteOptions = {
    onBeforeClearJournal: () => {
      throw new Error("eperm_unlink_journal");
    },
  };
  const cleanupFailRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(cleanupFailRes.ok).toBe(false);
  expect(cleanupFailRes.error).toBe("hermes_journal_cleanup_failed:eperm_unlink_journal");
  expect(cleanupFailRes.hermes).toMatchObject({
    enabled: true,
    rolledBack: false,
    partialUpdate: true,
    mixed: true,
  });
  expect(store.getAdapterControl("hermes")?.enabled).toBe(true);
  expect(readFileSync(rootCfg, "utf8")).toContain("enabled: true # keep comment");
  expect(readFileSync(atlasCfg, "utf8")).toContain("enabled: true # keep comment");
  expect(readFileSync(tycheCfg, "utf8")).toContain("enabled: true # keep comment");
  expect(existsSync(journalPath)).toBe(true);

  service.hermesWriteOptions = undefined;
  const cleanedUpRes = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(cleanedUpRes.ok).toBe(true);
  expect(cleanedUpRes.hermes.mixed).toBeUndefined();
  expect(cleanedUpRes.hermes.partialUpdate).toBeUndefined();
  expect(existsSync(journalPath)).toBe(false);
});

test("Hermes YAML patching uses Document AST to preserve flow strings, block scalars, doc-end markers, user settings, and fail closed on ambiguous YAML", async () => {
  const { parse } = await import("yaml");

  // 1. String literal containing "enabled: false" inside flow map must NOT be mutated
  const flowInput = [
    "# user header",
    "model: claude-sonnet-4 # keep comment",
    "plugins:",
    "  entries:",
    "    session-navigation:",
    '      settings: {note: "hello, enabled: false", other: x}',
    "",
  ].join("\n");
  const flowPatched = patchHermesConfigYaml(flowInput, true);
  expect(flowPatched).toContain("# user header");
  expect(flowPatched).toContain("model: claude-sonnet-4 # keep comment");
  expect(readHermesPluginEnabled(flowPatched)).toBe(true);
  expect(parse(flowPatched)).toEqual({
    model: "claude-sonnet-4",
    plugins: {
      entries: {
        "session-navigation": {
          settings: {
            note: "hello, enabled: false",
            other: "x",
            enabled: true,
          },
        },
      },
    },
  });

  // 2. Unrelated multiline block scalar containing `enabled: false` must stay intact while boolean `enabled` patches cleanly
  const blockScalarInput = [
    "model: gpt-5",
    "plugins:",
    "  entries:",
    "    session_navigation:",
    "      settings:",
    "        note: |",
    "          enabled: false",
    "          second line",
    "        enabled: false # keep inline",
    "        keep_lines_limit: 5",
    "",
  ].join("\n");
  const blockPatched = patchHermesConfigYaml(blockScalarInput, true);
  expect(readHermesPluginEnabled(blockPatched)).toBe(true);
  expect(blockPatched).toContain("# keep inline");
  expect(parse(blockPatched)).toEqual({
    model: "gpt-5",
    plugins: {
      entries: {
        session_navigation: {
          settings: {
            note: "enabled: false\nsecond line\n",
            enabled: true,
            keep_lines_limit: 5,
          },
        },
      },
    },
  });

  // 3. Explicit YAML document-end marker `...` must keep added mappings inside the document before `...`
  const docEndInput = [
    "---",
    "model: gpt-5",
    "...",
    "",
  ].join("\n");
  const docEndPatched = patchHermesConfigYaml(docEndInput, true);
  expect(readHermesPluginEnabled(docEndPatched)).toBe(true);
  expect(docEndPatched.indexOf("plugins:")).toBeGreaterThan(-1);
  expect(docEndPatched.indexOf("plugins:")).toBeLessThan(docEndPatched.lastIndexOf("..."));
  expect(parse(docEndPatched)).toEqual({
    model: "gpt-5",
    plugins: {
      entries: {
        "session-navigation": {
          settings: {
            enabled: true,
          },
        },
      },
    },
  });

  // 4. Unrelated anchors/aliases are preserved safely in syntax & semantics, while
  //    invalid/unsupported YAML (duplicates, multi-doc, target-spine alias, non-boolean enabled including "false"/"true"/block scalar strings)
  //    surfaces unknown status + error in getAdapterToggles and blocks both On and Off toggles.
  const unrelatedAliasInput = [
    "default_provider: &prov",
    "  timeout: 30",
    "fallback_provider: *prov",
    "model: gpt-5",
    "",
  ].join("\n");
  const unrelatedAliasPatched = patchHermesConfigYaml(unrelatedAliasInput, true);
  expect(unrelatedAliasPatched).toContain("&prov");
  expect(unrelatedAliasPatched).toContain("*prov");
  expect(readHermesPluginEnabled(unrelatedAliasPatched)).toBe(true);
  expect(parse(unrelatedAliasPatched)).toEqual({
    default_provider: { timeout: 30 },
    fallback_provider: { timeout: 30 },
    model: "gpt-5",
    plugins: {
      entries: {
        "session-navigation": {
          settings: {
            enabled: true,
          },
        },
      },
    },
  });

  const { home, store, service } = fixture([], false);
  const hermesRoot = join(home, ".hermes");
  const atlasDir = join(hermesRoot, "profiles", "atlas");
  mkdirSync(atlasDir, { recursive: true });
  const rootCfg = join(hermesRoot, "config.yaml");
  const atlasCfg = join(atlasDir, "config.yaml");
  const validRoot =
    "# root intact\nmodel: claude-3-7\nplugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: true\n";
  writeFileSync(rootCfg, validRoot, "utf8");
  store.setAdapterControl("hermes", true, 100);

  for (const invalidContent of [
    "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: false\n        enabled: true\n",
    "model: first\n---\nmodel: second\n",
    "defaults: &shared\n  enabled: true\nplugins:\n  entries:\n    session-navigation:\n      settings: *shared\n",
    "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: \"false\"\n",
    "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: \"true\"\n",
    "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: 'false'\n",
    "plugins:\n  entries:\n    session_navigation:\n      settings:\n        enabled: |\n          false\n",
    "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: \"maybe\"\n",
  ]) {
    expect(() => readHermesPluginEnabled(invalidContent)).toThrow("hermes_invalid_config_yaml");
    expect(() => patchHermesConfigYaml(invalidContent, true)).toThrow("hermes_invalid_config_yaml");
    expect(() => patchHermesConfigYaml(invalidContent, false)).toThrow("hermes_invalid_config_yaml");

    writeFileSync(atlasCfg, invalidContent, "utf8");
    const inspectedInvalid = await service.handle("session-nav.get-adapter-toggles", {});
    expect(inspectedInvalid.ok).toBe(true);
    expect(inspectedInvalid.hermes).toMatchObject({
      enabled: false,
      stateUnknown: true,
      error: "hermes_invalid_config_yaml",
      canDisable: false,
      statusText: "Config YAML error (state unknown).",
    });
    expect(inspectedInvalid.hermes.warning).toContain("invalid or unsupported YAML");

    for (const targetEnabled of [true, false]) {
      const res = await service.handle("session-nav.set-adapter-toggle", {
        adapter: "hermes",
        enabled: targetEnabled,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("hermes_invalid_config_yaml");
      expect(readFileSync(rootCfg, "utf8")).toBe(validRoot);
      expect(readFileSync(atlasCfg, "utf8")).toBe(invalidContent);
      expect(store.getAdapterControl("hermes")?.enabled).toBe(true);
    }
  }
});

test("manual hide ignores compaction policy and writes a single-line replacement", async () => {
  const content = `Traceback (most recent call last):\nERROR: command failed with exit_code=1\n${"x".repeat(900)}`;
  const invocation = { tool_name: "bash", arguments: { command: "false" } };
  const { home, store, call } = fixture(
    toolMessages(content, "bash", { command: "false" }),
  );
  const record = loadTimeline(home, scope).records.get("c1")!;
  expect(refusalReason(record)).toBe("protected_error");

  const hidden = await call("hide", { item_id: "c1" });
  expect(hidden.ok).toBe(true);
  const digest = invocationDigest(invocation);
  const sha = sha256(content);
  const item = store.get(scope, itemId(scope, "c1", sha, digest, 0));
  expect(item?.compacted).toBe("[hidden: bash c1]");
  expect(item?.excerpt_lines).toEqual([]);
  expect(item?.invocation_snapshot).toBe(null);
  expect(item?.original).toBe(content);
  expect(item?.visibility).toBe("hidden");
  expect(item?.compaction_source).toBe("explicit_user_hide");
});

test("history loader rejects files over the byte limit with history_too_large", async () => {
  const { home, call } = fixture();
  const path = join(home, ".omp/agent/sessions/project", "2026_sid.jsonl");
  truncateSync(path, MAX_HISTORY_BYTES + 1);
  const reply = await call("list");
  expect(reply.ok).toBe(false);
  expect(reply.error).toBe("history_too_large");
});

test("msg: hide/unhide through the service gate survive oversized history via the stored unit", async () => {
  const { home, store, call } = fixture();
  const unitId = "msg:user:p0:deadbeefcafe";
  // Seed the unit as a prior hide would have, then blow past the byte cap so
  // every timeline load throws HistoryTooLargeError.
  expect(
    store.setMessageVisibility(scope, unitId, "user", sha256("hello"), 5, "hidden").ok,
  ).toBe(true);
  expect(
    store.setMessageVisibility(scope, unitId, "user", sha256("hello"), 5, "visible").ok,
  ).toBe(true);
  truncateSync(join(home, ".omp/agent/sessions/project", "2026_sid.jsonl"), MAX_HISTORY_BYTES + 1);
  const hidden = await call("hide", { item_id: unitId });
  expect(hidden.ok).toBe(true);
  expect(hidden.visibility).toBe("hidden");
  const shown = await call("unhide", { item_id: unitId });
  expect(shown.ok).toBe(true);
  expect(shown.visibility).toBe("visible");
  // Unknown msg: IDs still 404 instead of surfacing history_too_large.
  expect((await call("hide", { item_id: "msg:user:p9:000000000000" })).error).toBe(
    "not_found",
  );
  expect((await call("unhide", { item_id: "msg:user:p9:000000000000" })).error).toBe(
    "not_found",
  );
});

test("parent-scope Hermes mutations resolve the rotation-effective child scope", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home, store, service, register } = fixture([], false);
  const parentScope = "hermes:default:h-old:unknown";
  const childScope = "hermes:default:h-new:unknown";
  // Only the rotation child is registered: capabilities must resolve to it.
  register(childScope);

  mkdirSync(join(home, ".hermes"), { recursive: true });
  const hdb = new DatabaseSync(join(home, ".hermes/state.db"));
  try {
    hdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT, parent_session_id TEXT, started_at REAL);
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
        compacted INTEGER NOT NULL DEFAULT 0,
        _compressed_summary INTEGER NOT NULL DEFAULT 0
      );
    `);
    hdb.prepare("INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)").run("h-old", "{}", null, 100);
    hdb.prepare("INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)").run("h-new", "{}", "h-old", 200);
    const ins = hdb.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?, ?)");
    ins.run("h-new", "user", "current prompt", null, null, null);
    const toolCall = (id: string, path: string) =>
      JSON.stringify([{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }]);
    ins.run("h-new", "assistant", "", null, toolCall("call_a", "a.txt"), null);
    ins.run("h-new", "tool", "alpha output", "call_a", null, "read_file");
    ins.run("h-new", "assistant", "", null, toolCall("call_b", "b.txt"), null);
    ins.run("h-new", "tool", "beta output", "call_b", null, "read_file");
  } finally {
    hdb.close();
  }

  // list with the parent scope_key resolves the child chunk but echoes the
  // requested parent scope_key for API compatibility.
  const listed = await service.handle("list", { scope_key: parentScope });
  expect(listed.ok).toBe(true);
  expect(listed.scope_key).toBe(parentScope);
  expect(listed.capabilities).toMatchObject({ state: "ready", hide: true });
  expect(listed.items.map((row: Row) => row.tool_call_id)).toEqual(["", "call_a", "call_b"]);
  const toolA = listed.items.find((row: Row) => row.tool_call_id === "call_a");
  const toolB = listed.items.find((row: Row) => row.tool_call_id === "call_b");
  const userMsg = listed.items.find((row: Row) => row.kind === "user");
  expect(userMsg.item_id).toStartWith("msg:user:");

  // Tool hide via the parent scope_key lands on the child session, not 404.
  const hideA = await service.handle("hide", { scope_key: parentScope, item_id: toolA.item_id });
  expect(hideA.ok).toBe(true);
  expect(store.get(childScope, toolA.item_id)?.visibility).toBe("hidden");
  expect(store.items(parentScope)).toHaveLength(0);
  const unhideA = await service.handle("unhide", { scope_key: parentScope, item_id: toolA.item_id });
  expect(unhideA.ok).toBe(true);
  expect(store.get(childScope, toolA.item_id)?.visibility).toBe("visible");

  // Message hide via the parent scope_key writes the unit under the child
  // scope (where the Hermes middleware reads it), not the parent.
  const hideMsg = await service.handle("hide", { scope_key: parentScope, item_id: userMsg.item_id });
  expect(hideMsg.ok).toBe(true);
  const childUnits = store.listUnits(childScope);
  expect(childUnits.some((unit) => String(unit.unit_id) === userMsg.item_id && unit.visibility === "hidden")).toBe(true);
  expect(store.listUnits(parentScope).some((unit) => String(unit.unit_id) === userMsg.item_id)).toBe(false);
  const unhideMsg = await service.handle("unhide", { scope_key: parentScope, item_id: userMsg.item_id });
  expect(unhideMsg.ok).toBe(true);

  // Batch and manage mutations resolve the child scope as well.
  const batched = await service.handle("hideBatch", {
    scope_key: parentScope,
    items: [{ item_id: toolA.item_id }, { item_id: toolB.item_id }],
  });
  expect(batched).toMatchObject({ ok: true, applied: 2, failed: 0 });
  const managed = await service.handle("manage", {
    scope_key: parentScope,
    tool_call_ids: ["call_a"],
    action: "hide",
  });
  expect(managed.ok).toBe(true);
  expect(store.get(childScope, toolA.item_id)?.visibility).toBe("hidden");
});

test("Hermes toggle lock recovers stale dead-owner locks but keeps live locks", () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-toggle-lock-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const hermesRoot = join(home, ".hermes");
  mkdirSync(hermesRoot, { recursive: true });
  const lockPath = join(hermesRoot, ".session-navigation-toggle.lock");
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 2147483647;
  writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() - 300_000, nonce: "stale" }), "utf8");
  const recovered = acquireHermesToggleLock(home);
  expect(recovered.ok).toBe(true);
  if (recovered.ok) recovered.release();
  expect(existsSync(lockPath)).toBe(false);

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: "live" }), "utf8");
  expect(acquireHermesToggleLock(home)).toEqual({ ok: false, error: "hermes_toggle_locked" });
});

test("Hermes toggle journal write failure surfaces an error and cleans staged temp files", async () => {
  const { home, service } = fixture([], false);
  const hermesRoot = join(home, ".hermes");
  mkdirSync(hermesRoot, { recursive: true });
  const rootCfg = join(hermesRoot, "config.yaml");
  writeFileSync(
    rootCfg,
    "plugins:\n  entries:\n    session-navigation:\n      settings:\n        enabled: false\n",
    "utf8",
  );
  const journalPath = join(hermesRoot, ".session-navigation-toggle.journal.json");

  // Block the journal path after precheck so the post-stage journal write fails.
  let stagedWrites = 0;
  service.hermesWriteOptions = {
    writeFileImpl: (targetPath, data, opts) => {
      stagedWrites++;
      if (stagedWrites === 1) mkdirSync(journalPath, { recursive: true });
      writeFileSync(targetPath, data, opts);
    },
  };
  const failed = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(failed.ok).toBe(false);
  expect(stagedWrites).toBeGreaterThan(0);
  expect(readFileSync(rootCfg, "utf8")).toContain("enabled: false");
  // No staged *.tmp files leak and no half-written journal file exists.
  const leftovers: string[] = [];
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== journalPath) scan(full);
      } else if (entry.name.endsWith(".tmp")) {
        leftovers.push(full);
      }
    }
  };
  scan(hermesRoot);
  expect(leftovers).toEqual([]);
  rmSync(journalPath, { recursive: true, force: true });

  // After clearing the blockage the toggle succeeds (lock was released).
  service.hermesWriteOptions = undefined;
  const recovered = await service.handle("session-nav.set-adapter-toggle", {
    adapter: "hermes",
    enabled: true,
  });
  expect(recovered.ok).toBe(true);
});

test("parent-scope Hermes summarize resolves the rotation-effective child scope", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const home = mkdtempSync(join(tmpdir(), "paseo-parent-sum-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  cleanup.push(() => store.close());
  const service = new PaseoService(store, home);
  const parentScope = "hermes:default:sum-old:unknown";
  const childScope = "hermes:default:sum-new:unknown";
  store.register(childScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const hdb = new DatabaseSync(join(home, ".hermes/state.db"));
  try {
    hdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT, parent_session_id TEXT, started_at REAL);
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
        compacted INTEGER NOT NULL DEFAULT 0,
        _compressed_summary INTEGER NOT NULL DEFAULT 0
      );
    `);
    hdb.prepare("INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)").run("sum-old", "{}", null, 100);
    hdb.prepare("INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)").run("sum-new", "{}", "sum-old", 200);
    hdb.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?, ?)").run(
      "sum-new",
      "assistant",
      "",
      null,
      JSON.stringify([{ id: "call_s", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "s.txt" }) } }]),
      null,
    );
    hdb.prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?, ?)").run("sum-new", "tool", "summarizable output", "call_s", null, "read_file");
  } finally {
    hdb.close();
  }
  const listed = await service.handle("list", { scope_key: parentScope });
  const tool = listed.items.find((row: Row) => row.tool_call_id === "call_s");
  const summarized = await service.handle("hide", {
    scope_key: parentScope,
    item_id: tool.item_id,
    mode: "summarize",
  });
  expect(summarized.ok).toBe(true);
  const stored = store.get(childScope, tool.item_id);
  expect(stored?.visibility).toBe("hidden");
  expect(stored?.compaction_source).toBe("summarize_pending");
  expect(store.items(parentScope)).toHaveLength(0);
});

test("manage on tool items succeeds without loading an oversized history; unknown ids stay bounded", async () => {
  const big = fixture(toolMessages());
  const stored = (await big.call("list")).items.find((item: Row) => item.tool_call_id === "c1");
  expect(stored).toBeDefined();
  // Seed the stored item first so manage can resolve it without the timeline.
  expect((await big.call("hide", { item_id: stored.item_id })).ok).toBe(true);
  // Blow past the byte cap so every timeline load throws HistoryTooLargeError.
  truncateSync(join(big.home, ".omp/agent/sessions/project", "2026_sid.jsonl"), MAX_HISTORY_BYTES + 1);
  const managed = await big.service.handle("manage", { scope_key: scope, tool_call_ids: ["c1"], action: "hide" });
  expect(managed.ok).toBe(true);
  expect(managed.items).toMatchObject([{ tool_call_id: "c1", ok: true }]);
  // Unknown ids that need the timeline get a bounded per-item error, not a throw.
  const missing = await big.service.handle("manage", { scope_key: scope, tool_call_ids: ["nope"], action: "hide" });
  expect(missing.ok).toBe(false);
  expect(missing.items).toMatchObject([{ tool_call_id: "nope", ok: false, error: "history_too_large" }]);
});

test("list replies validate against ListResultSchema and dbChoice requires a scope_key", async () => {
  const { call } = fixture(toolMessages());
  const listed = await call("list");
  const parsed = ListResultSchema.parse(listed);
  // The facade schema must not strip the resolved scope.
  expect(parsed.scope_key).toBe(scope);
  expect(parsed.items.length).toBeGreaterThan(0);
  // dbChoice without a scope_key is rejected by the schema (the server
  // requires 4 segments and answers invalid_scope).
  expect(() => dbChoiceRpc.input.parse({ choice: "abort_request" })).toThrow();
  const { service } = fixture();
  const noScope = await service.handle("dbChoice", { choice: "abort_request" });
  expect(noScope).toMatchObject({ ok: false, error: "invalid_scope" });
  const okChoice = await call("dbChoice", { scope_key: scope, choice: "abort_request" });
  expect(DbChoiceResultSchema.parse(okChoice)).toMatchObject({ ok: true });
});

test("batch abort surfaces unsafe_journal_mode and engine_protocol_incompatible with abort choices", async () => {
  const first = fixture(toolMessages());
  const row = (await first.call("list")).items.find((item: Row) => item.tool_call_id === "c1");
  first.store.driver.exec("INSERT OR REPLACE INTO meta(key,value) VALUES ('engine_protocol_version','999')");
  const batched = await first.service.handle("hideBatch", {
    scope_key: scope,
    items: [{ item_id: row.item_id }],
  });
  expect(batched).toMatchObject({
    ok: false,
    error: "engine_protocol_incompatible",
    choices: ["abort_request", "send_original"],
    applied: 0,
    failed: 1,
  });
  expect(batched.items[0]).toMatchObject({ ok: false, error: "engine_protocol_incompatible" });

  const second = fixture(toolMessages());
  const secondRow = (await second.call("list")).items.find((item: Row) => item.tool_call_id === "c1");
  second.store.driver.exec("PRAGMA journal_mode=WAL");
  // Test seam: simulate a pre-WAL sqlite so the write gate rejects WAL mode.
  const legacyStore = second.store as unknown as { sqliteVersion: string };
  legacyStore.sqliteVersion = "3.0.0";
  const walBatched = await second.service.handle("hideBatch", {
    scope_key: scope,
    items: [{ item_id: secondRow.item_id }],
  });
  expect(walBatched).toMatchObject({
    ok: false,
    error: "unsafe_journal_mode",
    choices: ["abort_request", "send_original"],
    applied: 0,
    failed: 1,
  });
  expect(walBatched.items[0]).toMatchObject({ ok: false, error: "unsafe_journal_mode" });
});

test("bindAgents rejects colon scopes, matches ACP case-insensitively, and skips archived agents", () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-bind-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const agentsDir = join(home, ".paseo", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const writeAgent = (name: string, agent: Record<string, unknown>) =>
    writeFileSync(join(agentsDir, name), JSON.stringify(agent));
  // Case-insensitive ACP transport/provider still binds.
  writeAgent("upper.json", { id: "upper-agent", provider: "ACP", runtimeInfo: { sessionId: "s1", provider: "Acp" } });
  // A hermes-* provider prefix alone is not ACP and must not bind.
  writeAgent("pseudo.json", { id: "pseudo-agent", provider: "hermes-openai", runtimeInfo: { sessionId: "s2", provider: "hermes-openai" } });
  // Colon scopes would forge scope_key segments: never bind.
  writeAgent("colon.json", { id: "colon-agent", provider: "acp", runtimeInfo: { sessionId: "a:b", provider: "acp" } });
  // Archived descriptors never overwrite live bindings.
  writeAgent("archived.json", { id: "stale-agent", archived: true, provider: "acp", runtimeInfo: { sessionId: "s1", provider: "acp" } });
  type Entry = { scope_key: string; items: number; capabilities: { state: string; unhide: boolean }; agent_id?: string };
  const scopes: Entry[] = [
    { scope_key: "hermes:default:s1:unknown", items: 0, capabilities: { state: "ready", unhide: true } },
    { scope_key: "hermes:default:s2:unknown", items: 0, capabilities: { state: "ready", unhide: true } },
  ];
  bindAgents(home, scopes, join(home, ".paseo"));
  expect(scopes.find((s) => s.scope_key === "hermes:default:s1:unknown")?.agent_id).toBe("upper-agent");
  expect(scopes.find((s) => s.scope_key === "hermes:default:s2:unknown")?.agent_id).toBeUndefined();
  expect(scopes.some((s) => s.scope_key.includes("a:b"))).toBe(false);
});

test("bindAgents sorts agent files and never scans the process CWD for empty PASEO_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-bind-sort-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const agentsDir = join(home, ".paseo", "agents");
  mkdirSync(agentsDir, { recursive: true });
  // Later-sorting file wins deterministically.
  writeFileSync(join(agentsDir, "b.json"), JSON.stringify({ id: "b-agent", provider: "acp", runtimeInfo: { sessionId: "s9", provider: "acp" } }));
  writeFileSync(join(agentsDir, "a.json"), JSON.stringify({ id: "a-agent", provider: "acp", runtimeInfo: { sessionId: "s9", provider: "acp" } }));
  type Entry = { scope_key: string; items: number; capabilities: { state: string; unhide: boolean }; agent_id?: string };
  const scopes: Entry[] = [
    { scope_key: "hermes:default:s9:unknown", items: 0, capabilities: { state: "ready", unhide: true } },
  ];
  bindAgents(home, scopes, join(home, ".paseo"));
  expect(scopes[0].agent_id).toBe("b-agent");

  // Empty PASEO_HOME falls back to the home dir, never the CWD: plant a
  // decoy for a CWD-only session and prove it is not picked up.
  const cwd = mkdtempSync(join(tmpdir(), "paseo-bind-cwd-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "agents"), { recursive: true });
  writeFileSync(join(cwd, "agents", "decoy.json"), JSON.stringify({ id: "decoy-agent", provider: "acp", runtimeInfo: { sessionId: "s-cwd-only", provider: "acp" } }));
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const fresh: Entry[] = [
      { scope_key: "hermes:default:s-cwd-only:unknown", items: 0, capabilities: { state: "ready", unhide: true } },
    ];
    bindAgents(home, fresh, "");
    expect(fresh[0].agent_id).toBeUndefined();
  } finally {
    process.chdir(previousCwd);
  }
});

test("dangling toggle symlinks are rejected and non-string YAML keys outside the target path are kept", () => {
  const home = mkdtempSync(join(tmpdir(), "paseo-dangle-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  symlinkSync(join(home, ".hermes", "missing-target"), join(home, ".hermes", ".session-navigation-toggle.lock"));
  const inspected = inspectHermesToggle(home);
  expect(inspected.error ?? JSON.stringify(inspected)).toMatch(/unsafe_hermes_path/);

  // Non-string keys in unrelated sections (numeric port keys) are valid YAML
  // and must not fail as hermes_invalid_config_yaml.
  const yaml = "ports:\n  8080: http\n";
  expect(readHermesPluginEnabled(yaml)).toBe(false);
  const patched = patchHermesConfigYaml(yaml, true);
  expect(patched).toContain("session-navigation");
  expect(patched).toContain("8080");
});
