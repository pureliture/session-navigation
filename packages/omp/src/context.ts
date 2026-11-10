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
export class BoundaryReminder {
  private seen: { turn: string; tier: number } | undefined;
  private tier(tokens: number, window?: number) {
    return window && window > 0
      ? [50, 75, 90].filter((t) => (100 * tokens) / window >= t).length
      : 0;
  }
  due(turn: string, tokens: number, window?: number): boolean {
    return (
      !!turn &&
      (!this.seen || this.seen.turn !== turn || this.tier(tokens, window) > this.seen.tier)
    );
  }
  note(
    turn: string,
    tokens: number,
    window: number | undefined,
    total: number,
    items: ReminderItem[],
  ): string | null {
    if (!total || !this.due(turn, tokens, window)) return null;
    const usage =
      window && window > 0
        ? `~${tokens}/${window} tokens (${Math.round((100 * tokens) / window)}%)`
        : `~${tokens}/? tokens (?%)`;
    const header = `[context-navigation] ${usage}; eligible=${total}. Finish the work unit and answer first; then, if useful, batch cleanup in one call. After cleanup, the final message must restate the complete answer with all requested facts/values; never say 'reported above' or 'see above'. You decide when/what/how: hide unneeded results (rules), summarize facts still needed (session LLM). Prefer literal IDs already shown here; avoid re-verifying unchanged files. Display only; any valid ID is accepted. Use list_context_items(view=candidates) only when needed. Rows: [id,tool,path/command,bytes,turn].`;
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
    this.seen = { turn, tier: this.tier(tokens, window) };
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
  "Finish each work unit and answer first. Then, if useful, batch cleanup in one call. After cleanup, the final message must restate the complete answer with all requested facts/values; never say 'reported above' or 'see above'. You decide when/what/how: hide unneeded results (rules), summarize facts still needed (session LLM); auto prefers summary with rule fallback. Prefer literal IDs already shown in context notes; use list_context_items(view=candidates) only when needed, and avoid re-verifying unchanged files. Display limits never restrict targets. Originals remain restorable.";
export const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

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
