import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import {
  BatchMutationResultSchema,
  hideBatchRpc,
  unhideBatchRpc,
  dbChoiceRpc,
  forkScopeRpc,
  hideItemRpc,
  listItemsRpc,
  listScopesRpc,
  manageItemsRpc,
  summarizeItemRpc,
  unhideItemRpc,
  RowSchema,
} from "../shared/sessionNav";

type CliResult = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function invokeCli(args: string[]): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "session-navigation", args },
    { cmd: "python3", args: ["-m", "session_navigation.cli", ...args] },
    { cmd: "python", args: ["-m", "session_navigation.cli", ...args] },
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const stdout = execFileSync(attempt.cmd, attempt.args, {
        encoding: "utf8",
        env,
        timeout: 30000,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(String(stdout || "{}"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as CliResult)
        : {};
    } catch (error) {
      const stdout =
        typeof error === "object" && error !== null && "stdout" in error
          ? String((error as { stdout?: unknown }).stdout ?? "")
          : "";
      if (stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout);
          if (typeof parsed === "object" && parsed !== null) return parsed as CliResult;
        } catch {
          // Fall through and try the next invocation strategy.
        }
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("session-navigation CLI unavailable");
}

function asRow(item: unknown): z.infer<typeof RowSchema> {
  const obj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
  const rawKind = str(obj.kind);
  const kind = rawKind === "user" || rawKind === "assistant" || rawKind === "tool" ? rawKind : undefined;
  return {
    item_id: str(obj.item_id) ?? null,
    tool_call_id: str(obj.tool_call_id) ?? str(obj.call_id) ?? "",
    tool_name: str(obj.tool_name) ?? null,
    kind,
    status: (str(obj.status) ?? str(obj.visibility) ?? "hidden") as z.infer<typeof RowSchema>["status"],
    visibility:
      obj.visibility === "hidden" || obj.visibility === "visible"
        ? obj.visibility
        : undefined,
    version: num(obj.version) ?? 1,
    tokens_display: str(obj.tokens_display) ?? "—",
    cost_usd: num(obj.cost_usd) ?? null,
    source: str(obj.source) ?? str(obj.compaction_source),
    bytes_size: num(obj.bytes_size),
    summary_line: str(obj.summary_line),
    tool_input: str(obj.tool_input),
    tool_output: str(obj.tool_output),
  };
}

function dbErrorResponse(res: CliResult | undefined): { ok: false; error: string; choices?: string[] } {
  const code = str(res?.error) ?? "db_error";
  if (code === "db_error" || code === "db_full") {
    return { ok: false, error: code, choices: ["abort_request", "send_original"] };
  }
  return { ok: false, error: code };
}
// D9: per-scope DB-error decision. abort_request locks mutations; lists act as
// recovery probes (success clears the lock, failure keeps it). send_original
// permits exactly one read-only list under explicit user choice, then flips
// to abort (mutations stay locked). Never silent.
const dbDecisions = new Map<string, { choice: string; sendOriginalUsed: boolean }>();

function dbGate(scopeKey: string, opts?: { probe?: boolean }): { ok: false; error: string; choices: string[] } | null {
	const decision = dbDecisions.get(scopeKey);
	if (!decision) return null;
	if (decision.choice === "abort_request") {
		if (opts?.probe) return null;
		return { ok: false, error: "db_error", choices: ["abort_request", "send_original"] };
	}
	if (decision.choice === "send_original") {
		if (opts?.probe && !decision.sendOriginalUsed) {
			decision.sendOriginalUsed = true;
			return null;
		}
		return { ok: false, error: "db_error", choices: ["abort_request", "send_original"] };
	}
	return null;
}

function dbNoteSuccess(scopeKey: string): void {
	dbDecisions.delete(scopeKey);
}


function findAgentMappings(): {
  sessionToAgent: Map<string, string>;
  ompScopes: Array<{ scope_key: string; agent_id: string }>;
} {
  const sessionToAgent = new Map<string, string>(); // sessionId -> agentId
  const ompScopes: Array<{ scope_key: string; agent_id: string }> = [];
  try {
    const agentsDir = path.join(os.homedir(), ".paseo", "agents");
    if (!fs.existsSync(agentsDir)) return { sessionToAgent, ompScopes };
    const dirs = fs.readdirSync(agentsDir);
    for (const d of dirs) {
      const subPath = path.join(agentsDir, d);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(subPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const files = fs.readdirSync(subPath);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          try {
            const content = fs.readFileSync(path.join(subPath, f), "utf8");
            const data = JSON.parse(content);
            const agentId = typeof data.id === "string" ? data.id : f.replace(/\.json$/, "");
            const sessionId =
              typeof data.runtimeInfo?.sessionId === "string"
                ? data.runtimeInfo.sessionId
                : typeof data.persistence?.sessionId === "string"
                  ? data.persistence.sessionId
                  : undefined;
            const provider =
              typeof data.runtimeInfo?.provider === "string"
                ? data.runtimeInfo.provider
                : typeof data.persistence?.provider === "string"
                  ? data.persistence.provider
                  : undefined;
            const nativeHandle =
              typeof data.persistence?.nativeHandle === "string"
                ? data.persistence.nativeHandle
                : undefined;
            if (sessionId) {
              sessionToAgent.set(sessionId, agentId);
              if (
                (provider === "omp" || provider === "pi") &&
                (!nativeHandle || fs.existsSync(nativeHandle))
              ) {
                ompScopes.push({
                  scope_key: `pi:default:${sessionId}:default`,
                  agent_id: agentId,
                });
              }
            }
          } catch {
            // ignore malformed
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return { sessionToAgent, ompScopes };
}

export async function listScopes() {
  try {
    const res = invokeCli(["scopes"]);
    if (res.ok !== true) { const err = dbErrorResponse(res); return { ok: false as const, scopes: [], error: err.error, choices: err.choices }; }
    const { sessionToAgent: agentMap, ompScopes } = findAgentMappings();
    const scopes = Array.isArray(res.scopes) ? res.scopes.map((s: unknown) => {
      const o = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
      const scope_key = typeof o.scope_key === "string" ? o.scope_key : "";
      const parts = scope_key.split(":");
      const sessionId = parts.length >= 3 && parts[0] === "pi" ? parts[2] : parts[1] || "";
      const agent_id = sessionId ? agentMap.get(sessionId) : undefined;
      return {
        scope_key,
        items: typeof o.items === "number" ? o.items : 0,
        ...(agent_id ? { agent_id } : {}),
      };
    }).filter((s) => s.scope_key) : [];
    const seen = new Set(scopes.map((s) => s.scope_key));
    for (const omp of ompScopes) {
      if (!seen.has(omp.scope_key)) {
        seen.add(omp.scope_key);
        scopes.push({
          scope_key: omp.scope_key,
          items: 1,
          agent_id: omp.agent_id,
        });
      }
    }
    return { ok: true, scopes };
  } catch {
    return { ok: false, scopes: [], error: "db_error", choices: ["abort_request", "send_original"] };
  }
}


export async function listItems(input: RpcInput<typeof listItemsRpc>) {
	const gate = dbGate(input.scope_key, { probe: true });
	if (gate) return { ok: false, items: [], error: gate.error, choices: gate.choices };
  try {
    const res = invokeCli([
      "list",
      "--scope",
      input.scope_key,
      ...(input.query ? ["--query", input.query] : []),
    ]);
    if (res.ok !== true) {
      const err = dbErrorResponse(res);
      return { ok: false, items: [], error: err.error, choices: err.choices };
    }
    const items = Array.isArray(res.items) ? res.items.map(asRow) : [];
    // send_original one-shot flips to abort (mutations stay locked); a probe
    // list under abort that succeeds proves recovery and clears the lock.
    if (dbDecisions.get(input.scope_key)?.choice === "send_original") {
      dbDecisions.set(input.scope_key, { choice: "abort_request", sendOriginalUsed: true });
    } else {
      dbNoteSuccess(input.scope_key);
    }
    return { ok: true, items };
  } catch {
    return { ok: false, items: [], error: "db_error", choices: ["abort_request", "send_original"] };
  }
}

export async function hideItem(input: RpcInput<typeof hideItemRpc>) {
	const gate = dbGate(input.scope_key);
	if (gate) return gate;
  try {
    const res = invokeCli([
      "hide",
      "--scope",
      input.scope_key,
      "--item-id",
      input.item_id,
      ...(input.expected_version !== undefined
        ? ["--expected-version", String(input.expected_version)]
        : []),
      ...(input.mode ? ["--mode", input.mode] : []),
    ]);
    if (res.ok !== true) {
      if (str(res.error) === "version_conflict") {
        return {
          ok: false,
          error: "version_conflict",
          item: res.item ? asRow(res.item) : undefined,
        };
      }
      return dbErrorResponse(res);
    }
    dbNoteSuccess(input.scope_key);
    return {
      ok: true,
      item_id: str(res.item_id) ?? input.item_id,
      status: "hidden" as const,
      version: num(res.version),
    };
  } catch {
    return { ok: false, error: "db_error", choices: ["abort_request", "send_original"] };
  }
}

export async function unhideItem(input: RpcInput<typeof unhideItemRpc>) {
	const gate = dbGate(input.scope_key);
	if (gate) return gate;
  try {
    const res = invokeCli([
      "unhide",
      "--scope",
      input.scope_key,
      "--item-id",
      input.item_id,
      ...(input.expected_version !== undefined
        ? ["--expected-version", String(input.expected_version)]
        : []),
    ]);
    if (res.ok !== true) {
      if (str(res.error) === "version_conflict") {
        return {
          ok: false,
          error: "version_conflict",
          item: res.item ? asRow(res.item) : undefined,
        };
      }
      return dbErrorResponse(res);
    }
    const visibility = res.visibility === "hidden" ? "hidden" : "visible";
    return {
      ok: true,
      item_id: str(res.item_id) ?? input.item_id,
      status: visibility as "hidden" | "visible" | "unhidden",
      visibility: visibility as "hidden" | "visible",
      version: num(res.version),
    };
  } catch {
    return { ok: false, error: "db_error", choices: ["abort_request", "send_original"] };
  }
}

export async function summarizeItem(_input: RpcInput<typeof summarizeItemRpc>) {
  // D5: Paseo has no session model. Never report a rule hide as a summary.
  return { ok: false, error: "summarizer_unavailable" };
}

async function mutateBatch(
  command: "hide" | "unhide",
  input: RpcInput<typeof hideBatchRpc>,
) {
  const empty = { applied: 0, failed: 0, items: [] };
  const gate = dbGate(input.scope_key);
  if (gate) return { ...empty, ...gate };
  try {
    const res = invokeCli([
      command, "--scope", input.scope_key,
      "--items-json", JSON.stringify(input.items),
      ...(command === "hide" ? ["--mode", input.mode ?? "hide"] : []),
    ]);
    if (!Array.isArray(res.items)) return { ...empty, ...dbErrorResponse(res) };
    const result = BatchMutationResultSchema.parse(res);
    if (result.ok) dbNoteSuccess(input.scope_key);
    return result.error ? { ...result, ...dbErrorResponse(res) } : result;
  } catch {
    return { ...empty, ...dbErrorResponse(undefined) };
  }
}

export async function hideBatch(input: RpcInput<typeof hideBatchRpc>) {
  return mutateBatch("hide", input);
}

export async function unhideBatch(input: RpcInput<typeof unhideBatchRpc>) {
  return mutateBatch("unhide", input);
}

export async function manageItems(input: RpcInput<typeof manageItemsRpc>) {
	const gate = dbGate(input.scope_key);
	if (gate) return { ok: false, applied: 0, failed: 0, items: [], error: gate.error, choices: gate.choices };
  try {
    const res = invokeCli(["manage", "--scope", input.scope_key,
      "--action", input.action ?? "auto",
      "--max-items", String(input.max_items ?? 20)]);
    if (res.ok !== true && !Array.isArray(res.items)) {
      const err = dbErrorResponse(res);
      return { ok: false, applied: 0, failed: 0, items: [], error: err.error, choices: err.choices };
    }
    const items = Array.isArray(res.items) ? res.items.map((r: unknown) => {
      const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
      return {
        tool_call_id: typeof o.tool_call_id === "string" ? o.tool_call_id : "",
        ok: o.ok === true,
        error: typeof o.error === "string" ? o.error : undefined,
        item_id: typeof o.item_id === "string" ? o.item_id : undefined,
      };
    }) : [];
    const applied = typeof res.applied === "number" ? res.applied : items.filter((i) => i.ok).length;
    const failed = typeof res.failed === "number" ? res.failed : items.length - applied;
    if (res.ok === true) dbNoteSuccess(input.scope_key);
    return { ok: res.ok === true, applied, failed, items,
      ...(typeof res.error === "string" ? { error: res.error } : {}) };
  } catch {
    return { ok: false, applied: 0, failed: 0, items: [], error: "db_error", choices: ["abort_request", "send_original"] };
  }
}

export async function forkScope(input: RpcInput<typeof forkScopeRpc>) {
  try {
    const res = invokeCli(["fork-scope", input.src_scope_key, input.dst_scope_key]);
    if (res.ok !== true) return dbErrorResponse(res);
    const counts = typeof res.counts === "object" && res.counts !== null ? (res.counts as Record<string, number>) : undefined;
    return { ok: true, counts };
  } catch {
    return { ok: false, error: "db_error", choices: ["abort_request", "send_original"] };
  }
}

export async function dbChoice(input: RpcInput<typeof dbChoiceRpc>) {
	const scopeKey = typeof input.scope_key === "string" ? input.scope_key : "";
	dbDecisions.set(scopeKey, { choice: input.choice, sendOriginalUsed: input.choice !== "send_original" });
	return { ok: true };
}
