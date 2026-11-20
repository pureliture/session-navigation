import { homedir } from "node:os";
import {
  Engine,
  EngineError,
  Store,
  bytes,
  itemId,
  sha256,
  length,
  splitLines,
  scopeAliases,
  selectRule,
  selectableText,
  evaluateCompaction,
  refusalReason,
  invocationDigest,
  isDestructive,
  type Item,
  type RecordInput,
  type Result,
} from "../../packages/core/src/index.ts";
import { bindAgents } from "./mapping.ts";
import { manualHideItem } from "./manualHide.ts";
import { HistoryTooLargeError } from "./historyLimits.ts";
import {
  acquireHermesToggleLock,
  inspectHermesToggle,
  setHermesToggleAcrossProfiles,
  type HermesRuntimeInspectionContext,
  type HermesRuntimeSessionInfo,
  type HermesWriteOptions,
} from "./adapterToggles.ts";
import {
  loadTimeline,
  measuredTokens,
  preview,
  summaryLine,
  type Message,
  type Timeline,
} from "./history.ts";

export interface Capabilities {
  display: boolean;
  hide: boolean;
  summarize: boolean;
  unhide: boolean;
  state:
    | "ready"
    | "adapter_not_detected"
    | "incompatible_protocol"
    | "adapter_disabled";
  hint?: string;
}
export interface Reply {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

type VerifiedTargetRecord = RecordInput & {
  item_id: string;
  options_omitted: boolean;
};

function isToolTimelineRow(row: Message): boolean {
  const kind =
    row.kind ??
    (row.tool_name === "user"
      ? "user"
      : row.tool_name === "assistant"
        ? "assistant"
        : "tool");
  return kind === "tool";
}

function effectiveRowBytesServer(row: Message): number {
  if (row.status === "hidden") {
    let post: number | undefined;
    if (typeof row.compacted_bytes_size === "number") {
      post = row.compacted_bytes_size;
    } else if (typeof row.replacement_text === "string") {
      post = bytes(row.replacement_text);
    } else if (
      row.kind === "user" ||
      row.kind === "assistant" ||
      row.kind === "agent"
    ) {
      post = 0;
    }
    if (post !== undefined) {
      const clamped = Math.max(0, post);
      return typeof row.bytes_size === "number"
        ? Math.min(Math.max(0, row.bytes_size), clamped)
        : clamped;
    }
  }
  return typeof row.bytes_size === "number" ? row.bytes_size : 0;
}

export class PaseoService {
  readonly engine: Engine;
  private readonly decisions = new Map<string, string>();
  hermesWriteOptions?: HermesWriteOptions;
  constructor(
    readonly store: Store,
    readonly home = homedir(),
  ) {
    this.engine = new Engine(store);
  }

  capabilities(scope: string): Capabilities {
    const registration = this.store.driver.get(
      "SELECT * FROM adapter_sessions WHERE scope_key=?",
      [scope],
    );
    const adapterId = scope.startsWith("hermes:")
      ? "hermes"
      : scope.startsWith("omp:")
        ? "omp"
        : null;
    const control = adapterId ? this.store.getAdapterControl(adapterId) : null;
    const state =
      !registration || scope.startsWith("pi:")
        ? "adapter_not_detected"
        : registration.adapter_protocol !== 1
          ? "incompatible_protocol"
          : !registration.enabled || (control !== null && !control.enabled)
            ? "adapter_disabled"
            : "ready";
    return {
      display: true,
      hide: state === "ready" && this.store.can(scope, "hide"),
      summarize: state === "ready" && this.store.can(scope, "summarize"),
      unhide:
        this.store.items(scope).some((item) => item.visibility === "hidden") ||
        this.store.hiddenMessages(scope).length > 0,
      state,
      ...(state === "adapter_not_detected"
        ? {
            hint: scope.startsWith("hermes:")
              ? "Install and enable the Session Navigation Hermes adapter."
              : "Install and enable @pureliture/session-navigation-omp in the session host.",
          }
        : state === "adapter_disabled" && scope.startsWith("hermes:")
          ? {
              hint: "Context management paused via DB control — updated protection-only sessions protect hidden items while older/frozen Hermes processes stay active until restarted (SQLite DB errors fail open per D9).",
            }
          : {}),
    };
  }

  private hermesRuntimeContext(): HermesRuntimeInspectionContext {
    const control = this.store.getAdapterControl("hermes");
    const hiddenScopeRows = this.store.driver.all(
      `SELECT DISTINCT scope_key FROM items WHERE scope_key LIKE 'hermes:%' AND visibility='hidden'
       UNION
       SELECT DISTINCT scope_key FROM units WHERE scope_key LIKE 'hermes:%' AND kind IN ('user', 'assistant') AND visibility='hidden'`,
    );
    const hiddenScopes = hiddenScopeRows.map((row) => String(row.scope_key));
    const regRows = this.store.driver.all(
      "SELECT * FROM adapter_sessions WHERE adapter_id='hermes' OR scope_key LIKE 'hermes:%' ORDER BY scope_key",
    );
    const registeredSessions: HermesRuntimeSessionInfo[] = regRows.map((row) => {
      let capabilities: Record<string, any> = {};
      try {
        const parsed = JSON.parse(String(row.capabilities ?? "{}"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          capabilities = parsed as Record<string, any>;
        }
      } catch {
        capabilities = {};
      }
      return {
        scope_key: String(row.scope_key),
        adapter_protocol: Number(row.adapter_protocol),
        capabilities,
        enabled: Boolean(row.enabled),
        last_seen: Number(row.last_seen),
      };
    });

    const knownKeys = new Set<string>([
      ...hiddenScopes,
      ...registeredSessions.map((r) => r.scope_key),
    ]);
    const initialBound: Array<{
      scope_key: string;
      items: number;
      capabilities: { state: string; unhide: boolean };
      agent_id?: string;
    }> = [...knownKeys].map((scopeKey) => ({
      scope_key: scopeKey,
      items: 0,
      capabilities: { state: "ready", unhide: false },
    }));
    const bound = bindAgents(this.home, initialBound, undefined, (scopeKey) =>
      this.capabilities(scopeKey),
    );
    const boundScopes = bound
      .filter((entry) => entry.scope_key.startsWith("hermes:") && Boolean(entry.agent_id))
      .map((entry) => entry.scope_key);

    return {
      control,
      hiddenScopes,
      registeredSessions,
      boundScopes,
      now: this.store.clock(),
    };
  }

  getAdapterToggles(): Reply {
    const ompEnabled = this.store.getAdapterControl("omp")?.enabled ?? true;
    const omp = {
      installed: true,
      enabled: ompEnabled,
      statusText: ompEnabled ? "Active" : "Paused (existing hidden items protected)",
    };
    const hermesCtrl = this.store.getAdapterControl("hermes");
    const hermes = inspectHermesToggle(
      this.home,
      hermesCtrl?.enabled,
      this.hermesRuntimeContext(),
    );
    return { ok: true, omp, hermes };
  }

  setAdapterToggle(input: Record<string, any>): Reply {
    const adapter = input?.adapter;
    const enabled = input?.enabled;
    if ((adapter !== "omp" && adapter !== "hermes") || typeof enabled !== "boolean") {
      return { ...this.getAdapterToggles(), ok: false, error: "invalid_params" };
    }
    if (adapter === "omp") {
      try {
        this.store.setAdapterControl("omp", enabled);
        return this.getAdapterToggles();
      } catch (err) {
        const dbCode = err instanceof EngineError ? err.code : "db_error";
        return { ...this.getAdapterToggles(), ok: false, error: dbCode };
      }
    }
    const lockRes = acquireHermesToggleLock(this.home);
    if (!lockRes.ok) {
      const current = this.getAdapterToggles();
      const lockErrorDetail =
        lockRes.error === "hermes_toggle_locked"
          ? "Hermes toggle is locked (~/.hermes/.session-navigation-toggle.lock). Wait for active toggles to finish, or if a previous process crashed, verify no toggle is running and remove ~/.hermes/.session-navigation-toggle.lock."
          : lockRes.error;
      return {
        ...current,
        ok: false,
        error: lockRes.error,
        ...(lockRes.error === "hermes_not_installed"
          ? {}
          : { hermes: { ...current.hermes, error: lockErrorDetail } }),
      };
    }
    try {
      const hermesCtrl = this.store.getAdapterControl("hermes");
      const preCheck = inspectHermesToggle(
        this.home,
        hermesCtrl?.enabled,
        this.hermesRuntimeContext(),
      );
      if (!preCheck.installed) {
        return {
          ...this.getAdapterToggles(),
          ok: false,
          error: preCheck.error ?? "hermes_not_installed",
          ...(preCheck.error ? { hermes: { ...preCheck, error: preCheck.error } } : {}),
        };
      }
      if (preCheck.error) {
        return {
          ...this.getAdapterToggles(),
          ok: false,
          error: preCheck.error,
          hermes: {
            ...preCheck,
            error: preCheck.error,
          },
        };
      }
      // Pausing Hermes updates shared SQLite adapter_control only while leaving config.yaml intact
      // (enabled) so legacy/duplicate/frozen Hermes processes never disable middleware protection.
      if (!enabled) {
        try {
          this.store.setAdapterControl("hermes", false);
          return this.getAdapterToggles();
        } catch (err) {
          const dbCode = err instanceof EngineError ? err.code : "db_error";
          return { ...this.getAdapterToggles(), ok: false, error: dbCode };
        }
      }
      const writeRes = setHermesToggleAcrossProfiles(this.home, true, {
        ...this.hermesWriteOptions,
        deferJournalClear: true,
        lockAlreadyHeld: true,
      });
      if (!writeRes.ok) {
        const current = this.getAdapterToggles();
        const detailError = writeRes.partialUpdate
          ? `Partial config update (${writeRes.error ?? "write_failed"}): rollback failed for ${writeRes.rollbackFailedFiles.join(", ")}. Reconcile profiles before retrying.`
          : writeRes.rolledBack
            ? `Update failed (${writeRes.error ?? "write_failed"}); rolled back ${writeRes.rolledBackFiles.length} modified file(s).`
            : (writeRes.error ?? "Failed to update Hermes config");
        return {
          ...current,
          ok: false,
          error: writeRes.partialUpdate
            ? `hermes_partial_update:${writeRes.error ?? "write_failed"}`
            : (writeRes.error ?? "hermes_toggle_failed"),
          hermes: {
            ...current.hermes,
            ...(writeRes.profiles.length > 0 ? { profiles: writeRes.profiles } : {}),
            rolledBack: writeRes.rolledBack,
            partialUpdate: writeRes.partialUpdate,
            updatedFiles: writeRes.updatedFiles,
            rolledBackFiles: writeRes.rolledBackFiles,
            rollbackFailedFiles: writeRes.rollbackFailedFiles,
            ...(writeRes.partialUpdate ? { mixed: true } : {}),
            error: detailError,
          },
        };
      }
      try {
        this.store.setAdapterControl("hermes", true);
      } catch (err) {
        const dbCode = err instanceof EngineError ? err.code : "db_error";
        const rb = writeRes.rollbackSnapshot?.();
        const rbOk = rb ? rb.ok : false;
        const current = this.getAdapterToggles();
        return {
          ...current,
          ok: false,
          error: rbOk ? dbCode : `hermes_partial_update:${dbCode}`,
          hermes: {
            ...current.hermes,
            ...(rb
              ? {
                  profiles: rb.profiles,
                  rolledBackFiles: rb.rolledBackFiles,
                  rollbackFailedFiles: rb.rollbackFailedFiles,
                }
              : {}),
            rolledBack: rbOk,
            partialUpdate: rb ? !rb.ok : true,
            ...(!rbOk ? { mixed: true } : {}),
            error: rbOk
              ? `SQLite update failed (${dbCode}); rolled back Hermes config files.`
              : `SQLite update failed (${dbCode}) and config rollback failed for: ${rb?.rollbackFailedFiles.join(", ") ?? "unknown"}.`,
          },
        };
      }
      // Post-commit journal cleanup failure must NOT roll back already-committed config.yaml files,
      // because SQLite adapter_control is already committed. Surface residual journal state honestly.
      try {
        writeRes.clearJournal?.();
      } catch (cleanupErr) {
        const cleanupReason = cleanupErr instanceof Error ? cleanupErr.message : "journal_cleanup_failed";
        const current = this.getAdapterToggles();
        return {
          ...current,
          ok: false,
          error: `hermes_journal_cleanup_failed:${cleanupReason}`,
          hermes: {
            ...current.hermes,
            updatedFiles: writeRes.updatedFiles,
            rolledBack: false,
            partialUpdate: true,
            mixed: true,
            error: `Hermes config files and SQLite adapter_control were committed, but journal cleanup failed (${cleanupReason}); residual journal remains until reconciled.`,
          },
        };
      }
      return this.getAdapterToggles();
    } finally {
      lockRes.release();
    }
  }

  async handle(method: string, input: Record<string, any>): Promise<Reply> {
    try {
      if (method === "getAdapterToggles" || method === "session-nav.get-adapter-toggles") {
        return this.getAdapterToggles();
      }
      if (method === "setAdapterToggle" || method === "session-nav.set-adapter-toggle") {
        return this.setAdapterToggle(input);
      }
      if (method === "scopes") return this.scopes(input.parent_scope);
      const requested = input.scope_key;
      if (typeof requested !== "string" || requested.split(":").length !== 4)
        return { ok: false, error: "invalid_scope" };
      const scope = this.resolveScope(requested);
      if (method === "dbChoice") {
        if (!["abort_request", "send_original"].includes(input.choice))
          return { ok: false, error: "invalid_choice" };
        this.decisions.set(scope, input.choice);
        return { ok: true };
      }
      if (method === "list") {
        const result = this.list(
          scope,
          input.query,
          {
            limit: typeof input.limit === "number" ? input.limit : undefined,
            before_index:
              typeof input.before_index === "number"
                ? input.before_index
                : undefined,
          },
          scope,
        );
        if (this.decisions.get(scope) === "send_original")
          this.decisions.set(scope, "abort_request");
        else this.decisions.delete(scope);
        return result;
      }
      if (this.decisions.has(scope))
        return {
          ok: false,
          error: "db_error",
          choices: ["abort_request", "send_original"],
        };
      if (method === "fork") {
        const effective = this.effectiveScope(scope);
        const destination =
          typeof input.dst_scope_key === "string"
            ? this.resolveScope(input.dst_scope_key)
            : "";
        const denied = this.gate(destination, "hide");
        if (denied) return denied;
        if (
          this.store
            .items(effective)
            .some((item) => item.compaction_source === "summarize_pending")
        ) {
          const deniedSummary = this.gate(destination, "summarize");
          if (deniedSummary) return deniedSummary;
        }
        return { ok: true, counts: this.store.fork(effective, destination) };
      }
      // P0-1: mutations resolve the rotation-effective scope once so hide /
      // unhide / batch / manage act on the child session that owns the latest
      // chunk instead of 404ing against the requested parent scope.
      if (method === "hide" || method === "unhide")
        return await this.mutate(
          this.effectiveScope(scope),
          input.item_id,
          method,
          input.mode ?? "hide",
          input.expected_version,
        );
      if (method === "hideBatch" || method === "unhideBatch")
        return await this.batch(
          this.effectiveScope(scope),
          input,
          method === "hideBatch" ? "hide" : "unhide",
        );
      if (method === "manage") return await this.manage(this.effectiveScope(scope), input);
      return { ok: false, error: "unknown_method" };
    } catch (error) {
      return this.failure(error);
    }
  }

  private resolveScope(scope: string): string {
    return (
      scopeAliases(scope).find((key) =>
        ["adapter_sessions", "items", "units", "adapter_targets"].some(
          (table) =>
            this.store.driver.get(
              `SELECT 1 FROM ${table} WHERE scope_key=? LIMIT 1`,
              [key],
            ),
        ),
      ) ?? scope
    );
  }

  /**
   * Resolve the rotation-effective scope (P0-1). Hermes sessions rotate
   * parent -> child; the panel keeps sending the parent scope_key, so the
   * server resolves the child scope that owns the latest chunk and uses it
   * consistently for items, message-unit writes, targets, capabilities,
   * aliases and gates. The requested parent scope_key stays API-compatible
   * (replies still echo it); only server-side state uses the effective scope.
   * Non-Hermes scopes resolve to themselves without extra I/O.
   */
  private effectiveScope(scope: string): string {
    if (!scope.startsWith("hermes:")) return scope;
    return this.resolvedTimeline(scope).scope;
  }

  private resolvedTimeline(scope: string) {
    const items = this.store.items(scope);
    const units = this.store.listUnits(scope);
    const timeline = this.timeline(scope, items, units);
    const effective = timeline.history.effectiveScope;
    if (!effective || effective === scope) return { scope, items, units, timeline };
    const effectiveItems = this.store.items(effective);
    const effectiveUnits = this.store.listUnits(effective);
    return {
      scope: effective,
      items: effectiveItems,
      units: effectiveUnits,
      timeline: this.timeline(effective, effectiveItems, effectiveUnits),
    };
  }

  private failure(error: unknown): Reply {
    const code =
      error instanceof EngineError
        ? error.code
        : error instanceof HistoryTooLargeError
          ? error.code
          : "engine_error";
    return {
      ok: false,
      error: code,
      ...(["db_error", "db_full", "unsafe_journal_mode"].includes(code)
        ? { choices: ["abort_request", "send_original"] }
        : {}),
    };
  }

  private gate(
    scope: string,
    capability: "hide" | "summarize",
  ): Reply | undefined {
    if (typeof scope !== "string" || scope.split(":").length !== 4)
      return { ok: false, error: "invalid_scope" };
    const capabilities = this.capabilities(scope);
    if (!capabilities[capability])
      return {
        ok: false,
        error:
          capabilities.state === "ready"
            ? "capability_unavailable"
            : capabilities.state,
        capabilities,
      };
  }

  private scopes(parentScope?: unknown): Reply {
    if (parentScope !== undefined && typeof parentScope !== "string")
      return { ok: false, error: "invalid_params" };
    const scopes = this.store.driver
      .all(
        "SELECT scope_key FROM adapter_sessions UNION SELECT scope_key FROM items UNION SELECT scope_key FROM units ORDER BY scope_key",
      )
      .map((row) => {
        const scope = String(row.scope_key);
        return {
          scope_key: scope,
          items: this.store.items(scope).length,
          parent_scope: this.store.registration(scope)?.parent_scope ?? null,
          tool_call_id: this.store.registration(scope)?.tool_call_id ?? null,
          subagent_id: this.store.registration(scope)?.subagent_id ?? null,
          capabilities: this.capabilities(scope),
        };
      });
    const filtered = scopes.filter(
      (row) => parentScope === undefined || row.parent_scope === parentScope,
    );
    return {
      ok: true,
      scopes:
        parentScope === undefined
          ? bindAgents(this.home, filtered, undefined, (scopeKey) =>
              this.capabilities(scopeKey),
            )
          : bindAgents(this.home, filtered),
    };
  }

  private verifiedTargetRecord(
    scope: string,
    target: Record<string, unknown>,
  ): VerifiedTargetRecord | null {
    let invocation: Record<string, any>;
    try {
      const parsed = JSON.parse(String(target.invocation_snapshot));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      invocation = parsed as Record<string, any>;
    } catch {
      return null;
    }
    const callId = String(target.tool_call_id ?? "");
    const content = String(target.original ?? "");
    const contentSha = String(target.content_sha256 ?? "");
    const digest = String(target.invocation_digest ?? "");
    const resultPosition = Number(target.result_position);
    const optionsOmitted = Boolean(target.options_omitted);
    if (
      !callId ||
      !Number.isSafeInteger(resultPosition) ||
      resultPosition < 0 ||
      sha256(content) !== contentSha ||
      (!optionsOmitted && invocationDigest(invocation) !== digest) ||
      itemId(scope, callId, contentSha, digest, resultPosition) !==
        String(target.item_id ?? "")
    ) {
      return null;
    }
    return {
      item_id: String(target.item_id),
      call_id: callId,
      content,
      content_sha256: contentSha,
      invocation,
      invocation_digest: digest,
      result_position: resultPosition,
      status: "ok",
      options_omitted: optionsOmitted,
    };
  }

  private timeline(
    scope: string,
    storedItems: readonly Item[] = this.store.items(scope),
    storedUnits: readonly Record<string, unknown>[] = this.store.listUnits(scope),
  ): Timeline {
    const timeline = loadTimeline(this.home, scope, storedItems, storedUnits);
    if (
      timeline.rows.length > 0 ||
      // P1-2: an empty but authoritative latest chunk (matched session/file)
      // is valid and must NOT be backfilled with stale targets. Only a
      // genuinely missing timeline (no session, no file, no read) falls
      // through to the legacy targets resurrection below.
      timeline.history.chunkAuthoritative === true ||
      (!scope.startsWith("hermes:") && !this.store.registration(scope)?.parent_scope)
    )
      return timeline;
    for (const target of this.store.targets(scope)) {
      const verified = this.verifiedTargetRecord(scope, target);
      if (!verified || timeline.records.has(verified.call_id)) continue;
      const { item_id: verifiedItemId, ...record } = verified;
      timeline.records.set(record.call_id, record);
      timeline.rows.push({
        item_id: verifiedItemId,
        tool_call_id: record.call_id,
        tool_name: target.tool_name,
        kind: "tool",
        manageable: true,
        summary_line: summaryLine(record.content),
        tool_input: preview(record.invocation.arguments),
        tool_output: preview(record.content),
        bytes_size: bytes(record.content),
      });
    }
    return timeline;
  }

  private itemRow(item: Item): Message {
    return {
      item_id: item.item_id,
      tool_call_id: item.tool_call_id,
      kind: "tool",
      tool_name: item.tool_name,
      visibility: item.visibility,
      status:
        item.visibility === "hidden"
          ? "hidden"
          : item.version > 1
            ? "unhidden"
            : "visible",
      version: item.version,
      tokens_display: "—",
      source: item.compaction_source,
      summary_line:
        summaryLine(item.original) ||
        summaryLine(item.compacted) ||
        `[${item.tool_name}]`,
      bytes_size: bytes(item.original),
      tool_output: preview(item.original),
      ...(item.invocation_snapshot &&
      typeof item.invocation_snapshot === "object" &&
      "arguments" in item.invocation_snapshot
        ? { tool_input: preview(item.invocation_snapshot.arguments) }
        : {}),
      ...(item.visibility === "hidden"
        ? {
            compacted_bytes_size: bytes(item.compacted),
            replacement_text: preview(item.compacted),
            summary_pending: item.compaction_source === "summarize_pending",
          }
        : {}),
    };
  }

  private list(
    scope: string,
    query = "",
    paging?: { limit?: number; before_index?: number },
    requestedScope?: string,
  ): Reply {
    // P0-1/P1-4: resolve the rotation-effective scope once and load its
    // items/units/timeline a single time (no same-key cache thrash).
    const resolved = this.resolvedTimeline(scope);
    const effectiveScope = resolved.scope;
    const items = resolved.items;
    const rawUnits = resolved.units;
    const timeline = resolved.timeline;
    const stored = new Map(items.map((item) => [item.item_id, item]));
    const units = new Map(
      rawUnits.map((unit) => [String(unit.unit_id), unit]),
    );
    const spans: [number, number][] = items
      .filter((item) => item.version > 1 || item.visibility === "hidden")
      .map((item) => [item.created_at, item.updated_at]);
    for (const [key, unit] of units)
      if (
        key.startsWith("msg:") &&
        (Number(unit.version) > 1 || unit.visibility === "hidden")
      )
        spans.push([Number(key.split(":")[2]) / 1000, Number(unit.updated_at)]);
    const measured = measuredTokens(this.home, timeline.history, spans);
    const seen = new Set<string>();
    const rows = timeline.rows.map((row) => {
      seen.add(row.item_id);
      let merged: Message;
      const item = stored.get(row.item_id);
      if (item) {
        const itemProps = this.itemRow(item);
        const preservedSummary =
          typeof row.summary_line === "string" &&
          row.summary_line &&
          !row.summary_line.startsWith("[hidden:")
            ? row.summary_line
            : itemProps.summary_line;
        merged = {
          ...row,
          ...itemProps,
          summary_line: preservedSummary,
          ...(row.tool_input !== undefined
            ? { tool_input: row.tool_input }
            : {}),
        };
      } else {
        const unit = units.get(row.item_id);
        const hidden = unit?.visibility === "hidden";
        const version = Number(unit?.version ?? 1);
        merged = {
          status: hidden ? "hidden" : version > 1 ? "unhidden" : "visible",
          visibility: hidden ? "hidden" : "visible",
          version,
          tokens_display: "—",
          ...(hidden ? { compacted_bytes_size: 0 } : {}),
          ...row,
        };
      }
      const tokens = measured.tokens.get(
        row.kind === "tool" ? row.tool_call_id : row.item_id,
      );
      if (tokens !== undefined)
        Object.assign(merged, {
          tokens,
          tokens_display:
            tokens < 1000
              ? `${tokens} tok`
              : `${(tokens / 1000).toFixed(1)}K tok`,
          tokens_source: "measured allocation",
        });
      return merged;
    });
    if (!timeline.rows.length) {
      for (const item of items)
        if (!seen.has(item.item_id)) rows.push(this.itemRow(item));
      const calls = new Set(items.map((item) => item.tool_call_id));
      for (const unit of units.values()) {
        if (
          unit.kind === "tool_result" &&
          unit.tool_call_id &&
          !calls.has(String(unit.tool_call_id))
        ) {
          calls.add(String(unit.tool_call_id));
          rows.push({
            item_id: `unit_${unit.unit_id}`,
            tool_call_id: unit.tool_call_id,
            kind: "tool",
            tool_name: "tool",
            status: "visible",
            visibility: "visible",
            version: 1,
            source: "unrecorded",
            manageable: false,
            bytes_size: Number(unit.char_count),
            summary_line: `[tool_result] ${unit.tool_call_id}`,
          });
        }
      }
    }
    const indexedRows: Message[] = rows.map((row, idx) => ({
      tokens_display: "—",
      ...row,
      timeline_index: idx,
    }));
    const hiddenRows = indexedRows.filter((row) => row.status === "hidden");
    const totals = {
      total_rows: indexedRows.length,
      manageable_count: indexedRows.filter(
        (row) => Boolean(row.item_id) && row.manageable !== false,
      ).length,
      hidden_count: hiddenRows.length,
      saved_bytes: hiddenRows.reduce(
        (sum, row) =>
          sum +
          Math.max(
            0,
            (typeof row.bytes_size === "number" ? row.bytes_size : 0) -
              effectiveRowBytesServer(row),
          ),
        0,
      ),
    };
    const hasQuery = typeof query === "string" && query.length > 0;
    let pageItems: Message[];
    let hasOlder = false;
    let nextBeforeIndex: number | null = null;
    if (hasQuery) {
      const q = query.toLowerCase();
      pageItems = indexedRows.filter((row) =>
        [
          row.item_id,
          row.tool_call_id,
          row.tool_name,
          row.summary_line,
          row.tool_input,
          stored.get(row.item_id)?.compacted,
        ].some(
          (value) =>
            typeof value === "string" && value.toLowerCase().includes(q),
        ),
      );
    } else if (
      typeof paging?.limit === "number" &&
      Number.isFinite(paging.limit) &&
      paging.limit > 0
    ) {
      const limit = Math.min(2000, Math.max(1, Math.trunc(paging.limit)));
      const endIndex =
        typeof paging.before_index === "number" &&
        Number.isFinite(paging.before_index)
          ? Math.max(0, Math.min(indexedRows.length, Math.trunc(paging.before_index)))
          : indexedRows.length;
      let startIndex = Math.max(0, endIndex - limit);
      while (
        startIndex > 0 &&
        isToolTimelineRow(indexedRows[startIndex]) &&
        isToolTimelineRow(indexedRows[startIndex - 1])
      ) {
        startIndex--;
      }
      pageItems = indexedRows.slice(startIndex, endIndex);
      hasOlder = startIndex > 0;
      nextBeforeIndex = startIndex > 0 ? startIndex : null;
    } else {
      pageItems = indexedRows;
    }
    return {
      ok: true,
      // P0-1: echo the requested (parent) scope_key for API compatibility;
      // all state above (items, units, capabilities, gates) uses the
      // rotation-effective scope.
      scope_key: requestedScope ?? scope,
      items: pageItems,
      capabilities: this.capabilities(effectiveScope),
      server_timeline: timeline.rows.length > 0,
      has_older: hasOlder,
      next_before_index: nextBeforeIndex,
      totals,
      ...(timeline.history.recordsCapped ? { records_capped: true } : {}),
      ...(timeline.history.readError
        ? { timeline_read_error: timeline.history.readError }
        : {}),
      ...(measured.context ? { context: measured.context } : {}),
    };
  }

  private result(result: Result): Reply {
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.item
        ? {
            item_id: result.item.item_id,
            visibility: result.item.visibility,
            status: result.item.visibility,
            version: result.item.version,
            item: this.itemRow(result.item),
          }
        : {}),
    };
  }

  private async mutate(
    scope: string,
    id: string,
    command: "hide" | "unhide",
    mode: string,
    expected?: number,
  ): Promise<Reply> {
    if (command === "hide") {
      const denied = this.gate(
        scope,
        mode === "summarize" ? "summarize" : "hide",
      );
      if (denied) return denied;
    }
    if (typeof id !== "string" || !id) return { ok: false, error: "not_found" };
    if (id.startsWith("msg:")) {
      if (command === "hide" && mode === "summarize")
        return { ok: false, error: "summarize_unsupported" };
      const row = this.timeline(scope).rows.find(
        (row) => row.item_id === id && row.kind !== "tool",
      );
      const unit = this.store
        .listUnits(scope)
        .find((unit) => unit.unit_id === id);
      if (!row && (!unit || command !== "unhide"))
        return { ok: false, error: "not_found" };
      if (command === "unhide" && !unit)
        return { ok: false, error: "not_found" };
      const text = row?.message_text ?? "";
      return {
        item_id: id,
        ...this.store.setMessageVisibility(
          scope,
          id,
          row?.kind ?? String(unit!.kind),
          String(unit?.content_sha256 ?? sha256(text)),
          Number(unit?.char_count ?? length(text)),
          command === "hide" ? "hidden" : "visible",
          expected,
        ),
      };
    }
    if (command === "unhide")
      return this.result(this.store.restore(scope, id, expected));
    const source =
      mode === "summarize" ? "summarize_pending" : "explicit_user_hide";
    let item = this.store.get(scope, id);
    if (item && expected !== undefined && item.version !== expected)
      return this.result({ ok: false, error: "version_conflict", item });
    if (item && mode === "summarize" && ["llm", "llm_summary"].includes(item.compaction_source))
      return this.result(item.visibility === "hidden" ? { ok: true, item } :
        this.store.put(scope, { ...item, visibility: "hidden", version: item.version + 1 }, item.version));
    if (!item) {
      const verifiedTargets = this.store
        .targets(scope)
        .map((target) => this.verifiedTargetRecord(scope, target))
        .filter((target): target is VerifiedTargetRecord => target !== null);
      let matchedTarget =
        verifiedTargets.find((target) => target.item_id === id) ??
        verifiedTargets.find((target) => target.call_id === id);
      const timelineRecord = !matchedTarget
        ? [...this.timeline(scope).records.values()].find(
            (candidate) =>
              candidate.call_id === id ||
              itemId(
                scope,
                candidate.call_id,
                candidate.content_sha256,
                candidate.invocation_digest,
                candidate.result_position,
              ) === id,
          )
        : undefined;
      if (!matchedTarget && timelineRecord) {
        matchedTarget = verifiedTargets.find(
          (target) =>
            target.call_id === timelineRecord.call_id &&
            target.result_position === timelineRecord.result_position,
        );
      }
      const record: (RecordInput & { options_omitted?: boolean }) | undefined =
        matchedTarget ?? timelineRecord;
      if (!record) return { ok: false, error: "not_found" };
      if (expected !== undefined && expected !== 1)
        return { ok: false, error: "version_conflict" };
      if (isDestructive(record.invocation.tool_name, record.invocation.arguments))
        return { ok: false, error: "destructive_command" };
      const digests = this.store.driver.all(
        "SELECT invocation_digest FROM identities WHERE scope_key=? AND tool_call_id=? AND content_sha256=? AND result_position=?",
        [
          scope,
          record.call_id,
          record.content_sha256,
          record.result_position,
        ],
      );
      if (
        digests.length &&
        !digests.some(
          (row) => row.invocation_digest === record.invocation_digest,
        )
      ) {
        return { ok: false, error: "invocation_conflict" };
      }
      const fallbackId =
        matchedTarget?.item_id ??
        itemId(
          scope,
          record.call_id,
          record.content_sha256,
          record.invocation_digest,
          record.result_position,
        );
      if (mode !== "summarize") {
        return this.result(
          this.store.put(
            scope,
            manualHideItem(fallbackId, record),
            undefined,
            true,
          ),
        );
      }
      const optionsOmitted = Boolean(
        matchedTarget?.options_omitted ??
          ("options_omitted" in record ? record.options_omitted : undefined),
      );
      const refusal = refusalReason(record, this.engine.config);
      if (
        refusal &&
        ![
          "not_long",
          "protected_error",
          "sensitive_invocation",
          "invocation_too_large",
        ].includes(refusal)
      )
        return { ok: false, error: refusal };
      const baseline = refusal
        ? null
        : selectRule(selectableText(record.content), [], this.engine.config);
      const evaluated = baseline
        ? evaluateCompaction(
            record.content,
            fallbackId,
            selectableText(record.content),
            baseline,
            undefined,
            record.invocation,
            optionsOmitted,
            true,
          )
        : undefined;
      {
        const lines = splitLines(record.content);
        const head = lines.slice(0, 3);
        const tail = lines.length > 3 ? lines.slice(-2) : [];
        const excerpt = [
          ...head,
          ...(tail.length ? ["..."] : []),
          ...tail,
        ].join("\n");
        const defaultCompacted =
          evaluated?.rendered ??
          `[hidden: ${record.invocation.tool_name} ${record.call_id}]\n${excerpt}`;
        const compacted =
          bytes(defaultCompacted) >= bytes(record.content)
            ? `[hidden:${fallbackId}]`
            : defaultCompacted;
        const fallback: Item = {
          item_id: fallbackId,
          tool_call_id: record.call_id,
          result_position: record.result_position,
          content_sha256: record.content_sha256,
          invocation_digest: record.invocation_digest,
          original: record.content,
          compacted,
          excerpt_lines: evaluated?.choice?.lines ?? [...head, ...tail],
          visibility: "hidden",
          version: evaluated?.rendered ? 2 : 1,
          tool_name: String(record.invocation.tool_name),
          compaction_source: source,
          invocation_snapshot: record.invocation,
          context_hint: null,
          invocation_options_omitted: optionsOmitted,
          created_at: 0,
          updated_at: 0,
        };
        const saved = this.store.put(scope, fallback, undefined, true);
        return this.result(saved);
      }
    }
    if (!item) return { ok: false, error: "not_found" };
    if (
      item.invocation_snapshot &&
      typeof item.invocation_snapshot === "object" &&
      !Array.isArray(item.invocation_snapshot) &&
      "tool_name" in item.invocation_snapshot &&
      isDestructive(
        item.invocation_snapshot.tool_name,
        (item.invocation_snapshot as Record<string, unknown>).arguments,
      )
    ) {
      return { ok: false, error: "destructive_command" };
    }
    if (item.visibility === "hidden" && item.compaction_source === source)
      return this.result({ ok: true, item });
    return this.result(
      this.store.put(
        scope,
        {
          ...item,
          visibility: "hidden",
          compaction_source: source,
          version: item.version + 1,
        },
        item.version,
      ),
    );
  }

  private async batch(
    scope: string,
    input: Record<string, any>,
    command: "hide" | "unhide",
  ): Promise<Reply> {
    if (
      !Array.isArray(input.items) ||
      input.items.some(
        (item) =>
          !item ||
          typeof item.item_id !== "string" ||
          !item.item_id ||
          (item.expected_version !== undefined &&
            !Number.isSafeInteger(item.expected_version)),
      )
    )
      return {
        ok: false,
        error: "invalid_items",
        applied: 0,
        failed: 0,
        items: [],
      };
    if (command === "hide") {
      const denied = this.gate(
        scope,
        input.mode === "summarize" ? "summarize" : "hide",
      );
      if (denied)
        return { ...denied, applied: 0, failed: input.items.length, items: [] };
    }
    const results: Reply[] = [];
    const seen = new Set<string>();
    for (const item of input.items) {
      if (seen.has(item.item_id)) continue;
      seen.add(item.item_id);
      let result: Reply;
      try {
        result = await this.mutate(
          scope,
          item.item_id,
          command,
          input.mode ?? "hide",
          item.expected_version,
        );
      } catch (error) {
        result = this.failure(error);
      }
      results.push({
        item_id: result.item_id ?? item.item_id,
        ok: result.ok,
        status: result.visibility ?? result.item?.visibility ?? null,
        visibility: result.visibility ?? result.item?.visibility ?? null,
        version: result.version ?? result.item?.version ?? null,
        ...(result.error ? { error: result.error } : {}),
      });
      if (["db_error", "db_full"].includes(result.error ?? ""))
        return {
          ...result,
          items: results,
          applied: results.filter((item) => item.ok).length,
          failed: results.filter((item) => !item.ok).length,
        };
    }
    return {
      ok: results.every((item) => item.ok),
      applied: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      items: results,
    };
  }

  private async manage(
    scope: string,
    input: Record<string, any>,
  ): Promise<Reply> {
    if (!Array.isArray(input.tool_call_ids) || !input.tool_call_ids.length)
      return {
        ok: false,
        error: "tool_call_ids_required",
        applied: 0,
        failed: 0,
        items: [],
      };
    const mode = input.action === "summarize" ? "summarize" : "hide";
    const denied = this.gate(scope, mode);
    if (denied)
      return {
        ...denied,
        applied: 0,
        failed: input.tool_call_ids.length,
        items: [],
      };
    const timeline = this.timeline(scope);
    const results: Reply[] = [];
    for (const id of new Set<string>(input.tool_call_ids)) {
      const existing = this.store
        .items(scope)
        .find((item) => item.tool_call_id === id);
      const target =
        existing?.item_id ??
        timeline.rows.find((row) => row.tool_call_id === id && row.manageable)
          ?.item_id;
      const result = await this.mutate(
        scope,
        target ?? "",
        "hide",
        mode,
        existing?.version,
      );
      results.push({
        tool_call_id: id,
        ok: result.ok,
        ...(result.item_id ? { item_id: result.item_id } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
    }
    return {
      ok: results.every((item) => item.ok),
      applied: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      items: results,
    };
  }
}
