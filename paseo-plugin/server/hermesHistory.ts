import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  bytes,
  invocationDigest,
  itemId,
  sha256,
  type Item,
  type Json,
  type RecordInput,
} from "../../packages/core/src/index.ts";
import { cloneTimeline, formatToolSummary, preview, summaryLine, type History, type Message, type Timeline } from "./history.ts";
import { HistoryTooLargeError, MAX_HISTORY_ROWS } from "./historyLimits.ts";
import { summaryDedupeKey } from "../shared/summaryDedupe.ts";

export type HermesExtendedRecord = RecordInput & { options_omitted?: boolean };

type StoredUnitRow = Record<string, unknown>;

export interface HermesIndexSlot {
  kind: "user" | "assistant" | "tool";
  tool_name: string;
  tool_call_id: string;
  computed_item_id: string;
  msg_role_pos?: string;
  result_position: number;
  manageable: boolean;
  source: "unrecorded" | "display_only";
  summary_line: string;
  bytes_size: number;
  db_row_id: number;
  assistant_row_id?: number;
  codex_sub_index?: number;
}

export interface HermesOverlaidSlot {
  item_id: string;
  tool_call_id: string;
  tool_name: string;
  kind: "user" | "assistant" | "tool";
  manageable: boolean;
  source: "unrecorded" | "display_only";
  summary_line: string;
  bytes_size: number;
  db_row_id: number;
  assistant_row_id?: number;
  codex_sub_index?: number;
}

export interface HermesTimelineIndex {
  requestedScope: string;
  effectiveScope: string;
  dbPath: string;
  snapshot: string;
  apiMode: string;
  usedTokens?: number;
  slots: HermesIndexSlot[];
  chunkAuthoritative: boolean;
  recordsCapped: boolean;
  estimatedBytes: number;
}

export interface HermesTimelineIndexResult {
  index: HermesTimelineIndex | null;
  readError?: string;
  readErrorDb?: string;
}

const HERMES_FIELDS: Record<string, readonly string[]> = {
  terminal: ["command", "workdir"],
  read_file: ["path", "offset", "limit"],
  search_files: ["pattern", "target", "path", "file_glob"],
  web_search: ["query"],
  web_extract: ["url", "urls"],
  execute_code: ["code", "language"],
  vision_analyze: ["image_path", "path", "url"],
  skill_view: ["name"],
  tool_describe: ["name", "names"],
  browser_snapshot: ["browserId", "selector", "tabId", "tab_id", "url"],
  browser_console: ["browserId", "tabId", "tab_id"],
  browser_logs: ["browserId", "tabId", "tab_id"],
  browser_vision: ["browserId", "prompt", "question", "selector", "tabId", "tab_id", "url"],
  browser_list_tabs: ["browserId"],
  get_agent_activity: ["agentId", "agent_id", "id"],
  get_agent_status: ["agentId", "agent_id", "id"],
  list_agents: ["cwd", "serverId", "server_id"],
  list_workspaces: ["cwd", "serverId", "server_id"],
  list_hosts: ["cwd", "serverId", "server_id"],
  list_models: ["provider", "serverId", "server_id"],
  list_providers: ["cwd", "serverId", "server_id"],
  list_profiles: ["cwd", "serverId", "server_id"],
  inspect_provider: ["provider", "serverId", "server_id"],
  list_terminals: ["cwd", "serverId", "server_id"],
  capture_terminal: ["id", "terminalId", "terminal_id"],
  list_schedules: ["cwd", "serverId", "server_id"],
  inspect_schedule: ["id", "scheduleId", "schedule_id"],
  schedule_logs: ["id", "scheduleId", "schedule_id"],
  memory_authority_pack_read: ["id", "key", "pack_id", "path", "query", "scope", "topic"],
  brain_memory_search: ["id", "key", "namespace", "path", "query", "scope", "topic"],
  brain_context_resolve: ["context_id", "id", "key", "namespace", "path", "query", "scope", "topic"],
};

const HERMES_DEFAULTS: Record<string, Record<string, unknown>> = {
  terminal: {
    background: false,
    pty: false,
    persist_on_release: false,
    heartbeat: 0,
    notify: false,
  },
  read_file: {},
  search_files: {
    limit: 50,
    offset: 0,
    order: "discovery",
    output_mode: "content",
    context: 0,
    case_insensitive: false,
  },
};

const HERMES_REQUIRED: Record<string, string> = {
  terminal: "command",
  read_file: "path",
  search_files: "pattern",
  web_search: "query",
  execute_code: "code",
  skill_view: "name",
};

const HERMES_INTERNAL: Record<string, true> = {
  hide_context: true,
  summarize_context: true,
  list_context_items: true,
  unhide_context: true,
  manage_context: true,
};

const TERMINAL_BLOCKED_TRUTHY_OPTIONS = ["background", "pty", "persist_on_release", "notify"] as const;
const MCP_READ_PATTERN = /(?:^|_)(?:read|get|list|search|query|inspect|resolve|fetch)(?:$|_)/i;
const INT_OR_STR_ID_KEYS: Record<string, true> = {
  id: true,
  tabId: true,
  tab_id: true,
  scheduleId: true,
  schedule_id: true,
  terminalId: true,
  terminal_id: true,
};

const MAX_HERMES_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_HERMES_RECORDS = 5000;
const MAX_HERMES_TIMELINE_CACHE = 8;
const MAX_HERMES_TIMELINE_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_HERMES_INDEX_CACHE = 16;
const MAX_HERMES_INDEX_CACHE_BYTES = 16 * 1024 * 1024;
const WAL_HASH_CHUNK_BYTES = 64 * 1024;
const HERMES_KEYSET_BATCH_SIZE = 256;
const HERMES_HYDRATE_BATCH_SIZE = 200;

const hermesTimelineCache = new Map<
  string,
  { snapshot: string; estimatedBytes: number; timeline: Timeline }
>();
let hermesTimelineCacheBytes = 0;

const hermesIndexCache = new Map<string, HermesTimelineIndex>();
let hermesIndexCacheBytes = 0;

function estimateStrBytes(text: unknown): number {
  return typeof text === "string" ? text.length * 2 + 32 : 0;
}

function estimateHermesIndexBytes(slots: readonly HermesIndexSlot[]): number {
  let total = 512;
  for (const slot of slots) {
    total +=
      220 +
      estimateStrBytes(slot.computed_item_id) +
      estimateStrBytes(slot.summary_line);
  }
  return total;
}

function setHermesIndexCache(cacheKey: string, index: HermesTimelineIndex): void {
  const existing = hermesIndexCache.get(cacheKey);
  if (existing) {
    hermesIndexCacheBytes -= existing.estimatedBytes;
    hermesIndexCache.delete(cacheKey);
  }
  if (index.estimatedBytes > MAX_HERMES_INDEX_CACHE_BYTES) {
    return;
  }
  hermesIndexCache.set(cacheKey, index);
  hermesIndexCacheBytes += index.estimatedBytes;
  while (
    hermesIndexCache.size > MAX_HERMES_INDEX_CACHE ||
    hermesIndexCacheBytes > MAX_HERMES_INDEX_CACHE_BYTES
  ) {
    const oldestKey = hermesIndexCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = hermesIndexCache.get(oldestKey);
    hermesIndexCache.delete(oldestKey);
    if (evicted) hermesIndexCacheBytes -= evicted.estimatedBytes;
  }
}

function estimateTimelineBytes(timeline: Timeline): number {
  let total = 512;
  for (const row of timeline.rows) {
    total +=
      256 +
      estimateStrBytes(row.summary_line) +
      estimateStrBytes(row.message_text) +
      estimateStrBytes(row.tool_input) +
      estimateStrBytes(row.tool_output);
  }
  for (const record of timeline.records.values()) {
    total += 256 + estimateStrBytes(record.content);
  }
  return total;
}

function setHermesTimelineCache(
  cacheKey: string,
  snapshot: string,
  timeline: Timeline,
): void {
  const existing = hermesTimelineCache.get(cacheKey);
  if (existing) {
    hermesTimelineCacheBytes -= existing.estimatedBytes;
    hermesTimelineCache.delete(cacheKey);
  }
  const estimatedBytes = estimateTimelineBytes(timeline);
  if (estimatedBytes > MAX_HERMES_TIMELINE_CACHE_BYTES) {
    return;
  }
  hermesTimelineCache.set(cacheKey, { snapshot, estimatedBytes, timeline });
  hermesTimelineCacheBytes += estimatedBytes;
  while (
    hermesTimelineCache.size > MAX_HERMES_TIMELINE_CACHE ||
    hermesTimelineCacheBytes > MAX_HERMES_TIMELINE_CACHE_BYTES
  ) {
    const oldestKey = hermesTimelineCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = hermesTimelineCache.get(oldestKey);
    hermesTimelineCache.delete(oldestKey);
    if (evicted) hermesTimelineCacheBytes -= evicted.estimatedBytes;
  }
}

function walContentToken(fd: number, size: number): string {
  // B6: stream WAL content in bounded 64 KiB chunks so middle-byte frame
  // overwrites remain cache-sensitive without allocating an 8 MiB buffer.
  try {
    if (size < 32) return "";
    if (size <= 8 * 1024 * 1024) {
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.min(WAL_HASH_CHUNK_BYTES, size));
      let offset = 0;
      while (offset < size) {
        const toRead = Math.min(chunk.length, size - offset);
        const n = readSync(fd, chunk, 0, toRead, offset);
        if (n <= 0) break;
        hash.update(chunk.subarray(0, n));
        offset += n;
      }
      if (offset !== size) return "";
      return `:walhash:${hash.digest("hex")}`;
    }
    const hdr = Buffer.alloc(32);
    readSync(fd, hdr, 0, 32, 0);
    if (hdr.readUInt32BE(0) !== 0x377f0682 && hdr.readUInt32BE(0) !== 0x377f0683) return "";
    const pageSize = hdr.readUInt32BE(8) || 4096;
    const checkpointSeq = hdr.readUInt32BE(12);
    const salt = hdr.subarray(16, 32).toString("hex");
    const frameSize = 24 + pageSize;
    const frames = Math.max(0, Math.floor((size - 32) / frameSize));
    let lastFrame = "";
    if (frames > 0) {
      const last = Buffer.alloc(24);
      readSync(fd, last, 0, 24, 32 + (frames - 1) * frameSize);
      lastFrame = last.toString("hex");
    }
    return `:wal${checkpointSeq}:${salt}:${frames}:${lastFrame}`;
  } catch {
    return ":wal-unreadable";
  }
}

// Exported for regression tests: the timeline cache snapshot derives from
// this token, so WAL content sensitivity is verified directly against it.
export function fileChangeToken(filePath: string, isDb: boolean): string {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return "missing";
  }
  let extra = "";
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    if (isDb) {
      const hdr = Buffer.alloc(100);
      const n = readSync(fd, hdr, 0, 100, 0);
      if (n >= 96) {
        extra = `:${hdr.readUInt32BE(24)}:${hdr.readUInt32BE(92)}`;
      }
    } else if (filePath.endsWith("-wal")) {
      extra = walContentToken(fd, st.size);
      if (!extra) {
        const hdrLen = Math.min(32, st.size);
        const hdr = Buffer.alloc(hdrLen);
        readSync(fd, hdr, 0, hdrLen, 0);
        extra = `:${hdr.toString("hex")}`;
      }
    } else if (st.size > 0) {
      const hdrLen = Math.min(32, st.size);
      const hdr = Buffer.alloc(hdrLen);
      readSync(fd, hdr, 0, hdrLen, 0);
      const tailLen = Math.min(24, st.size);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, Math.max(0, st.size - tailLen));
      extra = `:${hdr.toString("hex")}:${tail.toString("hex")}`;
    }
  } catch {
    extra = ":unreadable";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}${extra}`;
}

function candidateDbOnlySnapshotKey(candidates: readonly string[]): string {
  return candidates
    .map((p) => `${resolve(p)}=${fileChangeToken(p, true)}|${fileChangeToken(`${p}-wal`, false)}`)
    .join(";");
}

function candidateDbSnapshotKey(
  candidates: readonly string[],
  storedItems: readonly Item[],
  storedUnits: readonly StoredUnitRow[],
): string {
  const dbPart = candidateDbOnlySnapshotKey(candidates);
  const itemsPart = storedItems
    .map(
      (i) =>
        `${i.item_id}:${i.tool_call_id}:${i.result_position}:${i.visibility}:${i.version}:${i.compaction_source}`,
    )
    .join(",");
  const unitsPart = storedUnits
    .map(
      (u) =>
        `${String(u.unit_id ?? "")}:${String(u.visibility ?? "")}:${String(u.version ?? "")}:${String(u.updated_at ?? "")}`,
    )
    .join(",");
  return `${dbPart}##${itemsPart}##${unitsPart}`;
}

function unicodeCompare(left: string, right: string): number {
  const leftChars = [...left];
  const rightChars = [...right];
  for (let index = 0; index < Math.min(leftChars.length, rightChars.length); index++) {
    const difference = leftChars[index].codePointAt(0)! - rightChars[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return leftChars.length - rightChars.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidJson(value: unknown): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (Array.isArray(value)) return value.every(isValidJson);
  if (isPlainObject(value)) return Object.values(value).every(isValidJson);
  return false;
}

function setOwnProp(target: Record<string, Json>, key: string, value: Json): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function canonicalizeJson(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, Json>;
    const out: Record<string, Json> = {};
    for (const key of Object.keys(obj).sort(unicodeCompare)) {
      const entry = Object.getOwnPropertyDescriptor(obj, key)?.value as Json;
      setOwnProp(out, key, canonicalizeJson(entry));
    }
    return out;
  }
  return value;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function pythonSortedJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonSortedJson).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort(unicodeCompare)
      .map((k) => `${JSON.stringify(k)}: ${pythonSortedJson(Object.getOwnPropertyDescriptor(obj, k)?.value)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hermesFilterInvocation(
  toolName: unknown,
  rawArgs: unknown,
): { invocation: { tool_name: string; arguments: Record<string, Json> }; omitted?: Record<string, Json> } | null {
  if (typeof toolName !== "string" || !toolName.trim()) return null;
  const name = toolName.trim();
  if (Object.hasOwn(HERMES_INTERNAL, name)) return null;
  const hasFields = Object.hasOwn(HERMES_FIELDS, name);
  const isMcp = name.startsWith("mcp_") && MCP_READ_PATTERN.test(name);
  if (!hasFields && !isMcp) return null;

  let args: Record<string, unknown>;
  if (isPlainObject(rawArgs)) {
    args = rawArgs;
  } else if (typeof rawArgs === "string") {
    try {
      const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      if (!isPlainObject(parsed)) return null;
      args = parsed;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!isValidJson(args)) return null;
  if (isMcp && !hasFields) {
    return {
      invocation: {
        tool_name: name,
        arguments: canonicalizeJson(args) as Record<string, Json>,
      },
    };
  }

  if (name === "terminal") {
    for (const flag of TERMINAL_BLOCKED_TRUTHY_OPTIONS) {
      if (Object.hasOwn(args, flag) && isTruthy(args[flag])) return null;
    }
    if (Object.hasOwn(args, "timeout") && args.timeout !== null) {
      const t = args.timeout;
      if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1) return null;
    }
  }

  if (Object.hasOwn(HERMES_REQUIRED, name)) {
    const req = HERMES_REQUIRED[name];
    if (typeof args[req] !== "string" || !(args[req] as string).trim()) return null;
  } else if (name === "web_extract") {
    const hasUrl = typeof args.url === "string" && args.url.trim().length > 0;
    const urlsVal = args.urls;
    const hasUrls =
      Array.isArray(urlsVal) &&
      urlsVal.length > 0 &&
      urlsVal.every((u) => typeof u === "string" && u.trim().length > 0);
    if (!hasUrl && !hasUrls) return null;
  } else if (name === "vision_analyze") {
    const hasSource = ["image_path", "path", "url"].some(
      (key) => typeof args[key] === "string" && (args[key] as string).trim().length > 0,
    );
    if (!hasSource) return null;
  }

  const fieldSet = new Set(HERMES_FIELDS[name]);
  const defaults = HERMES_DEFAULTS[name] ?? {};
  const filtered: Record<string, Json> = {};
  const omitted: Record<string, Json> = {};
  for (const key of Object.keys(args).sort(unicodeCompare)) {
    const val = Object.getOwnPropertyDescriptor(args, key)?.value;
    if (val === null || val === undefined) continue;
    if (fieldSet.has(key)) {
      if (name === "read_file" && (key === "offset" || key === "limit")) {
        if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1) return null;
        setOwnProp(filtered, key, val);
      } else if (name === "web_extract" && key === "urls") {
        if (
          !Array.isArray(val) ||
          val.length === 0 ||
          !val.every((u) => typeof u === "string" && u.trim().length > 0)
        ) {
          return null;
        }
        setOwnProp(filtered, key, [...val]);
      } else if (name === "tool_describe" && (key === "name" || key === "names")) {
        if (typeof val === "string") {
          setOwnProp(filtered, key, val);
        } else if (Array.isArray(val) && val.every((item) => typeof item === "string")) {
          setOwnProp(filtered, key, [...val]);
        } else {
          return null;
        }
      } else if (Object.hasOwn(INT_OR_STR_ID_KEYS, key) && typeof val === "number" && Number.isSafeInteger(val)) {
        setOwnProp(filtered, key, val);
      } else {
        if (typeof val !== "string") return null;
        setOwnProp(filtered, key, val);
      }
    } else {
      if (Object.hasOwn(defaults, key)) {
        const def = defaults[key];
        if (typeof val === typeof def && val === def) continue;
      }
      setOwnProp(omitted, key, canonicalizeJson(val as Json));
    }
  }

  return {
    invocation: { tool_name: name, arguments: filtered },
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
  };
}

function candidateHermesDbs(home: string, profile: string): string[] {
  const candidates: string[] = [];
  const add = (p: string) => {
    if (existsSync(p) && !candidates.includes(p)) candidates.push(p);
  };
  if (!profile || profile === "default") {
    add(join(home, ".hermes", "state.db"));
  } else if (!/[\\/:]/.test(profile) && profile !== "..") {
    add(join(home, ".hermes", "profiles", profile, "state.db"));
  }
  add(join(home, ".hermes", "state.db"));
  const profilesDir = join(home, ".hermes", "profiles");
  if (existsSync(profilesDir)) {
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          add(join(profilesDir, entry.name, "state.db"));
        }
      }
    } catch {
      // Ignore unreadable profile directories.
    }
  }
  return candidates;
}

function tableColumns(db: DatabaseSync, table: "sessions" | "messages"): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    return new Set(
      rows.map((r) => (typeof r.name === "string" ? r.name : "")).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function hasHermesSessionsBatch(
  home: string,
  requests: ReadonlyArray<{ profile: string; sessionId: string }>,
): Set<string> {
  const matched = new Set<string>();
  const pendingByDb = new Map<string, Array<{ key: string; sessionId: string }>>();
  for (const req of requests) {
    if (!req.sessionId || /[\\/:]/.test(req.sessionId)) continue;
    const key = `${req.profile}\0${req.sessionId}`;
    for (const dbPath of candidateHermesDbs(home, req.profile)) {
      const list = pendingByDb.get(dbPath) ?? [];
      list.push({ key, sessionId: req.sessionId });
      pendingByDb.set(dbPath, list);
    }
  }
  for (const [dbPath, checks] of pendingByDb) {
    const unresolved = checks.filter((c) => !matched.has(c.key));
    if (!unresolved.length) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const sessionCols = tableColumns(db, "sessions");
      const hasParentSessionId = sessionCols.has("parent_session_id");
      const messageCols = tableColumns(db, "messages");

      const stmtSession = sessionCols.has("id")
        ? db.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
        : null;
      const stmtParent = hasParentSessionId
        ? db.prepare("SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1")
        : null;
      const stmtMessages =
        messageCols.has("session_id") && messageCols.has("active")
          ? db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1")
          : null;

      for (const check of unresolved) {
        if (matched.has(check.key)) continue;
        let found = false;
        if (stmtSession) {
          try {
            found = Boolean(stmtSession.get(check.sessionId));
          } catch {
            // Ignore malformed sessions table.
          }
        }
        if (!found && stmtParent) {
          try {
            found = Boolean(stmtParent.get(check.sessionId));
          } catch {
            // Ignore query error.
          }
        }
        if (!found && stmtMessages) {
          try {
            found = Boolean(stmtMessages.get(check.sessionId));
          } catch {
            // Ignore query error.
          }
        }
        if (found) matched.add(check.key);
      }
    } catch {
      // Ignore unreadable/busy candidate DB and try remaining DBs.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
  return matched;
}

export function hasHermesSession(home: string, profile: string, sessionId: string): boolean {
  if (!sessionId || /[\\/:]/.test(sessionId)) return false;
  return hasHermesSessionsBatch(home, [{ profile, sessionId }]).has(
    `${profile}\0${sessionId}`,
  );
}

function resolveRotationTargetSessionId(
  database: DatabaseSync,
  sessionId: string,
  hasParentSessionId: boolean,
  hasStartedAt: boolean,
  hasCompressedSummary: boolean,
): string {
  if (!hasParentSessionId) return sessionId;
  let targetSessionId = sessionId;
  const visited = new Set<string>([targetSessionId]);
  const path = [targetSessionId];
  const childStmt = database.prepare(
    hasStartedAt
      ? "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC, rowid DESC"
      : "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY rowid DESC",
  );
  const liveStmt = database.prepare(
    "SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1",
  );
  const summaryStmt = hasCompressedSummary
    ? database.prepare(
        "SELECT 1 FROM messages WHERE session_id = ? AND active = 1 AND _compressed_summary = 1 LIMIT 1",
      )
    : null;
  const hasLiveMessages = (id: string): boolean => {
    try {
      return Boolean(liveStmt.get(id));
    } catch {
      return false;
    }
  };
  const hasRotationSummary = (id: string): boolean => {
    if (!summaryStmt) return false;
    try {
      return Boolean(summaryStmt.get(id));
    } catch {
      return false;
    }
  };
  for (let hop = 0; hop < 32; hop++) {
    let children: Array<{ id?: unknown }>;
    try {
      children = childStmt.all(targetSessionId) as Array<{ id?: unknown }>;
    } catch {
      break;
    }
    const fresh = children.filter(
      (row) => typeof row.id === "string" && row.id.length > 0 && !visited.has(row.id),
    ) as Array<{ id: string }>;
    if (fresh.length === 0) break;
    let next: string | undefined;
    if (fresh.length === 1) {
      next = fresh[0].id;
    } else {
      next = fresh.find((row) => hasLiveMessages(row.id) && hasRotationSummary(row.id))?.id;
    }
    if (!next) break;
    visited.add(next);
    path.push(next);
    targetSessionId = next;
  }
  if (!hasLiveMessages(targetSessionId)) {
    for (let i = path.length - 1; i >= 0; i--) {
      if (hasLiveMessages(path[i])) {
        targetSessionId = path[i];
        break;
      }
    }
  }
  return targetSessionId;
}

export function resolveHermesEffectiveScope(home: string, scope: string): string {
  const parts = scope.split(":");
  if (parts[0] !== "hermes") return scope;
  const profile = parts[1] ?? "default";
  const sessionId = parts[2] ?? "";
  if (!sessionId) return scope;

  const candidates = candidateHermesDbs(home, profile);
  if (candidates.length === 0) return scope;

  const cacheKey = `${resolve(home)}\0${scope}`;
  const cached = hermesIndexCache.get(cacheKey);
  if (cached) {
    const dbSnapshot = candidateDbOnlySnapshotKey(candidates);
    if (cached.snapshot === dbSnapshot) {
      return cached.effectiveScope;
    }
  }

  for (const dbPath of candidates) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const sessionCols = tableColumns(db, "sessions");
      const hasParentSessionId = sessionCols.has("parent_session_id");
      const hasStartedAt = sessionCols.has("started_at");
      const messageCols = tableColumns(db, "messages");
      const hasCompressedSummary = messageCols.has("_compressed_summary");

      let hasSession = false;
      try {
        hasSession = Boolean(db.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(sessionId));
      } catch {
        // Ignore missing sessions table.
      }
      if (!hasSession && hasParentSessionId) {
        try {
          hasSession = Boolean(
            db.prepare("SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore query error.
        }
      }
      if (!hasSession) {
        try {
          hasSession = Boolean(
            db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore missing messages table.
        }
      }
      if (!hasSession) continue;

      const targetSessionId = resolveRotationTargetSessionId(
        db,
        sessionId,
        hasParentSessionId,
        hasStartedAt,
        hasCompressedSummary,
      );
      return targetSessionId === sessionId
        ? scope
        : `hermes:${profile}:${targetSessionId}:unknown`;
    } catch {
      // Ignore unreadable/busy DBs and try next candidate.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
  return scope;
}

type HermesActiveSlotRow = {
  role: string;
  content: string | null;
  codex_message_items: string | null;
};

function countHermesMessageSlots(row: HermesActiveSlotRow, isCodexMode: boolean): number {
  if (row.role === "user") return 1;
  if (row.role !== "assistant") return 0;
  if (typeof row.codex_message_items === "string" && row.codex_message_items.trim()) {
    try {
      const items: unknown = JSON.parse(row.codex_message_items);
      if (Array.isArray(items) && items.length > 0) {
        let slots = 0;
        for (const it of items) {
          if (!it || typeof it !== "object") continue;
          const entry = it as { type?: unknown; role?: unknown };
          if ((entry.type ?? "message") !== "message" || entry.role !== "assistant") continue;
          slots += 1;
        }
        if (slots > 0) return slots;
      }
    } catch {
      // Fall through to content-based counting, mirroring emission.
    }
  }
  if (isCodexMode) return typeof row.content === "string" && row.content.length > 0 ? 1 : 0;
  return 1;
}

function parseCallArguments(rawArgs: unknown): unknown {
  if (typeof rawArgs === "string") {
    try {
      return rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return rawArgs;
    }
  }
  return rawArgs;
}

export function loadHermesTimelineIndex(
  home: string,
  scope: string,
): HermesTimelineIndexResult {
  const parts = scope.split(":");
  if (parts[0] !== "hermes") return { index: null };
  const profile = parts[1] ?? "default";
  const sessionId = parts[2] ?? "";
  if (!sessionId) return { index: null };

  const candidates = candidateHermesDbs(home, profile);
  if (candidates.length === 0) return { index: null };

  const cacheKey = `${resolve(home)}\0${scope}`;
  const snapshot = candidateDbOnlySnapshotKey(candidates);
  const cached = hermesIndexCache.get(cacheKey);
  if (cached && cached.snapshot === snapshot) {
    hermesIndexCache.delete(cacheKey);
    hermesIndexCache.set(cacheKey, cached);
    return { index: cached };
  }

  let matchedReadError: { dbPath: string; error: string } | null = null;
  for (const dbPath of candidates) {
    let db: DatabaseSync | undefined;
    let matchedInThisDb = false;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const sessionCols = tableColumns(db, "sessions");
      const hasParentSessionId = sessionCols.has("parent_session_id");
      const hasStartedAt = sessionCols.has("started_at");
      const messageCols = tableColumns(db, "messages");
      const hasCompressedSummary = messageCols.has("_compressed_summary");

      let sessionRow: { id?: string; model_config?: string | null } | undefined;
      try {
        sessionRow = db
          .prepare("SELECT id, model_config FROM sessions WHERE id = ?")
          .get(sessionId) as { id?: string; model_config?: string | null } | undefined;
      } catch {
        // Ignore missing sessions table.
      }
      let hasSession = Boolean(sessionRow?.id);
      if (!hasSession && hasParentSessionId) {
        try {
          hasSession = Boolean(
            db.prepare("SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore query error.
        }
      }
      if (!hasSession) {
        try {
          hasSession = Boolean(
            db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore unreadable messages table.
        }
      }
      if (!hasSession) continue;
      matchedInThisDb = true;

      const targetSessionId = resolveRotationTargetSessionId(
        db,
        sessionId,
        hasParentSessionId,
        hasStartedAt,
        hasCompressedSummary,
      );
      if (targetSessionId !== sessionId) {
        try {
          const targetRow = db
            .prepare("SELECT id, model_config FROM sessions WHERE id = ?")
            .get(targetSessionId) as { id?: string; model_config?: string | null } | undefined;
          if (targetRow && typeof targetRow.id === "string") {
            sessionRow = targetRow;
          }
        } catch {
          // Keep initial sessionRow fallback.
        }
      }

      const effectiveScope =
        targetSessionId === sessionId
          ? scope
          : `hermes:${profile}:${targetSessionId}:unknown`;

      let apiMode = "chat_completions";
      let usedTokens: number | undefined;
      if (typeof sessionRow?.model_config === "string" && sessionRow.model_config) {
        try {
          const cfg = JSON.parse(sessionRow.model_config) as Record<string, any>;
          if (typeof cfg?.gateway_runtime?.api_mode === "string") {
            apiMode = cfg.gateway_runtime.api_mode;
          }
          const anchor = cfg?._usage_anchor;
          if (anchor && typeof anchor.prompt_tokens === "number" && anchor.prompt_tokens > 0) {
            usedTokens = Math.trunc(anchor.prompt_tokens + (Number(anchor.completion_tokens) || 0));
          }
        } catch {
          // Ignore malformed model_config JSON.
        }
      }

      // P1-4: pre-count guard runs before scanning or allocating chunk rows.
      const activeCount = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND active = 1")
        .get(targetSessionId) as { n?: number } | undefined;
      if ((activeCount?.n ?? 0) > MAX_HISTORY_ROWS) {
        throw new HistoryTooLargeError(
          `hermes session chunk exceeds ${MAX_HISTORY_ROWS} active rows (${activeCount?.n})`,
        );
      }

      let lastSummaryId: number | null = null;
      if (hasCompressedSummary) {
        const sumRow = db
          .prepare(
            "SELECT MAX(id) AS last_summary_id FROM messages WHERE session_id = ? AND active = 1 AND _compressed_summary = 1",
          )
          .get(targetSessionId) as { last_summary_id?: number | null } | undefined;
        if (typeof sumRow?.last_summary_id === "number" && Number.isFinite(sumRow.last_summary_id)) {
          lastSummaryId = Number(sumRow.last_summary_id);
        }
      }

      const isCodexMode = apiMode === "codex_responses";
      let msgPos = 0;

      // Count pre-summary slots without loading content/api_content blobs.
      if (lastSummaryId !== null) {
        let preFirst = true;
        let preCursorId = 0;
        const preFirstStmt = db.prepare(
          `SELECT id, role, codex_message_items,
                  CASE WHEN typeof(content) = 'text' AND length(content) > 0 THEN 1 ELSE 0 END AS has_content
           FROM messages
           WHERE session_id = ? AND active = 1 AND id < ?
           ORDER BY id ASC
           LIMIT ${HERMES_KEYSET_BATCH_SIZE}`,
        );
        const preNextStmt = db.prepare(
          `SELECT id, role, codex_message_items,
                  CASE WHEN typeof(content) = 'text' AND length(content) > 0 THEN 1 ELSE 0 END AS has_content
           FROM messages
           WHERE session_id = ? AND active = 1 AND id < ? AND id > ?
           ORDER BY id ASC
           LIMIT ${HERMES_KEYSET_BATCH_SIZE}`,
        );
        while (true) {
          const batch = (
            preFirst
              ? preFirstStmt.all(targetSessionId, lastSummaryId)
              : preNextStmt.all(targetSessionId, lastSummaryId, preCursorId)
          ) as Array<{
            id: number;
            role: string;
            codex_message_items: string | null;
            has_content: number;
          }>;
          preFirst = false;
          if (batch.length === 0) break;
          for (const row of batch) {
            msgPos += countHermesMessageSlots(
              {
                role: row.role,
                content: row.has_content ? "x" : null,
                codex_message_items: row.codex_message_items,
              },
              isCodexMode,
            );
            preCursorId = Number(row.id);
          }
          if (batch.length < HERMES_KEYSET_BATCH_SIZE) break;
        }
      }

      type IndexedCallEntry = {
        name: string;
        rowOrdinal: number;
        assistantRowId: number;
        filteredDigest?: string;
        optionsOmitted?: boolean;
        manageableCall: boolean;
      };
      type ToolCandidate = {
        slotIndex: number;
        callId: string;
        toolName: string;
        rowId: number;
        rowOrdinal: number;
        resultPos: number;
        byteSize: number;
        contentSha: string;
        found?: IndexedCallEntry;
      };

      const calls = new Map<string, IndexedCallEntry>();
      const duplicate = new Set<string>();
      const resultCounts = new Map<string, number>();
      const slots: HermesIndexSlot[] = [];
      const toolCandidates: ToolCandidate[] = [];

      let canonicalSummaryKey: string | null = null;
      let canonicalSummarySlotIdx = -1;
      const emitMessageSlot = (
        slot: HermesIndexSlot,
        fullText: string,
        isFlaggedSummary: boolean,
      ): void => {
        if (isFlaggedSummary && canonicalSummaryKey === null) {
          canonicalSummaryKey = summaryDedupeKey(fullText);
          canonicalSummarySlotIdx = slots.length;
          slots.push(slot);
          return;
        }
        if (canonicalSummaryKey !== null && summaryDedupeKey(fullText) === canonicalSummaryKey) {
          const kept = slots[canonicalSummarySlotIdx];
          if (kept) {
            if (slot.manageable && !kept.manageable) {
              slots[canonicalSummarySlotIdx] = slot;
            } else {
              kept.manageable = Boolean(kept.manageable || slot.manageable);
              if (
                kept.computed_item_id.startsWith("hist_") &&
                slot.computed_item_id.startsWith("msg:")
              ) {
                kept.computed_item_id = slot.computed_item_id;
                kept.msg_role_pos = slot.msg_role_pos;
              }
            }
          }
          return;
        }
        slots.push(slot);
      };

      const computeMsgId = (
        role: "user" | "assistant",
        pos: number,
        wireContent: unknown,
      ): { computedId: string; rolePos: string } => {
        const serialized =
          typeof wireContent === "string" ? wireContent : pythonSortedJson(wireContent);
        return {
          computedId: `msg:${role}:p${pos}:${sha256(serialized).slice(0, 12)}`,
          rolePos: `${role}:p${pos}`,
        };
      };

      const colsSql = `id, role, content, tool_call_id, tool_calls, tool_name,
                  codex_message_items, api_content, compacted`;
      const firstBatchStmt =
        lastSummaryId !== null
          ? db.prepare(
              `SELECT ${colsSql} FROM messages
               WHERE session_id = ? AND active = 1 AND id >= ?
               ORDER BY id ASC LIMIT ${HERMES_KEYSET_BATCH_SIZE}`,
            )
          : db.prepare(
              `SELECT ${colsSql} FROM messages
               WHERE session_id = ? AND active = 1
               ORDER BY id ASC LIMIT ${HERMES_KEYSET_BATCH_SIZE}`,
            );
      const nextBatchStmt = db.prepare(
        `SELECT ${colsSql} FROM messages
         WHERE session_id = ? AND active = 1 AND id > ?
         ORDER BY id ASC LIMIT ${HERMES_KEYSET_BATCH_SIZE}`,
      );

      let firstBatch = true;
      let cursorId = 0;
      let rowOrdinal = 0;

      while (true) {
        const batch = (
          firstBatch
            ? lastSummaryId !== null
              ? firstBatchStmt.all(targetSessionId, lastSummaryId)
              : firstBatchStmt.all(targetSessionId)
            : nextBatchStmt.all(targetSessionId, cursorId)
        ) as Array<{
          id: number;
          role: string;
          content: string | null;
          tool_call_id: string | null;
          tool_calls: string | null;
          tool_name: string | null;
          codex_message_items: string | null;
          api_content: string | null;
          compacted: number | null;
        }>;
        firstBatch = false;
        if (batch.length === 0) break;

        for (const row of batch) {
          const rowId = Number(row.id);
          cursorId = rowId;
          const ordinal = rowOrdinal++;
          const isFlaggedSummary = lastSummaryId !== null && rowId === lastSummaryId;
          const isUncompacted = Number(row.compacted ?? 0) === 0;

          if (row.role === "user") {
            const displayText = row.content ?? row.api_content ?? "";
            let rowIdStr = `hist_user_${rowId}`;
            let rolePos: string | undefined;
            if (isUncompacted) {
              const rawApi = row.api_content !== null ? row.api_content : (row.content ?? "");
              const wireContent = isCodexMode ? [{ text: rawApi, type: "input_text" }] : rawApi;
              const info = computeMsgId("user", msgPos, wireContent);
              rowIdStr = info.computedId;
              rolePos = info.rolePos;
            }
            msgPos += 1;
            if (displayText.trim()) {
              emitMessageSlot(
                {
                  kind: "user",
                  tool_name: "user",
                  tool_call_id: "",
                  computed_item_id: rowIdStr,
                  ...(rolePos ? { msg_role_pos: rolePos } : {}),
                  result_position: 0,
                  manageable: isUncompacted,
                  source: "display_only",
                  summary_line: summaryLine(displayText),
                  bytes_size: bytes(displayText),
                  db_row_id: rowId,
                },
                displayText,
                isFlaggedSummary,
              );
            }
            continue;
          }

          if (row.role === "assistant") {
            if (typeof row.tool_calls === "string" && row.tool_calls.trim()) {
              try {
                const parsedCalls = JSON.parse(row.tool_calls);
                if (Array.isArray(parsedCalls)) {
                  for (const entry of parsedCalls) {
                    const rawCid =
                      typeof entry?.call_id === "string" && entry.call_id.trim()
                        ? entry.call_id
                        : typeof entry?.id === "string"
                          ? entry.id
                          : "";
                    const cid = rawCid.trim();
                    const fnName = typeof entry?.function?.name === "string" ? entry.function.name : "";
                    if (!cid) continue;
                    const rawArgs = entry?.function?.arguments ?? {};
                    if (calls.has(cid)) {
                      duplicate.add(cid);
                    } else {
                      const filtered = fnName ? hermesFilterInvocation(fnName, rawArgs) : null;
                      calls.set(cid, {
                        name: fnName,
                        rowOrdinal: ordinal,
                        assistantRowId: rowId,
                        manageableCall: Boolean(filtered),
                        ...(filtered
                          ? {
                              filteredDigest: invocationDigest(
                                filtered.invocation,
                                filtered.omitted,
                              ),
                              optionsOmitted: Boolean(filtered.omitted),
                            }
                          : {}),
                      });
                    }
                  }
                }
              } catch {
                // Ignore malformed tool_calls JSON.
              }
            }

            let handledViaCodexItems = false;
            if (typeof row.codex_message_items === "string" && row.codex_message_items.trim()) {
              try {
                const items = JSON.parse(row.codex_message_items);
                if (Array.isArray(items) && items.length > 0) {
                  for (let subIdx = 0; subIdx < items.length; subIdx++) {
                    const it = items[subIdx];
                    if (
                      !it ||
                      typeof it !== "object" ||
                      (it.type ?? "message") !== "message" ||
                      it.role !== "assistant"
                    ) {
                      continue;
                    }
                    handledViaCodexItems = true;
                    const ic = it.content;
                    const text =
                      typeof ic === "string"
                        ? ic
                        : Array.isArray(ic)
                          ? ic
                              .map((p: any) =>
                                p && typeof p === "object" && typeof p.text === "string"
                                  ? p.text
                                  : "",
                              )
                              .join("")
                          : "";
                    let rowIdStr = `hist_ast_${rowId}_${subIdx}`;
                    let rolePos: string | undefined;
                    if (isUncompacted) {
                      const info = computeMsgId("assistant", msgPos, ic);
                      rowIdStr = info.computedId;
                      rolePos = info.rolePos;
                    }
                    msgPos += 1;
                    if (text.trim()) {
                      emitMessageSlot(
                        {
                          kind: "assistant",
                          tool_name: "assistant",
                          tool_call_id: "",
                          computed_item_id: rowIdStr,
                          ...(rolePos ? { msg_role_pos: rolePos } : {}),
                          result_position: 0,
                          manageable: isUncompacted,
                          source: "display_only",
                          summary_line: summaryLine(text),
                          bytes_size: bytes(text),
                          db_row_id: rowId,
                          codex_sub_index: subIdx,
                        },
                        text,
                        isFlaggedSummary,
                      );
                    }
                  }
                }
              } catch {
                handledViaCodexItems = false;
              }
            }
            if (!handledViaCodexItems) {
              if (isCodexMode) {
                if (typeof row.content === "string" && row.content.length > 0) {
                  const text = row.content;
                  let rowIdStr = `hist_ast_${rowId}`;
                  let rolePos: string | undefined;
                  if (isUncompacted) {
                    const wireContent = [{ text, type: "output_text" }];
                    const info = computeMsgId("assistant", msgPos, wireContent);
                    rowIdStr = info.computedId;
                    rolePos = info.rolePos;
                  }
                  msgPos += 1;
                  if (text.trim()) {
                    emitMessageSlot(
                      {
                        kind: "assistant",
                        tool_name: "assistant",
                        tool_call_id: "",
                        computed_item_id: rowIdStr,
                        ...(rolePos ? { msg_role_pos: rolePos } : {}),
                        result_position: 0,
                        manageable: isUncompacted,
                        source: "display_only",
                        summary_line: summaryLine(text),
                        bytes_size: bytes(text),
                        db_row_id: rowId,
                      },
                      text,
                      isFlaggedSummary,
                    );
                  }
                }
              } else {
                const wireContent =
                  typeof row.api_content === "string"
                    ? row.api_content
                    : typeof row.content === "string"
                      ? row.content
                      : "";
                const text =
                  typeof row.content === "string" && row.content.length > 0
                    ? row.content
                    : typeof row.api_content === "string"
                      ? row.api_content
                      : "";
                let rowIdStr = `hist_ast_${rowId}`;
                let rolePos: string | undefined;
                if (isUncompacted) {
                  const info = computeMsgId("assistant", msgPos, wireContent);
                  rowIdStr = info.computedId;
                  rolePos = info.rolePos;
                }
                msgPos += 1;
                if (text.trim()) {
                  emitMessageSlot(
                    {
                      kind: "assistant",
                      tool_name: "assistant",
                      tool_call_id: "",
                      computed_item_id: rowIdStr,
                      ...(rolePos ? { msg_role_pos: rolePos } : {}),
                      result_position: 0,
                      manageable: isUncompacted,
                      source: "display_only",
                      summary_line: summaryLine(text),
                      bytes_size: bytes(text),
                      db_row_id: rowId,
                    },
                    text,
                    isFlaggedSummary,
                  );
                }
              }
            }
            continue;
          }

          if (row.role !== "tool") continue;
          const callId = (row.tool_call_id ?? "").trim();
          const resultPos = callId ? (resultCounts.get(callId) ?? 0) : 0;
          if (callId) {
            resultCounts.set(callId, resultPos + 1);
          }
          const found = callId ? calls.get(callId) : undefined;
          const toolName = row.tool_name || found?.name || "tool";
          const text = row.content ?? "";
          const textSize = bytes(text);

          const slotIndex = slots.length;
          slots.push({
            kind: "tool",
            tool_name: toolName,
            tool_call_id: callId,
            computed_item_id: `display_hermes_${rowId}`,
            result_position: resultPos,
            manageable: false,
            source: "display_only",
            summary_line: formatToolSummary(toolName, text) || `[${toolName}]`,
            bytes_size: textSize,
            db_row_id: rowId,
            ...(found ? { assistant_row_id: found.assistantRowId } : {}),
          });

          if (
            callId &&
            found &&
            found.rowOrdinal < ordinal &&
            found.name === toolName &&
            found.manageableCall &&
            found.filteredDigest !== undefined
          ) {
            toolCandidates.push({
              slotIndex,
              callId,
              toolName,
              rowId,
              rowOrdinal: ordinal,
              resultPos,
              byteSize: textSize,
              contentSha: sha256(text),
              found,
            });
          }
        }

        if (batch.length < HERMES_KEYSET_BATCH_SIZE) break;
      }

      // Apply MAX_HERMES_RECORD_BYTES / MAX_HERMES_RECORDS from newest to oldest.
      let totalRecordBytes = 0;
      let recordCount = 0;
      let recordsCapped = false;
      const recordedCallIds = new Set<string>();
      for (let i = toolCandidates.length - 1; i >= 0; i--) {
        const candidate = toolCandidates[i];
        if (
          duplicate.has(candidate.callId) ||
          resultCounts.get(candidate.callId) !== 1
        ) {
          continue;
        }
        if (recordedCallIds.has(candidate.callId)) continue;
        if (
          totalRecordBytes + candidate.byteSize <= MAX_HERMES_RECORD_BYTES &&
          recordCount < MAX_HERMES_RECORDS
        ) {
          totalRecordBytes += candidate.byteSize;
          recordCount += 1;
          recordedCallIds.add(candidate.callId);
          const slot = slots[candidate.slotIndex];
          slot.computed_item_id = itemId(
            effectiveScope,
            candidate.callId,
            candidate.contentSha,
            candidate.found!.filteredDigest!,
            candidate.resultPos,
          );
          slot.manageable = true;
          slot.source = "unrecorded";
        } else {
          recordsCapped = true;
        }
      }

      const built: HermesTimelineIndex = {
        requestedScope: scope,
        effectiveScope,
        dbPath,
        snapshot,
        apiMode,
        usedTokens,
        slots,
        chunkAuthoritative: true,
        recordsCapped,
        estimatedBytes: estimateHermesIndexBytes(slots),
      };
      setHermesIndexCache(cacheKey, built);
      return { index: built };
    } catch (err) {
      if (err instanceof HistoryTooLargeError) throw err;
      if (matchedInThisDb && !matchedReadError) {
        matchedReadError = {
          dbPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // Ignore unreadable or busy candidate DBs and try next candidate.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  if (matchedReadError) {
    return {
      index: null,
      readError: matchedReadError.error,
      readErrorDb: matchedReadError.dbPath,
    };
  }
  return { index: null };
}

export function applyHermesOverlay(
  index: HermesTimelineIndex,
  storedItems: readonly Item[],
  storedUnits: readonly StoredUnitRow[],
): HermesOverlaidSlot[] {
  const storedByCallPos = new Map<string, Item>();
  for (const item of storedItems) {
    const cid = item.tool_call_id.trim();
    const posKey = `${cid}\0${item.result_position}`;
    if (!storedByCallPos.has(posKey)) {
      storedByCallPos.set(posKey, item);
    }
  }

  const exactUnitIds = new Set<string>();
  const unitsByRolePos = new Map<string, StoredUnitRow[]>();
  for (const unit of storedUnits) {
    const uid = String(unit.unit_id ?? "");
    if (!uid.startsWith("msg:")) continue;
    exactUnitIds.add(uid);
    const segs = uid.split(":");
    if (segs.length >= 3) {
      const rpKey = `${segs[1]}:${segs[2]}`;
      const list = unitsByRolePos.get(rpKey) ?? [];
      list.push(unit);
      unitsByRolePos.set(rpKey, list);
    }
  }

  const resolveOverlayMsgId = (computedId: string, rolePos?: string): string => {
    if (exactUnitIds.has(computedId) || !rolePos) return computedId;
    const candidates = unitsByRolePos.get(rolePos);
    if (candidates && candidates.length > 0) {
      const hidden = candidates.find((u) => u.visibility === "hidden");
      if (hidden) return String(hidden.unit_id);
      const sorted = [...candidates].sort(
        (a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0),
      );
      return String(sorted[0].unit_id);
    }
    return computedId;
  };

  return index.slots.map((slot) => {
    if (slot.kind === "tool") {
      const storedItem = slot.tool_call_id
        ? storedByCallPos.get(`${slot.tool_call_id}\0${slot.result_position}`)
        : undefined;
      return {
        item_id: storedItem ? storedItem.item_id : slot.computed_item_id,
        tool_call_id: slot.tool_call_id,
        tool_name: slot.tool_name,
        kind: "tool",
        manageable: Boolean(storedItem || slot.manageable),
        source: slot.source,
        summary_line: slot.summary_line,
        bytes_size: slot.bytes_size,
        db_row_id: slot.db_row_id,
        ...(slot.assistant_row_id !== undefined
          ? { assistant_row_id: slot.assistant_row_id }
          : {}),
      };
    }
    const itemIdResolved = slot.msg_role_pos
      ? resolveOverlayMsgId(slot.computed_item_id, slot.msg_role_pos)
      : slot.computed_item_id;
    return {
      item_id: itemIdResolved,
      tool_call_id: "",
      tool_name: slot.tool_name,
      kind: slot.kind,
      manageable: slot.manageable,
      source: slot.source,
      summary_line: slot.summary_line,
      bytes_size: slot.bytes_size,
      db_row_id: slot.db_row_id,
      ...(slot.codex_sub_index !== undefined
        ? { codex_sub_index: slot.codex_sub_index }
        : {}),
    };
  });
}

type HydratedDbRow = {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  codex_message_items: string | null;
  api_content: string | null;
};

function fetchRowsByIds(
  db: DatabaseSync,
  ids: readonly number[],
): Map<number, HydratedDbRow> {
  const byId = new Map<number, HydratedDbRow>();
  if (!ids.length) return byId;
  for (let i = 0; i < ids.length; i += HERMES_HYDRATE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + HERMES_HYDRATE_BATCH_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const fetched = db
      .prepare(
        `SELECT id, role, content, tool_calls, codex_message_items, api_content
         FROM messages
         WHERE id IN (${placeholders})`,
      )
      .all(...chunk) as HydratedDbRow[];
    for (const row of fetched) {
      byId.set(Number(row.id), row);
    }
  }
  return byId;
}

function slotToLightweightRow(slot: HermesOverlaidSlot): Message {
  return {
    item_id: slot.item_id,
    tool_call_id: slot.tool_call_id,
    tool_name: slot.tool_name,
    kind: slot.kind,
    manageable: slot.manageable,
    source: slot.source,
    summary_line: slot.summary_line,
    bytes_size: slot.bytes_size,
  };
}

export function hydrateHermesRows(
  index: HermesTimelineIndex,
  slots: readonly HermesOverlaidSlot[],
): Message[] {
  if (!slots.length) return [];
  const neededIds = new Set<number>();
  for (const slot of slots) {
    neededIds.add(slot.db_row_id);
    if (slot.assistant_row_id !== undefined) {
      neededIds.add(slot.assistant_row_id);
    }
  }
  let db: DatabaseSync | undefined;
  let rowsById = new Map<number, HydratedDbRow>();
  try {
    db = new DatabaseSync(index.dbPath, { readOnly: true });
    rowsById = fetchRowsByIds(db, [...neededIds]);
  } catch {
    return slots.map(slotToLightweightRow);
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }

  const parsedCallsByAssistantId = new Map<number, Map<string, unknown>>();
  const getToolArgs = (assistantRowId: number, callId: string): unknown => {
    let callMap = parsedCallsByAssistantId.get(assistantRowId);
    if (!callMap) {
      callMap = new Map<string, unknown>();
      parsedCallsByAssistantId.set(assistantRowId, callMap);
      const aRow = rowsById.get(assistantRowId);
      if (aRow && typeof aRow.tool_calls === "string" && aRow.tool_calls.trim()) {
        try {
          const parsedCalls = JSON.parse(aRow.tool_calls);
          if (Array.isArray(parsedCalls)) {
            for (const entry of parsedCalls) {
              const rawCid =
                typeof entry?.call_id === "string" && entry.call_id.trim()
                  ? entry.call_id
                  : typeof entry?.id === "string"
                    ? entry.id
                    : "";
              const cid = rawCid.trim();
              if (cid && !callMap.has(cid)) {
                callMap.set(cid, parseCallArguments(entry?.function?.arguments ?? {}));
              }
            }
          }
        } catch {
          // Ignore malformed tool_calls.
        }
      }
    }
    return callMap.get(callId);
  };

  const isCodexMode = index.apiMode === "codex_responses";
  return slots.map((slot) => {
    const out = slotToLightweightRow(slot);
    const dbRow = rowsById.get(slot.db_row_id);
    if (!dbRow) return out;

    if (slot.kind === "user") {
      const displayText = dbRow.content ?? dbRow.api_content ?? "";
      out.message_text = preview(displayText);
      return out;
    }
    if (slot.kind === "assistant") {
      let text = "";
      if (slot.codex_sub_index !== undefined && typeof dbRow.codex_message_items === "string") {
        try {
          const items = JSON.parse(dbRow.codex_message_items);
          const item = Array.isArray(items) ? items[slot.codex_sub_index] : undefined;
          const ic = item?.content;
          text =
            typeof ic === "string"
              ? ic
              : Array.isArray(ic)
                ? ic
                    .map((p: any) =>
                      p && typeof p === "object" && typeof p.text === "string" ? p.text : "",
                    )
                    .join("")
                : "";
        } catch {
          text = "";
        }
      } else if (isCodexMode) {
        text = dbRow.content ?? "";
      } else {
        text =
          typeof dbRow.content === "string" && dbRow.content.length > 0
            ? dbRow.content
            : typeof dbRow.api_content === "string"
              ? dbRow.api_content
              : "";
      }
      out.message_text = preview(text);
      return out;
    }

    const text = dbRow.content ?? "";
    if (slot.assistant_row_id !== undefined && slot.tool_call_id) {
      const parsedArgs = getToolArgs(slot.assistant_row_id, slot.tool_call_id);
      if (parsedArgs !== undefined) {
        out.tool_input = preview(parsedArgs);
      }
    }
    out.tool_output = preview(text);
    return out;
  });
}

export function searchHermesIndex(
  index: HermesTimelineIndex,
  overlaidSlots: readonly HermesOverlaidSlot[],
  query: string,
  storedCompactedByItemId?: ReadonlyMap<string, string | undefined>,
): number[] {
  const q = query.toLowerCase();
  const matched = new Set<number>();
  const toolInputChecks: number[] = [];

  for (let i = 0; i < overlaidSlots.length; i++) {
    const slot = overlaidSlots[i];
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
      slot.assistant_row_id !== undefined &&
      slot.tool_call_id
    ) {
      toolInputChecks.push(i);
    }
  }

  if (toolInputChecks.length > 0) {
    const assistantIds = [...new Set(toolInputChecks.map((idx) => overlaidSlots[idx].assistant_row_id!))];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(index.dbPath, { readOnly: true });
      const rowsById = fetchRowsByIds(db, assistantIds);
      const parsedCalls = new Map<number, Map<string, unknown>>();
      for (const idx of toolInputChecks) {
        const slot = overlaidSlots[idx];
        const aId = slot.assistant_row_id!;
        let callMap = parsedCalls.get(aId);
        if (!callMap) {
          callMap = new Map<string, unknown>();
          parsedCalls.set(aId, callMap);
          const aRow = rowsById.get(aId);
          if (aRow && typeof aRow.tool_calls === "string" && aRow.tool_calls.trim()) {
            try {
              const arr = JSON.parse(aRow.tool_calls);
              if (Array.isArray(arr)) {
                for (const entry of arr) {
                  const rawCid =
                    typeof entry?.call_id === "string" && entry.call_id.trim()
                      ? entry.call_id
                      : typeof entry?.id === "string"
                        ? entry.id
                        : "";
                  const cid = rawCid.trim();
                  if (cid && !callMap.has(cid)) {
                    callMap.set(cid, parseCallArguments(entry?.function?.arguments ?? {}));
                  }
                }
              }
            } catch {
              // Ignore malformed JSON.
            }
          }
        }
        const args = callMap.get(slot.tool_call_id);
        if (args !== undefined && preview(args).toLowerCase().includes(q)) {
          matched.add(idx);
        }
      }
    } catch {
      // Ignore DB read issues during search fallback.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  return [...matched].sort((a, b) => a - b);
}

export function loadHermesRecordById(
  index: HermesTimelineIndex,
  overlaidSlots: readonly HermesOverlaidSlot[],
  id: string,
): HermesExtendedRecord | undefined {
  const slot = overlaidSlots.find(
    (candidate, i) =>
      candidate.kind === "tool" &&
      index.slots[i]?.source === "unrecorded" &&
      (candidate.tool_call_id === id ||
        candidate.item_id === id ||
        index.slots[i]?.computed_item_id === id),
  );
  if (!slot || slot.assistant_row_id === undefined) return undefined;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(index.dbPath, { readOnly: true });
    const rowsById = fetchRowsByIds(db, [slot.db_row_id, slot.assistant_row_id]);
    const toolRow = rowsById.get(slot.db_row_id);
    const astRow = rowsById.get(slot.assistant_row_id);
    if (!toolRow || !astRow || typeof astRow.tool_calls !== "string") return undefined;
    const parsedCalls = JSON.parse(astRow.tool_calls);
    if (!Array.isArray(parsedCalls)) return undefined;
    let rawArgs: unknown;
    let fnName = slot.tool_name;
    for (const entry of parsedCalls) {
      const rawCid =
        typeof entry?.call_id === "string" && entry.call_id.trim()
          ? entry.call_id
          : typeof entry?.id === "string"
            ? entry.id
            : "";
      if (rawCid.trim() === slot.tool_call_id) {
        rawArgs = entry?.function?.arguments ?? {};
        if (typeof entry?.function?.name === "string" && entry.function.name) {
          fnName = entry.function.name;
        }
        break;
      }
    }
    const filtered = hermesFilterInvocation(fnName, rawArgs);
    if (!filtered) return undefined;
    const text = toolRow.content ?? "";
    const digest = invocationDigest(filtered.invocation, filtered.omitted);
    return {
      call_id: slot.tool_call_id,
      content: text,
      content_sha256: sha256(text),
      invocation: filtered.invocation,
      invocation_digest: digest,
      result_position: index.slots.find((s) => s.db_row_id === slot.db_row_id)?.result_position ?? 0,
      status: "ok",
      ...(filtered.omitted ? { options_omitted: true } : {}),
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

export function loadHermesTimeline(
  home: string,
  scope: string,
  storedItems: readonly Item[] = [],
  storedUnits: readonly StoredUnitRow[] = [],
): Timeline | null {
  const parts = scope.split(":");
  if (parts[0] !== "hermes") return null;
  const profile = parts[1] ?? "default";
  const sessionId = parts[2] ?? "";
  if (!sessionId) return null;

  const candidates = candidateHermesDbs(home, profile);
  if (candidates.length === 0) return null;

  const cacheKey = `${resolve(home)}\0${scope}`;
  const snapshot = candidateDbSnapshotKey(candidates, storedItems, storedUnits);
  const cached = hermesTimelineCache.get(cacheKey);
  if (cached && cached.snapshot === snapshot) {
    hermesTimelineCache.delete(cacheKey);
    hermesTimelineCache.set(cacheKey, cached);
    return cloneTimeline(cached.timeline);
  }

  const indexResult = loadHermesTimelineIndex(home, scope);
  if (indexResult.readError) {
    return {
      rows: [],
      records: new Map(),
      history: {
        messages: [],
        boundaries: [],
        injected: [],
        chunkStart: 0,
        readError: indexResult.readError,
        readErrorDb: indexResult.readErrorDb,
      },
    };
  }
  const index = indexResult.index;
  if (!index) return null;

  const overlaid = applyHermesOverlay(index, storedItems, storedUnits);
  const rows = hydrateHermesRows(index, overlaid);

  const records = new Map<string, HermesExtendedRecord>();
  const recordEligibleSlots = index.slots.filter(
    (s) => s.kind === "tool" && s.source === "unrecorded" && s.assistant_row_id !== undefined,
  );
  if (recordEligibleSlots.length > 0) {
    const ids = new Set<number>();
    for (const s of recordEligibleSlots) {
      ids.add(s.db_row_id);
      ids.add(s.assistant_row_id!);
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(index.dbPath, { readOnly: true });
      const rowsById = fetchRowsByIds(db, [...ids]);
      const callArgsByAssistantId = new Map<number, Map<string, unknown>>();
      for (const s of recordEligibleSlots) {
        let cmap = callArgsByAssistantId.get(s.assistant_row_id!);
        if (!cmap) {
          cmap = new Map();
          callArgsByAssistantId.set(s.assistant_row_id!, cmap);
          const aRow = rowsById.get(s.assistant_row_id!);
          if (aRow && typeof aRow.tool_calls === "string") {
            try {
              const arr = JSON.parse(aRow.tool_calls);
              if (Array.isArray(arr)) {
                for (const entry of arr) {
                  const rawCid =
                    typeof entry?.call_id === "string" && entry.call_id.trim()
                      ? entry.call_id
                      : typeof entry?.id === "string"
                        ? entry.id
                        : "";
                  const cid = rawCid.trim();
                  if (cid && !cmap.has(cid)) {
                    cmap.set(cid, entry?.function?.arguments ?? {});
                  }
                }
              }
            } catch {
              // Ignore malformed tool_calls.
            }
          }
        }
        const toolRow = rowsById.get(s.db_row_id);
        const filtered = hermesFilterInvocation(s.tool_name, cmap.get(s.tool_call_id));
        if (!toolRow || !filtered) continue;
        const text = toolRow.content ?? "";
        records.set(s.tool_call_id, {
          call_id: s.tool_call_id,
          content: text,
          content_sha256: sha256(text),
          invocation: filtered.invocation,
          invocation_digest: invocationDigest(filtered.invocation, filtered.omitted),
          result_position: s.result_position,
          status: "ok",
          ...(filtered.omitted ? { options_omitted: true } : {}),
        });
      }
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  const history: History = {
    messages: [],
    boundaries: [],
    injected: [],
    chunkStart: 0,
    effectiveScope: index.effectiveScope,
    chunkAuthoritative: index.chunkAuthoritative,
    ...(index.usedTokens
      ? {
          externalContext: {
            used_tokens: index.usedTokens,
            max_tokens: null,
            source: "hermes_session_usage",
          },
        }
      : {}),
  };
  if (index.recordsCapped) {
    history.recordsCapped = true;
  }

  const built: Timeline = { rows, records, history };
  setHermesTimelineCache(cacheKey, snapshot, built);
  return cloneTimeline(built);
}
