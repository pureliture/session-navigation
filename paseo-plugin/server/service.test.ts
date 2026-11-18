import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Store,
  EngineError,
  canonical,
  sha256,
  invocationDigest,
  itemId,
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
import { bindAgents } from "./mapping.ts";
import { MutationResultSchema } from "../shared/sessionNav.ts";

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
  expect(store.get(hermesScope, id)?.invocation_options_omitted).toBe(true);
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

  // Hide the Hermes terminal tool call (with timeout: 30 -> invocation_options_omitted = true)
  const hideTool = await service.handle("hide", {
    scope_key: hermesScope,
    item_id: listed.items[2].item_id,
  });
  expect(hideTool.ok).toBe(true);
  const storedTool = store.get(hermesScope, listed.items[2].item_id);
  expect(storedTool?.invocation_options_omitted).toBe(true);
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
  expect(stored.compacted).toBe(`[hidden:${toolRow.item_id}]`);

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

  // Hiding by tool_call_id should prioritize matchedTarget's verified invocation_digest and options_omitted
  const hidePrio = await service.handle("hide", { scope_key: hScope, item_id: "call_prio" });
  expect(hidePrio.ok).toBe(true);
  expect(hidePrio.item_id).toBe(targetItemId);
  expect(store.get(hScope, targetItemId)?.invocation_options_omitted).toBe(true);
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
