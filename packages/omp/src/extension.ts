import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { WorkerClient, type ServiceClient } from "./client.ts";
import { acquireExtension, releaseExtension } from "./registration.ts";
import {
  BoundaryReminder,
  CLEANUP_GUIDANCE,
  MAX_SUMMARY_CONCURRENCY,
  MAX_CHUNK_RECORDS,
  SUMMARY_TIMEOUT_MS,
  dropHiddenMessages,
  prepareRequest,
  messageText,
  hash,
  type Candidate,
  type RecordItem,
  type Reply,
  type ReminderItem,
} from "./context.ts";
import { registerOverlay } from "./overlay.ts";
import { childLinkage } from "./subagents.ts";
import { summaryPrompt, summarySource, MAX_SUMMARY_INPUT_BYTES } from "../../core/src/summary.ts";
export * from "./context.ts";

export interface ExtensionOptions {
  client?: (invalidateSnapshot: () => void) => ServiceClient;
}
export default function sessionNavigationExtension(
  pi: ExtensionAPI,
  options: ExtensionOptions = {},
): void {
  let active = false;
  pi.on("session_start", async (_event, ctx) => {
    if (active) return;
    const child = ctx.agent?.kind === "sub";
    const linkage = child ? childLinkage(ctx) : null;
    if (child && !linkage) return;
    const owner = ctx.sessionManager?.getSessionId?.() ?? "main";
    if (!acquireExtension(owner)) return;
    active = true;
    await activateExtension(pi, options, ctx, owner, linkage);
  });
}

async function activateExtension(pi: ExtensionAPI, options: ExtensionOptions, startContext: ExtensionContext,
  owner: string, linkage: { parent_scope: string; subagent_id: string } | null): Promise<void> {
  const child = linkage !== null;
  const z = pi.zod;
  if (!child) pi.on("before_agent_start", async (event) => ({
    systemPrompt: [...event.systemPrompt, CLEANUP_GUIDANCE],
  }));
  let candidate: Candidate | null = null;
  let generation = 0;
  const modelControllers = new Set<AbortController>();
  function invalidateSnapshot(): void {
    candidate = null;
    generation++;
    for (const controller of modelControllers) controller.abort();
  }
  const reminders = new Map<string, BoundaryReminder>();
  const client =
    options.client?.(invalidateSnapshot) ?? new WorkerClient(undefined, invalidateSnapshot);
  let queue: Promise<unknown> = Promise.resolve();
  const rpcOnce = (
    method: string,
    params: object,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Reply> => client.request(method, { ...params, ...(linkage ?? {}) }, timeout, signal) as Promise<Reply>;
  function rpc(
    method: string,
    params: object,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Reply> {
    const run = queue.then(() => rpcOnce(method, params, timeout, signal));
    queue = run.catch(() => undefined);
    return run;
  }
  function sessionId(ctx: ExtensionContext): string | null {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      return typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes(":")
        ? id
        : null;
    } catch {
      return null;
    }
  }
  function collect(
    messages: any[],
  ): { records: RecordItem[]; positions: Map<string, number> } | null {
    const calls = new Map<string, any>();
    const duplicates = new Set<string>();
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string" || !block.id) continue;
        if (calls.has(block.id)) duplicates.add(block.id);
        else calls.set(block.id, { block, index });
      }
    }
    const resultCounts = new Map<string, number>();
    for (const message of messages)
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1);
      }
    const records: RecordItem[] = [];
    const positions = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const id = message?.toolCallId;
      const found = calls.get(id);
      const call = found?.block;
      if (
        message?.role !== "toolResult" ||
        typeof id !== "string" ||
        duplicates.has(id) ||
        resultCounts.get(id) !== 1 ||
        !call ||
        found.index >= i ||
        (call.name !== "read" && call.name !== "bash") ||
        (message.toolName !== "read" && message.toolName !== "bash") ||
        call.name !== message.toolName ||
        message.isError !== false ||
        !call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments) ||
        !Array.isArray(message.content) ||
        message.content.length !== 1 ||
        message.content[0]?.type !== "text" ||
        typeof message.content[0].text !== "string"
      )
        continue;
      let args: Record<string, unknown>;
      if (call.name === "read") {
        // Real shape: {i, path} (+ query params for internal URIs). Identity = path only.
        if (typeof call.arguments.path !== "string" || !call.arguments.path.trim()) continue;
        args = { path: call.arguments.path };
      } else {
        if (typeof call.arguments.command !== "string" || !call.arguments.command.trim()) continue;
        args = { command: call.arguments.command };
        if (typeof call.arguments.cwd === "string" && call.arguments.cwd.trim())
          args.cwd = call.arguments.cwd;
      }
      const content = message.content[0].text;
      records.push({ call_id: id, tool_name: call.name, arguments: args, status: "ok", content });
      positions.set(id, i);
    }
    return { records, positions };
  }
  pi.on("context", async (event: { messages: any[] }, ctx: ExtensionContext) => {
    candidate = null;
    const requestGeneration = generation;
    const session = sessionId(ctx);
    const collected = collect(event.messages);
    if (!session || !collected) return;
    const next: Candidate = {
      session,
      token: randomUUID(),
      confirmed: false,
      records: collected.records,
    };
    candidate = next;
    const deadline = Date.now() + SUMMARY_TIMEOUT_MS;
    const users = event.messages.filter((message) => message?.role === "user");
    const turn = users.length ? `${users.length}:${hash(messageText(users.at(-1)))}` : "";
    let usage: { tokens: number; contextWindow?: number } | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      /* use request estimate */
    }
    const tokens =
      usage && Number.isFinite(usage.tokens) && usage.tokens >= 0
        ? usage.tokens
        : Math.ceil(JSON.stringify(event.messages).length / 4);
    const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? undefined;
    let reminder = reminders.get(session);
    if (!reminder) {
      reminder = new BoundaryReminder();
      reminders.set(session, reminder);
    }
    if (reminders.size > 128) reminders.delete(reminders.keys().next().value!);
    let note: string | null = null;
    let reminderItems: ReminderItem[] = [],
      eligibleCount = 0;
    const prepared = queue.then(async () => {
      const response = await prepareRequest(
        collected.records,
        session,
        next.token,
        rpcOnce,
        (content, timeout) => summarizeText(ctx, content, timeout),
        deadline,
        () => generation === requestGeneration && sessionId(ctx) === session,
      );
      if (!child && response.ok && collected.records.length && reminder.due(turn, tokens, window)) {
        const listed = await rpcOnce(
          "list_candidates",
          { session_id: session, snapshot_id: next.token, limit: 3 },
          2000,
        );
        if (listed.ok && Array.isArray(listed.items)) {
          reminderItems = (listed.items as ReminderItem[])
            .filter(
              (item) =>
                typeof item?.tool_call_id === "string" && typeof item.bytes_size === "number",
            )
            .map((item) => ({
              ...item,
              turn: event.messages
                .slice(0, (collected.positions.get(item.tool_call_id) ?? -1) + 1)
                .filter((message) => message.role === "user").length,
            }));
          eligibleCount = Number(listed.total ?? reminderItems.length);
        }
      }
      return response;
    });
    queue = prepared.catch(() => undefined);
    const response = await prepared;
    const fatalErrors = [
      "db_error",
      "db_full",
      "unsafe_journal_mode",
      "engine_protocol_incompatible",
      "worker_error",
      "invalid_response",
    ];
    const dbFailure =
      !response.ok && typeof response.error === "string" && fatalErrors.includes(response.error);
    if (dbFailure) {
      // D9: persistence failure is never silent. Headless aborts; interactive asks.
      candidate = null;
      const mode = (ctx as { mode?: string }).mode;
      if (mode !== "tui") {
        try {
          ctx.abort?.();
        } catch {
          /* ignore */
        }
        throw new Error(`session-navigation: ${response.error} (aborted)`);
      }
      try {
        const choices = Array.isArray(response.choices)
          ? (response.choices as string[])
          : ["abort_request", "send_original"];
        const choice = await ctx.ui.select(
          "Database error",
          choices.map((c) => ({ label: c })),
        );
        if (choice === "abort_request" || !choice) {
          try {
            ctx.abort?.();
          } catch {
            /* ignore */
          }
          throw new Error("session-navigation: db_error (aborted by user choice)");
        }
        ctx.ui.notify?.(
          "session-navigation: proceeding with originals (explicit choice)",
          "warning",
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes("session-navigation: db_error")) throw err;
        try {
          ctx.abort?.();
        } catch {
          /* ignore */
        }
        throw new Error("session-navigation: db_error (aborted)");
      }
      return;
    }
    // A newer context hook may have replaced `candidate`; these patches still belong to this request's messages.
    if (!response.ok || !Array.isArray(response.patches)) {
      if (candidate === next) candidate = null;
      return;
    }
    let messages: any[] | null = null;
    for (const patch of response.patches) {
      if (
        !patch ||
        typeof patch.call_id !== "string" ||
        typeof patch.sha256 !== "string" ||
        typeof patch.text !== "string"
      )
        continue;
      const index = collected.positions.get(patch.call_id);
      if (index === undefined) continue;
      const original = event.messages[index];
      const block = original?.content?.[0];
      if (
        original?.toolCallId !== patch.call_id ||
        original.isError !== false ||
        original.content.length !== 1 ||
        block?.type !== "text" ||
        typeof block.text !== "string" ||
        hash(block.text) !== patch.sha256
      )
        continue;
      messages ??= event.messages.slice();
      messages[index] = { ...original, content: [{ ...block, text: patch.text }] };
    }
    const hidden = new Set<string>(
      Array.isArray(response.hidden_messages)
        ? (response.hidden_messages as unknown[]).filter((k): k is string => typeof k === "string")
        : [],
    );
    messages = dropHiddenMessages(messages ?? event.messages, hidden) ?? messages;
    const saved = messages
      ? Math.ceil((JSON.stringify(event.messages).length - JSON.stringify(messages).length) / 4)
      : 0;
    note = child ? null : reminder.note(turn, Math.max(0, tokens - saved), window, eligibleCount, reminderItems);
    if (note)
      messages = [
        ...(messages ?? event.messages),
        { role: "user", content: [{ type: "text", text: note }], timestamp: Date.now() },
      ];
    if (messages) return { messages };
  });
  pi.on(
    "assistant_message",
    async (event: { message: { role?: string; stopReason?: string } }, ctx: ExtensionContext) => {
      if (event.message?.role !== "assistant") return;
      if (
        candidate &&
        candidate.session === sessionId(ctx) &&
        (event.message.stopReason === "stop" || event.message.stopReason === "toolUse")
      )
        candidate.confirmed = true;
      else candidate = null;
    },
  );
  pi.on("session_switch", async () => {
    invalidateSnapshot();
  });
  pi.on("tool_result", async (event, ctx) => {
    const progress = (event.details as { progress?: unknown })?.progress;
    if (event.toolName !== "task" || !Array.isArray(progress)) return;
    await rpc("link_children", { session_id: sessionId(ctx), tool_call_id: event.toolCallId,
      subagent_ids: progress.filter((entry) => entry && typeof entry.id === "string").map((entry) => entry.id) }, 2000);
  });
  async function tool(
    method: string,
    params: unknown,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) {
    const session = sessionId(ctx);
    if (!session) return { ok: false, error: "invalid_session" };
    if (
      (method === "compact" ||
        method === "summarize" ||
        method === "manage" ||
        method === "list_candidates") &&
      (!candidate?.confirmed || candidate.session !== session)
    )
      return { ok: false, error: "unconfirmed_snapshot" };
    return rpc(
      method,
      {
        ...(params as Record<string, unknown>),
        session_id: session,
        snapshot_id: candidate?.token,
      },
      method === "summarize" || method === "manage" ? 25_000 : 5000,
      signal,
    );
  }
  function result(value: Reply) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
  }
  // D5: session-model-only summary. Returns target text or null when no session
  // model is available. Budget refusals propagate as input_too_large.
  async function summarizeText(
    ctx: unknown,
    content: string,
    timeout = SUMMARY_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<string | null> {
    summarySource(content);
    try {
      if (!ctx || typeof ctx !== "object") return null;
      const c: Record<string, unknown> = ctx as Record<string, unknown>;
      const models: unknown = c["models"];
      const current: unknown =
        models && typeof models === "object" && "current" in models
          ? (models as Record<string, unknown>)["current"]
          : undefined;
      const getter: unknown = c["getModel"] ?? current ?? c["model"];
      const model: unknown =
        typeof getter === "function" ? (getter as () => unknown).call(ctx) : getter;
      if (!model || typeof model !== "object") return null;
      // D5: session model via modelRegistry.resolver (auth-retry policy).
      const registry: unknown = c["modelRegistry"];
      const resolverFn: unknown =
        registry && typeof registry === "object" && "resolver" in registry
          ? (registry as Record<string, unknown>)["resolver"]
          : undefined;
      if (typeof resolverFn !== "function") return null;
      const sessionId = sessionIdFrom(ctx);
      let apiKey: unknown;
      try {
        apiKey = (resolverFn as (m: unknown, s?: string) => unknown).call(
          registry,
          model,
          sessionId ?? undefined,
        );
      } catch {
        return null;
      }
      if (!apiKey) return null;
      // Dynamic import: @oh-my-pi/pi-ai ships with the host, not this extension bundle.
      const mod: unknown = await import("@oh-my-pi/pi-ai");
      const complete: unknown =
        mod && typeof mod === "object" && "completeSimple" in mod
          ? (mod as Record<string, unknown>)["completeSimple"]
          : undefined;
      if (typeof complete !== "function") return null;
      const window = (model as { contextWindow?: number }).contextWindow;
      const budget = typeof window === "number" && Number.isFinite(window)
        ? Math.min(MAX_SUMMARY_INPUT_BYTES, Math.max(0, window - 8192)) : MAX_SUMMARY_INPUT_BYTES;
      const prompt = summaryPrompt(content, budget);
      const params = { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
      // 25s end-to-end: the RPC timeout after this covers transport, this covers the model call.
      const controller = new AbortController();
      if (signal?.aborted) return null;
      const abort = (): void => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      modelControllers.add(controller);
      let msg: unknown;
      try {
        msg = await withTimeout(
          timeout,
          (complete as (m: unknown, cc: unknown, o?: unknown) => Promise<unknown>)(model, params, {
            apiKey,
            disableReasoning: true,
            signal: controller.signal,
          }),
          controller.signal,
        );
      } finally {
        controller.abort();
        modelControllers.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
      if (!msg || typeof msg !== "object" || !("content" in msg)) return null;
      const blocks: unknown = (msg as { content: unknown }).content;
      if (!Array.isArray(blocks)) return null;
      const parts: string[] = [];
      for (const b of blocks) {
        if (
          b &&
          typeof b === "object" &&
          "text" in b &&
          typeof (b as { text: unknown }).text === "string"
        )
          parts.push((b as { text: string }).text);
      }
      const text = parts.join("\n").trim();
      return text || null;
    } catch (error) {
      if ((error as { reason?: string })?.reason === "input_too_large") throw error;
      return null;
    }
  }
  function sessionIdFrom(ctx: unknown): string | null {
    try {
      const c = ctx as { sessionManager?: { getSessionId?: () => unknown } };
      const id = c?.sessionManager?.getSessionId?.();
      return typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes(":")
        ? id
        : null;
    } catch {
      return null;
    }
  }
  async function withTimeout<T>(ms: number, promise: Promise<T>, signal: AbortSignal): Promise<T> {
    const deadline = Promise.withResolvers<never>();
    const abort = (): void => deadline.reject(new Error("session-navigation: summarize cancelled"));
    const timer = setTimeout(
      () => deadline.reject(new Error("session-navigation: summarize timeout")),
      ms,
    );
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([promise, deadline.promise]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  pi.on("session_shutdown", async () => {
    invalidateSnapshot();
    client.close();
    releaseExtension(owner);
  });
  if (child) {
    await rpc("register", { session_id: sessionId(startContext) }, 2000);
    return;
  }
  pi.registerTool({
    name: "list_context_items",
    label: "List Context Items",
    description:
      "Discover visible cleanup IDs with view=candidates; default items lists stored results. limit is display-only (default 30).",
    parameters: z.object({
      query: z.string().optional(),
      view: z.enum(["items", "candidates"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      return result(
        await tool(
          (params as { view?: string }).view === "candidates" ? "list_candidates" : "list_items",
          params,
          ctx,
          signal,
        ),
      );
    },
  });
  async function manageChosen(
    params: Record<string, unknown>,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<Reply> {
    const ids = params.tool_call_ids;
    if (ids === undefined || (Array.isArray(ids) && ids.length === 0))
      return { ok: false, error: "tool_call_ids_required" };
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.trim()))
      return { ok: false, error: "invalid_tool_call_ids" };
    const snapshot = candidate;
    const session = sessionId(ctx);
    if (!session || !snapshot?.confirmed || snapshot.session !== session)
      return { ok: false, error: "unconfirmed_snapshot" };
    const action = params.action ?? "auto";
    if (!["auto", "hide", "summarize"].includes(String(action)))
      return { ok: false, error: "invalid_action" };
    if (params.keep_lines !== undefined && action !== "hide")
      return { ok: false, error: "invalid_keep_lines_action" };
    const wanted = [...new Set(ids as string[])];
    const records = new Map(snapshot.records.map((record) => [record.call_id, record]));
    const items: any[] = [];
    for (let offset = 0; offset < wanted.length; offset += MAX_CHUNK_RECORDS) {
      if (candidate !== snapshot) return { ok: false, error: "unconfirmed_snapshot", items };
      if (signal?.aborted) return { ok: false, error: "cancelled", items };
      const batch = wanted.slice(offset, offset + MAX_CHUNK_RECORDS);
      const summaries: Record<string, string> = {};
      if (action !== "hide") {
        const eligible = await tool(
          "list_candidates",
          { tool_call_ids: batch, limit: batch.length },
          ctx,
          signal,
        );
        if (!eligible.ok) return eligible;
        const queue = (eligible.items as { tool_call_id: string }[])
          .map((item) => records.get(item.tool_call_id))
          .filter((record): record is RecordItem => !!record);
        await Promise.all(
          Array.from({ length: Math.min(MAX_SUMMARY_CONCURRENCY, queue.length) }, async () => {
            while (queue.length && !signal?.aborted && candidate === snapshot) {
              const record = queue.shift()!;
              let text: string | null;
              try {
                text = await summarizeText(ctx, record.content, SUMMARY_TIMEOUT_MS, signal);
              } catch (error) {
                if (action === "auto") continue;
                throw error;
              }
              if (text) summaries[record.call_id] = text;
            }
          }),
        );
      }
      if (candidate !== snapshot) return { ok: false, error: "unconfirmed_snapshot", items };
      const response = await tool(
        "manage",
        {
          tool_call_ids: batch,
          action,
          summaries,
          ...(params.keep_lines !== undefined ? { keep_lines: params.keep_lines } : {}),
        },
        ctx,
        signal,
      );
      if (!Array.isArray(response.items)) return response;
      items.push(...response.items);
    }
    const applied = items.filter((item) => item.ok).length;
    return { ok: applied === items.length, applied, failed: items.length - applied, items };
  }
  pi.registerTool({
    name: "manage_context",
    label: "Manage Context",
    description:
      "Clean agent-chosen tool_call_ids. action: hide=rules, summarize=session LLM, auto=summary with rule fallback. keep_lines: single-line substrings (hide only, 1024 bytes per target). Whitespace/line-number near misses are normalized. Unmatched or invalid entries are ignored per target with English reasons in keep_lines_ignored; valid entries still apply.",
    parameters: z.object({
      tool_call_ids: z.array(z.string()),
      action: z.enum(["auto", "hide", "summarize"]).optional(),
      keep_lines: z.array(z.string()).optional(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        return result(await manageChosen(params as Record<string, unknown>, ctx, signal));
      } catch (error) {
        if ((error as { reason?: string })?.reason === "input_too_large")
          return result({ ok: false, error: "input_too_large" });
        throw error;
      }
    },
  });
  pi.registerTool({
    name: "hide_context",
    label: "Hide Context",
    description: "Hide one result with rule excerpts; no LLM.",
    parameters: z.object({ tool_call_id: z.string() }),
    async execute(_id, params, signal, _update, ctx) {
      return result(await tool("compact", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "summarize_context",
    label: "Summarize Context",
    description: "Summarize one result using the session LLM; no rule fallback.",
    parameters: z.object({ tool_call_id: z.string() }),
    async execute(_id, params, signal, _update, ctx) {
      const session = sessionId(ctx);
      const snapshot = candidate;
      if (session && candidate?.confirmed && candidate.session === session) {
        const target = candidate.records.find(
          (r) => r.call_id === (params as { tool_call_id: string }).tool_call_id,
        );
        if (target) {
          let summary: string | null;
          try {
            summary = await summarizeText(ctx, target.content, SUMMARY_TIMEOUT_MS, signal);
          } catch (error) {
            if ((error as { reason?: string })?.reason === "input_too_large")
              return result({ ok: false, error: "input_too_large" });
            throw error;
          }
          if (signal?.aborted) return result({ ok: false, error: "cancelled" });
          if (candidate !== snapshot) return result({ ok: false, error: "unconfirmed_snapshot" });
          if (summary)
            return result(
              await tool(
                "summarize",
                { ...(params as Record<string, unknown>), summary_text: summary },
                ctx,
                signal,
              ),
            );
          return result({ ok: false, error: "summarizer_unavailable" });
        }
      }
      return result(await tool("summarize", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "unhide_context",
    label: "Unhide Context",
    description: "Restore an original by item_id without re-execution.",
    parameters: z.object({ item_id: z.string() }),
    async execute(_id, params, signal, _update, ctx) {
      return result(await tool("restore", params, ctx, signal));
    },
  });
  registerOverlay(pi, {
    sessionId,
    getCandidate: () => candidate,
    rpc,
    summarizeText,
    manageChosen,
  });
}
