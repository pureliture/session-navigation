import { createHash } from "node:crypto";

export type ReminderItem = {
  tool_call_id: string;
  tool_name?: string;
  hint?: string;
  bytes_size: number;
  turn?: number;
};
const REMINDER_BYTES = 16 * 1024;
const REMINDER_MAX_ID_CHARS = 128;
const REMINDER_MAX_NOTES_PER_WAVE = 4;
export const REMINDER_ELIGIBLE_STEP_BYTES = 100 * 1024;
export const REMINDER_WORTHWHILE_BYTES = 32 * 1024;
type ReminderState = {
  turn: string;
  watermark: number;
  intraCredit: number;
  unfiredCredit: number;
  firedInTurn: boolean;
  notesInWave: number;
  lastFiredStep: number | null;
  suppressNextGrowth: boolean;
};

export class BoundaryReminder {
  private state: ReminderState | undefined;

  suppressUnhide(): void {
    if (this.state) this.state.suppressNextGrowth = true;
    else {
      this.state = {
        turn: "",
        watermark: 0,
        intraCredit: 0,
        unfiredCredit: 0,
        firedInTurn: false,
        notesInWave: 0,
        lastFiredStep: null,
        suppressNextGrowth: true,
      };
    }
  }

  note(
    turn: string,
    _tokens: number,
    _window: number | undefined,
    total: number,
    items: ReminderItem[],
    eligibleBytes?: number,
    _candidateIds?: readonly string[],
    afterTool = true,
    stepKey?: number,
  ): string | null {
    if (!turn) return null;
    const bytesTotal =
      total <= 0
        ? 0
        : typeof eligibleBytes === "number" && Number.isFinite(eligibleBytes) && eligibleBytes >= 0
          ? eligibleBytes
          : items.reduce(
              (sum, item) =>
                sum +
                (typeof item?.bytes_size === "number" && item.bytes_size > 0 ? item.bytes_size : 0),
              0,
            );
    const state =
      this.state ??
      (this.state = {
        turn: "",
        watermark: 0,
        intraCredit: 0,
        unfiredCredit: 0,
        firedInTurn: false,
        notesInWave: 0,
        lastFiredStep: null,
        suppressNextGrowth: false,
      });

    const isNewTurn = state.turn !== turn;
    const delta = bytesTotal - state.watermark;
    const wasSuppressed = state.suppressNextGrowth;
    state.suppressNextGrowth = false;
    state.turn = turn;
    state.watermark = bytesTotal;

    if (wasSuppressed) {
      if (isNewTurn) {
        if (state.firedInTurn) state.unfiredCredit = 0;
        state.intraCredit = 0;
        state.firedInTurn = false;
        state.notesInWave = 0;
        state.lastFiredStep = null;
      }
      if (bytesTotal < state.unfiredCredit) state.unfiredCredit = bytesTotal;
      return null;
    }

    if (delta < 0) {
      state.unfiredCredit = 0;
      state.intraCredit = 0;
      state.firedInTurn = false;
      state.notesInWave = 0;
      state.lastFiredStep = null;
    } else {
      const gain = delta > 0 ? delta : 0;
      if (isNewTurn) {
        state.unfiredCredit = state.firedInTurn
          ? Math.min(bytesTotal, gain)
          : Math.min(bytesTotal, state.unfiredCredit + gain);
        state.intraCredit = gain;
        state.firedInTurn = false;
        state.notesInWave = 0;
        state.lastFiredStep = null;
      } else {
        state.unfiredCredit = Math.min(bytesTotal, state.unfiredCredit + gain);
        state.intraCredit += gain;
        if (state.intraCredit >= REMINDER_ELIGIBLE_STEP_BYTES) {
          state.intraCredit = 0;
          state.notesInWave = 0;
          state.lastFiredStep = null;
        }
      }
    }
    if (
      !afterTool ||
      total <= 0 ||
      bytesTotal < REMINDER_WORTHWHILE_BYTES ||
      state.unfiredCredit < REMINDER_WORTHWHILE_BYTES ||
      state.notesInWave >= REMINDER_MAX_NOTES_PER_WAVE ||
      (stepKey !== undefined && state.lastFiredStep === stepKey)
    ) {
      return null;
    }

    state.firedInTurn = true;
    state.notesInWave += 1;
    state.lastFiredStep = stepKey ?? null;

    const sizeHint = bytesTotal >= 1024 ? ` (${Math.floor(bytesTotal / 1024)} KiB)` : "";
    const baseHeader = `[context-navigation] eligible=${total}${sizeHint}. Before your final answer (or after a large tool batch), if completed outputs below are no longer needed in full and the user did not ask to wait or restore originals, call manage_context once to batch-clean all unneeded tool_call_ids directly from Rows below (skip list_context_items unless IDs were omitted; hide=rules, summarize=session LLM, auto=LLM/rules); then send one complete final answer with all facts/values (never write the answer twice or say 'reported above'/'see above'). Rows:[id,tool,hint,bytes,turn].`;
    const budget = REMINDER_BYTES - Buffer.byteLength(baseHeader, "utf8") - 80;
    const rows: string[] = [];
    let usedBytes = 0;
    for (const item of items) {
      if (
        typeof item.tool_call_id !== "string" ||
        !item.tool_call_id ||
        item.tool_call_id.length > REMINDER_MAX_ID_CHARS
      )
        continue;
      const row = JSON.stringify([
        item.tool_call_id,
        (item.tool_name ?? "").slice(0, 24),
        (item.hint ?? "").slice(0, 48),
        item.bytes_size,
        item.turn ?? 0,
      ]);
      const rowBytes = Buffer.byteLength(row, "utf8") + 1;
      if (usedBytes + rowBytes > budget) break;
      rows.push(row);
      usedBytes += rowBytes;
    }
    const omitted = Math.max(0, total - rows.length);
    const moreHint =
      omitted > 0 ? ` (+${omitted} via list_context_items(view=candidates))` : "";
    const header = `[context-navigation] eligible=${total}${sizeHint}${moreHint}. Before your final answer (or after a large tool batch), if completed outputs below are no longer needed in full and the user did not ask to wait or restore originals, call manage_context once to batch-clean all unneeded tool_call_ids directly from Rows below (skip list_context_items unless IDs were omitted; hide=rules, summarize=session LLM, auto=LLM/rules); then send one complete final answer with all facts/values (never write the answer twice or say 'reported above'/'see above'). Rows:[id,tool,hint,bytes,turn].`;
    return [header, ...rows].join("\n");
  }
}

export type Reply = {
  id?: number;
  ok: boolean;
  error?: string;
  protocol?: number;
  patches?: Patch[];
  [key: string]: unknown;
};
export type Patch = { call_id: string; sha256: string; text: string };
export type RecordItem = {
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: string;
  content: string;
};
export type Candidate = {
  session: string;
  token: string;
  confirmed: boolean;
  records: RecordItem[];
};
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_RECORDS = 64;
export const MAX_SUMMARY_CONCURRENCY = 4;
export const SUMMARY_TIMEOUT_MS = 25_000;
export const CLEANUP_GUIDANCE =
  "When [context-navigation] lists unneeded completed tool outputs (or after a large tool batch), before sending your final answer — unless the user asked to defer cleanup or restore originals — call manage_context once to batch-clean all unneeded tool_call_ids directly from [context-navigation] (call list_context_items(view=candidates) only if no note is shown; keep outputs you still reference), then emit one complete final answer with all requested facts/values; never write the answer twice, never re-hide an item in the same turn you unhide_context it, and never say 'reported above' or 'see above'. Choose hide (rules), summarize (session LLM), or auto (summary with rule fallback); avoid re-verifying unchanged files. Originals remain restorable.";
export const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function ompInvocationArgs(
  tool: string,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const str = (key: string) =>
    typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string) : undefined;
  switch (tool) {
    case "eval":
      return typeof raw.code === "string" && raw.code
        ? { code: raw.code, ...(typeof raw.language === "string" ? { language: raw.language } : {}) }
        : null;
    case "browser_list_tabs":
    case "list_hosts":
    case "list_terminals":
    case "list_schedules":
      return {};
    case "inspect_schedule":
    case "schedule_logs":
      return typeof raw.id === "string" && raw.id ? { id: raw.id } : null;
    case "read": {
      const path = str("path");
      return path && !path.trim().startsWith("xd://") ? { path } : null;
    }
    case "bash": {
      const command = str("command");
      if (!command) return null;
      const cwd = str("cwd");
      return cwd ? { command, cwd } : { command };
    }
    case "grep": {
      const pattern = str("pattern");
      if (!pattern) return null;
      const path = str("path");
      return path ? { pattern, path } : { pattern };
    }
    case "glob":
      return { path: str("path") ?? "." };
    case "web_search": {
      const query = str("query");
      return query ? { query } : null;
    }
    case "get_agent_activity":
    case "get_agent_status": {
      const agentId = str("agentId");
      return agentId ? { agentId } : null;
    }
    case "list_models":
    case "inspect_provider": {
      const provider = str("provider");
      return provider ? { provider } : null;
    }
    case "capture_terminal": {
      const terminalId = str("terminalId");
      return terminalId ? { terminalId } : null;
    }
    case "browser_snapshot":
    case "browser_logs": {
      const browserId = str("browserId");
      return browserId ? { browserId } : null;
    }
    case "list_agents":
    case "list_workspaces":
    case "list_providers":
    case "list_profiles": {
      const out: Record<string, string> = {};
      const cwd = str("cwd");
      const serverId = str("serverId");
      if (cwd) out.cwd = cwd;
      if (serverId) out.serverId = serverId;
      return out;
    }
    default:
      if (
        ["memory_authority_pack_read", "brain_memory_search", "brain_context_resolve"].includes(tool) ||
        (tool.startsWith("mcp_") && /(?:^|_)(?:read|get|list|search|query|inspect|resolve|fetch)(?:$|_)/i.test(tool))
      ) {
        try {
          return JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)))));
        } catch {
          return null;
        }
      }
      return null;
  }
}
export function toolResultText(message: unknown): string | null {
  if (!message || typeof message !== "object" || !("isError" in message) || message.isError !== false ||
      !("content" in message) || !Array.isArray(message.content)) return null;
  const texts: string[] = [];
  for (const block of message.content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      texts.push(block.text);
  }
  return texts.length ? texts.join("\n") : null;
}
export function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}
/** Same id as the CLI's `_message_key`, so a prompt/response hidden from Paseo or Hermes is recognised here. */
export function messageKey(message: any): string | null {
  if (
    (message?.role !== "user" && message?.role !== "assistant") ||
    !Number.isInteger(message.timestamp)
  )
    return null;
  return `msg:${message.role}:${message.timestamp}:${hash(messageText(message)).slice(0, 12)}`;
}
/**
 * Drop hidden prompts; a hidden response that made tool calls keeps only those calls so call/result pairs stay valid.
 * Its thinking survives only on the latest assistant turn, where providers require it alongside the calls.
 */
export function dropHiddenMessages(messages: any[], hidden: ReadonlySet<string>): any[] | null {
  if (hidden.size === 0) return null;
  let changed = false;
  const kept: any[] = [];
  const lastAssistant = messages.reduce(
    (last: number, m: any, i: number) => (m?.role === "assistant" ? i : last),
    -1,
  );
  for (const [index, message] of messages.entries()) {
    const key = messageKey(message);
    if (!key || !hidden.has(key)) {
      kept.push(message);
      continue;
    }
    changed = true;
    if (
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((b: any) => b?.type === "toolCall")
    ) {
      const keep = (b: any) =>
        b?.type === "toolCall" ||
        (index === lastAssistant && (b?.type === "thinking" || b?.type === "redactedThinking"));
      kept.push({ ...message, content: message.content.filter(keep) });
    }
  }
  return changed ? kept : null;
}

function* prepareChunks(
  records: RecordItem[],
  session: string,
  token: string,
): Generator<RecordItem[]> {
  const envelope =
    Buffer.byteLength(
      JSON.stringify({
        id: Number.MAX_SAFE_INTEGER,
        method: "prepare",
        params: { session_id: session, snapshot_id: token, records: [], append: true },
      }),
      "utf8",
    ) + 1;
  let chunk: RecordItem[] = [],
    bytes = envelope;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (envelope + size > MAX_CHUNK_BYTES) continue;
    if (chunk.length === MAX_CHUNK_RECORDS || bytes + size > MAX_CHUNK_BYTES) {
      yield chunk;
      chunk = [];
      bytes = envelope;
    }
    chunk.push(record);
    bytes += size;
  }
  yield chunk;
}

/** Each reply covers its chunk; the worker retains all chunks under the same snapshot token. */
export async function prepareSnapshot(
  records: RecordItem[],
  session: string,
  token: string,
  send: (method: string, params: object, timeout: number) => Promise<Reply>,
): Promise<Reply> {
  const patches: Patch[] = [],
    pending: unknown[] = [],
    hidden = new Set<string>(),
    evicted = new Set<string>();
  let append = false,
    response: Reply = { ok: true };
  for (const chunk of prepareChunks(records, session, token)) {
    response = await send(
      "prepare",
      {
        session_id: session,
        snapshot_id: token,
        records: chunk,
        ...(append ? { append: true } : {}),
      },
      2000,
    );
    if (!response.ok || !Array.isArray(response.patches)) return response;
    for (const patch of response.patches) patches.push(patch);
    if (Array.isArray(response.pending_summaries))
      for (const job of response.pending_summaries) pending.push(job);
    if (Array.isArray(response.hidden_messages))
      for (const key of response.hidden_messages) if (typeof key === "string") hidden.add(key);
    if (Array.isArray(response.evicted_snapshots))
      for (const key of response.evicted_snapshots) if (typeof key === "string") evicted.add(key);
    append = true;
  }
  return {
    ...response,
    patches,
    pending_summaries: pending,
    hidden_messages: [...hidden],
    ...(evicted.size ? { evicted_snapshots: [...evicted] } : {}),
  };
}

export async function prepareRequest(
  records: RecordItem[],
  session: string,
  token: string,
  send: (method: string, params: object, timeout: number) => Promise<Reply>,
  summarize: (content: string, timeout: number) => Promise<string | null>,
  deadline?: number,
  isCurrent: () => boolean = () => true,
): Promise<Reply> {
  const response = await prepareSnapshot(records, session, token, send);
  if (!response.ok || !Array.isArray(response.pending_summaries)) return response;
  const jobs = new Map<string, { item_id: string; content: string; version?: number }>();
  for (const job of response.pending_summaries as any[]) {
    if (typeof job?.item_id === "string" && typeof job.content === "string")
      jobs.set(job.item_id, job);
  }
  if (jobs.size === 0) return response;
  const effectiveDeadline = deadline ?? Date.now() + Math.min(
    120_000,
    Math.max(1, Math.ceil(jobs.size / MAX_SUMMARY_CONCURRENCY)) * SUMMARY_TIMEOUT_MS,
  );
  const waiting = [...jobs.values()];
  const summaries = new Map<string, string>();
  await Promise.all(
    Array.from({ length: Math.min(MAX_SUMMARY_CONCURRENCY, waiting.length) }, async () => {
      while (waiting.length && Date.now() < effectiveDeadline && isCurrent()) {
        const job = waiting.shift()!;
        try {
          const text = await summarize(job.content, Math.max(1, Math.min(SUMMARY_TIMEOUT_MS, effectiveDeadline - Date.now())));
          if (text) summaries.set(job.item_id, text);
        } catch {
          /* retain the rule excerpt */
        }
      }
    }),
  );
  for (const job of jobs.values()) {
    if (!isCurrent()) return { ok: false, error: "unconfirmed_snapshot" };
    const text = summaries.get(job.item_id);
    const finished = await send(
      text ? "apply_summary" : "summary_failed",
      {
        session_id: session,
        item_id: job.item_id,
        ...(job.version === undefined ? {} : { expected_version: job.version }),
        ...(text ? { summary_text: text } : {}),
      },
      5000,
    );
    if (
      !finished.ok &&
      finished.error !== "verification_failed" &&
      finished.error !== "not_found" &&
      finished.error !== "version_conflict"
    )
      return finished;
  }
  return prepareSnapshot(records, session, token, send);
}
