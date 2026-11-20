import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { WorkerClient, type RequestOptions, type ServiceClient } from "./client.ts";
import { acquireExtension, releaseExtension } from "./registration.ts";
import {
  ADAPTER_RPC_TIMEOUT_MS,
  BoundaryReminder,
  CLEANUP_GUIDANCE,
  MAX_SUMMARY_CONCURRENCY,
  MAX_CHUNK_RECORDS,
  SUMMARY_TIMEOUT_MS,
  dropHiddenMessages,
  ompInvocationArgs,
  prepareRequest,
  messageText,
  safeString,
  toolResultText,
  hash,
  type Candidate,
  type RecordItem,
  type Reply,
  type ReminderItem,
} from "./context.ts";
import { registerOverlay } from "./overlay.ts";
import { childLinkage } from "./subagents.ts";
import {
  MAX_SUMMARY_INPUT_BYTES,
  SEQUENCE_CHUNK_BYTES,
  chunkSequenceSteps,
  composeHybridSlotSummaries,
  sequenceSummaryPrompt,
  summaryPrompt,
  summarySource,
  summaryWithRetry,
  validateSequenceChunk,
  type SequenceStepInput,
} from "../../core/src/summary.ts";
import { requiredEvidence } from "../../core/src/policy.ts";
import { MINIMUM_SQLITE_VERSION, runtimeSqliteVersion, supportedSqliteVersion } from "./sqlite-runtime.ts";
export * from "./context.ts";

export interface ExtensionOptions {
  client?: (invalidateSnapshot: () => void) => ServiceClient;
  sqliteVersion?: () => string;
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
    let version: string;
    try {
      version = (options.sqliteVersion ?? runtimeSqliteVersion)();
    } catch {
      version = "unknown";
    }
    if (!supportedSqliteVersion(version)) {
      const message = `session-navigation: SQLite ${version}은 지원되지 않습니다. SQLite ${MINIMUM_SQLITE_VERSION} 이상이 필요합니다. 숨긴 컨텍스트를 보호할 수 없어 요청을 중단합니다.`;
      try { ctx.ui?.notify?.(message, "error"); } catch { /* report through the hook too */ }
      console.error(message);
      // A prior session may contain hidden context. Never send originals silently.
      pi.on("context", async (_event, requestContext) => {
        try { requestContext.abort?.(); } catch { /* surface the explicit error below */ }
        throw new Error(message);
      });
      return;
    }
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
  let adapterEnabled = true;
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
    options?: RequestOptions,
  ): Promise<Reply> => client.request(method, { ...params, ...(linkage ?? {}) }, timeout, signal, options) as Promise<Reply>;
  function rpc(
    method: string,
    params: object,
    timeout: number,
    signal?: AbortSignal,
    options?: RequestOptions,
  ): Promise<Reply> {
    const run = queue.then(() => rpcOnce(method, params, timeout, signal, options));
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
  if (!child) pi.on("before_agent_start", async (event, ctx) => {
    try {
      const sid = sessionId(ctx) ?? sessionId(startContext) ?? "main";
      // P0-4: read-only probe — never kill the worker or start a cooldown on a
      // slow status, and allow a full busy_timeout + margin for lock waits.
      const status = await rpc("adapter_status", { session_id: sid }, ADAPTER_RPC_TIMEOUT_MS, undefined, {
        invalidateOnTimeout: false,
      });
      if (status && status.ok && typeof status.enabled === "boolean") {
        adapterEnabled = status.enabled;
      }
    } catch {
      /* retain last known adapterEnabled */
    }
    if (!adapterEnabled) {
      return { systemPrompt: [...event.systemPrompt] };
    }
    return {
      systemPrompt: [...event.systemPrompt, CLEANUP_GUIDANCE],
    };
  });
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
        typeof call.name !== "string" ||
        call.name !== message.toolName ||
        !call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments)
      )
        continue;
      const args = ompInvocationArgs(call.name, call.arguments as Record<string, unknown>);
      if (!args) continue;
      const content = toolResultText(message);
      if (content === null) continue;
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
    const users = event.messages.filter((message) => message?.role === "user");
    const turn = users.length ? `${users.length}:${hash(messageText(users.at(-1)))}` : "";
    let reminder = reminders.get(session);
    if (!reminder) {
      reminder = new BoundaryReminder();
      reminders.set(session, reminder);
    }
    if (reminders.size > 128) reminders.delete(reminders.keys().next().value!);
    let note: string | null = null;
    let reminderItems: ReminderItem[] = [],
      eligibleCount = 0,
      eligibleBytes = 0,
      candidateIds: string[] = [];
    const prepared = queue.then(async () => {
      const response = await prepareRequest(
        collected.records,
        session,
        next.token,
        rpcOnce,
        (content, timeout) => summarizeText(ctx, content, timeout),
        undefined,
        () => generation === requestGeneration && sessionId(ctx) === session,
      );
      if (!child && response.ok) {
        const rawItems = Array.isArray(response.reminder_items)
          ? (response.reminder_items as ReminderItem[])
          : [];
        reminderItems = rawItems
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
        eligibleCount = Number(response.eligible_count ?? reminderItems.length);
        eligibleBytes = Number(
          response.eligible_bytes ??
            reminderItems.reduce((sum, item) => sum + item.bytes_size, 0),
        );
        candidateIds = Array.isArray(response.candidate_ids)
          ? (response.candidate_ids as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : reminderItems.map((item) => item.tool_call_id);
      }
      return response;
    });
    queue = prepared.catch(() => undefined);
    const response = await prepared;
    if (response.adapter_enabled === false) {
      adapterEnabled = false;
    } else if (response.ok) {
      adapterEnabled = true;
    }
    // Fail-closed set: these errors mean the worker could not prove what is
    // hidden, so sending the original messages would leak hidden content.
    // adapter_disabled covers a disable mid-prepare (P0-3); cooldown/timeout
    // cover worker invalidation after a slow status/lock wait (P0-4).
    const fatalErrors = [
      "db_error",
      "db_full",
      "unsafe_journal_mode",
      "engine_protocol_incompatible",
      "worker_error",
      "invalid_response",
      "adapter_disabled",
      "cooldown",
      "timeout",
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
      const text = toolResultText(original);
      if (
        original?.toolCallId !== patch.call_id ||
        text === null ||
        hash(text) !== patch.sha256
      )
        continue;
      messages ??= event.messages.slice();
      messages[index] = { ...original, content: [{ type: "text", text: patch.text }] };
    }
    const hidden = new Set<string>(
      Array.isArray(response.hidden_messages)
        ? (response.hidden_messages as unknown[]).filter((k): k is string => typeof k === "string")
        : [],
    );
    const effective = messages ?? event.messages;
    const afterHidden = dropHiddenMessages(effective, hidden);
    if (afterHidden) messages = afterHidden;
    const activeMessages = messages ?? event.messages;
    let afterTool = false;
    for (let idx = activeMessages.length - 1; idx >= 0; idx--) {
      const msg = activeMessages[idx];
      if (msg?.role !== "toolResult") break;
      const toolName = safeString(msg.toolName ?? "");
      if (
        toolName === "manage_context" ||
        toolName === "hide_context" ||
        toolName === "summarize_context" ||
        toolName === "unhide_context"
      ) {
        afterTool = false;
        break;
      }
      afterTool = true;
    }
    note = child || !adapterEnabled || response.adapter_enabled === false
      ? null
      : reminder.note(
          turn,
          0,
          undefined,
          eligibleCount,
          reminderItems,
          eligibleBytes,
          candidateIds,
          afterTool,
          activeMessages.length,
        );
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
        method === "summary_state" ||
        method === "manage" ||
        method === "list_candidates") &&
      (!candidate?.confirmed || candidate.session !== session)
    ) {
      if (method !== "list_candidates") {
        const status = await rpc("adapter_status", { session_id: session }, ADAPTER_RPC_TIMEOUT_MS, signal, {
          invalidateOnTimeout: false,
        });
        if (status.ok && status.enabled === false) {
          adapterEnabled = false;
          return { ok: false, error: "adapter_disabled" };
        }
      }
      return { ok: false, error: "unconfirmed_snapshot" };
    }
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
  function fmtBytePair(postBytes: number, preBytes: number): string {
    const post = Math.max(0, postBytes);
    const pre = Math.max(0, preBytes);
    if (pre < 1024 && post < 1024) return `${post}/${pre} B`;
    const preKib = (pre / 1024).toFixed(1);
    if (post === 0) return `0/${preKib} KiB`;
    const postKib = post / 1024;
    return postKib < 0.05 ? `<0.1/${preKib} KiB` : `${postKib.toFixed(1)}/${preKib} KiB`;
  }
  function formatManageText(value: Reply): string {
    if (!Array.isArray(value.items)) return JSON.stringify(value);
    const items = value.items as Record<string, unknown>[];
    const applied = items.filter((item) => Boolean(item.ok));
    const failed = items.filter((item) => !item.ok);
    const sumCount = applied.filter((item) => item.mode === "summarize").length;
    const hideCount = applied.length - sumCount;
    const parts: string[] = [];
    if (hideCount > 0) parts.push(`${hideCount} hide`);
    if (sumCount > 0) parts.push(`${sumCount} summarize`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);
    const postTotal = applied.reduce(
      (sum, item) => sum + (typeof item.compacted_bytes === "number" ? item.compacted_bytes : 0),
      0,
    );
    const preTotal = applied.reduce(
      (sum, item) => sum + (typeof item.original_bytes === "number" ? item.original_bytes : 0),
      0,
    );
    const headerSize = preTotal > 0 ? ` · ${fmtBytePair(postTotal, preTotal)}` : "";
    const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    const lines = [`${applied.length} managed${breakdown}${headerSize}`];
    for (const item of items) {
      const toolName =
        typeof item.tool_name === "string" && item.tool_name
          ? item.tool_name
          : typeof item.tool_call_id === "string"
            ? item.tool_call_id
            : "tool";
      const hint = typeof item.hint === "string" && item.hint ? ` ${item.hint}` : "";
      if (item.ok) {
        const mode = item.mode === "summarize" ? "summarize" : "hide";
        const size =
          typeof item.compacted_bytes === "number" && typeof item.original_bytes === "number"
            ? ` · ${fmtBytePair(item.compacted_bytes, item.original_bytes)}`
            : "";
        lines.push(`- [${mode}] ${toolName}${hint}${size}`);
      } else {
        const err = typeof item.error === "string" ? item.error : "failed";
        lines.push(`- [failed: ${err}] ${toolName}${hint}`);
      }
      if (Array.isArray(item.keep_lines_ignored) && item.keep_lines_ignored.length > 0) {
        lines.push(`  keep_lines_ignored: ${JSON.stringify(item.keep_lines_ignored)}`);
      }
    }
    return lines.join("\n");
  }
  function manageResult(value: Reply) {
    return { content: [{ type: "text" as const, text: formatManageText(value) }], details: value };
  }
  // D5: session-model-only summary. Returns target text or null when no session
  // model is available. Budget refusals propagate as input_too_large.
  async function summarizeText(
    ctx: unknown,
    content: string,
    timeout = SUMMARY_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await summaryWithRetry(content, requiredEvidence(content), async feedback => {
      const text = await summarizeAttempt(ctx, content, timeout, signal, feedback);
      return text === null ? null : { summary: text };
    });
    return result && typeof result === "object" && "summary" in result ? String(result.summary) : null;
  }
  function resolveModelWindow(ctx: unknown): number | undefined {
    if (!ctx || typeof ctx !== "object") return undefined;
    const c = ctx as Record<string, unknown>;
    const models = c["models"];
    const current =
      models && typeof models === "object" && "current" in models
        ? (models as Record<string, unknown>)["current"]
        : undefined;
    const getter = c["getModel"] ?? current ?? c["model"];
    const model = typeof getter === "function" ? (getter as () => unknown).call(ctx) : getter;
    if (!model || typeof model !== "object" || !("contextWindow" in model)) return undefined;
    const win = model.contextWindow;
    return typeof win === "number" && Number.isFinite(win) ? win : undefined;
  }
  async function requestModelCompletion(
    ctx: unknown,
    prompt: string,
    timeout: number,
    signal?: AbortSignal,
    feedback?: string,
  ): Promise<string | null> {
    try {
      if (!ctx || typeof ctx !== "object") return null;
      const c = ctx as Record<string, unknown>;
      const models = c["models"];
      const current =
        models && typeof models === "object" && "current" in models
          ? (models as Record<string, unknown>)["current"]
          : undefined;
      const getter = c["getModel"] ?? current ?? c["model"];
      const model = typeof getter === "function" ? (getter as () => unknown).call(ctx) : getter;
      if (!model || typeof model !== "object") return null;
      // D5: session model via modelRegistry.resolver (auth-retry policy).
      const registry = c["modelRegistry"];
      const resolverFn =
        registry && typeof registry === "object" && "resolver" in registry
          ? (registry as Record<string, unknown>)["resolver"]
          : undefined;
      if (typeof resolverFn !== "function") return null;
      const currentSession = sessionIdFrom(ctx);
      let apiKey: unknown;
      try {
        apiKey = (resolverFn as (m: unknown, s?: string) => unknown).call(
          registry,
          model,
          currentSession ?? undefined,
        );
      } catch {
        return null;
      }
      if (!apiKey) return null;
      // Platform host module shipped by OMP runtime rather than bundled into this extension.
      const mod: unknown = await import("@oh-my-pi/pi-ai");
      const complete =
        mod && typeof mod === "object" && "completeSimple" in mod
          ? (mod as Record<string, unknown>)["completeSimple"]
          : undefined;
      if (typeof complete !== "function") return null;
      const params = { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
      if (feedback) params.messages.push({ role: "user", content: [{ type: "text", text: feedback }] });
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
      const rawUsage = "usage" in msg && msg.usage && typeof msg.usage === "object" ? msg.usage : null;
      const num = (obj: object | null, key: string) =>
        obj && key in obj && typeof (obj as Record<string, unknown>)[key] === "number"
          ? ((obj as Record<string, number>)[key] ?? 0)
          : 0;
      const costObj =
        rawUsage && "cost" in rawUsage && rawUsage.cost && typeof rawUsage.cost === "object"
          ? rawUsage.cost
          : null;
      const totalCost =
        costObj && "total" in costObj && typeof costObj.total === "number" ? costObj.total : null;
      try {
        await rpcOnce(
          "record_summary_call",
          {
            session_id: currentSession,
            call_key: `summary:${randomUUID()}`,
            prompt_tokens: num(rawUsage, "input") + num(rawUsage, "cacheRead") + num(rawUsage, "cacheWrite"),
            completion_tokens: num(rawUsage, "output"),
            total_tokens: num(rawUsage, "totalTokens"),
            cost_usd: totalCost,
          },
          2000,
        );
      } catch {}
      const blocks = msg.content;
      if (!Array.isArray(blocks)) return null;
      const parts: string[] = [];
      for (const b of blocks) {
        if (b && typeof b === "object" && "text" in b && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
      const text = parts.join("\n").trim();
      return text || null;
    } catch {
      return null;
    }
  }
  async function summarizeAttempt(
    ctx: unknown,
    content: string,
    timeout: number,
    signal?: AbortSignal,
    feedback?: string,
  ): Promise<string | null> {
    summarySource(content);
    const win = resolveModelWindow(ctx);
    const budget =
      win !== undefined
        ? Math.min(MAX_SUMMARY_INPUT_BYTES, Math.max(0, win - 8192))
        : MAX_SUMMARY_INPUT_BYTES;
    const prompt = summaryPrompt(content, budget);
    return requestModelCompletion(ctx, prompt, timeout, signal, feedback);
  }
  async function summarizeSequence(
    ctx: unknown,
    orderedRecords: readonly RecordItem[],
    action: string,
    isStillValid: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ summaries: Record<string, string>; failure?: string }> {
    const win = resolveModelWindow(ctx);
    const chunkBudget =
      win !== undefined && win > 16384
        ? Math.min(SEQUENCE_CHUNK_BYTES, win - 8192)
        : SEQUENCE_CHUNK_BYTES;
    const steps: SequenceStepInput[] = orderedRecords.map((rec) => ({
      call_id: rec.call_id,
      tool_name: rec.tool_name,
      invocation: { tool_name: rec.tool_name, arguments: rec.arguments as Record<string, string> },
      content: rec.content,
    }));
    const chunks = chunkSequenceSteps(steps, chunkBudget);
    const stepTraces: Record<string, string> = {};
    let priorSummary = "";
    for (const chunk of chunks) {
      if (signal?.aborted || !isStillValid()) return { summaries: {} };
      const prompt = sequenceSummaryPrompt(chunk, priorSummary || undefined);
      const first = await requestModelCompletion(ctx, prompt, SUMMARY_TIMEOUT_MS, signal);
      if (first === null) {
        if (action === "summarize") return { summaries: {}, failure: "summarizer_unavailable" };
        continue;
      }
      let check = validateSequenceChunk(chunk, first, priorSummary || undefined);
      if (!check.ok && !signal?.aborted && isStillValid()) {
        const second = await requestModelCompletion(
          ctx,
          prompt,
          SUMMARY_TIMEOUT_MS,
          signal,
          check.feedback,
        );
        if (second !== null) {
          check = validateSequenceChunk(chunk, second, priorSummary || undefined);
        }
      }
      if (!check.ok) {
        if (action === "summarize") return { summaries: {}, failure: "verification_failed" };
        continue;
      }
      Object.assign(stepTraces, check.steps);
      priorSummary = check.sequenceSummary;
    }
    return { summaries: composeHybridSlotSummaries(steps, stepTraces, priorSummary) };
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
    loadMode: "essential",
    approval: "read",
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
    const session = sessionId(ctx);
    if (!session) return { ok: false, error: "invalid_session" };
    const status = await rpc("adapter_status", { session_id: session }, ADAPTER_RPC_TIMEOUT_MS, signal, {
      invalidateOnTimeout: false,
    });
    if (status.ok && status.enabled === false) {
      adapterEnabled = false;
      return { ok: false, error: "adapter_disabled" };
    }
    const ids = params.tool_call_ids;
    if (ids === undefined || (Array.isArray(ids) && ids.length === 0))
      return { ok: false, error: "tool_call_ids_required" };
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.trim()))
      return { ok: false, error: "invalid_tool_call_ids" };
    const snapshot = candidate;
    if (!snapshot?.confirmed || snapshot.session !== session)
      return { ok: false, error: "unconfirmed_snapshot" };
    const action = params.action ?? "auto";
    if (!["auto", "hide", "summarize"].includes(safeString(action)))
      return { ok: false, error: "invalid_action" };
    const rawKeepLines = params.keep_lines;
    const normalizedKeepLines =
      rawKeepLines === null || (Array.isArray(rawKeepLines) && rawKeepLines.length === 0)
        ? undefined
        : rawKeepLines;
    if (normalizedKeepLines !== undefined && action !== "hide")
      return { ok: false, error: "invalid_keep_lines_action" };
    const wanted = [...new Set(ids as string[])];
    const summaries: Record<string, string> = {};
    const expectedVersions: Record<string, number> = {};
    let summaryFailure: string | undefined;
    if (action !== "hide") {
      const eligibleIds = new Set<string>();
      for (let offset = 0; offset < wanted.length; offset += MAX_CHUNK_RECORDS) {
        if (candidate !== snapshot) return { ok: false, error: "unconfirmed_snapshot", items: [] };
        if (signal?.aborted) return { ok: false, error: "cancelled", items: [] };
        const slice = wanted.slice(offset, offset + MAX_CHUNK_RECORDS);
        const eligible = await tool(
          "list_candidates",
          { tool_call_ids: slice, limit: slice.length, include_hidden: action === "summarize" },
          ctx,
          signal,
        );
        if (!eligible.ok) return eligible;
        if (Array.isArray(eligible.items)) {
          for (const entry of eligible.items) {
            if (entry && typeof entry === "object" && "tool_call_id" in entry && typeof entry.tool_call_id === "string") {
              eligibleIds.add(entry.tool_call_id);
            }
          }
        }
      }
      const uncachedIds = new Set<string>();
      for (const callId of eligibleIds) {
        if (candidate !== snapshot || signal?.aborted) break;
        const state = await tool("summary_state", { tool_call_id: callId }, ctx, signal);
        if (!state.ok) continue;
        expectedVersions[callId] = Number(state.expected_version);
        if (!state.cached) uncachedIds.add(callId);
      }
      const orderedUncached = snapshot.records.filter((record) => uncachedIds.has(record.call_id));
      if (orderedUncached.length > 0) {
        const outcome = await summarizeSequence(
          ctx,
          orderedUncached,
          String(action),
          () => candidate === snapshot,
          signal,
        );
        Object.assign(summaries, outcome.summaries);
        summaryFailure = outcome.failure;
      }
    }
    const items: Record<string, unknown>[] = [];
    for (let offset = 0; offset < wanted.length; offset += MAX_CHUNK_RECORDS) {
      if (candidate !== snapshot) return { ok: false, error: "unconfirmed_snapshot", items };
      if (signal?.aborted) return { ok: false, error: "cancelled", items };
      const batch = wanted.slice(offset, offset + MAX_CHUNK_RECORDS);
      const batchSummaries: Record<string, string> = {};
      const batchVersions: Record<string, number> = {};
      for (const id of batch) {
        if (summaries[id] !== undefined) batchSummaries[id] = summaries[id];
        if (expectedVersions[id] !== undefined) batchVersions[id] = expectedVersions[id];
      }
      const response = await tool(
        "manage",
        {
          tool_call_ids: batch,
          action,
          expected_versions: batchVersions,
          summaries: batchSummaries,
          sequence_verified: true,
          ...(summaryFailure ? { summary_failure: summaryFailure } : {}),
          ...(normalizedKeepLines !== undefined ? { keep_lines: normalizedKeepLines } : {}),
        },
        ctx,
        signal,
      );
      if (!Array.isArray(response.items)) return response;
      for (const entry of response.items) {
        if (entry && typeof entry === "object") items.push(entry as Record<string, unknown>);
      }
    }
    const appliedItems = items.filter((item) => Boolean(item.ok));
    const applied = appliedItems.length;
    const compactedBytes = appliedItems.reduce(
      (sum, item) => sum + (typeof item.compacted_bytes === "number" ? item.compacted_bytes : 0),
      0,
    );
    const originalBytes = appliedItems.reduce(
      (sum, item) => sum + (typeof item.original_bytes === "number" ? item.original_bytes : 0),
      0,
    );
    return {
      ok: applied === items.length,
      applied,
      failed: items.length - applied,
      compacted_bytes: compactedBytes,
      original_bytes: originalBytes,
      items,
    };
  }
  pi.registerTool({
    name: "manage_context",
    label: "Manage Context",
    loadMode: "essential",
    approval: "read",
    description:
      "Clean agent-chosen tool_call_ids. action: hide=rules, summarize=session LLM, auto=summary with rule fallback. keep_lines: single-line substrings (hide only, 1024 bytes per target). Whitespace/line-number near misses are normalized. Unmatched or invalid entries are ignored per target with English reasons in keep_lines_ignored; valid entries still apply.",
    parameters: z.object({
      tool_call_ids: z.array(z.string()),
      action: z.enum(["auto", "hide", "summarize"]).optional(),
      keep_lines: z.array(z.string()).optional(),
    }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        return manageResult(await manageChosen(params as Record<string, unknown>, ctx, signal));
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
    loadMode: "essential",
    approval: "read",
    description: "Hide one result with rule excerpts; no LLM.",
    parameters: z.object({ tool_call_id: z.string() }),
    async execute(_id, params, signal, _update, ctx) {
      return result(await tool("compact", params, ctx, signal));
    },
  });
  pi.registerTool({
    name: "summarize_context",
    label: "Summarize Context",
    loadMode: "essential",
    approval: "read",
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
          const state = await tool("summary_state", params, ctx, signal);
          if (!state.ok) return result(state);
          const fencedParams = { ...(params as Record<string, unknown>), expected_version: state.expected_version };
          if (state.cached) return result(await tool("summarize", fencedParams, ctx, signal));
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
                { ...fencedParams, summary_text: summary },
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
    loadMode: "essential",
    approval: "read",
    description: "Restore an original by item_id without re-execution.",
    parameters: z.object({ item_id: z.string() }),
    async execute(_id, params, signal, _update, ctx) {
      const reply = await tool("restore", params, ctx, signal);
      const sid = sessionId(ctx);
      if (reply.ok && sid) reminders.get(sid)?.suppressUnhide();
      return result(reply);
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
