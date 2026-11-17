import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { formatToolSummary, preview, summaryLine, type History, type Timeline } from "./history.ts";

export type HermesExtendedRecord = RecordInput & { options_omitted?: boolean };

type StoredUnitRow = Record<string, unknown>;

const HERMES_FIELDS: Record<string, readonly string[]> = {
  terminal: ["command", "workdir"],
  read_file: ["path", "offset", "limit"],
  search_files: ["pattern", "target", "path", "file_glob"],
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
  },
};

const HERMES_REQUIRED: Record<string, string> = {
  terminal: "command",
  read_file: "path",
  search_files: "pattern",
};

const HERMES_INTERNAL: Record<string, true> = {
  hide_context: true,
  summarize_context: true,
  list_context_items: true,
  unhide_context: true,
  manage_context: true,
};

function pythonSortedJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonSortedJson).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}: ${pythonSortedJson(obj[k])}`)
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
  if (HERMES_INTERNAL[name] || !HERMES_FIELDS[name]) return null;

  let args: Record<string, unknown>;
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string") {
    try {
      const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      args = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const fieldSet = new Set(HERMES_FIELDS[name]);
  const defaults = HERMES_DEFAULTS[name];
  for (const key of Object.keys(args)) {
    if (fieldSet.has(key)) continue;
    if (name === "terminal" && key === "timeout") {
      const t = args.timeout;
      if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 1) return null;
      continue;
    }
    if (Object.hasOwn(defaults, key)) {
      const def = defaults[key];
      if (typeof args[key] !== typeof def || args[key] !== def) return null;
      continue;
    }
    return null;
  }

  const req = HERMES_REQUIRED[name];
  if (typeof args[req] !== "string" || !(args[req] as string).trim()) return null;

  const filtered: Record<string, Json> = {};
  for (const key of [...HERMES_FIELDS[name]].sort()) {
    if (!Object.hasOwn(args, key)) continue;
    const val = args[key];
    if (key === "offset" || key === "limit") {
      if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1) return null;
      filtered[key] = val;
    } else {
      if (typeof val !== "string") return null;
      filtered[key] = val;
    }
  }

  const omitted: Record<string, Json> = {};
  for (const [key, val] of Object.entries(args)) {
    if (!Object.hasOwn(filtered, key)) omitted[key] = val as Json;
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

function formatMessageSummaryLine(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<paseo-system")) {
    const titleMatch = /source-agent-title="([^"]+)"/.exec(trimmed);
    const eventMatch = /event="([^"]+)"/.exec(trimmed);
    const idMatch = /source-agent-id="([^"]+)"/.exec(trimmed);
    const label = titleMatch?.[1] ?? (idMatch?.[1] ? idMatch[1].slice(0, 8) : "subagent");
    const ev = eventMatch?.[1] ?? "notification";
    return `[Subagent ${ev}] ${label}`;
  }
  return summaryLine(text);
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

  for (const dbPath of candidateHermesDbs(home, profile)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const sessionRow = db
        .prepare("SELECT id, model_config FROM sessions WHERE id = ?")
        .get(sessionId) as { id?: string; model_config?: string | null } | undefined;
      if (!sessionRow?.id) continue;

      let apiMode = "chat_completions";
      let usedTokens: number | undefined;
      if (typeof sessionRow.model_config === "string" && sessionRow.model_config) {
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

      const dbRows = db
        .prepare(
          `SELECT id, role, content, tool_call_id, tool_calls, tool_name,
                  codex_message_items, api_content, compacted
           FROM messages
           WHERE session_id = ? AND active = 1
           ORDER BY id ASC`,
        )
        .all(sessionId) as Array<{
        id: number;
        role: string;
        content: string | null;
        tool_call_id: string | null;
        tool_calls: string | null;
        tool_name: string | null;
        codex_message_items: string | null;
        api_content: string | null;
        compacted: number;
      }>;

      const calls = new Map<string, { name: string; rawArgs: unknown; parsedArgs: unknown; index: number }>();
      const duplicate = new Set<string>();
      const resultCounts = new Map<string, number>();

      dbRows.forEach((row, index) => {
        if (row.role === "assistant" && typeof row.tool_calls === "string" && row.tool_calls.trim()) {
          try {
            const parsedCalls = JSON.parse(row.tool_calls);
            if (Array.isArray(parsedCalls)) {
              for (const entry of parsedCalls) {
                const cid =
                  typeof entry?.call_id === "string" && entry.call_id
                    ? entry.call_id
                    : typeof entry?.id === "string"
                      ? entry.id
                      : "";
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
        } else if (row.role === "tool" && typeof row.tool_call_id === "string" && row.tool_call_id) {
          resultCounts.set(row.tool_call_id, (resultCounts.get(row.tool_call_id) ?? 0) + 1);
        }
      });

      const storedByCallId = new Map<string, Item>();
      for (const item of storedItems) {
        if (!storedByCallId.has(item.tool_call_id)) {
          storedByCallId.set(item.tool_call_id, item);
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
      let msgPos = 0;

      dbRows.forEach((row, index) => {
        const isUncompacted = Number(row.compacted ?? 0) === 0;
        if (row.role === "user") {
          const displayText = row.content ?? row.api_content ?? "";
          let rowId = `hist_user_${row.id}`;
          if (isUncompacted) {
            const rawApi = row.api_content !== null ? row.api_content : (row.content ?? "");
            const wireContent =
              apiMode === "codex_responses" ? [{ text: rawApi, type: "input_text" }] : rawApi;
            rowId = resolveMsgUnitId("user", msgPos, wireContent);
            msgPos += 1;
          }
          if (displayText.trim()) {
            rows.push({
              item_id: rowId,
              tool_call_id: "",
              kind: "user",
              tool_name: "user",
              summary_line: formatMessageSummaryLine(displayText),
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
          if (!handledViaCodexItems && typeof row.content === "string" && row.content.length > 0) {
            const text = row.content;
            let rowId = `hist_ast_${row.id}`;
            if (isUncompacted) {
              const wireContent =
                apiMode === "codex_responses" ? [{ text, type: "output_text" }] : text;
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
          return;
        }

        if (row.role !== "tool") return;
        const callId = row.tool_call_id ?? "";
        const found = calls.get(callId);
        const toolName = row.tool_name || found?.name || "tool";
        const text = row.content ?? "";
        const storedItem = callId ? storedByCallId.get(callId) : undefined;
        let record: HermesExtendedRecord | undefined;

        if (
          callId &&
          !duplicate.has(callId) &&
          resultCounts.get(callId) === 1 &&
          found &&
          found.index < index &&
          found.name === toolName
        ) {
          const filtered = hermesFilterInvocation(toolName, found.rawArgs);
          if (filtered) {
            totalRecordBytes += bytes(text);
            if (totalRecordBytes <= 8 * 1024 * 1024 && records.size < 2000) {
              const digest = invocationDigest(filtered.invocation, filtered.omitted);
              record = {
                call_id: callId,
                content: text,
                content_sha256: sha256(text),
                invocation: filtered.invocation,
                invocation_digest: digest,
                result_position: 0,
                status: "ok",
                ...(filtered.omitted ? { options_omitted: true } : {}),
              };
              records.set(callId, record);
            }
          }
        }

        const resolvedItemId = storedItem
          ? storedItem.item_id
          : record
            ? itemId(scope, callId, record.content_sha256, record.invocation_digest, 0)
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
      return { rows, records, history };
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
  return null;
}
