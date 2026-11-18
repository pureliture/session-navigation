import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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
import { ompInvocationArgs, toolResultText } from "../../packages/omp/src/context.ts";

export type Message = Record<string, any>;
export type History = {
  messages: Message[];
  boundaries: number[];
  injected: [number, number][];
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

const MAX_TIMELINE_CACHE = 32;
type CachedTimelineEntry = {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  timeline: Timeline;
};
const timelineCache = new Map<string, CachedTimelineEntry>();

export function cloneTimeline(timeline: Timeline): Timeline {
  return {
    rows: timeline.rows.map((row) => ({ ...row })),
    records: new Map(timeline.records),
    history: {
      messages: [...timeline.history.messages],
      boundaries: [...timeline.history.boundaries],
      injected: timeline.history.injected.map(([pos, len]) => [pos, len] as [number, number]),
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

function parseHistoryFile(filename: string): History {
  const history: History = { messages: [], boundaries: [], injected: [] };
  for (const line of readFileSync(filename, "utf8").split("\n")) {
    let data: Message;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    if (
      data.type === "message" &&
      data.message &&
      typeof data.message === "object"
    )
      history.messages.push(data.message);
    else if (
      ["compaction", "branch_summary", "reset_boundary"].includes(data.type)
    )
      history.boundaries.push(history.messages.length);
    else if (data.type === "custom" && typeof data.data?.reminder === "string")
      history.injected.push([
        history.messages.length,
        length(data.data.reminder),
      ]);
    else if (typeof data.role === "string") history.messages.push(data);
  }
  return history;
}

export function findSession(home: string, session: string): string | undefined {
  const sessionId = session.includes(":") ? (session.split(":")[2] ?? "") : session;
  if (!sessionId || /[\\/:]/.test(sessionId)) return;
  function search(directory: string): string | undefined {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) {
        const result = search(filename);
        if (result) return result;
      } else if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`))
        return filename;
    }
  }
  return search(join(home, ".omp", "agent", "sessions"));
}

export function readHistory(home: string, scope: string): History {
  const [adapter, , session] = scope.split(":");
  if (!["omp", "pi"].includes(adapter)) return { messages: [], boundaries: [], injected: [] };
  const filename = findSession(home, session);
  if (!filename) return { messages: [], boundaries: [], injected: [] };
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
    return { rows: [], records: new Map(), history: { messages: [], boundaries: [], injected: [] } };
  }
  const absPath = resolve(filename);
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return { rows: [], records: new Map(), history: { messages: [], boundaries: [], injected: [] } };
  }
  const cacheKey = `${absPath}\0${scope}`;
  const cached = timelineCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs &&
    cached.size === stat.size
  ) {
    timelineCache.delete(cacheKey);
    timelineCache.set(cacheKey, cached);
    return cloneTimeline(cached.timeline);
  }
  const history = parseHistoryFile(absPath);
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
        if (totalBytes + size <= 32 * 1024 * 1024 && records.size < 5000) {
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
  timelineCache.delete(cacheKey);
  timelineCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    timeline: built,
  });
  while (timelineCache.size > MAX_TIMELINE_CACHE) {
    timelineCache.delete(timelineCache.keys().next().value!);
  }
  return cloneTimeline(built);
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

function contextWindow(
  home: string,
  provider: unknown,
  model: unknown,
): number | null {
  const filename = join(home, ".omp", "agent", "models.yml");
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    !existsSync(filename)
  )
    return null;
  const lines = readFileSync(filename, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `${provider}:`);
  if (start < 0) return null;
  const indent = lines[start].search(/\S/);
  let selected = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    const id = line.match(/^\s*-\s*id:\s*["']?([^"']+?)["']?\s*$/);
    if (id) selected = id[1] === model;
    const window = line.match(/^\s*contextWindow:\s*(\d+)/);
    if (selected && window) return Number(window[1]);
  }
  return null;
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
  const anchors = messages.flatMap((message, index) =>
    message.role === "assistant" &&
    message.usage &&
    typeof message.usage === "object"
      ? [index]
      : [],
  );
  const totals = new Map<string, number>();
  const incomplete = new Set<string>();
  function promptOf(message: Message): number {
    return typeof message.contextSnapshot?.promptTokens === "number"
      ? message.contextSnapshot.promptTokens
      : ["input", "cacheRead", "cacheWrite"].reduce(
          (sum, key) => sum + (message.usage[key] || 0),
          0,
        );
  }
  let previousIndex: number | undefined;
  let previousTokens: number | undefined;
  let previousTimestamp: number | undefined;
  for (const anchor of anchors) {
    const message = messages[anchor];
    const nonMessage = message.contextSnapshot?.nonMessageTokens;
    const tokens =
      typeof nonMessage === "number"
        ? promptOf(message) - nonMessage
        : undefined;
    const start = previousIndex ?? 0;
    const parts: [string | undefined, number][] = messages
      .slice(start, anchor)
      .flatMap((entry, offset) => messageWeights(start + offset, entry));
    parts.push(
      ...injected
        .filter(
          ([position]) =>
            (previousIndex ?? -1) < position && position <= anchor,
        )
        .map(([, chars]): [undefined, number] => [undefined, chars]),
    );
    const weight = parts.reduce((sum, [, chars]) => sum + chars, 0);
    const delta =
      tokens !== undefined &&
      (previousIndex === undefined || previousTokens !== undefined)
        ? tokens - (previousTokens ?? 0)
        : undefined;
    const changed =
      typeof previousTimestamp === "number" &&
      typeof message.timestamp === "number" &&
      spans.some(
        ([low, high]) =>
          low <= message.timestamp / 1000 && high > previousTimestamp! / 1000,
      );
    const measured =
      previousIndex !== undefined &&
      delta !== undefined &&
      delta > 0 &&
      weight > 0 &&
      !changed &&
      !boundaries.some((boundary) => start < boundary && boundary <= anchor) &&
      parts.every(([key]) => key !== "?");
    for (const [key, chars] of parts) {
      if (!key || key === "?") continue;
      if (measured)
        totals.set(key, (totals.get(key) ?? 0) + (delta! * chars) / weight);
      else incomplete.add(key);
    }
    previousIndex = anchor;
    previousTokens = tokens;
    previousTimestamp = message.timestamp;
  }
  if (!anchors.length) {
    return history.externalContext
      ? { tokens: totals, context: history.externalContext }
      : { tokens: totals };
  }
  messages.slice(anchors.at(-1)!).forEach((message, offset) =>
    messageWeights(anchors.at(-1)! + offset, message).forEach(([key]) => {
      if (key) incomplete.add(key);
    }),
  );
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
  const last = messages[anchors.at(-1)!];
  return {
    tokens: totals,
    context: {
      used_tokens: Math.trunc(
        last.usage.totalTokens > 0
          ? last.usage.totalTokens
          : promptOf(last) + (last.usage.output || 0),
      ),
      max_tokens: contextWindow(home, last.provider, last.model),
      source: "omp_session_usage",
    },
  };
}
