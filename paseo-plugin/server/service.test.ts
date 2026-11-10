import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  EngineError,
  sha256,
  invocationDigest,
  itemId,
  type Item,
} from "../../packages/core/src/index.ts";
import { BunDriver } from "../../packages/core/src/drivers/bun.ts";
import { OmpService } from "../../packages/omp/src/service.ts";
import { PaseoService } from "./service.ts";
import {
  loadTimeline,
  measuredTokens,
  messageKey,
  preview,
  type Message,
} from "./history.ts";
import { bindAgents } from "./mapping.ts";

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
    "multiblock",
  ]) {
    const changed = toolMessages("out");
    if (variant === "duplicate") changed[1].content.push(changed[1].content[1]);
    if (variant === "error") changed[2].isError = true;
    if (variant === "result") changed.push(changed[2]);
    if (variant === "order")
      [changed[1], changed[2]] = [changed[2], changed[1]];
    if (variant === "multiblock")
      changed[2].content.push({ type: "image", data: "x" });
    const current = fixture(changed);
    expect(
      (await current.call("list")).items
        .filter((row: any) => row.kind === "tool")
        .every((row: any) => !row.manageable),
    ).toBe(true);
  }
});

test("a long outline reaches the final result beyond the 1000-record and 4MiB management caps", () => {
  const messages: Message[] = [];
  for (let index = 0; index < 1005; index++)
    messages.push(
      ...toolMessages(`out ${index}`)
        .slice(1, 3)
        .map((message) =>
          JSON.parse(JSON.stringify(message).replaceAll("c1", `call-${index}`)),
        ),
    );
  const { home } = fixture(messages);
  const timeline = loadTimeline(home, scope);
  expect(timeline.rows.filter((row) => row.kind === "tool")).toHaveLength(1005);
  expect(timeline.records.size).toBe(1000);
  expect(timeline.rows.at(-1)?.manageable).toBe(false);
  const huge = fixture(toolMessages("x".repeat(4 * 1024 * 1024 + 1)));
  expect(loadTimeline(huge.home, scope).records.size).toBe(0);
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
