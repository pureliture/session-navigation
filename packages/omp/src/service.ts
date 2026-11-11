import { randomUUID } from "node:crypto";
import {
  Engine,
  EngineError,
  Store,
  bytes,
  invocationDigest,
  itemId,
  safeNumber,
  length,
  pairUnitId,
  refusalReason,
  requiredEvidence,
  sha256,
  validateSummary,
  isDestructive,
  type Json,
  type RecordInput,
  type Result,
  type Row,
} from "../../core/src/index.ts";

export const MAX_SCOPES = 32;
export const MAX_CHUNK_RECORDS = 64;
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export interface Reply {
  ok: boolean;
  error?: string | null;
  [key: string]: unknown;
}

interface Snapshot {
  token: string;
  records: Map<string, RecordInput>;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sessionScope(session: string): string {
  return `omp:default:${session}:default`;
}

function identity(scope: string, record: RecordInput): string {
  return itemId(
    scope,
    record.call_id,
    record.content_sha256,
    record.invocation_digest,
    record.result_position,
  );
}

function mutationReply(result: Result): Reply {
  return {
    ok: result.ok,
    error: result.error ?? null,
    item_id: result.plan?.item_id ?? result.item?.item_id ?? null,
    version: result.item?.version ?? null,
  };
}

export class OmpService {
  readonly engine: Engine;
  readonly snapshots = new Map<string, Snapshot>();
  private readonly instanceId = randomUUID();

  constructor(readonly store: Store) {
    this.engine = new Engine(store);
  }

  async handle(method: string, params: unknown): Promise<Reply> {
    try {
      if (method === "ping") return { ok: true, protocol: 1 };
      if (!object(params)) return { ok: false, error: "invalid_params" };
      if (method === "fork_scope") return this.fork(params);
      const session = params.session_id;
      if (
        typeof session !== "string" ||
        !session ||
        length(session) > 256 ||
        session.includes(":")
      ) {
        return { ok: false, error: "invalid_session" };
      }
      const scope = sessionScope(session);
      if (method === "register") {
        this.register(scope, params);
        return { ok: true };
      }
      if (method === "link_children") {
        if (typeof params.tool_call_id !== "string" || !params.tool_call_id ||
          !Array.isArray(params.subagent_ids) || params.subagent_ids.some((id) => typeof id !== "string"))
          return { ok: false, error: "invalid_params" };
        this.store.linkChildren(scope, params.tool_call_id, params.subagent_ids as string[]);
        return { ok: true };
      }
      if (method === "prepare") return this.prepare(scope, session, params);
      if (method === "restore") {
        if (
          params.expected_version !== undefined &&
          params.expected_version !== null &&
          !Number.isSafeInteger(params.expected_version)
        ) {
          return { ok: false, error: "invalid_version" };
        }
        return mutationReply(
          this.engine.unhide(
            scope,
            String(params.item_id ?? ""),
            params.expected_version == null ? undefined : Number(params.expected_version),
          ),
        );
      }
      if (method === "apply_summary" || method === "summary_failed")
        return this.finishSummary(scope, method, params);
      if (method === "list_items") return this.listItems(scope, session, params);
      if (method === "list_candidates") return this.listCandidates(scope, session, params);
      if (method === "manage") return this.manage(scope, session, params);
      if (method === "compact" || method === "summarize")
        return this.compact(scope, session, method, params);
      return { ok: false, error: "unknown_method" };
    } catch (error) {
      if (error instanceof EngineError)
        return { ok: false, error: error.code, choices: ["abort_request", "send_original"] };
      throw error;
    }
  }

  private fork(params: Record<string, unknown>): Reply {
    const source = params.src_session_id ?? params.source_session_id ?? params.src_scope_key;
    const destination =
      params.dst_session_id ?? params.destination_session_id ?? params.dst_scope_key;
    if (typeof source !== "string" || !source || typeof destination !== "string" || !destination)
      return { ok: false, error: "invalid_session" };
    return {
      ok: true,
      counts: this.store.fork(
        source.split(":").length >= 4 ? source : sessionScope(source),
        destination.split(":").length >= 4 ? destination : sessionScope(destination),
      ),
    };
  }

  private adoptLegacySession(scope: string, session: string): void {
    const legacy = `pi:default:${session}:default`;
    this.store.transaction(() => {
      const tables = [
        "adapter_sessions",
        "adapter_targets",
        "items",
        "identities",
        "units",
        "calls",
      ];
      if (
        tables.some((table) =>
          this.store.driver.get(`SELECT 1 FROM ${table} WHERE scope_key=? LIMIT 1`, [scope]),
        )
      )
        return;
      const itemIdentities = new Map<string, string>();
      for (const table of ["items", "identities", "units", "calls"]) {
        for (const row of this.store.driver.all(`SELECT * FROM ${table} WHERE scope_key=?`, [
          legacy,
        ])) {
          const copiedRow: Row = { ...row, scope_key: scope };
          if (table === "items") {
            copiedRow.item_id = itemId(
              scope,
              String(row.tool_call_id),
              String(row.content_sha256),
              String(row.invocation_digest),
              safeNumber(row.result_position),
            );
            itemIdentities.set(String(row.item_id), String(copiedRow.item_id));
          } else if (table === "identities") {
            copiedRow.item_id = itemIdentities.get(String(row.item_id)) ?? row.item_id;
          }
          const columns = Object.keys(copiedRow);
          this.store.driver.run(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            Object.values(copiedRow),
          );
        }
      }
    });
  }

  private parseRecord(
    raw: unknown,
    previous: Map<string, RecordInput>,
    selected: Map<string, RecordInput>,
  ): RecordInput | undefined {
    if (!object(raw) || !object(raw.arguments)) return;
    const { call_id, content, tool_name } = raw;
    const position = raw.result_position ?? 0;
    if (
      typeof call_id !== "string" ||
      !call_id ||
      previous.has(call_id) ||
      selected.has(call_id) ||
      typeof content !== "string" ||
      !["read", "bash"].includes(String(tool_name)) ||
      (raw.status ?? "ok") !== "ok" ||
      !Number.isSafeInteger(position)
    )
      return;
    const argument = tool_name === "read" ? raw.arguments.path : raw.arguments.command;
    if (typeof argument !== "string" || !argument.trim()) return;
    const invocation = {
      tool_name: tool_name as string,
      arguments: raw.arguments as { [key: string]: Json },
    };
    return {
      call_id,
      content,
      content_sha256: String(raw.content_sha256 || sha256(content)),
      invocation,
      invocation_digest: invocationDigest(invocation),
      status: "ok",
      result_position: Number(position),
    };
  }

  private register(scope: string, params: Record<string, unknown>): void {
    this.store.register(scope, {
      adapter_id: "omp", adapter_protocol: 1,
      capabilities: { hide: true, summarize: true, unhide: true },
      enabled: true, instance_id: this.instanceId,
      parent_scope: params.parent_scope as string | undefined,
      tool_call_id: params.tool_call_id as string | undefined,
      subagent_id: params.subagent_id as string | undefined,
    });
  }

  private prepare(scope: string, session: string, params: Record<string, unknown>): Reply {
    const token = params.snapshot_id;
    const append = params.append ?? false;
    const snapshot = this.snapshots.get(session);
    if (append === true && (!snapshot || snapshot.token !== token))
      return { ok: false, error: "unconfirmed_snapshot" };
    this.snapshots.delete(session);
    if (
      typeof append !== "boolean" ||
      typeof token !== "string" ||
      !Array.isArray(params.records) ||
      params.records.length > MAX_CHUNK_RECORDS
    )
      return { ok: false, error: "invalid_snapshot" };
    const previous = append ? snapshot!.records : new Map<string, RecordInput>();
    const selected = new Map<string, RecordInput>();
    let totalBytes = 0;
    for (const raw of params.records) {
      const record = this.parseRecord(raw, previous, selected);
      if (!record) return { ok: false, error: "invalid_record" };
      totalBytes += bytes(record.content);
      if (totalBytes > MAX_CHUNK_BYTES) return { ok: false, error: "snapshot_too_large" };
      selected.set(record.call_id, record);
    }
    this.adoptLegacySession(scope, session);
    this.register(scope, params);
    if (this.store.registration(scope)?.parent_scope)
      this.store.publishTargets(scope, [...selected.values()]
        .filter((record) => !refusalReason(record) &&
          !isDestructive(record.invocation.tool_name, record.invocation.arguments) &&
          !this.identityError(scope, record))
        .map((record) => ({ record })));
    for (const record of selected.values()) {
      this.store.upsertUnit(scope, {
        unit_id: pairUnitId(scope, record.call_id, record.content_sha256),
        kind: "tool_result",
        tool_call_id: record.call_id,
        content_sha256: record.content_sha256,
        char_count: length(record.content),
      });
    }
    for (const [callId, record] of selected) previous.set(callId, record);
    this.snapshots.set(session, { token, records: previous });
    const evicted: string[] = [];
    while (this.snapshots.size > MAX_SCOPES) {
      const oldest = this.snapshots.keys().next().value!;
      this.snapshots.delete(oldest);
      evicted.push(oldest);
    }
    const patches = [];
    const pending = [];
    for (const record of selected.values()) {
      const item = this.store.get(scope, identity(scope, record));
      if (item?.visibility !== "hidden") continue;
      patches.push({
        call_id: record.call_id,
        sha256: record.content_sha256,
        text: item.compacted,
      });
      if (item.compaction_source === "summarize_pending")
        pending.push({
          item_id: item.item_id,
          call_id: record.call_id,
          version: item.version,
          content: record.content,
        });
    }
    return {
      ok: true,
      patches,
      hidden_messages: this.store.hiddenMessages(scope),
      pending_summaries: pending,
      ...(evicted.length ? { evicted_snapshots: evicted } : {}),
    };
  }

  private confirmed(session: string, token: unknown): Snapshot | undefined {
    const snapshot = this.snapshots.get(session);
    return snapshot?.token === token ? snapshot : undefined;
  }

  private identityError(scope: string, record: RecordInput): string | undefined {
    const digests = this.store.driver.all(
      "SELECT invocation_digest FROM identities WHERE scope_key=? AND tool_call_id=? AND content_sha256=? AND result_position=?",
      [scope, record.call_id, record.content_sha256, record.result_position],
    );
    if (
      digests.length &&
      !digests.some((row) => row.invocation_digest === record.invocation_digest)
    )
      return "invocation_conflict";
    if (!this.store.fence(scope, record) && this.store.get(scope, identity(scope, record)))
      return "identity_expired";
  }

  private cleanupError(scope: string, record: RecordInput): string | undefined {
    const conflict = this.identityError(scope, record);
    if (conflict) return conflict;
    if (this.store.get(scope, identity(scope, record))?.visibility === "hidden")
      return "already_hidden";
    if (isDestructive(record.invocation.tool_name, record.invocation.arguments))
      return "destructive_command";
    return refusalReason(record);
  }

  private listItems(scope: string, session: string, params: Record<string, unknown>): Reply {
    const items = this.engine.listItems(
      scope,
      typeof params.query === "string" ? params.query : "",
    );
    const rows: Record<string, unknown>[] = items.map((item) => ({
      ...item,
      call_id: item.tool_call_id,
      source: item.compaction_source,
      status: item.visibility,
      bytes_size: bytes(item.original),
      tokens_display: "—",
    }));
    const recorded = new Set(this.engine.listItems(scope).map((item) => item.tool_call_id));
    for (const record of this.confirmed(session, params.snapshot_id)?.records.values() ?? []) {
      if (!recorded.has(record.call_id))
        rows.push({
          item_id: null,
          call_id: record.call_id,
          tool_call_id: record.call_id,
          content_sha256: record.content_sha256,
          visibility: "unhidden",
          status: "unhidden",
          version: 1,
          source: "unrecorded",
          bytes_size: bytes(record.content),
          tool_name: record.invocation.tool_name,
          tokens_display: "—",
        });
    }
    return { ok: true, items: rows };
  }

  private listCandidates(scope: string, session: string, params: Record<string, unknown>): Reply {
    const snapshot = this.confirmed(session, params.snapshot_id);
    if (!snapshot) return { ok: false, error: "unconfirmed_snapshot" };
    const limit = params.limit ?? 30;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200)
      return { ok: false, error: "invalid_limit" };
    const wanted = params.tool_call_ids;
    if (
      wanted !== undefined &&
      (!Array.isArray(wanted) || !wanted.every((id) => typeof id === "string"))
    )
      return { ok: false, error: "invalid_tool_call_ids" };
    const filtered = [...snapshot.records.values()]
      .reverse()
      .filter(
        (record) =>
          (!Array.isArray(wanted) || wanted.includes(record.call_id)) &&
          !this.cleanupError(scope, record),
      );
    return {
      ok: true,
      total: filtered.length,
      items: filtered.slice(0, Number(limit)).map((record) => {
        const args = record.invocation.arguments as { [key: string]: Json };
        return {
          tool_call_id: record.call_id,
          tool_name: record.invocation.tool_name,
          hint: String(args.command || args.path || "").slice(0, 160),
          bytes_size: bytes(record.content),
          tokens_display: "—",
        };
      }),
    };
  }

  private async apply(
    scope: string,
    record: RecordInput,
    summarize: boolean,
    text: unknown,
    keepLines?: unknown,
  ): Promise<Result> {
    if (!summarize)
      return this.engine.hide(
        scope,
        record,
        keepLines === undefined ? {} : { keep_lines: keepLines as Json },
      );
    if (typeof text !== "string" || !text.trim())
      return { ok: false, error: "summarizer_unavailable" };
    const validated = validateSummary(
      record.content,
      { summary: text },
      requiredEvidence(record.content),
      record.invocation,
    );
    if (!validated) return { ok: false, error: "verification_failed" };
    return this.engine.summarize(scope, record, async () => validated);
  }

  private async compact(
    scope: string,
    session: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Reply> {
    const snapshot = this.confirmed(session, params.snapshot_id);
    if (!snapshot) return { ok: false, error: "unconfirmed_snapshot" };
    const record = snapshot.records.get(String(params.tool_call_id));
    if (!record) return { ok: false, error: "not_found" };
    const conflict = this.identityError(scope, record);
    if (conflict) return { ok: false, error: conflict };
    return mutationReply(
      await this.apply(scope, record, method === "summarize", params.summary_text),
    );
  }

  private finishSummary(scope: string, method: string, params: Record<string, unknown>): Reply {
    const item = this.store.get(scope, String(params.item_id));
    if (!item || item.compaction_source !== "summarize_pending")
      return { ok: false, error: "not_found" };
    if (params.expected_version !== undefined && params.expected_version !== item.version)
      return { ok: false, error: "version_conflict" };
    const text = params.summary_text;
    if (method === "apply_summary" && (typeof text !== "string" || !text.trim()))
      return { ok: false, error: "summarizer_unavailable" };
    return mutationReply(
      this.engine.settlePending(
        scope,
        item.item_id,
        item.version,
        method === "apply_summary" ? (text as string) : undefined,
      ),
    );
  }

  private async manage(
    scope: string,
    session: string,
    params: Record<string, unknown>,
  ): Promise<Reply> {
    const wanted = params.tool_call_ids;
    if (wanted === undefined || (Array.isArray(wanted) && !wanted.length))
      return { ok: false, error: "tool_call_ids_required" };
    if (!Array.isArray(wanted) || !wanted.every((id) => typeof id === "string" && id.trim()))
      return { ok: false, error: "invalid_tool_call_ids" };
    const snapshot = this.confirmed(session, params.snapshot_id);
    if (!snapshot) return { ok: false, error: "unconfirmed_snapshot" };
    const action = params.action ?? "auto";
    if (!["auto", "hide", "summarize"].includes(String(action)))
      return { ok: false, error: "invalid_action" };
    if (params.keep_lines !== undefined && action !== "hide")
      return { ok: false, error: "invalid_keep_lines_action" };
    const summaries = params.summaries;
    if (
      summaries !== undefined &&
      (!object(summaries) || !Object.values(summaries).every((value) => typeof value === "string"))
    )
      return { ok: false, error: "invalid_summaries" };
    const items: Record<string, unknown>[] = [];
    for (const callId of new Set<string>(wanted)) {
      const record = snapshot.records.get(callId);
      const error = record ? this.cleanupError(scope, record) : "not_found";
      if (!record || error) {
        items.push({ tool_call_id: callId, ok: false, error });
        continue;
      }
      const text = object(summaries) ? summaries[callId] : undefined;
      const summarize =
        action === "summarize" || (action === "auto" && typeof text === "string" && !!text.trim());
      const result = await this.apply(scope, record, summarize, text, params.keep_lines);
      items.push({
        tool_call_id: callId,
        ok: result.ok,
        ...(result.ok ? { item_id: result.plan!.item_id } : { error: result.error ?? "not_found" }),
        ...(result.keep_lines_ignored?.length
          ? { keep_lines_ignored: result.keep_lines_ignored }
          : {}),
        ...(result.keep_lines_normalized?.length
          ? { keep_lines_normalized: result.keep_lines_normalized }
          : {}),
      });
    }
    const applied = items.filter((item) => item.ok).length;
    return { ok: applied === items.length, applied, failed: items.length - applied, items };
  }
}
