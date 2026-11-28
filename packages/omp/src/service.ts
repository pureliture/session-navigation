import { randomUUID } from "node:crypto";
import {
  Engine,
  EngineError,
  Store,
  bytes,
  hasSummaryInjection,
  invocationDigest,
  itemId,
  safeNumber,
  length,
  normalizeKeepLines,
  pairUnitId,
  refusalReasonForRecord,
  renderCompaction,
  requiredEvidence,
  selectableText,
  sha256,
  splitLines,
  validateSummary,
  verifiedFacts,
  isDestructive,
  type Item,
  type Json,
  type RecordInput,
  type Result,
  type Row,
} from "../../core/src/index.ts";
import { ompInvocationArgs, safeString } from "./context.ts";
import { recordOmpPerf, sanitizeOmpErrorCode } from "./diagnostics.ts";

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

/**
 * First non-empty display field for hints. Mirrors the old
 * `String(a || b || ...)` order while never throwing on exotic values
 * (null-prototype objects, hostile toString), which used to surface as a
 * fatal db_error.
 */
function hintText(args: { [key: string]: Json }): string {
  const fields = [
    args.command,
    args.path,
    args.pattern,
    args.query,
    args.agentId,
    args.provider,
    args.terminalId,
    args.browserId,
  ];
  for (const field of fields) {
    if (!field) continue;
    const text = safeString(field);
    if (text) return text.slice(0, 160);
  }
  return "";
}

type StaticRecordMeta = {
  bytesSize: number;
  isDestructiveCall: boolean;
  staticRefusal: string | undefined;
};

const staticRecordMetaCache = new WeakMap<RecordInput, StaticRecordMeta>();

function getStaticRecordMeta(record: RecordInput): StaticRecordMeta {
  const cached = staticRecordMetaCache.get(record);
  if (cached) return cached;
  const computed: StaticRecordMeta = {
    bytesSize: bytes(record.content),
    isDestructiveCall: isDestructive(
      record.invocation.tool_name,
      record.invocation.arguments,
    ),
    staticRefusal: refusalReasonForRecord(record),
  };
  staticRecordMetaCache.set(record, computed);
  return computed;
}

export class OmpService {
  readonly engine: Engine;
  readonly snapshots = new Map<string, Snapshot>();
  private readonly instanceId = randomUUID();

  constructor(readonly store: Store) {
    this.engine = new Engine(store);
  }

  private isAdapterEnabled(): boolean {
    return this.store.getAdapterControl("omp")?.enabled ?? true;
  }

  async handle(method: string, params: unknown): Promise<Reply> {
    const started = performance.now();
    try {
      const reply = await this.dispatch(method, params);
      recordOmpPerf({
        op: method,
        duration_ms: performance.now() - started,
        ok: Boolean(reply.ok),
        ...(reply.ok ? {} : { error_code: sanitizeOmpErrorCode(reply.error ?? "error") }),
        ...(method === "prepare" && object(params) && Array.isArray(params.records)
          ? { unit_count: params.records.length, include_memory: true }
          : {}),
        ...(method === "manage" && Array.isArray(reply.items)
          ? { row_count: reply.items.length }
          : {}),
      });
      return reply;
    } catch (error) {
      recordOmpPerf({
        op: method,
        duration_ms: performance.now() - started,
        ok: false,
        error_code: sanitizeOmpErrorCode(error),
      });
      if (error instanceof EngineError)
        return { ok: false, error: error.code, choices: ["abort_request", "send_original"] };
      throw error;
    }
  }

  private async dispatch(method: string, params: unknown): Promise<Reply> {
    if (method === "ping") return { ok: true, protocol: 1 };
    if (method === "adapter_status") return { ok: true, enabled: this.isAdapterEnabled() };
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
    if (method === "record_summary_call") {
      if (typeof params.call_key !== "string" || !params.call_key || params.call_key.length > 256 ||
        ![params.prompt_tokens, params.completion_tokens, params.total_tokens].every(value => Number.isSafeInteger(value) && Number(value) >= 0) ||
        !(params.cost_usd === null || (typeof params.cost_usd === "number" && Number.isFinite(params.cost_usd) && params.cost_usd >= 0)))
        return { ok: false, error: "invalid_params" };
      this.store.recordCall(scope, params.call_key, Number(params.prompt_tokens), Number(params.completion_tokens), Number(params.total_tokens), params.cost_usd as number | null);
      return { ok: true };
    }
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
          safeString(params.item_id ?? ""),
          params.expected_version == null ? undefined : Number(params.expected_version),
        ),
      );
    }
    if (method === "apply_summary" || method === "summary_failed") {
      if (!this.isAdapterEnabled()) return { ok: false, error: "adapter_disabled" };
      return this.finishSummary(scope, method, params);
    }
    if (method === "list_items") return this.listItems(scope, session, params);
    if (method === "list_candidates") return this.listCandidates(scope, session, params);
    if (method === "manage") {
      if (!this.isAdapterEnabled()) return { ok: false, error: "adapter_disabled" };
      return this.manage(scope, session, params);
    }
    if (method === "compact" || method === "summarize" || method === "summary_state") {
      if (!this.isAdapterEnabled()) return { ok: false, error: "adapter_disabled" };
      return this.compact(scope, session, method, params);
    }
    return { ok: false, error: "unknown_method" };
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
      typeof tool_name !== "string" ||
      (raw.status ?? "ok") !== "ok" ||
      !Number.isSafeInteger(position)
    )
      return;
    const args = ompInvocationArgs(tool_name, raw.arguments);
    if (!args) return;
    const invocation = {
      tool_name,
      arguments: args as { [key: string]: Json },
    };
    return {
      call_id,
      content,
      content_sha256: safeString(raw.content_sha256) || sha256(content),
      invocation,
      invocation_digest: invocationDigest(invocation),
      status: "ok",
      result_position: Number(position),
    };
  }

  private register(scope: string, params: Record<string, unknown>, enabled = this.isAdapterEnabled()): void {
    this.store.register(scope, {
      adapter_id: "omp", adapter_protocol: 1,
      capabilities: { hide: true, summarize: true, unhide: true },
      enabled, instance_id: this.instanceId,
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
    const enabled = this.isAdapterEnabled();
    this.adoptLegacySession(scope, session);
    this.register(scope, params, enabled);
    const includeCandidates = params.include_candidates !== false;
    const isChildScope = Boolean(this.store.registration(scope)?.parent_scope);
    const needsIdentities = enabled && (isChildScope || includeCandidates);
    const identities = needsIdentities
      ? this.store.identitiesForScope(scope)
      : undefined;
    const visibilityMap = needsIdentities
      ? this.store.itemVisibilityMap(scope)
      : undefined;
    if (enabled) {
      if (isChildScope && identities && visibilityMap)
        this.store.publishTargets(scope, [...selected.values()]
          .filter((record) => {
            const meta = getStaticRecordMeta(record);
            return (
              !meta.staticRefusal &&
              !meta.isDestructiveCall &&
              !this.identityErrorWithMaps(scope, record, identities, visibilityMap)
            );
          })
          .map((record) => ({ record })));
      if (selected.size > 0) {
        const units: Array<Row & { unit_id: string }> = [];
        for (const record of selected.values()) {
          units.push({
            unit_id: pairUnitId(scope, record.call_id, record.content_sha256),
            kind: "tool_result",
            tool_call_id: record.call_id,
            content_sha256: record.content_sha256,
            char_count: length(record.content),
          });
        }
        this.store.upsertUnits(scope, units);
      }
    }
    for (const [callId, record] of selected) previous.set(callId, record);
    this.snapshots.set(session, { token, records: previous });
    const evicted: string[] = [];
    while (this.snapshots.size > MAX_SCOPES) {
      const oldest = this.snapshots.keys().next().value!;
      this.snapshots.delete(oldest);
      evicted.push(oldest);
    }
    const hiddenProjection = this.store.hiddenItemsForProjection(scope);
    const patches = [];
    const pending = [];
    for (const record of selected.values()) {
      const item = hiddenProjection.get(identity(scope, record));
      if (!item) continue;
      patches.push({
        call_id: record.call_id,
        sha256: record.content_sha256,
        text: item.compacted,
      });
      if (enabled && item.compaction_source === "summarize_pending")
        pending.push({
          item_id: item.item_id,
          call_id: record.call_id,
          version: item.version,
          content: record.content,
        });
    }
    const candidates = !enabled || isChildScope || !includeCandidates
      ? { total: 0, total_bytes: 0, candidate_ids: [] as string[], items: [] }
      : this.candidateSnapshot(
          scope,
          previous.values(),
          previous.size,
          undefined,
          false,
          identities,
          visibilityMap,
        );
    return {
      ok: true,
      patches,
      hidden_messages: this.store.hiddenMessages(scope),
      pending_summaries: pending,
      ...(!enabled ? { adapter_enabled: false } : {}),
      ...(candidates.total
        ? {
            eligible_count: candidates.total,
            eligible_bytes: candidates.total_bytes,
            candidate_ids: candidates.candidate_ids,
            reminder_items: candidates.items,
          }
        : {}),
      ...(evicted.length ? { evicted_snapshots: evicted } : {}),
    };
  }

  private confirmed(session: string, token: unknown): Snapshot | undefined {
    const snapshot = this.snapshots.get(session);
    return snapshot?.token === token ? snapshot : undefined;
  }

  private identityErrorWithMaps(
    scope: string,
    record: RecordInput,
    identities: ReadonlyMap<string, ReadonlySet<string>>,
    visibilityMap: ReadonlyMap<string, string>,
  ): string | undefined {
    const key = `${record.call_id}\0${record.content_sha256}\0${record.result_position}`;
    const digests = identities.get(key);
    if (digests && digests.size > 0 && !digests.has(record.invocation_digest)) {
      return "invocation_conflict";
    }
    if (!digests?.has(record.invocation_digest) && visibilityMap.has(identity(scope, record))) {
      return "identity_expired";
    }
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

  private cleanupError(scope: string, record: RecordInput, allowHidden = false): string | undefined {
    const conflict = this.identityError(scope, record);
    if (conflict) return conflict;
    if (!allowHidden && this.store.get(scope, identity(scope, record))?.visibility === "hidden")
      return "already_hidden";
    if (isDestructive(record.invocation.tool_name, record.invocation.arguments))
      return "destructive_command";
    return refusalReasonForRecord(record);
  }

  private cleanupErrorWithMaps(
    scope: string,
    record: RecordInput,
    allowHidden: boolean,
    identities: ReadonlyMap<string, ReadonlySet<string>>,
    visibilityMap: ReadonlyMap<string, string>,
  ): string | undefined {
    const conflict = this.identityErrorWithMaps(scope, record, identities, visibilityMap);
    if (conflict) return conflict;
    if (!allowHidden && visibilityMap.get(identity(scope, record)) === "hidden")
      return "already_hidden";
    const meta = getStaticRecordMeta(record);
    if (meta.isDestructiveCall)
      return "destructive_command";
    return meta.staticRefusal;
  }

  private listItems(scope: string, session: string, params: Record<string, unknown>): Reply {
    const query = safeString(params.query);
    const items = this.engine.listItems(scope, query);
    const rows: Record<string, unknown>[] = items.map((item) => ({
      ...item,
      call_id: item.tool_call_id,
      source: item.compaction_source,
      status: item.visibility,
      bytes_size: bytes(item.original),
      tokens_display: "—",
    }));
    if (this.isAdapterEnabled()) {
      const recorded = query
        ? new Set(
            this.store.driver
              .all("SELECT DISTINCT tool_call_id FROM items WHERE scope_key=?", [scope])
              .map((row) => String(row.tool_call_id ?? "")),
          )
        : new Set(items.map((item) => item.tool_call_id));
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
    }
    return { ok: true, items: rows };
  }

  private listCandidates(scope: string, session: string, params: Record<string, unknown>): Reply {
    if (!this.isAdapterEnabled()) {
      return { ok: true, total: 0, total_bytes: 0, candidate_ids: [], items: [] };
    }
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
    const snapshotOut = this.candidateSnapshot(
      scope,
      snapshot.records.values(),
      Number(limit),
      Array.isArray(wanted) ? wanted : undefined,
      params.include_hidden === true,
    );
    return {
      ok: true,
      ...snapshotOut,
    };
  }

  private candidateSnapshot(
    scope: string,
    records: Iterable<RecordInput>,
    limit: number,
    wanted?: readonly string[],
    includeHidden = false,
    identitiesArg?: ReadonlyMap<string, ReadonlySet<string>>,
    visibilityMapArg?: ReadonlyMap<string, string>,
  ) {
    const identities = identitiesArg ?? this.store.identitiesForScope(scope);
    const visibilityMap = visibilityMapArg ?? this.store.itemVisibilityMap(scope);
    const wantedSet = wanted ? new Set(wanted) : undefined;
    const filtered = [...records]
      .reverse()
      .filter(
        (record) =>
          (!wantedSet || wantedSet.has(record.call_id)) &&
          !this.cleanupErrorWithMaps(
            scope,
            record,
            includeHidden,
            identities,
            visibilityMap,
          ),
      );
    return {
      total: filtered.length,
      total_bytes: filtered.reduce((sum, record) => sum + getStaticRecordMeta(record).bytesSize, 0),
      candidate_ids: filtered.map((record) => record.call_id),
      items: filtered.slice(0, limit).map((record) => {
        const args = record.invocation.arguments as { [key: string]: Json };
        return {
          tool_call_id: record.call_id,
          tool_name: record.invocation.tool_name,
          hint: hintText(args),
          bytes_size: getStaticRecordMeta(record).bytesSize,
          tokens_display: "—",
        };
      }),
    };
  }

  private recordHint(record: RecordInput, maxLen = 64): string {
    const args = record.invocation.arguments as { [key: string]: Json };
    const raw = hintText(args)
      .replace(/\r?\n/g, " ")
      .trim();
    return raw.length <= maxLen ? raw : `${raw.slice(0, maxLen - 1)}…`;
  }

  private async apply(
    scope: string,
    record: RecordInput,
    summarize: boolean,
    text: unknown,
    keepLines?: unknown,
    expectedVersion?: unknown,
  ): Promise<Result> {
    const existing = this.store.get(scope, identity(scope, record));
    if (expectedVersion !== undefined && expectedVersion !== (existing?.version ?? 0))
      return { ok: false, error: "version_conflict" };
    if (!summarize) {
      const res = await this.engine.hide(
        scope,
        record,
        keepLines === undefined ? {} : { keep_lines: keepLines as Json },
      );
      if (!res.ok && res.error === "verification_failed" && !refusalReasonForRecord(record, this.engine.config)) {
        return this.explicitManageFallback(scope, record, undefined, keepLines, expectedVersion);
      }
      return res;
    }
    if (existing && ["llm", "llm_summary"].includes(existing.compaction_source))
      return this.engine.summarize(scope, record, async () => { throw new Error("cached summary"); });
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

  private applySequenceSummary(
    scope: string,
    record: RecordInput,
    summaryText: unknown,
    expectedVersion?: unknown,
    failureReason?: unknown,
  ): Result {
    const id = identity(scope, record);
    const existing = this.store.get(scope, id);
    if (expectedVersion !== undefined && expectedVersion !== (existing?.version ?? 0))
      return { ok: false, error: "version_conflict" };
    if (existing && ["llm", "llm_summary"].includes(existing.compaction_source)) {
      if (existing.visibility === "hidden") {
        return {
          ok: true,
          item: existing,
          plan: {
            item_id: id,
            tool_call_id: record.call_id,
            visibility_version: existing.version,
            expected_content_sha256: record.content_sha256,
            replacement_text: existing.compacted,
          },
        };
      }
      const restoredHidden: Item = { ...existing, visibility: "hidden", version: existing.version + 1 };
      const saved = this.store.put(scope, restoredHidden, existing.version, false);
      return saved.ok && saved.item
        ? {
            ok: true,
            item: saved.item,
            plan: {
              item_id: id,
              tool_call_id: record.call_id,
              visibility_version: saved.item.version,
              expected_content_sha256: record.content_sha256,
              replacement_text: saved.item.compacted,
            },
          }
        : saved;
    }
    if (typeof summaryText !== "string" || !summaryText.trim()) {
      return {
        ok: false,
        error: failureReason === "verification_failed" ? "verification_failed" : "summarizer_unavailable",
      };
    }
    const refused = refusalReasonForRecord(record, this.engine.config);
    if (refused) return { ok: false, error: refused };
    const trimmed = summaryText.trim();
    if (length(trimmed) > 1800 || hasSummaryInjection(trimmed)) {
      return { ok: false, error: "verification_failed" };
    }
    const facts = verifiedFacts(record.content);
    const req = requiredEvidence(record.content);
    const origBytes = bytes(record.content);
    let excerptLines: string[] = [];
    let compacted = renderCompaction(id, [], { summary: trimmed }, facts, false);
    if (req.length > 0 && req.length <= 8 && req.every((line) => length(line) <= 240)) {
      const withReq = renderCompaction(id, req, { summary: trimmed }, facts, false);
      if (bytes(withReq) <= origBytes * 0.8) {
        excerptLines = req;
        compacted = withReq;
      }
    }
    if (bytes(compacted) >= origBytes && trimmed.includes("\n[Sequence summary] ")) {
      const stepOnly = trimmed.split("\n[Sequence summary] ")[0];
      compacted = renderCompaction(id, [], { summary: stepOnly }, facts, false);
      excerptLines = [];
    }
    if (bytes(compacted) >= origBytes) {
      return { ok: false, error: "verification_failed" };
    }
    const nextItem: Item = {
      item_id: id,
      tool_call_id: record.call_id,
      result_position: record.result_position,
      content_sha256: record.content_sha256,
      invocation_digest: record.invocation_digest,
      original: record.content,
      compacted,
      excerpt_lines: excerptLines,
      visibility: "hidden",
      version: existing ? existing.version + 1 : 1,
      tool_name: String(record.invocation.tool_name),
      compaction_source: "llm",
      invocation_snapshot: record.invocation,
      context_hint: null,
      invocation_options_omitted: false,
      created_at: existing?.created_at ?? 0,
      updated_at: 0,
    };
    const saved = this.store.put(scope, nextItem, existing?.version, !existing);
    if (!saved.ok || !saved.item) return saved;
    return {
      ok: true,
      item: saved.item,
      plan: {
        item_id: id,
        tool_call_id: record.call_id,
        visibility_version: saved.item.version,
        expected_content_sha256: record.content_sha256,
        replacement_text: compacted,
      },
    };
  }

  private explicitManageFallback(
    scope: string,
    record: RecordInput,
    summaryText: unknown,
    keepLines: unknown,
    expectedVersion?: unknown,
  ): Result {
    if (keepLines !== undefined && !Array.isArray(keepLines))
      return { ok: false, error: "invalid_keep_lines" };
    const id = identity(scope, record);
    const existing = this.store.get(scope, id);
    if (expectedVersion !== undefined && expectedVersion !== (existing?.version ?? 0))
      return { ok: false, error: "version_conflict" };
    const source = selectableText(record.content);
    const lines = splitLines(source);
    const eligible = lines.flatMap((line, index) =>
      length(line) > 0 && length(line) <= 240 ? [index] : [],
    );
    if (!eligible.length) return { ok: false, error: "verification_failed" };
    const retention = Array.isArray(keepLines)
      ? normalizeKeepLines(record.content, keepLines as Json[])
      : { accepted: [], ignored: [], normalized: [] };
    const selected = [...new Set([...eligible.slice(0, 3), ...eligible.slice(-2)])];
    lines.forEach((line, index) => {
      if (
        length(line) <= 240 &&
        retention.accepted.some((part) => line.includes(part)) &&
        !selected.includes(index)
      ) {
        selected.push(index);
      }
    });
    selected.sort((left, right) => left - right);
    const excerptLines = selected.map((index) => lines[index]);
    const excerptBytes = excerptLines.reduce((sum, line) => sum + bytes(line) + 1, 0);
    if (excerptBytes > 3072) {
      return {
        ok: false,
        error: retention.accepted.length ? "keep_lines_too_broad" : "verification_failed",
        keep_lines_ignored: retention.ignored,
        keep_lines_normalized: retention.normalized,
      };
    }
    const facts = verifiedFacts(record.content);
    const validated =
      typeof summaryText === "string" && summaryText.trim()
        ? validateSummary(record.content, { summary: summaryText }, [], record.invocation)
        : undefined;
    const summaryRendered = validated
      ? renderCompaction(id, excerptLines, validated, facts, false)
      : undefined;
    const useSummary =
      !!summaryRendered && bytes(summaryRendered) <= bytes(record.content) * 0.8;
    const compacted = useSummary
      ? summaryRendered!
      : renderCompaction(id, excerptLines, undefined, facts, false);
    if (bytes(compacted) >= bytes(record.content)) {
      return {
        ok: false,
        error: "verification_failed",
        keep_lines_ignored: retention.ignored,
        keep_lines_normalized: retention.normalized,
      };
    }
    const nextItem: Item = {
      item_id: id,
      tool_call_id: record.call_id,
      result_position: record.result_position,
      content_sha256: record.content_sha256,
      invocation_digest: record.invocation_digest,
      original: record.content,
      compacted,
      excerpt_lines: excerptLines,
      visibility: "hidden",
      version: existing ? existing.version + 1 : 1,
      tool_name: String(record.invocation.tool_name),
      compaction_source: useSummary ? "llm" : "rule",
      invocation_snapshot: record.invocation,
      context_hint: null,
      invocation_options_omitted: false,
      created_at: existing?.created_at ?? 0,
      updated_at: 0,
    };
    const saved = this.store.put(scope, nextItem, existing?.version, !existing);
    if (!saved.ok || !saved.item) return saved;
    return {
      ok: true,
      item: saved.item,
      plan: {
        item_id: id,
        tool_call_id: record.call_id,
        visibility_version: saved.item.version,
        expected_content_sha256: record.content_sha256,
        replacement_text: compacted,
      },
      keep_lines_ignored: retention.ignored,
      keep_lines_normalized: retention.normalized,
    };
  }

  private async compact(
    scope: string,
    session: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Reply> {
    const snapshot = this.confirmed(session, params.snapshot_id);
    if (!snapshot) return { ok: false, error: "unconfirmed_snapshot" };
    const record = snapshot.records.get(safeString(params.tool_call_id));
    if (!record) return { ok: false, error: "not_found" };
    const conflict = this.identityError(scope, record);
    if (conflict) return { ok: false, error: conflict };
    if (method === "summary_state") {
      const error = this.cleanupError(scope, record, true);
      if (error) return { ok: false, error };
      const existing = this.store.get(scope, identity(scope, record));
      return { ok: true, cached: !!existing && ["llm", "llm_summary"].includes(existing.compaction_source), expected_version: existing?.version ?? 0 };
    }
    return mutationReply(
      await this.apply(scope, record, method === "summarize", params.summary_text, undefined, params.expected_version),
    );
  }

  private finishSummary(scope: string, method: string, params: Record<string, unknown>): Reply {
    const item = this.store.get(scope, safeString(params.item_id));
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
    if (!["auto", "hide", "summarize"].includes(safeString(action)))
      return { ok: false, error: "invalid_action" };
    const rawKeepLines = params.keep_lines;
    const normalizedKeepLines =
      rawKeepLines === null || (Array.isArray(rawKeepLines) && rawKeepLines.length === 0)
        ? undefined
        : rawKeepLines;
    if (normalizedKeepLines !== undefined && action !== "hide")
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
      const error = record ? this.cleanupError(scope, record, action === "summarize") : "not_found";
      if (!record || error) {
        items.push({
          tool_call_id: callId,
          ...(record ? { tool_name: record.invocation.tool_name } : {}),
          ok: false,
          error,
        });
        continue;
      }
      const text = object(summaries) ? summaries[callId] : undefined;
      const summarize =
        action === "summarize" || (action === "auto" && typeof text === "string" && !!text.trim());
      const versions = params.expected_versions;
      const expectedVersion = object(versions) ? versions[callId] : undefined;
      let result =
        summarize && params.sequence_verified === true
          ? this.applySequenceSummary(
              scope,
              record,
              text,
              expectedVersion,
              params.summary_failure,
            )
          : await this.apply(
              scope,
              record,
              summarize,
              text,
              normalizedKeepLines,
              expectedVersion,
            );
      if (!result.ok && result.error === "verification_failed" && action !== "summarize") {
        result = this.explicitManageFallback(
          scope,
          record,
          action === "auto" ? text : undefined,
          normalizedKeepLines,
          expectedVersion,
        );
      }
      const hint = this.recordHint(record);
      const savedItem =
        result.ok && result.plan
          ? (result.item ?? this.store.get(scope, result.plan.item_id))
          : undefined;
      const mode =
        savedItem && ["llm", "llm_summary"].includes(savedItem.compaction_source)
          ? "summarize"
          : "hide";
      items.push({
        tool_call_id: callId,
        tool_name: record.invocation.tool_name,
        ...(hint ? { hint } : {}),
        ok: result.ok,
        ...(result.ok
          ? {
              item_id: result.plan!.item_id,
              mode,
              compacted_bytes: bytes(result.plan!.replacement_text),
              original_bytes: bytes(record.content),
            }
          : { error: result.error ?? "not_found" }),
        ...(result.keep_lines_ignored?.length
          ? { keep_lines_ignored: result.keep_lines_ignored }
          : {}),
        ...(result.keep_lines_normalized?.length
          ? { keep_lines_normalized: result.keep_lines_normalized }
          : {}),
      });
    }
    const appliedItems = items.filter((item) => item.ok);
    const applied = appliedItems.length;
    const compactedBytes = appliedItems.reduce(
      (sum, item) => sum + (typeof item.compacted_bytes === "number" ? item.compacted_bytes : 0),
      0,
    );
    const originalBytes = appliedItems.reduce(
      (sum, item) => sum + (typeof item.original_bytes === "number" ? item.original_bytes : 0),
      0,
    );
    return {
      ok: applied === items.length,
      applied,
      failed: items.length - applied,
      compacted_bytes: compactedBytes,
      original_bytes: originalBytes,
      items,
    };
  }
}
