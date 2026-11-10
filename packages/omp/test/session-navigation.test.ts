import { releaseExtension } from "../src/registration.ts";
import { beforeEach, test, expect } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { prepareRequest } from "../src/extension.ts";

beforeEach(() => releaseExtension());

const testDb = join(mkdtempSync(join(tmpdir(), "sn-test-")), "state.sqlite3");
process.env.SESSION_NAVIGATION_STATE_PATH = testDb;

function setup(client?: import("../src/client.ts").ServiceClient) {
  process.env.SESSION_NAVIGATION_STATE_PATH = testDb;
  const events: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const chainable = () => ({ optional: () => ({}) });
  const pi = {
    zod: {
      object: () => ({}),
      string: chainable,
      number: () => ({ int: () => ({ min: () => ({ max: chainable }) }) }),
      array: () => chainable(),
      enum: () => chainable(),
    },
    on: (name: string, handler: Function) => {
      events[name] = handler;
    },
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
  };
  extension(pi as any, client ? { client: () => client } : {});
  events.session_start({}, { agent: { kind: "main" } });
  return { events, tools };
}
const ctx = { sessionManager: { getSessionId: () => "test-session" } };

test("pending summaries settle before the first request selects patches", async () => {
  let stored = "rule excerpt";
  const sent: string[] = [];
  let start!: () => void, finish!: (value: string) => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const completion = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let returned = false;
  const request = prepareRequest(
    [],
    "s",
    "t",
    async (method, params: any) => {
      sent.push(method);
      if (method === "apply_summary") {
        stored = params.summary_text;
        return { ok: true };
      }
      return {
        ok: true,
        patches: [{ call_id: "c", sha256: "digest", text: stored }],
        pending_summaries:
          stored === "rule excerpt" ? [{ item_id: "item", content: "original" }] : [],
      };
    },
    async (content, timeout) => {
      expect(content).toBe("original");
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(25_000);
      start();
      return completion;
    },
  ).then((reply) => {
    returned = true;
    return reply;
  });
  await started;
  expect(returned).toBe(false);
  finish("session LLM summary");
  expect((await request).patches?.[0].text).toBe("session LLM summary");
  expect(sent).toEqual(["prepare", "apply_summary", "prepare"]);
});

test("pending settlement carries version CAS and discards stale session generations", async () => {
  const writes: any[] = [];
  let current = true;
  const reply = await prepareRequest(
    [],
    "s",
    "t",
    async (method, params) => {
      writes.push({ method, params });
      return {
        ok: true,
        patches: [],
        pending_summaries: [{ item_id: "pending", version: 7, content: "original" }],
      };
    },
    async () => {
      current = false;
      return "stale summary";
    },
    Date.now() + 25_000,
    () => current,
  );
  expect(reply.error).toBe("unconfirmed_snapshot");
  expect(writes.map((write) => write.method)).toEqual(["prepare"]);
  writes.length = 0;
  await prepareRequest(
    [],
    "s",
    "t",
    async (method, params) => {
      writes.push({ method, params });
      return {
        ok: true,
        patches: [],
        pending_summaries:
          method === "prepare" ? [{ item_id: "pending", version: 7, content: "original" }] : [],
      };
    },
    async () => "summary",
  );
  expect(writes.find((write) => write.method === "apply_summary").params.expected_version).toBe(7);
});

test("pending generation uses four workers, deduplicates IDs and serializes writes", async () => {
  const jobs = Array.from({ length: 11 }, (_, i) => ({
    item_id: `i${i}`,
    content: `original ${i}`,
  }));
  let prepares = 0,
    active = 0,
    peak = 0,
    writes = 0,
    writeActive = false;
  const calls: string[] = [];
  const reply = await prepareRequest(
    [],
    "s",
    "t",
    async (method) => {
      if (method === "prepare")
        return {
          ok: true,
          patches: [],
          pending_summaries: ++prepares === 1 ? [...jobs, jobs[0]] : [],
        };
      expect(writeActive).toBe(false);
      writeActive = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      writeActive = false;
      writes++;
      return { ok: true };
    },
    async (content) => {
      calls.push(content);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      --active;
      return "summary";
    },
  );
  expect(reply.ok).toBe(true);
  expect(peak).toBe(4);
  expect(calls).toHaveLength(11);
  expect(writes).toBe(11);
});

for (const failure of ["unavailable", "rejected", "invalid"] as const) {
  test(`pending ${failure} falls back to refreshed rule patches`, async () => {
    const methods: string[] = [];
    const reply = await prepareRequest(
      [],
      "s",
      "t",
      async (method) => {
        methods.push(method);
        if (method === "apply_summary") return { ok: false, error: "verification_failed" };
        return {
          ok: true,
          patches: [{ call_id: "c", sha256: "digest", text: "rule excerpt" }],
          pending_summaries: [{ item_id: "i", content: "original" }],
        };
      },
      async () => {
        if (failure === "rejected") throw new Error("model failed");
        return failure === "invalid" ? "invented" : null;
      },
    );
    expect(reply.patches?.[0].text).toBe("rule excerpt");
    expect(methods).toEqual([
      "prepare",
      failure === "invalid" ? "apply_summary" : "summary_failed",
      "prepare",
    ]);
  });
}

test("no pending IDs means no model call or second prepare; DB write errors propagate", async () => {
  let calls = 0;
  const initial = { ok: true, patches: [], pending_summaries: [] };
  expect(
    await prepareRequest(
      [],
      "s",
      "t",
      async () => {
        calls++;
        return initial;
      },
      async () => {
        throw new Error("unexpected model");
      },
    ),
  ).toEqual({ ...initial, hidden_messages: [] });
  expect(calls).toBe(1);
  expect(
    await prepareRequest(
      [],
      "s",
      "t",
      async (method) =>
        method === "prepare"
          ? { ok: true, patches: [], pending_summaries: [{ item_id: "i", content: "original" }] }
          : { ok: false, error: "db_error" },
      async () => "summary",
    ),
  ).toEqual({ ok: false, error: "db_error" });
});

test("the shared model deadline prevents starting remaining pending jobs", async () => {
  const originalNow = Date.now;
  let now = 0,
    generated = 0,
    failed = 0,
    prepares = 0;
  Date.now = () => now;
  try {
    await prepareRequest(
      [],
      "s",
      "t",
      async (method) => {
        if (method === "prepare")
          return {
            ok: true,
            patches: [],
            pending_summaries:
              ++prepares === 1
                ? Array.from({ length: 9 }, (_, i) => ({ item_id: `i${i}`, content: "original" }))
                : [],
          };
        failed++;
        return { ok: true };
      },
      async () => {
        generated++;
        now = 25_001;
        return null;
      },
    );
    expect(generated).toBe(1);
    expect(failed).toBe(9);
  } finally {
    Date.now = originalNow;
  }
});

test("queue wait consumes the model budget instead of starting another full timeout", async () => {
  const methods: string[] = [];
  await prepareRequest(
    [],
    "s",
    "t",
    async (method) => {
      methods.push(method);
      return { ok: true, patches: [], pending_summaries: [{ item_id: "i", content: "original" }] };
    },
    async () => {
      throw new Error("expired job must not call a model");
    },
    Date.now() - 1,
  );
  expect(methods).toEqual(["prepare", "summary_failed", "prepare"]);
});
const longText = Array.from(
  { length: 100 },
  (_, i) => `Output row ${i.toString().padStart(3, "0")} details`,
).join("\n");
function messages(content: any[] = [{ type: "text", text: longText }], isError = false) {
  return [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "sample.txt" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content,
      isError,
      details: { preserved: true },
      timestamp: 1,
    },
  ];
}
async function execute(tool: any, args: any, context = ctx) {
  return (await tool.execute("test", args, undefined, undefined, context)).details;
}

test("worker engine compacts and restores confirmed read results", async () => {
  const { events, tools } = setup();
  const input = messages();
  try {
    expect(await events.context({ messages: input }, ctx)).toBeUndefined();
    expect((await execute(tools.hide_context, { tool_call_id: "call-1" })).error).toBe(
      "unconfirmed_snapshot",
    );
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    const compact = await execute(tools.hide_context, { tool_call_id: "call-1" });
    expect(compact.ok).toBe(true);
    const transformed = await events.context({ messages: input }, ctx);
    expect(transformed.messages[1].content[0].text).not.toBe(longText);
    expect(input[1].content[0].text).toBe(longText);
    expect(transformed.messages[1].details).toEqual({ preserved: true });
    const restored = await execute(tools.unhide_context, { item_id: compact.item_id });
    expect(restored.ok).toBe(true);
    expect(await events.context({ messages: input }, ctx)).toBeUndefined();
  } finally {
    await events.session_shutdown();
  }
});

test("실패, 이미지, 중복 ID와 확인되지 않은 세션은 원본을 보존한다", async () => {
  const { events, tools } = setup();
  try {
    for (const input of [
      messages(undefined, true),
      messages([
        { type: "text", text: longText },
        { type: "image", data: "abc" },
      ]),
      [...messages(), messages()[1]],
    ]) {
      expect(await events.context({ messages: input }, ctx)).toBeUndefined();
      await events.assistant_message(
        { message: { role: "assistant", stopReason: "toolUse" } },
        ctx,
      );
      expect((await execute(tools.hide_context, { tool_call_id: "call-1" })).error).toBe(
        "not_found",
      );
    }
    expect(
      (
        await execute(
          tools.hide_context,
          { tool_call_id: "call-1" },
          { sessionManager: { getSessionId: () => "other" } },
        )
      ).error,
    ).toBe("unconfirmed_snapshot");
    expect(await events.context({ messages: messages() }, {})).toBeUndefined();
  } finally {
    await events.session_shutdown();
  }
});

test("persistence failure aborts headless and requires an interactive choice", async () => {
  for (const mode of ["print", "tui"] as const) {
    const client = { request: async () => ({ ok: false, error: "db_error" }), close: () => {} };
    const { events } = setup(client);
    let aborted = false,
      asked = false;
    const context = {
      ...ctx,
      mode,
      abort: () => {
        aborted = true;
      },
      ui: {
        notify: () => {},
        select: async () => {
          asked = true;
          return "send_original";
        },
      },
    };
    try {
      if (mode === "print") {
        await expect(events.context({ messages: messages() }, context)).rejects.toThrow("aborted");
        expect(aborted).toBe(true);
      } else {
        expect(await events.context({ messages: messages() }, context)).toBeUndefined();
        expect(asked).toBe(true);
        expect(aborted).toBe(false);
      }
    } finally {
      await events.session_shutdown();
    }
  }
});

test("interactive abort and structural worker failures cannot silently pass through", async () => {
  for (const error of [
    "worker_error",
    "invalid_response",
    "db_error",
    "db_full",
    "engine_protocol_incompatible",
    "unsafe_journal_mode",
  ]) {
    const { events } = setup({ request: async () => ({ ok: false, error }), close: () => {} });
    let aborted = false;
    const context = {
      ...ctx,
      mode: "tui",
      abort: () => {
        aborted = true;
      },
      ui: { notify: () => {}, select: async () => "abort_request" },
    };
    try {
      await expect(events.context({ messages: messages() }, context)).rejects.toThrow("aborted");
      expect(aborted).toBe(true);
    } finally {
      await events.session_shutdown();
    }
  }
});

test("collect accepts bash invocation and preserves original SHA before projection", async () => {
  const calls: any[] = [];
  const { events } = setup({
    request: async (method, params) => {
      calls.push(params);
      return { ok: true, patches: [{ call_id: "call-b", sha256: "wrong digest", text: "hidden" }] };
    },
    close: () => {},
  });
  const input = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-b", name: "bash", arguments: { command: "ls -la" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "bash",
      content: [{ type: "text", text: longText }],
      isError: false,
    },
  ];
  try {
    expect(await events.context({ messages: input }, ctx)).toBeUndefined();
    expect(calls[0].records[0].tool_name).toBe("bash");
    expect(calls[0].records[0].arguments).toEqual({ command: "ls -la" });
  } finally {
    await events.session_shutdown();
  }
});

test("hidden prompts are dropped and hidden responses keep only their tool calls", async () => {
  const { messageKey, dropHiddenMessages } = await import("../src/extension.ts");
  const user = { role: "user", content: "check", timestamp: 1000 };
  const withCall = {
    role: "assistant",
    timestamp: 2000,
    content: [
      { type: "thinking", thinking: "t" },
      { type: "text", text: "Running" },
      { type: "toolCall", id: "c1", name: "bash", arguments: {} },
    ],
  };
  const result = {
    role: "toolResult",
    toolCallId: "c1",
    content: [{ type: "text", text: "ok" }],
    timestamp: 2500,
  };
  const textOnly = {
    role: "assistant",
    timestamp: 3000,
    content: [{ type: "text", text: "Done" }],
  };
  expect(messageKey(user)).toMatch(/^msg:user:1000:[0-9a-f]{12}$/);
  expect(dropHiddenMessages([user], new Set())).toBeNull();
  const kept = dropHiddenMessages(
    [user, withCall, result, textOnly],
    new Set([messageKey(user)!, messageKey(withCall)!, messageKey(textOnly)!]),
  )!;
  expect(kept).toEqual([{ ...withCall, content: [withCall.content[2]] }, result]);
  const latest = dropHiddenMessages([user, withCall, result], new Set([messageKey(withCall)!]))!;
  expect(latest[1].content).toEqual([withCall.content[0], withCall.content[2]]);
});

import { prepareSnapshot } from "../src/extension.ts";

test("prepare sends all 2000 records in bounded chunks and collects every response", async () => {
  const records = Array.from({ length: 2000 }, (_, i) => ({
    call_id: `c${i}`,
    tool_name: "bash",
    arguments: { command: `echo ${i}` },
    status: "ok",
    content: `out ${i}`,
  }));
  const sent: any[] = [];
  const response = await prepareSnapshot(
    records,
    "session",
    "token",
    async (method, params: any) => {
      sent.push(params);
      expect(method).toBe("prepare");
      expect(params.records.length).toBeLessThanOrEqual(64);
      expect(
        Buffer.byteLength(JSON.stringify({ id: 1, method, params }) + "\n"),
      ).toBeLessThanOrEqual(4 * 1024 * 1024);
      return {
        ok: true,
        patches: params.records.map((r: any) => ({
          call_id: r.call_id,
          sha256: "h",
          text: "hidden",
        })),
        pending_summaries: [{ call_id: params.records[0].call_id }],
        hidden_messages: ["message"],
        ...(sent.length === 1 ? { evicted_snapshots: ["old"] } : {}),
      };
    },
  );
  expect(sent.flatMap((p) => p.records)).toEqual(records);
  expect(sent[0]).toEqual({
    session_id: "session",
    snapshot_id: "token",
    records: records.slice(0, 64),
  });
  expect(sent.slice(1).every((p) => p.append === true && p.snapshot_id === "token")).toBe(true);
  expect(response.patches?.length).toBe(2000);
  expect((response.pending_summaries as any[]).length).toBe(sent.length);
  expect(response.hidden_messages).toEqual(["message"]);
  expect(response.evicted_snapshots).toEqual(["old"]);
});

test("prepare chunks escaped UTF-8 by wire bytes, skips oversized records, and sends empty snapshots", async () => {
  const record = (id: string, content: string) => ({
    call_id: id,
    tool_name: "read",
    arguments: { path: "file" },
    status: "ok",
    content,
  });
  const eligible = Array.from({ length: 10 }, (_, i) =>
    record(String(i), "\u0000한".repeat(100_000)),
  );
  const oversized = record("oversized", "x".repeat(4 * 1024 * 1024 + 1));
  const chunks: any[][] = [];
  const send = async (method: string, params: any) => {
    expect(
      Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, method, params }) + "\n"),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    chunks.push(params.records);
    return { ok: true, patches: [] };
  };
  expect((await prepareSnapshot([oversized, ...eligible], "s", "t", send)).ok).toBe(true);
  expect(chunks.flat()).toEqual(eligible);
  expect(chunks.length).toBeGreaterThan(1);
  chunks.length = 0;
  await prepareSnapshot([], "s", "empty", send);
  expect(chunks).toEqual([[]]);
});

test("a later failed chunk discards partial patches and stops sending", async () => {
  const records = Array.from({ length: 200 }, (_, i) => ({
    call_id: String(i),
    tool_name: "read",
    arguments: { path: "file" },
    status: "ok",
    content: "text",
  }));
  let calls = 0;
  const failure = { ok: false, error: "db_error", choices: ["abort_request", "send_original"] };
  const response = await prepareSnapshot(records, "s", "t", async () =>
    ++calls === 1
      ? { ok: true, patches: [{ call_id: "0", sha256: "h", text: "hidden" }] }
      : failure,
  );
  expect(calls).toBe(2);
  expect(response).toEqual(failure);
});

test("worker service patches hides across chunks and confirms the whole snapshot for tools", async () => {
  const { events, tools } = setup();
  const context = { sessionManager: { getSessionId: () => "chunked-session" } };
  const input = Array.from({ length: 130 }, (_, i) => [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: `chunk-${i}`, name: "read", arguments: { path: `file-${i}` } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: `chunk-${i}`,
      toolName: "read",
      content: [{ type: "text", text: longText }],
      isError: false,
    },
  ]).flat();
  try {
    expect(await events.context({ messages: input }, context)).toBeUndefined();
    expect((await execute(tools.hide_context, { tool_call_id: "chunk-0" }, context)).error).toBe(
      "unconfirmed_snapshot",
    );
    await events.assistant_message(
      { message: { role: "assistant", stopReason: "toolUse" } },
      context,
    );
    for (const id of ["chunk-0", "chunk-70"]) {
      expect((await execute(tools.hide_context, { tool_call_id: id }, context)).ok).toBe(true);
    }
    const transformed = await events.context({ messages: input }, context);
    expect(transformed.messages[1].content[0].text).not.toBe(longText);
    expect(transformed.messages[141].content[0].text).not.toBe(longText);
    expect(input[1].content[0].text).toBe(longText);
    const concurrent = await Promise.all([
      events.context({ messages: input }, context),
      events.context({ messages: input }, context),
    ]);
    expect(
      concurrent.every(
        (result) =>
          result?.messages[1].content[0].text !== longText &&
          result?.messages[141].content[0].text !== longText &&
          result?.messages,
      ),
    ).toBe(true);
    await events.assistant_message(
      { message: { role: "assistant", stopReason: "toolUse" } },
      context,
    );
    expect((await execute(tools.hide_context, { tool_call_id: "chunk-129" }, context)).ok).toBe(
      true,
    );
  } finally {
    await events.session_shutdown();
  }
});
