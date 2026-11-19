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

function fileChangeToken(filePath: string, isDb: boolean): string {
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
        const visited = new Set<string>([targetSessionId]);
        const childStmt = db.prepare(
          hasStartedAt
            ? "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC, rowid DESC"
            : "SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY rowid DESC",
        );
        for (let hop = 0; hop < 32; hop++) {
          const children = childStmt.all(targetSessionId) as Array<{ id?: unknown }>;
          const next = children.find(
            (row) => typeof row.id === "string" && row.id.length > 0 && !visited.has(row.id),
          );
          if (!next || typeof next.id !== "string") break;
          visited.add(next.id);
          targetSessionId = next.id;
        }
      }
      if (targetSessionId !== sessionId) {
        try {
          const targetRow = db
            .prepare("SELECT id, model_config FROM sessions WHERE id = ?")
            .get(targetSessionId) as { id?: string; model_config?: string | null } | undefined;
          if (targetRow?.model_config) {
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
      const summaryIndex = rawDbRows.findIndex((row) => Number(row._compressed_summary ?? 0) === 1);
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
      let msgPos = 0;

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
            msgPos += 1;
          }
          if (displayText.trim()) {
            rows.push({
              item_id: rowId,
              tool_call_id: "",
              kind: "user",
              tool_name: "user",
              summary_line: summaryLine(displayText),
              message_text: preview(displayText),
              bytes_size: bytes(displayText),
              manageable: isUncompacted,
            });
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
                    msgPos += 1;
                  }
                  if (text.trim()) {
                    rows.push({
                      item_id: rowId,
                      tool_call_id: "",
                      kind: "assistant",
                      tool_name: "assistant",
                      summary_line: summaryLine(text),
                      message_text: preview(text),
                      bytes_size: bytes(text),
                      manageable: isUncompacted,
                    });
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
                  msgPos += 1;
                }
                if (text.trim()) {
                  rows.push({
                    item_id: rowId,
                    tool_call_id: "",
                    kind: "assistant",
                    tool_name: "assistant",
                    summary_line: summaryLine(text),
                    message_text: preview(text),
                    bytes_size: bytes(text),
                    manageable: isUncompacted,
                  });
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
                msgPos += 1;
              }
              if (text.trim()) {
                rows.push({
                  item_id: rowId,
                  tool_call_id: "",
                  kind: "assistant",
                  tool_name: "assistant",
                  summary_line: summaryLine(text),
                  message_text: preview(text),
                  bytes_size: bytes(text),
                  manageable: isUncompacted,
                });
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
