import { createHash } from "node:crypto";

export type ReminderItem = {
  tool_call_id: string;
  tool_name?: string;
  hint?: string;
  bytes_size: number;
  turn?: number;
};
const REMINDER_BYTES = 1000;
const REMINDER_ITEMS = 3;
export const REMINDER_ELIGIBLE_STEP_BYTES = 100 * 1024;
export class BoundaryReminder {
  private seen: { turn: string; byteStep: number; ids: Set<string> } | undefined;
  private byteStep(eligibleBytes = 0) {
    return eligibleBytes > 0 ? Math.floor(eligibleBytes / REMINDER_ELIGIBLE_STEP_BYTES) : 0;
  }
  due(
    turn: string,
    _tokens?: number,
    _window?: number,
    eligibleBytes = 0,
    candidateIds: readonly string[] = [],
  ): boolean {
    if (!turn) return false;
    if (!this.seen) return candidateIds.length > 0 || eligibleBytes > 0;
    if (this.seen.turn !== turn) {
      return candidateIds.length > 0
        ? candidateIds.some((id) => !this.seen!.ids.has(id))
        : eligibleBytes > 0;
    }
    return this.byteStep(eligibleBytes) > this.seen.byteStep;
  }
  note(
    turn: string,
    _tokens: number,
    _window: number | undefined,
    total: number,
    items: ReminderItem[],
    eligibleBytes?: number,
    candidateIds?: readonly string[],
  ): string | null {
    if (!turn || !total) return null;
    const bytesTotal =
      typeof eligibleBytes === "number" && Number.isFinite(eligibleBytes) && eligibleBytes >= 0
        ? eligibleBytes
        : items.reduce(
            (sum, item) =>
              sum + (typeof item?.bytes_size === "number" && item.bytes_size > 0 ? item.bytes_size : 0),
            0,
          );
    const allIds = candidateIds?.length
      ? candidateIds
      : items.map((item) => item.tool_call_id).filter((id): id is string => typeof id === "string" && !!id);
    const step = this.byteStep(bytesTotal);
    if (this.seen && this.seen.turn === turn && step < this.seen.byteStep) {
      this.seen.byteStep = step;
    }
    if (!this.due(turn, undefined, undefined, bytesTotal, allIds)) return null;
    const sizeHint = bytesTotal >= 1024 ? ` (${Math.floor(bytesTotal / 1024)} KiB)` : "";
    const moreHint =
      total > REMINDER_ITEMS
        ? ` (+${total - REMINDER_ITEMS} via list_context_items(view=candidates))`
        : "";
    const header = `[context-navigation] eligible=${total}${sizeHint}${moreHint}. Clean strictly by need (never after routine single calls or when asked to wait/restore): keep outputs still needed; when a research/command phase finishes, sweep ALL unneeded IDs in one manage_context batch (do not trickle 3/turn; hide=rules, summarize=LLM, auto=LLM/rules), then send one complete final answer with all facts/values (never say 'reported above'/'see above'). Rows:[id,tool,hint,bytes,turn].`;
    const rows: string[] = [];
    for (const item of items) {
      const row = JSON.stringify([
        item.tool_call_id,
        (item.tool_name ?? "").slice(0, 24),
        (item.hint ?? "").slice(0, 48),
        item.bytes_size,
        item.turn ?? 0,
      ]);
      if (Buffer.byteLength([header, ...rows, row].join("\n"), "utf8") <= REMINDER_BYTES)
        rows.push(row);
      if (rows.length === REMINDER_ITEMS) break;
    }
    const mergedIds = new Set([...(this.seen?.ids ?? []), ...allIds]);
    while (mergedIds.size > 2048) {
      const oldest = mergedIds.values().next().value;
      if (oldest === undefined) break;
      mergedIds.delete(oldest);
    }
    this.seen = { turn, byteStep: step, ids: mergedIds };
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
  "Clean up context strictly by actual need, never by context occupancy % or mechanically after single routine tool calls: keep outputs you still reference, skip cleanup on brief checks or when the user asks to defer or restore items, and call manage_context once when an investigation or command phase finishes to sweep all unneeded tool_call_ids in a single batch (if more than the 3 previewed IDs are unneeded, call list_context_items(view=candidates) and batch them together rather than hiding a few per turn). Emit one complete final answer with all requested facts/values only after cleanup; never write the answer twice, never re-hide an item in the same turn as unhide_context, and never say 'reported above' or 'see above'. Choose hide (rules), summarize (session LLM), or auto (summary with rule fallback); avoid re-verifying unchanged files. Display limits never restrict targets. Originals remain restorable.";
export const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function ompInvocationArgs(
  tool: string,
  raw: Record<string, unknown>,
): Record<string, string> | null {
  const str = (key: string) =>
    typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string) : undefined;
  switch (tool) {
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
      return null;
  }
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
  deadline = Date.now() + SUMMARY_TIMEOUT_MS,
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
  const waiting = [...jobs.values()];
  const summaries = new Map<string, string>();
  await Promise.all(
    Array.from({ length: Math.min(MAX_SUMMARY_CONCURRENCY, waiting.length) }, async () => {
      while (waiting.length && Date.now() < deadline && isCurrent()) {
        const job = waiting.shift()!;
        try {
          const text = await summarize(job.content, Math.max(1, deadline - Date.now()));
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
