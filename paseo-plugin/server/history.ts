import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  bytes,
  invocationDigest,
  itemId,
  length,
  sha256,
  splitLines,
  type Json,
  type RecordInput,
} from "../../packages/core/src/index.ts";
import type { Item } from "../../packages/core/src/index.ts";
import { loadHermesTimeline } from "./hermesHistory.ts";
import { HistoryTooLargeError, MAX_HISTORY_BYTES, MAX_HISTORY_ROWS } from "./historyLimits.ts";
import { ompInvocationArgs, toolResultText } from "../../packages/omp/src/context.ts";

export type Message = Record<string, any>;
export type History = {
  messages: Message[];
  boundaries: number[];
  injected: [number, number][];
  /** Message index where the latest compaction chunk starts (0 = full history). */
  chunkStart: number;
  /** Scope of the session actually loaded after following the rotation chain. */
  effectiveScope?: string;
  /**
   * True when this timeline authoritatively represents the latest chunk
   * (source session/file matched), even when rows are empty. An empty
   * authoritative chunk must NOT be backfilled with stale targets/items.
   */
  chunkAuthoritative?: boolean;
  externalContext?: { used_tokens: number; max_tokens: number | null; source: string };
  recordsCapped?: boolean;
  readError?: string;
  readErrorDb?: string;
};
export interface Timeline {
  rows: Message[];
  records: Map<string, RecordInput>;
  history: History;
}

export interface MeasuredTokenSegment {
  startTimestampMs: number;
  endTimestampMs: number;
  delta: number;
  totalWeight: number;
  weights: Array<[string, number]>;
  keys: string[];
}

export interface MeasuredTokenSummary {
  segments: MeasuredTokenSegment[];
  alwaysIncomplete: string[];
  hasAnchors: boolean;
  lastUsage?: {
    totalTokens: number;
    promptTokens: number;
    output: number;
    provider?: unknown;
    model?: unknown;
  };
  externalContext?: { used_tokens: number; max_tokens: number | null; source: string };
}

export interface OmpTimelineSlot {
  item_id: string;
  tool_call_id: string;
  tool_name: string;
  kind: "user" | "assistant" | "tool";
  manageable: boolean;
  source: "unrecorded" | "display_only";
  summary_line: string;
  bytes_size: number;
  is_error?: boolean;
  line_offset: number;
  line_length: number;
  call_line_offset?: number;
  call_line_length?: number;
  result_position: number;
  options_omitted?: boolean;
}

export interface OmpTimelineIndex {
  absPath: string;
  scope: string;
  statKey: string;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  slots: OmpTimelineSlot[];
  summary: MeasuredTokenSummary;
  chunkAuthoritative: boolean;
  recordsCapped: boolean;
  estimatedBytes: number;
}

const JSONL_READ_CHUNK_BYTES = 256 * 1024;
const MAX_TIMELINE_CACHE = 8;
const MAX_TIMELINE_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_OMP_INDEX_CACHE = 16;
const MAX_OMP_INDEX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_PATH_CACHE = 256;
const MAX_MODELS_YML_CACHE = 16;
const MAX_OMP_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_OMP_RECORDS = 5000;

type CachedTimelineEntry = {
  statKey: string;
  estimatedBytes: number;
  timeline: Timeline;
};
const timelineCache = new Map<string, CachedTimelineEntry>();
let timelineCacheBytes = 0;

const ompIndexCache = new Map<string, OmpTimelineIndex>();
let ompIndexCacheBytes = 0;

const sessionPathCache = new Map<string, string>();
const modelsYamlCache = new Map<
  string,
  { statKey: string; content: string; lookups: Map<string, number | null> }
>();

function statIdentity(stat: { ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function estimateStringBytes(text: unknown): number {
  return typeof text === "string" ? text.length * 2 + 32 : 0;
}

function estimateTimelineBytes(timeline: Timeline): number {
  let total = 512;
  for (const row of timeline.rows) {
    total +=
      256 +
      estimateStringBytes(row.summary_line) +
      estimateStringBytes(row.message_text) +
      estimateStringBytes(row.tool_input) +
      estimateStringBytes(row.tool_output);
  }
  for (const record of timeline.records.values()) {
    total += 256 + estimateStringBytes(record.content);
  }
  for (const message of timeline.history.messages) {
    total += 256 + estimateStringBytes(typeof message.content === "string" ? message.content : "");
  }
  return total;
}

function setTimelineCache(cacheKey: string, entry: CachedTimelineEntry): void {
  const existing = timelineCache.get(cacheKey);
  if (existing) {
    timelineCacheBytes -= existing.estimatedBytes;
    timelineCache.delete(cacheKey);
  }
  if (entry.estimatedBytes > MAX_TIMELINE_CACHE_BYTES) {
    return;
  }
  timelineCache.set(cacheKey, entry);
  timelineCacheBytes += entry.estimatedBytes;
  while (
    timelineCache.size > MAX_TIMELINE_CACHE ||
    timelineCacheBytes > MAX_TIMELINE_CACHE_BYTES
  ) {
    const oldestKey = timelineCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = timelineCache.get(oldestKey);
    timelineCache.delete(oldestKey);
    if (evicted) timelineCacheBytes -= evicted.estimatedBytes;
  }
}

function estimateIndexBytes(slots: readonly OmpTimelineSlot[], summary: MeasuredTokenSummary): number {
  let total = 512;
  for (const slot of slots) {
    total += 220 + estimateStringBytes(slot.item_id) + estimateStringBytes(slot.summary_line);
  }
  for (const seg of summary.segments) {
    total += 96 + seg.weights.length * 64 + seg.keys.length * 48;
  }
  total += summary.alwaysIncomplete.length * 48;
  return total;
}

function setOmpIndexCache(cacheKey: string, index: OmpTimelineIndex): void {
  const existing = ompIndexCache.get(cacheKey);
  if (existing) {
    ompIndexCacheBytes -= existing.estimatedBytes;
    ompIndexCache.delete(cacheKey);
  }
  if (index.estimatedBytes > MAX_OMP_INDEX_CACHE_BYTES) {
    return;
  }
  ompIndexCache.set(cacheKey, index);
  ompIndexCacheBytes += index.estimatedBytes;
  while (
    ompIndexCache.size > MAX_OMP_INDEX_CACHE ||
    ompIndexCacheBytes > MAX_OMP_INDEX_CACHE_BYTES
  ) {
    const oldestKey = ompIndexCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = ompIndexCache.get(oldestKey);
    ompIndexCache.delete(oldestKey);
    if (evicted) ompIndexCacheBytes -= evicted.estimatedBytes;
  }
}

export function cloneTimeline(timeline: Timeline): Timeline {
  return {
    rows: timeline.rows.map((row) => ({ ...row })),
    records: new Map(timeline.records),
    history: {
      messages: [...timeline.history.messages],
      boundaries: [...timeline.history.boundaries],
      injected: timeline.history.injected.map(([pos, len]) => [pos, len] as [number, number]),
      chunkStart: timeline.history.chunkStart,
      ...(timeline.history.effectiveScope
        ? { effectiveScope: timeline.history.effectiveScope }
        : {}),
      ...(timeline.history.chunkAuthoritative !== undefined
        ? { chunkAuthoritative: timeline.history.chunkAuthoritative }
        : {}),
      ...(timeline.history.externalContext
        ? { externalContext: { ...timeline.history.externalContext } }
        : {}),
      ...(timeline.history.recordsCapped !== undefined
        ? { recordsCapped: timeline.history.recordsCapped }
        : {}),
      ...(timeline.history.readError !== undefined
        ? { readError: timeline.history.readError }
        : {}),
      ...(timeline.history.readErrorDb !== undefined
        ? { readErrorDb: timeline.history.readErrorDb }
        : {}),
    },
  };
}

function forEachJsonlLine(
  filename: string,
  onLine: (line: string, offset: number, byteLength: number) => void,
  startByte = 0,
): { ino: number; size: number; mtimeMs: number; ctimeMs: number } {
  const fd = openSync(filename, "r");
  try {
    const stat = fstatSync(fd);
    if (stat.size > MAX_HISTORY_BYTES) {
      throw new HistoryTooLargeError(
        `history file exceeds ${MAX_HISTORY_BYTES} bytes (${stat.size})`,
      );
    }
    const readBuf = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
    let filePos = Math.max(0, startByte);
    let lineStart = filePos;
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    while (filePos < stat.size) {
      const toRead = Math.min(JSONL_READ_CHUNK_BYTES, stat.size - filePos);
      const n = readSync(fd, readBuf, 0, toRead, filePos);
      if (n <= 0) break;
      filePos += n;

      let cursor = 0;
      while (cursor < n) {
        const nlIdx = readBuf.indexOf(0x0a, cursor);
        if (nlIdx === -1 || nlIdx >= n) {
          const tail = Buffer.from(readBuf.subarray(cursor, n));
          pending.push(tail);
          pendingBytes += tail.length;
          break;
        }
        const segment = readBuf.subarray(cursor, nlIdx);
        const lineLen = pendingBytes + segment.length;
        let line: string;
        if (pending.length === 0) {
          line = segment.toString("utf8");
        } else {
          pending.push(segment);
          line = Buffer.concat(pending, lineLen).toString("utf8");
          pending = [];
          pendingBytes = 0;
        }
        onLine(line, lineStart, lineLen);
        lineStart += lineLen + 1;
        cursor = nlIdx + 1;
      }
    }
    if (pendingBytes > 0) {
      const line = Buffer.concat(pending, pendingBytes).toString("utf8");
      onLine(line, lineStart, pendingBytes);
    }
    return {
      ino: Number(stat.ino),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      ctimeMs: Number(stat.ctimeMs),
    };
  } finally {
    closeSync(fd);
  }
}

function readJsonLineFromFd(fd: number, offset: number, byteLength: number): Message | null {
  if (byteLength <= 0) return null;
  const buf = Buffer.allocUnsafe(byteLength);
  let readTotal = 0;
  while (readTotal < byteLength) {
    const n = readSync(fd, buf, readTotal, byteLength - readTotal, offset + readTotal);
    if (n <= 0) break;
    readTotal += n;
  }
  if (readTotal <= 0) return null;
  try {
    const parsed = JSON.parse(buf.subarray(0, readTotal).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Message) : null;
  } catch {
    return null;
  }
}

function parseHistoryFile(filename: string): History {
  const history: History = {
    messages: [],
    boundaries: [],
    injected: [],
    chunkStart: 0,
  };
  const messageIndexById = new Map<string, number>();
  const entryIndexById = new Map<string, number>();
  const compactionClaims: Array<string | undefined> = [];
  const trackEntry = (id: unknown) => {
    if (typeof id === "string" && id) entryIndexById.set(id, history.messages.length);
  };
  forEachJsonlLine(filename, (line) => {
    let data: Message;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (
      data.type === "message" &&
      data.message &&
      typeof data.message === "object"
    ) {
      if (typeof data.id === "string" && data.id)
        messageIndexById.set(data.id, history.messages.length);
      history.messages.push(data.message);
      return;
    }
    trackEntry(data.id);
    if (["compaction", "branch_summary", "reset_boundary"].includes(data.type)) {
      history.boundaries.push(history.messages.length);
      if (data.type === "compaction")
        compactionClaims.push(
          typeof data.firstKeptEntryId === "string" ? data.firstKeptEntryId : undefined,
        );
    } else if (data.type === "custom" && typeof data.data?.reminder === "string")
      history.injected.push([
        history.messages.length,
        length(data.data.reminder),
      ]);
    else if (typeof data.role === "string") {
      if (typeof data.id === "string" && data.id)
        messageIndexById.set(data.id, history.messages.length);
      history.messages.push(data);
    }
  });
  for (const claimed of compactionClaims) {
    if (!claimed) continue;
    const index = messageIndexById.get(claimed) ?? entryIndexById.get(claimed);
    if (index === undefined) continue;
    history.chunkStart = index;
  }
  return history;
}

function collectSessionFilesSorted(directory: string, out: Array<{ name: string; path: string }>): void {
  if (!existsSync(directory)) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return;
  }
  for (const entry of entries) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSessionFilesSorted(filename, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push({ name: entry.name, path: filename });
    }
  }
}

export function findSessionsBatch(home: string, sessions: readonly string[]): Set<string> {
  const matched = new Set<string>();
  const pending: Array<{ raw: string; sessionId: string; suffix: string }> = [];
  for (const session of sessions) {
    const sessionId = session.includes(":") ? (session.split(":")[2] ?? "") : session;
    if (!sessionId || /[\\/:]/.test(sessionId)) continue;
    const cacheKey = `${resolve(home)}\0${sessionId}`;
    const cachedPath = sessionPathCache.get(cacheKey);
    if (cachedPath && existsSync(cachedPath)) {
      sessionPathCache.delete(cacheKey);
      sessionPathCache.set(cacheKey, cachedPath);
      matched.add(session);
      continue;
    }
    if (cachedPath) sessionPathCache.delete(cacheKey);
    pending.push({ raw: session, sessionId, suffix: `_${sessionId}.jsonl` });
  }
  if (!pending.length) return matched;
  const files: Array<{ name: string; path: string }> = [];
  collectSessionFilesSorted(join(home, ".omp", "agent", "sessions"), files);
  const absHome = resolve(home);
  for (const item of pending) {
    const found = files.find((f) => f.name.endsWith(item.suffix));
    if (found) {
      matched.add(item.raw);
      const cacheKey = `${absHome}\0${item.sessionId}`;
      sessionPathCache.delete(cacheKey);
      sessionPathCache.set(cacheKey, found.path);
      while (sessionPathCache.size > MAX_SESSION_PATH_CACHE) {
        const oldest = sessionPathCache.keys().next().value;
        if (!oldest) break;
        sessionPathCache.delete(oldest);
      }
    }
  }
  return matched;
}

export function findSession(home: string, session: string): string | undefined {
  const sessionId = session.includes(":") ? (session.split(":")[2] ?? "") : session;
  if (!sessionId || /[\\/:]/.test(sessionId)) return;
  const cacheKey = `${resolve(home)}\0${sessionId}`;
  const cachedPath = sessionPathCache.get(cacheKey);
  if (cachedPath) {
    try {
      if (statSync(cachedPath).isFile()) {
        sessionPathCache.delete(cacheKey);
        sessionPathCache.set(cacheKey, cachedPath);
        return cachedPath;
      }
    } catch {
      // Stale cached path; rescan below.
    }
    sessionPathCache.delete(cacheKey);
  }

  const suffix = `_${sessionId}.jsonl`;
  function search(directory: string): string | undefined {
    if (!existsSync(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) {
        const result = search(filename);
        if (result) return result;
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return filename;
      }
    }
  }
  const found = search(join(home, ".omp", "agent", "sessions"));
  if (found) {
    sessionPathCache.set(cacheKey, found);
    while (sessionPathCache.size > MAX_SESSION_PATH_CACHE) {
      const oldest = sessionPathCache.keys().next().value;
      if (!oldest) break;
      sessionPathCache.delete(oldest);
    }
  }
  return found;
}

export function readHistory(home: string, scope: string): History {
  const [adapter, , session] = scope.split(":");
  if (!["omp", "pi"].includes(adapter)) return { messages: [], boundaries: [], injected: [], chunkStart: 0 };
  const filename = findSession(home, session);
  if (!filename) return { messages: [], boundaries: [], injected: [], chunkStart: 0 };
  return parseHistoryFile(filename);
}

export function messageText(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter(
            (block: Message) =>
              block?.type === "text" && typeof block.text === "string",
          )
          .map((block: Message) => block.text)
          .join("")
      : "";
}

export function messageKey(
  index: number,
  message: Message,
): string | undefined {
  if (!["user", "assistant"].includes(message.role)) return;
  return Number.isInteger(message.timestamp)
    ? `msg:${message.role}:${message.timestamp}:${sha256(messageText(message)).slice(0, 12)}`
    : `${message.role === "user" ? "usr" : "ast"}_${index}`;
}

export function preview(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (bytes(text) <= 8192) return text;
  const encoded = Buffer.from(text);
  let end = 8192;
  while ((encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8") + "\n… [truncated]";
}

const SYSTEM_BLOCK_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<system-notice>[\s\S]*?<\/system-notice>/gu;

function stripSystemBlocks(text: string): string {
  return text.replace(SYSTEM_BLOCK_RE, "");
}

function sliceCodepoints(text: string, maxLen: number): string {
  return [...text].slice(0, maxLen).join("");
}

function formatPaseoSystemSummary(trimmed: string): string {
  const titleMatch = /source-agent-title="([^"]+)"/u.exec(trimmed);
  const eventMatch = /event="([^"]+)"/u.exec(trimmed);
  const idMatch = /source-agent-id="([^"]+)"/u.exec(trimmed);
  const kindMatch = /kind="([^"]+)"/u.exec(trimmed);
  const label = titleMatch?.[1]?.trim() || (idMatch?.[1] ? idMatch[1].slice(0, 8) : "");
  if (eventMatch?.[1]) {
    return sliceCodepoints(`[Subagent ${eventMatch[1]}] ${label || "subagent"}`, 220);
  }
  if (kindMatch?.[1] === "agent-notification") {
    return sliceCodepoints(`[Subagent notification] ${label || "subagent"}`, 220);
  }
  const body = trimmed
    .replace(/^<paseo-system\b[^>]*(?:>|$)/u, "")
    .replace(/<\/paseo-system>/gu, "")
    .replace(/<[^>]+>/gu, " ");
  const bodyLine = splitLines(body)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .find(Boolean);
  const formatted = bodyLine
    ? `[Agent message${label ? ` · ${label}` : ""}] ${bodyLine}`
    : `[Agent message] ${label || "subagent"}`;
  return sliceCodepoints(formatted, 220);
}

export function summaryLine(text: string): string {
  const stripped = stripSystemBlocks(text);
  const trimmed = stripped.trimStart();
  if (trimmed.startsWith("<paseo-system")) {
    return formatPaseoSystemSummary(trimmed);
  }
  return sliceCodepoints(
    splitLines(stripped)
      .map((line) => line.trim().replace(/\s+/gu, " "))
      .filter(
        (line) =>
          line &&
          !line.startsWith("[hidden:") &&
          !line.startsWith("The remaining result is preserved"),
      )
      .slice(0, 2)
      .join("\n"),
    220,
  );
}

export function formatToolSummary(tool: string, text: string): string {
  if (tool === "manage_context" && text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.applied === "number") {
        const failed = typeof parsed.failed === "number" && parsed.failed > 0 ? `, ${parsed.failed} failed` : "";
        const size = typeof parsed.size === "string" && parsed.size ? ` · ${parsed.size}` : "";
        return `${parsed.applied} managed${failed}${size}`;
      }
    } catch {
      // Fall back to plain summaryLine below.
    }
  }
  return summaryLine(text);
}

function promptOf(message: Message): number {
  return typeof message.contextSnapshot?.promptTokens === "number"
    ? message.contextSnapshot.promptTokens
    : ["input", "cacheRead", "cacheWrite"].reduce(
        (sum, key) => sum + (message.usage[key] || 0),
        0,
      );
}

function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${pythonJson(entry)}`)
      .join(", ")}}`;
  return JSON.stringify(value ?? null);
}

function messageWeights(
  index: number,
  message: Message,
): [string | undefined, number][] {
  const owner =
    message.role === "toolResult"
      ? message.toolCallId
      : messageKey(index, message);
  const blocks = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  return blocks
    .filter((block: Message) => block && typeof block === "object")
    .flatMap((block: Message): [string | undefined, number][] => {
      if (block.type === "text" && typeof block.text === "string")
        return [[owner, length(block.text)]];
      if (block.type === "toolCall")
        return [
          [
            block.id,
            length(String(block.name ?? "")) +
              length(pythonJson(block.arguments)),
          ],
        ];
      return block.type === "thinking" ? [] : [["?", 0]];
    });
}

class StreamingTokenSummaryBuilder {
  private readonly segments: MeasuredTokenSegment[] = [];
  private readonly alwaysIncomplete = new Set<string>();
  private hasAnchors = false;
  private previousIndex: number | undefined;
  private previousTokens: number | undefined;
  private previousTimestamp: number | undefined;

  private segWeightTotal = 0;
  private segHasUnknown = false;
  private segHasBoundary = false;
  private segKeyWeights = new Map<string, number>();
  private segAllKeys = new Set<string>();

  private lastUsage?: MeasuredTokenSummary["lastUsage"];

  onBoundary(): void {
    this.segHasBoundary = true;
  }

  onInjected(chars: number): void {
    this.segWeightTotal += chars;
  }

  onMessage(index: number, message: Message): void {
    const isAnchor =
      message.role === "assistant" &&
      Boolean(message.usage) &&
      typeof message.usage === "object";

    if (isAnchor) {
      this.hasAnchors = true;
      const nonMessage = message.contextSnapshot?.nonMessageTokens;
      const tokens =
        typeof nonMessage === "number" ? promptOf(message) - nonMessage : undefined;
      const delta =
        tokens !== undefined &&
        (this.previousIndex === undefined || this.previousTokens !== undefined)
          ? tokens - (this.previousTokens ?? 0)
          : undefined;
      const valid =
        this.previousIndex !== undefined &&
        delta !== undefined &&
        delta > 0 &&
        this.segWeightTotal > 0 &&
        !this.segHasBoundary &&
        !this.segHasUnknown;

      if (valid) {
        this.segments.push({
          startTimestampMs:
            typeof this.previousTimestamp === "number"
              ? this.previousTimestamp
              : Number.NaN,
          endTimestampMs:
            typeof message.timestamp === "number"
              ? message.timestamp
              : Number.NaN,
          delta: delta!,
          totalWeight: this.segWeightTotal,
          weights: [...this.segKeyWeights.entries()],
          keys: [...this.segAllKeys],
        });
      } else {
        for (const key of this.segAllKeys) {
          this.alwaysIncomplete.add(key);
        }
      }

      this.previousIndex = index;
      this.previousTokens = tokens;
      this.previousTimestamp =
        typeof message.timestamp === "number" ? message.timestamp : undefined;
      this.segWeightTotal = 0;
      this.segHasUnknown = false;
      this.segHasBoundary = false;
      this.segKeyWeights.clear();
      this.segAllKeys.clear();
      this.lastUsage = {
        totalTokens: Number(message.usage.totalTokens || 0),
        promptTokens: promptOf(message),
        output: Number(message.usage.output || 0),
        provider: message.provider,
        model: message.model,
      };
    }

    for (const [key, chars] of messageWeights(index, message)) {
      this.segWeightTotal += chars;
      if (key === "?") {
        this.segHasUnknown = true;
        this.alwaysIncomplete.add("?");
        continue;
      }
      if (key) {
        this.segAllKeys.add(key);
        this.segKeyWeights.set(key, (this.segKeyWeights.get(key) ?? 0) + chars);
      }
    }
  }

  finalize(): MeasuredTokenSummary {
    if (!this.hasAnchors) {
      return { segments: [], alwaysIncomplete: [], hasAnchors: false };
    }
    for (const key of this.segAllKeys) {
      this.alwaysIncomplete.add(key);
    }
    return {
      segments: this.segments,
      alwaysIncomplete: [...this.alwaysIncomplete],
      hasAnchors: true,
      lastUsage: this.lastUsage,
    };
  }
}

type BuildOmpIndexResult = {
  slots: OmpTimelineSlot[];
  summary: MeasuredTokenSummary;
  recordsCapped: boolean;
  messageCount: number;
};

function buildOmpIndexFromByteOffset(
  filename: string,
  scope: string,
  startByte: number,
  requireBoundaryScan: boolean,
): {
  result: BuildOmpIndexResult;
  stat: { ino: number; size: number; mtimeMs: number; ctimeMs: number };
  chunkStartOffset: number;
} {
  type CallEntry = {
    name: string;
    index: number;
    callLineOffset: number;
    callLineLength: number;
    invocationDigest?: string;
    hasManageableArgs: boolean;
  };
  type ToolCandidate = {
    slotIndex: number;
    callId: string;
    textSize: number;
    contentSha: string;
    invocationDigest: string;
  };

  const calls = new Map<string, CallEntry>();
  const duplicate = new Set<string>();
  const results = new Map<string, number>();
  const messageIndexById = new Map<string, number>();
  const entryIndexById = new Map<string, number>();
  const compactionClaims: Array<string | undefined> = [];
  const messageOffsets: number[] = [];

  const tokenBuilder = new StreamingTokenSummaryBuilder();
  const slots: OmpTimelineSlot[] = [];
  const toolCandidates: ToolCandidate[] = [];
  let msgIndex = 0;

  const stat = forEachJsonlLine(
    filename,
    (line, offset, byteLength) => {
      let data: Message;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;

      let message: Message | undefined;
      if (
        data.type === "message" &&
        data.message &&
        typeof data.message === "object"
      ) {
        if (requireBoundaryScan && typeof data.id === "string" && data.id) {
          messageIndexById.set(data.id, msgIndex);
        }
        message = data.message as Message;
      } else {
        if (requireBoundaryScan && typeof data.id === "string" && data.id) {
          entryIndexById.set(data.id, msgIndex);
        }
        if (["compaction", "branch_summary", "reset_boundary"].includes(data.type)) {
          tokenBuilder.onBoundary();
          if (requireBoundaryScan && data.type === "compaction") {
            compactionClaims.push(
              typeof data.firstKeptEntryId === "string" ? data.firstKeptEntryId : undefined,
            );
          }
          return;
        }
        if (data.type === "custom" && typeof data.data?.reminder === "string") {
          tokenBuilder.onInjected(length(data.data.reminder));
          return;
        }
        if (typeof data.role === "string") {
          if (requireBoundaryScan && typeof data.id === "string" && data.id) {
            messageIndexById.set(data.id, msgIndex);
          }
          message = data;
        }
      }

      if (!message) return;
      if (requireBoundaryScan) {
        messageOffsets.push(offset);
      }

      const currentIdx = msgIndex++;
      tokenBuilder.onMessage(currentIdx, message);

      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            block?.type !== "toolCall" ||
            typeof block.id !== "string" ||
            !block.id
          ) {
            continue;
          }
          if (calls.has(block.id)) {
            duplicate.add(block.id);
          } else {
            const arguments_ = block.arguments;
            let digest: string | undefined;
            let hasManageableArgs = false;
            if (
              typeof block.name === "string" &&
              arguments_ &&
              !Array.isArray(arguments_) &&
              typeof arguments_ === "object"
            ) {
              const args = ompInvocationArgs(
                block.name,
                arguments_ as Record<string, unknown>,
              ) as Record<string, Json> | null;
              if (args) {
                digest = invocationDigest({ tool_name: block.name, arguments: args });
                hasManageableArgs = true;
              }
            }
            calls.set(block.id, {
              name: typeof block.name === "string" ? block.name : "",
              index: currentIdx,
              callLineOffset: offset,
              callLineLength: byteLength,
              invocationDigest: digest,
              hasManageableArgs,
            });
          }
        }
      } else if (message.role === "toolResult") {
        results.set(
          message.toolCallId,
          (results.get(message.toolCallId) ?? 0) + 1,
        );
      }

      const extractedToolText =
        message.role === "toolResult" ? toolResultText(message) : null;
      const text =
        message.role === "toolResult"
          ? (extractedToolText ?? messageText(message))
          : messageText(message);

      if (message.role === "user" || message.role === "assistant") {
        if (text.trim()) {
          slots.push({
            item_id: messageKey(currentIdx, message)!,
            tool_call_id: "",
            kind: message.role,
            tool_name: message.role,
            manageable: Number.isInteger(message.timestamp),
            source: "display_only",
            summary_line: summaryLine(text),
            bytes_size: bytes(text),
            line_offset: offset,
            line_length: byteLength,
            result_position: 0,
          });
        }
        return;
      }

      if (message.role !== "toolResult") return;
      const callId =
        typeof message.toolCallId === "string" ? message.toolCallId : "";
      const found = calls.get(callId);
      const tool = message.toolName ?? found?.name ?? "tool";
      const textSize = bytes(text);
      const canCandidate =
        Boolean(found) &&
        !duplicate.has(callId) &&
        found!.index < currentIdx &&
        typeof tool === "string" &&
        found!.name === tool &&
        message.isError === false &&
        found!.hasManageableArgs &&
        found!.invocationDigest !== undefined &&
        extractedToolText !== null;

      const slotIndex = slots.length;
      slots.push({
        item_id: `display_${currentIdx}`,
        tool_call_id: callId,
        tool_name: String(tool),
        kind: "tool",
        manageable: false,
        source: "display_only",
        summary_line: `${message.isError ? "[error] " : ""}${formatToolSummary(String(tool), text) || `[${tool}]`}`,
        bytes_size: textSize,
        is_error: Boolean(message.isError),
        line_offset: offset,
        line_length: byteLength,
        ...(found
          ? {
              call_line_offset: found.callLineOffset,
              call_line_length: found.callLineLength,
            }
          : {}),
        result_position: 0,
      });

      if (canCandidate) {
        toolCandidates.push({
          slotIndex,
          callId,
          textSize,
          contentSha: sha256(text),
          invocationDigest: found!.invocationDigest!,
        });
      }
    },
    startByte,
  );

  let chunkStart = 0;
  if (requireBoundaryScan) {
    for (const claimed of compactionClaims) {
      if (!claimed) continue;
      const idx = messageIndexById.get(claimed) ?? entryIndexById.get(claimed);
      if (idx === undefined) continue;
      chunkStart = idx;
    }
    if (chunkStart > 0 && chunkStart < messageOffsets.length) {
      return {
        result: {
          slots: [],
          summary: { segments: [], alwaysIncomplete: [], hasAnchors: false },
          recordsCapped: false,
          messageCount: 0,
        },
        stat,
        chunkStartOffset: messageOffsets[chunkStart],
      };
    }
    if (chunkStart >= messageOffsets.length && chunkStart > 0) {
      return {
        result: {
          slots: [],
          summary: { segments: [], alwaysIncomplete: [], hasAnchors: false },
          recordsCapped: false,
          messageCount: 0,
        },
        stat,
        chunkStartOffset: stat.size,
      };
    }
  }

  if (msgIndex > MAX_HISTORY_ROWS) {
    throw new HistoryTooLargeError(
      `history chunk exceeds ${MAX_HISTORY_ROWS} rows (${msgIndex})`,
    );
  }

  // Finalize manageable records from newest to oldest, matching loadTimeline().
  let totalBytes = 0;
  let recordCount = 0;
  let recordsCapped = false;
  const acceptedCallIds = new Set<string>();
  for (let i = toolCandidates.length - 1; i >= 0; i--) {
    const candidate = toolCandidates[i];
    if (
      duplicate.has(candidate.callId) ||
      results.get(candidate.callId) !== 1
    ) {
      continue;
    }
    if (acceptedCallIds.has(candidate.callId)) continue;
    if (totalBytes + candidate.textSize <= MAX_OMP_RECORD_BYTES && recordCount < MAX_OMP_RECORDS) {
      totalBytes += candidate.textSize;
      recordCount += 1;
      acceptedCallIds.add(candidate.callId);
      const slot = slots[candidate.slotIndex];
      slot.item_id = itemId(
        scope,
        candidate.callId,
        candidate.contentSha,
        candidate.invocationDigest,
        0,
      );
      slot.manageable = true;
      slot.source = "unrecorded";
    } else {
      recordsCapped = true;
    }
  }

  return {
    result: {
      slots,
      summary: tokenBuilder.finalize(),
      recordsCapped,
      messageCount: msgIndex,
    },
    stat,
    chunkStartOffset: 0,
  };
}

export function loadOmpTimelineIndex(home: string, scope: string): OmpTimelineIndex | null {
  const [adapter, , session] = scope.split(":");
  const filename = ["omp", "pi"].includes(adapter) ? findSession(home, session) : undefined;
  if (!filename) return null;

  const absPath = resolve(filename);
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return null;
  }
  if (stat.size > MAX_HISTORY_BYTES) {
    throw new HistoryTooLargeError(
      `history file exceeds ${MAX_HISTORY_BYTES} bytes (${stat.size})`,
    );
  }

  const statKey = statIdentity(stat);
  const cacheKey = `${absPath}\0${scope}`;
  const cached = ompIndexCache.get(cacheKey);
  if (cached && cached.statKey === statKey) {
    ompIndexCache.delete(cacheKey);
    ompIndexCache.set(cacheKey, cached);
    return cached;
  }

  let pass = buildOmpIndexFromByteOffset(absPath, scope, 0, true);
  if (pass.chunkStartOffset > 0) {
    pass = buildOmpIndexFromByteOffset(absPath, scope, pass.chunkStartOffset, false);
  }

  const index: OmpTimelineIndex = {
    absPath,
    scope,
    statKey: statIdentity(pass.stat),
    ino: pass.stat.ino,
    size: pass.stat.size,
    mtimeMs: pass.stat.mtimeMs,
    ctimeMs: pass.stat.ctimeMs,
    slots: pass.result.slots,
    summary: pass.result.summary,
    chunkAuthoritative: true,
    recordsCapped: pass.result.recordsCapped,
    estimatedBytes: estimateIndexBytes(pass.result.slots, pass.result.summary),
  };
  setOmpIndexCache(cacheKey, index);
  return index;
}

function slotBaseRow(slot: OmpTimelineSlot): Message {
  return {
    item_id: slot.item_id,
    tool_call_id: slot.tool_call_id,
    kind: slot.kind,
    tool_name: slot.tool_name,
    manageable: slot.manageable,
    source: slot.source,
    summary_line: slot.summary_line,
    bytes_size: slot.bytes_size,
  };
}

function hydrateOmpRowsOnce(
  index: OmpTimelineIndex,
  slots: readonly OmpTimelineSlot[],
): { rows: Message[]; stale: boolean } {
  if (!slots.length) return { rows: [], stale: false };
  let fd: number | undefined;
  try {
    fd = openSync(index.absPath, "r");
    const stat = fstatSync(fd);
    if (statIdentity(stat) !== index.statKey) {
      return { rows: [], stale: true };
    }
    const parsedByOffset = new Map<number, Message | null>();
    const readMessage = (offset: number, byteLength: number): Message | null => {
      if (parsedByOffset.has(offset)) return parsedByOffset.get(offset) ?? null;
      const data = readJsonLineFromFd(fd!, offset, byteLength);
      const msg =
        data?.type === "message" && data.message && typeof data.message === "object"
          ? (data.message as Message)
          : data && typeof data.role === "string"
            ? data
            : null;
      parsedByOffset.set(offset, msg);
      return msg;
    };

    const rows = slots.map((slot) => {
      const row = slotBaseRow(slot);
      const msg = readMessage(slot.line_offset, slot.line_length);
      if (!msg) return row;

      const text =
        slot.kind === "tool"
          ? (toolResultText(msg) ?? messageText(msg))
          : messageText(msg);

      if (slot.kind !== "tool") {
        row.message_text = preview(text);
        return row;
      }

      if (slot.call_line_offset !== undefined && slot.call_line_length !== undefined) {
        const callMsg = readMessage(slot.call_line_offset, slot.call_line_length);
        if (callMsg && Array.isArray(callMsg.content)) {
          const block = callMsg.content.find(
            (entry: Message) => entry?.type === "toolCall" && entry.id === slot.tool_call_id,
          );
          if (block && block.arguments !== undefined) {
            row.tool_input = preview(block.arguments);
          }
        }
      }
      row.tool_output = preview(text);
      return row;
    });
    return { rows, stale: false };
  } catch {
    return { rows: slots.map(slotBaseRow), stale: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

export function hydrateOmpRows(
  home: string,
  index: OmpTimelineIndex,
  slots: readonly OmpTimelineSlot[],
): Message[] {
  const first = hydrateOmpRowsOnce(index, slots);
  if (!first.stale) return first.rows;
  ompIndexCache.delete(`${index.absPath}\0${index.scope}`);
  const refreshed = loadOmpTimelineIndex(home, index.scope);
  if (!refreshed) return slots.map(slotBaseRow);
  const idSet = new Set(slots.map((s) => s.item_id));
  const refreshedSlots = refreshed.slots.filter((s) => idSet.has(s.item_id));
  const second = hydrateOmpRowsOnce(refreshed, refreshedSlots);
  const byId = new Map<string, Message>();
  for (const row of second.rows) {
    if (typeof row.item_id === "string" && row.item_id) {
      byId.set(row.item_id, row);
    }
  }
  return slots.map((slot) => byId.get(slot.item_id) ?? slotBaseRow(slot));
}

export function searchOmpIndex(
  index: OmpTimelineIndex,
  query: string,
  storedCompactedByItemId?: ReadonlyMap<string, string | undefined>,
): number[] {
  const q = query.toLowerCase();
  const matched = new Set<number>();
  const toolInputCheckIndices: number[] = [];

  for (let i = 0; i < index.slots.length; i++) {
    const slot = index.slots[i];
    const compacted = storedCompactedByItemId?.get(slot.item_id);
    const cheapMatch = [
      slot.item_id,
      slot.tool_call_id,
      slot.tool_name,
      slot.summary_line,
      compacted,
    ].some((value) => typeof value === "string" && value.toLowerCase().includes(q));
    if (cheapMatch) {
      matched.add(i);
    } else if (
      slot.kind === "tool" &&
      slot.call_line_offset !== undefined &&
      slot.call_line_length !== undefined
    ) {
      toolInputCheckIndices.push(i);
    }
  }

  if (toolInputCheckIndices.length > 0) {
    let fd: number | undefined;
    try {
      fd = openSync(index.absPath, "r");
      const parsedCalls = new Map<number, Message | null>();
      for (const i of toolInputCheckIndices) {
        const slot = index.slots[i];
        const offset = slot.call_line_offset!;
        if (!parsedCalls.has(offset)) {
          const data = readJsonLineFromFd(fd, offset, slot.call_line_length!);
          const msg =
            data?.type === "message" && data.message && typeof data.message === "object"
              ? (data.message as Message)
              : data && typeof data.role === "string"
                ? data
                : null;
          parsedCalls.set(offset, msg);
        }
        const callMsg = parsedCalls.get(offset);
        if (callMsg && Array.isArray(callMsg.content)) {
          const block = callMsg.content.find(
            (entry: Message) => entry?.type === "toolCall" && entry.id === slot.tool_call_id,
          );
          if (block && block.arguments !== undefined) {
            if (preview(block.arguments).toLowerCase().includes(q)) {
              matched.add(i);
            }
          }
        }
      }
    } catch {
      // Ignore unreadable history during fallback search.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close errors.
        }
      }
    }
  }

  return [...matched].sort((a, b) => a - b);
}

export function loadOmpRecordById(
  home: string,
  scope: string,
  id: string,
): RecordInput | undefined {
  let index = loadOmpTimelineIndex(home, scope);
  if (!index) return undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const slot = index.slots.find(
      (candidate) =>
        candidate.kind === "tool" &&
        candidate.manageable &&
        (candidate.tool_call_id === id || candidate.item_id === id),
    );
    if (!slot || slot.call_line_offset === undefined || slot.call_line_length === undefined) {
      return undefined;
    }
    let fd: number | undefined;
    try {
      fd = openSync(index.absPath, "r");
      const stat = fstatSync(fd);
      if (statIdentity(stat) !== index.statKey) {
        ompIndexCache.delete(`${index.absPath}\0${index.scope}`);
        const refreshed = loadOmpTimelineIndex(home, scope);
        if (!refreshed) return undefined;
        index = refreshed;
        continue;
      }
      const resRaw = readJsonLineFromFd(fd, slot.line_offset, slot.line_length);
      const callRaw = readJsonLineFromFd(fd, slot.call_line_offset, slot.call_line_length);
      const resMsg =
        resRaw?.type === "message" && resRaw.message && typeof resRaw.message === "object"
          ? (resRaw.message as Message)
          : resRaw;
      const callMsg =
        callRaw?.type === "message" && callRaw.message && typeof callRaw.message === "object"
          ? (callRaw.message as Message)
          : callRaw;
      if (!resMsg || !callMsg || !Array.isArray(callMsg.content)) return undefined;
      const block = callMsg.content.find(
        (entry: Message) => entry?.type === "toolCall" && entry.id === slot.tool_call_id,
      );
      if (!block) return undefined;
      const text = toolResultText(resMsg);
      if (text === null) return undefined;
      const tool = resMsg.toolName ?? block.name ?? "tool";
      const args = ompInvocationArgs(
        tool,
        block.arguments as Record<string, unknown>,
      ) as Record<string, Json> | null;
      if (!args) return undefined;
      const invocation = { tool_name: tool, arguments: args };
      return {
        call_id: slot.tool_call_id,
        content: text,
        content_sha256: sha256(text),
        invocation,
        invocation_digest: invocationDigest(invocation),
        result_position: 0,
        status: "ok",
      };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close errors.
        }
      }
    }
  }
  return undefined;
}

export function loadTimeline(
  home: string,
  scope: string,
  storedItems: readonly Item[] = [],
  storedUnits: readonly Record<string, unknown>[] = [],
): Timeline {
  if (scope.startsWith("hermes:")) {
    const hermes = loadHermesTimeline(home, scope, storedItems, storedUnits);
    if (hermes) return hermes;
  }
  const [adapter, , session] = scope.split(":");
  const filename = ["omp", "pi"].includes(adapter) ? findSession(home, session) : undefined;
  if (!filename) {
    return { rows: [], records: new Map(), history: { messages: [], boundaries: [], injected: [], chunkStart: 0 } };
  }
  const absPath = resolve(filename);
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return { rows: [], records: new Map(), history: { messages: [], boundaries: [], injected: [], chunkStart: 0 } };
  }
  if (stat.size > MAX_HISTORY_BYTES) {
    throw new HistoryTooLargeError(
      `history file exceeds ${MAX_HISTORY_BYTES} bytes (${stat.size})`,
    );
  }
  const statKey = statIdentity(stat);
  const cacheKey = `${absPath}\0${scope}`;
  const cached = timelineCache.get(cacheKey);
  if (cached && cached.statKey === statKey) {
    timelineCache.delete(cacheKey);
    timelineCache.set(cacheKey, cached);
    return cloneTimeline(cached.timeline);
  }
  const history = parseHistoryFile(absPath);
  // The history file was found, so this timeline authoritatively represents
  // the latest chunk even when it yields zero rows (P1-2: never backfill).
  history.chunkAuthoritative = true;
  if (history.chunkStart > 0) {
    const start = Math.min(history.chunkStart, history.messages.length);
    history.messages = history.messages.slice(start);
    history.boundaries = history.boundaries
      .filter((index) => index >= start)
      .map((index) => index - start);
    history.injected = history.injected
      .filter(([index]) => index >= start)
      .map(([index, size]) => [index - start, size] as [number, number]);
    history.chunkStart = 0;
  }
  if (history.messages.length > MAX_HISTORY_ROWS) {
    throw new HistoryTooLargeError(
      `history chunk exceeds ${MAX_HISTORY_ROWS} rows (${history.messages.length})`,
    );
  }
  const calls = new Map<string, { block: Message; index: number }>();
  const duplicate = new Set<string>();
  const results = new Map<string, number>();
  history.messages.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block?.type !== "toolCall" ||
          typeof block.id !== "string" ||
          !block.id
        )
          continue;
        if (calls.has(block.id)) duplicate.add(block.id);
        else calls.set(block.id, { block, index });
      }
    }
    if (message.role === "toolResult")
      results.set(
        message.toolCallId,
        (results.get(message.toolCallId) ?? 0) + 1,
      );
  });
  const records = new Map<string, RecordInput>();
  const rows: Message[] = [];
  let totalBytes = 0;
  for (let index = history.messages.length - 1; index >= 0; index--) {
    const message = history.messages[index];
    const text = message.role === "toolResult" ? toolResultText(message) ?? messageText(message) : messageText(message);
    if (["user", "assistant"].includes(message.role)) {
      if (text.trim())
        rows.push({
          item_id: messageKey(index, message),
          tool_call_id: "",
          kind: message.role,
          tool_name: message.role,
          summary_line: summaryLine(text),
          message_text: preview(text),
          bytes_size: bytes(text),
          manageable: Number.isInteger(message.timestamp),
        });
      continue;
    }
    if (message.role !== "toolResult") continue;
    const callId =
      typeof message.toolCallId === "string" ? message.toolCallId : "";
    const found = calls.get(callId);
    const tool = message.toolName ?? found?.block.name ?? "tool";
    const arguments_ = found?.block.arguments;
    let record: RecordInput | undefined;
    if (
      !duplicate.has(callId) &&
      results.get(callId) === 1 &&
      found &&
      found.index < index &&
      typeof tool === "string" &&
      found.block.name === tool &&
      message.isError === false &&
      arguments_ &&
      !Array.isArray(arguments_) &&
      typeof arguments_ === "object" &&
      toolResultText(message) !== null
    ) {
      const args = ompInvocationArgs(tool, arguments_ as Record<string, unknown>) as Record<
        string,
        Json
      > | null;
      if (args) {
        const invocation = { tool_name: tool, arguments: args };
        const size = bytes(text);
        if (totalBytes + size <= MAX_OMP_RECORD_BYTES && records.size < MAX_OMP_RECORDS) {
          totalBytes += size;
          record = {
            call_id: callId,
            content: text,
            content_sha256: sha256(text),
            invocation,
            invocation_digest: invocationDigest(invocation),
            result_position: 0,
            status: "ok",
          };
          records.set(callId, record);
        } else {
          history.recordsCapped = true;
        }
      }
    }
    rows.push({
      item_id: record
        ? itemId(
            scope,
            callId,
            record.content_sha256,
            record.invocation_digest,
            0,
          )
        : `display_${index}`,
      tool_call_id: callId,
      tool_name: tool,
      kind: "tool",
      manageable: !!record,
      source: record ? "unrecorded" : "display_only",
      summary_line: `${message.isError ? "[error] " : ""}${formatToolSummary(tool, text) || `[${tool}]`}`,
      bytes_size: bytes(text),
      ...(arguments_ !== undefined ? { tool_input: preview(arguments_) } : {}),
      tool_output: preview(text),
    });
  }
  rows.reverse();
  const built: Timeline = { rows, records, history };
  setTimelineCache(cacheKey, {
    statKey,
    estimatedBytes: estimateTimelineBytes(built),
    timeline: built,
  });
  return cloneTimeline(built);
}

function contextWindow(
  home: string,
  provider: unknown,
  model: unknown,
): number | null {
  const filename = join(home, ".omp", "agent", "models.yml");
  if (typeof provider !== "string" || typeof model !== "string") return null;
  let stat;
  try {
    stat = statSync(filename);
  } catch {
    return null;
  }
  const absPath = resolve(filename);
  const statKey = statIdentity(stat);
  let cached = modelsYamlCache.get(absPath);
  if (!cached || cached.statKey !== statKey) {
    cached = {
      statKey,
      content: readFileSync(absPath, "utf8"),
      lookups: new Map(),
    };
    modelsYamlCache.delete(absPath);
    modelsYamlCache.set(absPath, cached);
    while (modelsYamlCache.size > MAX_MODELS_YML_CACHE) {
      const oldest = modelsYamlCache.keys().next().value;
      if (!oldest) break;
      modelsYamlCache.delete(oldest);
    }
  }
  const lookupKey = `${provider}\0${model}`;
  if (cached.lookups.has(lookupKey)) {
    return cached.lookups.get(lookupKey) ?? null;
  }
  const lines = cached.content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${provider}:`);
  let result: number | null = null;
  if (start >= 0) {
    const indent = lines[start].search(/\S/);
    let selected = false;
    for (const line of lines.slice(start + 1)) {
      if (line.trim() && line.search(/\S/) <= indent) break;
      const id = line.match(/^\s*-\s*id:\s*["']?([^"']+?)["']?\s*$/);
      if (id) selected = id[1] === model;
      const window = line.match(/^\s*contextWindow:\s*(\d+)/);
      if (selected && window) {
        result = Number(window[1]);
        break;
      }
    }
  }
  cached.lookups.set(lookupKey, result);
  return result;
}

export function measuredTokensFromSummary(
  home: string,
  summary: MeasuredTokenSummary,
  spans: [number, number][],
): {
  tokens: Map<string, number>;
  context?: { used_tokens: number; max_tokens: number | null; source: string };
} {
  const totals = new Map<string, number>();
  if (!summary.hasAnchors) {
    return summary.externalContext
      ? { tokens: totals, context: summary.externalContext }
      : { tokens: totals };
  }
  const incomplete = new Set<string>(summary.alwaysIncomplete);
  for (const seg of summary.segments) {
    const changed =
      Number.isFinite(seg.startTimestampMs) &&
      Number.isFinite(seg.endTimestampMs) &&
      spans.some(
        ([low, high]) =>
          low <= seg.endTimestampMs / 1000 && high > seg.startTimestampMs / 1000,
      );
    if (changed) {
      for (const key of seg.keys) incomplete.add(key);
      continue;
    }
    for (const [key, chars] of seg.weights) {
      totals.set(key, (totals.get(key) ?? 0) + (seg.delta * chars) / seg.totalWeight);
    }
  }
  for (const [key, total] of totals) {
    if (incomplete.has(key)) totals.delete(key);
    else {
      const floor = Math.floor(total);
      totals.set(
        key,
        total > 0
          ? Math.max(
              1,
              total - floor === 0.5 ? floor + (floor % 2) : Math.round(total),
            )
          : 0,
      );
    }
  }
  const last = summary.lastUsage;
  if (!last) return { tokens: totals };
  return {
    tokens: totals,
    context: {
      used_tokens: Math.trunc(
        last.totalTokens > 0 ? last.totalTokens : last.promptTokens + last.output,
      ),
      max_tokens: contextWindow(home, last.provider, last.model),
      source: "omp_session_usage",
    },
  };
}

export function measuredTokens(
  home: string,
  history: History,
  spans: [number, number][],
): {
  tokens: Map<string, number>;
  context?: { used_tokens: number; max_tokens: number | null; source: string };
} {
  const { messages, boundaries, injected } = history;
  const builder = new StreamingTokenSummaryBuilder();
  const boundaryCounts = new Map<number, number>();
  for (const b of boundaries) {
    boundaryCounts.set(b, (boundaryCounts.get(b) ?? 0) + 1);
  }
  const injectedByPos = new Map<number, number[]>();
  for (const [pos, size] of injected) {
    const arr = injectedByPos.get(pos) ?? [];
    arr.push(size);
    injectedByPos.set(pos, arr);
  }
  for (let index = 0; index < messages.length; index++) {
    if (boundaryCounts.has(index)) {
      builder.onBoundary();
    }
    const inj = injectedByPos.get(index);
    if (inj) {
      for (const size of inj) builder.onInjected(size);
    }
    builder.onMessage(index, messages[index]);
  }
  const summary = builder.finalize();
  if (history.externalContext) {
    summary.externalContext = history.externalContext;
  }
  return measuredTokensFromSummary(home, summary, spans);
}
