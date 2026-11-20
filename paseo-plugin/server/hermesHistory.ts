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
import { cloneTimeline, formatToolSummary, preview, summaryLine, type History, type Timeline } from "./history.ts";
import { HistoryTooLargeError, MAX_HISTORY_ROWS } from "./historyLimits.ts";
import { summaryDedupeKey } from "../shared/summaryDedupe.ts";

export type HermesExtendedRecord = RecordInput & { options_omitted?: boolean };

type StoredUnitRow = Record<string, unknown>;

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
const MAX_HERMES_TIMELINE_CACHE = 32;

const hermesTimelineCache = new Map<string, { snapshot: string; timeline: Timeline }>();

function walContentToken(fd: number, size: number): string {
  // B6: a non-truncating RESTART checkpoint can overwrite middle WAL frames
  // while leaving size/mtime (and even coarse header+tail bytes) unchanged,
  // so a header+tail sample alone can miss the rewrite and serve a stale
  // cached timeline. Session WALs are small, so hash the whole sidecar
  // (up to 8 MiB); larger WALs fall back to the structural frame token
  // (header checkpoint/salt words, derived frame count, last frame header).
  try {
    if (size < 32) return "";
    if (size <= 8 * 1024 * 1024) {
      const buf = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const n = readSync(fd, buf, read, size - read, read);
        if (n <= 0) break;
        read += n;
      }
      if (read !== size) return "";
      return `:walhash:${createHash("sha256").update(buf).digest("hex")}`;
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

function candidateDbSnapshotKey(
  candidates: readonly string[],
  storedItems: readonly Item[],
  storedUnits: readonly StoredUnitRow[],
): string {
  const dbPart = candidates
    .map((p) => `${resolve(p)}=${fileChangeToken(p, true)}|${fileChangeToken(`${p}-wal`, false)}`)
    .join(";");
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

export function hasHermesSession(home: string, profile: string, sessionId: string): boolean {
  if (!sessionId || /[\\/:]/.test(sessionId)) return false;
  for (const dbPath of candidateHermesDbs(home, profile)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      let found = false;
      try {
        found = Boolean(db.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(sessionId));
      } catch {
        // Ignore missing sessions table in malformed/partial DBs.
      }
      if (!found && tableColumns(db, "sessions").has("parent_session_id")) {
        try {
          found = Boolean(
            db.prepare("SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore missing parent_session_id or unreadable sessions table.
        }
      }
      if (!found) {
        try {
          found = Boolean(
            db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore missing messages table.
        }
      }
      if (found) return true;
    } catch {
      // Ignore unreadable or busy candidate DBs and try next candidate.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
  return false;
}

type HermesActiveRow = {
  role: string;
  content: string | null;
  codex_message_items: string | null;
};

/**
 * Count the payload message slots a DB row occupies (P0-2). This mirrors the
 * emission logic in loadHermesTimeline exactly: user rows always consume one
 * slot, assistant rows consume one slot per message sub-item (codex) or one
 * slot for plain/codex-mode content, and tool rows consume none. Positions
 * are counted over the FULL active row array so msg: unit IDs match the
 * payload.py full-payload p{N} numbering even when the chunk slice drops
 * pre-summary rows. The `compacted` flag only affects display, not numbering.
 */
function countHermesMessageSlots(row: HermesActiveRow, isCodexMode: boolean): number {
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
        // Fall through to messages probe when sessions table is absent/unreadable.
      }
      let hasSession = Boolean(sessionRow?.id);
      if (!hasSession && hasParentSessionId) {
        try {
          hasSession = Boolean(
            db.prepare("SELECT 1 FROM sessions WHERE parent_session_id = ? LIMIT 1").get(sessionId),
          );
        } catch {
          // Ignore sessions query errors.
        }
      }
      if (!hasSession) {
        try {
          hasSession = Boolean(
            db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1").get(sessionId),
          );
        } catch {
          // Session not matched in unreadable messages table; try next candidate.
        }
      }
      if (!hasSession) continue;
      matchedInThisDb = true;

      let targetSessionId = sessionId;
      if (hasParentSessionId) {
        // A1: not every parent_session_id child is a compaction rotation —
        // ACP forks, subagent runs and empty child shells also link back to
        // the parent. Following any newest child lets a non-rotation child
        // hijack the parent outline. Disambiguate per hop:
        // - a single child keeps legacy blind-follow behavior (rotation
        //   chains whose intermediate sessions carry no active rows);
        // - with several children (a fork), only a live child carrying a
        //   compaction summary (_compressed_summary=1) counts as the
        //   rotation successor; otherwise the walk stops;
        // - after the walk, an empty final target falls back to the deepest
        //   walked session with active messages, so an empty child shell
        //   never hijacks a parent that still owns the latest content.
        const database: DatabaseSync = db;
        const visited = new Set<string>([targetSessionId]);
        const path = [targetSessionId];
        const childStmt = database.prepare(
          hasStartedAt
            ? "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC, rowid DESC"
            : "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY rowid DESC",
        );
        const hasLiveMessages = (id: string): boolean => {
          try {
            return Boolean(
              database.prepare("SELECT 1 FROM messages WHERE session_id = ? AND active = 1 LIMIT 1").get(id),
            );
          } catch {
            return false;
          }
        };
        const hasRotationSummary = (id: string): boolean => {
          if (!hasCompressedSummary) return false;
          try {
            return Boolean(
              database
                .prepare(
                  "SELECT 1 FROM messages WHERE session_id = ? AND active = 1 AND _compressed_summary = 1 LIMIT 1",
                )
                .get(id),
            );
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
      }
      if (targetSessionId !== sessionId) {
        try {
          const targetRow = db
            .prepare("SELECT id, model_config FROM sessions WHERE id = ?")
            .get(targetSessionId) as { id?: string; model_config?: string | null } | undefined;
          // A2: always prefer the rotation child's own row. Inheriting the
          // parent row when the child model_config is null/empty surfaces
          // the parent's pre-compaction _usage_anchor (stale used_tokens
          // gauge). A child without config simply reports no anchor.
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

      // P1-4: pre-count guard runs before materializing the whole session so
      // an oversized chunk fails fast with history_too_large instead of OOMing.
      const activeCount = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND active = 1")
        .get(targetSessionId) as { n?: number } | undefined;
      if ((activeCount?.n ?? 0) > MAX_HISTORY_ROWS) {
        throw new HistoryTooLargeError(
          `hermes session chunk exceeds ${MAX_HISTORY_ROWS} active rows (${activeCount?.n})`,
        );
      }
      const rawDbRows = db
        .prepare(
          `SELECT id, role, content, tool_call_id, tool_calls, tool_name,
                  codex_message_items, api_content, compacted,
                  ${hasCompressedSummary ? "_compressed_summary" : "0 AS _compressed_summary"}
           FROM messages
           WHERE session_id = ? AND active = 1
           ORDER BY id ASC`,
        )
        .all(targetSessionId) as Array<{
        id: number;
        role: string;
        content: string | null;
        tool_call_id: string | null;
        tool_calls: string | null;
        tool_name: string | null;
        codex_message_items: string | null;
        api_content: string | null;
        compacted: number;
        _compressed_summary: number;
      }>;
      // P1-1: when several compactions exist, the latest summary wins; rows
      // before it belong to prior chunks.
      const summaryIndex = rawDbRows.findLastIndex((row) => Number(row._compressed_summary ?? 0) === 1);
      const chunkStart = summaryIndex > 0 ? summaryIndex : 0;
      const dbRows = chunkStart > 0 ? rawDbRows.slice(chunkStart) : rawDbRows;
      if (dbRows.length > MAX_HISTORY_ROWS) {
        throw new HistoryTooLargeError(
          `hermes session chunk exceeds ${MAX_HISTORY_ROWS} active rows (${dbRows.length})`,
        );
      }

      const calls = new Map<string, { name: string; rawArgs: unknown; parsedArgs: unknown; index: number }>();
      const duplicate = new Set<string>();
      const resultCounts = new Map<string, number>();
      const rowResultPos = new Map<number, number>();

      dbRows.forEach((row, index) => {
        if (row.role === "assistant" && typeof row.tool_calls === "string" && row.tool_calls.trim()) {
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
                let parsedArgs: unknown = rawArgs;
                if (typeof rawArgs === "string") {
                  try {
                    parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
                  } catch {
                    parsedArgs = rawArgs;
                  }
                }
                if (calls.has(cid)) duplicate.add(cid);
                else calls.set(cid, { name: fnName, rawArgs, parsedArgs, index });
              }
            }
          } catch {
            // Ignore malformed tool_calls JSON.
          }
        } else if (row.role === "tool" && typeof row.tool_call_id === "string") {
          const cid = row.tool_call_id.trim();
          if (cid) {
            const pos = resultCounts.get(cid) ?? 0;
            rowResultPos.set(index, pos);
            resultCounts.set(cid, pos + 1);
          }
        }
      });

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

      const resolveMsgUnitId = (role: "user" | "assistant", pos: number, wireContent: unknown): string => {
        const serialized =
          typeof wireContent === "string" ? wireContent : pythonSortedJson(wireContent);
        const computed = `msg:${role}:p${pos}:${sha256(serialized).slice(0, 12)}`;
        if (exactUnitIds.has(computed)) return computed;
        const candidates = unitsByRolePos.get(`${role}:p${pos}`);
        if (candidates && candidates.length > 0) {
          const hidden = candidates.find((u) => u.visibility === "hidden");
          if (hidden) return String(hidden.unit_id);
          const sorted = [...candidates].sort(
            (a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0),
          );
          return String(sorted[0].unit_id);
        }
        return computed;
      };

      const records = new Map<string, HermesExtendedRecord>();
      const rows: Record<string, any>[] = [];
      let totalRecordBytes = 0;
      let recordsCapped = false;
      // P0-2: msg: unit IDs follow payload.py full-payload p{N} numbering, so
      // slots are counted over the full active row array (including rows
      // before the compaction slice); pre-summary messages keep their slots.
      const preChunkCodexMode = apiMode === "codex_responses";
      let msgPos = 0;
      for (let pre = 0; pre < chunkStart; pre++) {
        msgPos += countHermesMessageSlots(rawDbRows[pre], preChunkCodexMode);
      }
      // P1-3: collapse duplicate compaction summaries (same full text as the
      // flagged _compressed_summary row) instead of showing them twice. Only
      // summary text participates; distinct messages never merge.
      const lastSummaryRawIndex = summaryIndex;
      let canonicalSummaryKey: string | null = null;
      let canonicalSummaryRowIndex = -1;
      const emitMessageRow = (
        row: Record<string, any>,
        fullText: string,
        isFlaggedSummary: boolean,
      ): void => {
        if (isFlaggedSummary && canonicalSummaryKey === null) {
          canonicalSummaryKey = summaryDedupeKey(fullText);
          canonicalSummaryRowIndex = rows.length;
          rows.push(row);
          return;
        }
        if (canonicalSummaryKey !== null && summaryDedupeKey(fullText) === canonicalSummaryKey) {
          const kept = rows[canonicalSummaryRowIndex];
          if (kept) {
            if (row.manageable && !kept.manageable) {
              rows[canonicalSummaryRowIndex] = row;
            } else {
              kept.manageable = Boolean(kept.manageable || row.manageable);
              if (
                typeof kept.item_id === "string" &&
                kept.item_id.startsWith("hist_") &&
                typeof row.item_id === "string" &&
                row.item_id.startsWith("msg:")
              ) {
                kept.item_id = row.item_id;
              }
            }
          }
          return;
        }
        rows.push(row);
      };

      for (let index = dbRows.length - 1; index >= 0; index--) {
        const row = dbRows[index];
        if (row.role !== "tool") continue;
        const callId = (row.tool_call_id ?? "").trim();
        const found = calls.get(callId);
        const toolName = row.tool_name || found?.name || "tool";
        if (
          !callId ||
          duplicate.has(callId) ||
          resultCounts.get(callId) !== 1 ||
          !found ||
          found.index >= index ||
          found.name !== toolName
        ) {
          continue;
        }
        const filtered = hermesFilterInvocation(toolName, found.rawArgs);
        if (!filtered) continue;
        const text = row.content ?? "";
        const size = bytes(text);
        const resultPos = rowResultPos.get(index) ?? 0;
        if (totalRecordBytes + size <= MAX_HERMES_RECORD_BYTES && records.size < MAX_HERMES_RECORDS) {
          totalRecordBytes += size;
          const digest = invocationDigest(filtered.invocation, filtered.omitted);
          records.set(callId, {
            call_id: callId,
            content: text,
            content_sha256: sha256(text),
            invocation: filtered.invocation,
            invocation_digest: digest,
            result_position: resultPos,
            status: "ok",
            ...(filtered.omitted ? { options_omitted: true } : {}),
          });
        } else {
          recordsCapped = true;
        }
      }

      const isCodexMode = apiMode === "codex_responses";
      dbRows.forEach((row, index) => {
        const isUncompacted = Number(row.compacted ?? 0) === 0;
        if (row.role === "user") {
          const displayText = row.content ?? row.api_content ?? "";
          let rowId = `hist_user_${row.id}`;
          if (isUncompacted) {
            const rawApi = row.api_content !== null ? row.api_content : (row.content ?? "");
            const wireContent = isCodexMode ? [{ text: rawApi, type: "input_text" }] : rawApi;
            rowId = resolveMsgUnitId("user", msgPos, wireContent);
          }
          // Slot counting covers the full active array (P0-2); only the unit
          // ID stays gated on the row being uncompacted.
          msgPos += 1;
          if (displayText.trim()) {
            emitMessageRow(
              {
                item_id: rowId,
                tool_call_id: "",
                kind: "user",
                tool_name: "user",
                summary_line: summaryLine(displayText),
                message_text: preview(displayText),
                bytes_size: bytes(displayText),
                manageable: isUncompacted,
              },
              displayText,
              chunkStart + index === lastSummaryRawIndex,
            );
          }
          return;
        }

        if (row.role === "assistant") {
          let handledViaCodexItems = false;
          if (typeof row.codex_message_items === "string" && row.codex_message_items.trim()) {
            try {
              const items = JSON.parse(row.codex_message_items);
              if (Array.isArray(items) && items.length > 0) {
                for (let subIdx = 0; subIdx < items.length; subIdx++) {
                  const it = items[subIdx];
                  if (!it || typeof it !== "object" || (it.type ?? "message") !== "message" || it.role !== "assistant") {
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
                              p && typeof p === "object" && typeof p.text === "string" ? p.text : "",
                            )
                            .join("")
                        : "";
                  let rowId = `hist_ast_${row.id}_${subIdx}`;
                  if (isUncompacted) {
                    rowId = resolveMsgUnitId("assistant", msgPos, ic);
                  }
                  msgPos += 1;
                  if (text.trim()) {
                    emitMessageRow(
                      {
                        item_id: rowId,
                        tool_call_id: "",
                        kind: "assistant",
                        tool_name: "assistant",
                        summary_line: summaryLine(text),
                        message_text: preview(text),
                        bytes_size: bytes(text),
                        manageable: isUncompacted,
                      },
                      text,
                      chunkStart + index === lastSummaryRawIndex,
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
                let rowId = `hist_ast_${row.id}`;
                if (isUncompacted) {
                  const wireContent = [{ text, type: "output_text" }];
                  rowId = resolveMsgUnitId("assistant", msgPos, wireContent);
                }
                msgPos += 1;
                if (text.trim()) {
                  emitMessageRow(
                    {
                      item_id: rowId,
                      tool_call_id: "",
                      kind: "assistant",
                      tool_name: "assistant",
                      summary_line: summaryLine(text),
                      message_text: preview(text),
                      bytes_size: bytes(text),
                      manageable: isUncompacted,
                    },
                    text,
                    chunkStart + index === lastSummaryRawIndex,
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
              let rowId = `hist_ast_${row.id}`;
              if (isUncompacted) {
                rowId = resolveMsgUnitId("assistant", msgPos, wireContent);
              }
              msgPos += 1;
              if (text.trim()) {
                emitMessageRow(
                  {
                    item_id: rowId,
                    tool_call_id: "",
                    kind: "assistant",
                    tool_name: "assistant",
                    summary_line: summaryLine(text),
                    message_text: preview(text),
                    bytes_size: bytes(text),
                    manageable: isUncompacted,
                  },
                  text,
                  chunkStart + index === lastSummaryRawIndex,
                );
              }
            }
          }
          return;
        }

        if (row.role !== "tool") return;
        const callId = (row.tool_call_id ?? "").trim();
        const resultPos = rowResultPos.get(index) ?? 0;
        const found = calls.get(callId);
        const toolName = row.tool_name || found?.name || "tool";
        const text = row.content ?? "";
        const storedItem = callId
          ? storedByCallPos.get(`${callId}\0${resultPos}`)
          : undefined;
        const record = callId ? records.get(callId) : undefined;

        const resolvedItemId = storedItem
          ? storedItem.item_id
          : record
            ? itemId(effectiveScope, callId, record.content_sha256, record.invocation_digest, record.result_position)
            : `display_hermes_${row.id}`;

        rows.push({
          item_id: resolvedItemId,
          tool_call_id: callId,
          tool_name: toolName,
          kind: "tool",
          manageable: Boolean(storedItem || record),
          source: record ? "unrecorded" : "display_only",
          summary_line: formatToolSummary(toolName, text) || `[${toolName}]`,
          bytes_size: bytes(text),
          ...(found?.parsedArgs !== undefined ? { tool_input: preview(found.parsedArgs) } : {}),
          tool_output: preview(text),
        });
      });

      const history: History = {
        messages: [],
        boundaries: [],
        injected: [],
        chunkStart: 0,
        effectiveScope,
        // The session matched, so this timeline authoritatively represents
        // the latest chunk even when it yields zero rows (P1-2: never
        // backfill an empty valid chunk with stale targets/items).
        chunkAuthoritative: true,
        ...(usedTokens
          ? {
              externalContext: {
                used_tokens: usedTokens,
                max_tokens: null,
                source: "hermes_session_usage",
              },
            }
          : {}),
      };
      if (recordsCapped) {
        (history as any).recordsCapped = true;
      }
      const built: Timeline = { rows, records, history };
      hermesTimelineCache.delete(cacheKey);
      hermesTimelineCache.set(cacheKey, { snapshot, timeline: built });
      while (hermesTimelineCache.size > MAX_HERMES_TIMELINE_CACHE) {
        hermesTimelineCache.delete(hermesTimelineCache.keys().next().value!);
      }
      return cloneTimeline(built);
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
      rows: [],
      records: new Map(),
      history: {
        messages: [],
        boundaries: [],
        injected: [],
        chunkStart: 0,
        readError: matchedReadError.error,
        readErrorDb: matchedReadError.dbPath,
      },
    };
  }
  return null;
}
