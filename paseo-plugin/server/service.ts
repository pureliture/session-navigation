import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  inspectHermesPluginInstall,
  inspectHermesToggle,
  setHermesToggleAcrossProfiles,
  type HermesRuntimeInspectionContext,
  type HermesRuntimeSessionInfo,
  type HermesWriteOptions,
} from "./adapterToggles.ts";
import {
  applyHermesOverlay,
  hydrateHermesRows,
  loadHermesRecordById,
  loadHermesTimelineIndex,
  resolveHermesEffectiveScope,
  searchHermesIndex,
  type HermesOverlaidSlot,
  type HermesTimelineIndex,
} from "./hermesHistory.ts";
import {
  hydrateOmpRows,
  loadOmpRecordById,
  loadOmpTimelineIndex,
  loadTimeline,
  measuredTokens,
  measuredTokensFromSummary,
  preview,
  searchOmpIndex,
  summaryLine,
  type Message,
  type OmpTimelineIndex,
  type Timeline,
} from "./history.ts";
import {
  recordServerPerf,
  sanitizeErrorCode,
  scopeAdapterKind,
} from "./diagnostics.ts";

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

function isToolTimelineRow(row: { kind?: unknown; tool_name?: unknown }): boolean {
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
  private hermesHostCheck?: {
    at: number;
    controlRev: string;
    statSig: string;
    valid: boolean;
    profiles: string[];
  };

  constructor(
    readonly store: Store,
    readonly home = homedir(),
  ) {
    this.engine = new Engine(store);
  }

  invalidateControlCaches(): void {
    this.hermesHostCheck = undefined;
  }

  exportDecisions(): Record<string, string> {
    return Object.fromEntries(this.decisions.entries());
  }

  restoreDecisions(decisions: Record<string, string>): void {
    this.decisions.clear();
    for (const [scope, choice] of Object.entries(decisions)) {
      if (choice === "abort_request" || choice === "send_original") {
        this.decisions.set(scope, choice);
      }
    }
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
    const hostVerified =
      !registration &&
      adapterId === "hermes" &&
      this.hermesHostProtectionReady(scope, control);
    let state: Capabilities["state"];
    if (control !== null && !control.enabled) {
      state = "adapter_disabled";
    } else if (registration) {
      state =
        registration.adapter_protocol !== 1 || !registration.enabled
          ? registration.adapter_protocol !== 1
            ? "incompatible_protocol"
            : "adapter_disabled"
          : "ready";
    } else if (hostVerified) {
      state = "ready";
    } else {
      state = "adapter_not_detected";
    }
    return {
      display: true,
      hide: state === "ready" && (hostVerified || this.store.can(scope, "hide")),
      summarize:
        state === "ready" && (hostVerified || this.store.can(scope, "summarize")),
      unhide:
        this.store.hasHiddenItems(scope) ||
        this.store.hasHiddenMessages(scope),
      state,
      ...(state === "adapter_not_detected"
        ? {
            hint: scope.startsWith("hermes:")
              ? "Install and enable the Session Navigation Hermes adapter."
              : "Install and enable @tkdgur1756/session-navigation-omp in the session host.",
          }
        : state === "adapter_disabled" && scope.startsWith("hermes:")
          ? {
              hint: "Context management paused via DB control — updated protection-only sessions protect hidden items while older/frozen Hermes processes stay active until restarted (SQLite DB errors fail open per D9).",
            }
          : {}),
    };
  }

  private capabilitiesFromStats(
    scope: string,
    stats: ReturnType<Store["scopeSummaryStats"]>,
  ): Capabilities {
    const registration = stats.registrations.get(scope);
    const adapterId = scope.startsWith("hermes:")
      ? "hermes"
      : scope.startsWith("omp:")
        ? "omp"
        : null;
    const control = adapterId ? (stats.controls.get(adapterId) ?? null) : null;
    const hostVerified =
      !registration &&
      adapterId === "hermes" &&
      this.hermesHostProtectionReady(scope, control);
    let state: Capabilities["state"];
    if (control !== null && !control.enabled) {
      state = "adapter_disabled";
    } else if (registration) {
      state =
        registration.adapter_protocol !== 1 || !registration.enabled
          ? registration.adapter_protocol !== 1
            ? "incompatible_protocol"
            : "adapter_disabled"
          : "ready";
    } else if (hostVerified) {
      state = "ready";
    } else {
      state = "adapter_not_detected";
    }
    const counts = stats.itemCounts.get(scope);
    const hiddenMsgCount = stats.hiddenMessageCounts.get(scope) ?? 0;
    const regCaps = registration?.capabilities as Record<string, unknown> | undefined;
    const regCanHide =
      Boolean(registration?.enabled) &&
      registration?.adapter_protocol === 1 &&
      (control === null || control.enabled) &&
      Boolean(regCaps?.hide);
    const regCanSummarize =
      Boolean(registration?.enabled) &&
      registration?.adapter_protocol === 1 &&
      (control === null || control.enabled) &&
      Boolean(regCaps?.summarize);
    return {
      display: true,
      hide: state === "ready" && (hostVerified || regCanHide),
      summarize: state === "ready" && (hostVerified || regCanSummarize),
      unhide: (counts?.hiddenItemCount ?? 0) > 0 || hiddenMsgCount > 0,
      state,
      ...(state === "adapter_not_detected"
        ? {
            hint: scope.startsWith("hermes:")
              ? "Install and enable the Session Navigation Hermes adapter."
              : "Install and enable @tkdgur1756/session-navigation-omp in the session host.",
          }
        : state === "adapter_disabled" && scope.startsWith("hermes:")
          ? {
              hint: "Context management paused via DB control — updated protection-only sessions protect hidden items while older/frozen Hermes processes stay active until restarted (SQLite DB errors fail open per D9).",
            }
          : {}),
    };
  }

  private hermesHostStatSignature(profile?: string): string {
    const profileDir = join(this.home, ".hermes", "profiles");
    const profileNames = new Set<string>(this.hermesHostCheck?.profiles ?? []);
    if (profile && profile !== "default" && !/[\\/:]/.test(profile) && profile !== "..") {
      profileNames.add(profile);
    }
    const paths = [
      join(this.home, ".hermes", "config.yaml"),
      join(this.home, ".hermes", "plugins", "session_navigation", "__init__.py"),
      join(this.home, ".hermes", "plugins", "session_navigation", "vendor", "session_navigation_hermes", "plugin.py"),
      profileDir,
      ...[...profileNames].sort().map((p) => join(profileDir, p, "config.yaml")),
    ];
    return paths
      .map((p) => {
        try {
          const st = statSync(p);
          return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        } catch {
          return "missing";
        }
      })
      .join("|");
  }

  private hermesHostProtectionReady(
    scope: string,
    controlArg?: ReturnType<Store["getAdapterControl"]>,
  ): boolean {
    const profile = scope.split(":")[1] || "default";
    const control =
      controlArg !== undefined
        ? controlArg
        : this.store.getAdapterControl("hermes");
    const controlRev = control
      ? `${control.enabled ? 1 : 0}:${control.revision}:${control.updated_at}`
      : "none";
    const statSig = this.hermesHostStatSignature(profile);
    const now = Date.now();
    if (
      !this.hermesHostCheck ||
      this.hermesHostCheck.controlRev !== controlRev ||
      this.hermesHostCheck.statSig !== statSig ||
      now - this.hermesHostCheck.at > 5000
    ) {
      const install = inspectHermesPluginInstall(this.home);
      const status = inspectHermesToggle(this.home, control?.enabled);
      this.hermesHostCheck = {
        at: now,
        controlRev,
        statSig: "",
        valid: Boolean(
          install.pluginInstalled &&
            install.protectionSupportedOnDisk &&
            status.installed &&
            status.enabled &&
            !status.stateUnknown &&
            !status.error &&
            (status.enabledProfileCount ?? 0) > 0,
        ),
        profiles: (status.profiles ?? [])
          .filter((entry) => entry.enabled)
          .map((entry) => entry.profile),
      };
      this.hermesHostCheck.statSig = this.hermesHostStatSignature(profile);
    }
    return (
      this.hermesHostCheck.valid &&
      this.hermesHostCheck.profiles.includes(profile)
    );
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
      .filter(
        (entry) =>
          entry.scope_key.startsWith("hermes:") && Boolean(entry.agent_id),
      )
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
      statusText: ompEnabled
        ? "Active"
        : "Paused (existing hidden items protected)",
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
    this.invalidateControlCaches();
    const adapter = input?.adapter;
    const enabled = input?.enabled;
    if (
      (adapter !== "omp" && adapter !== "hermes") ||
      typeof enabled !== "boolean"
    ) {
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
          ...(preCheck.error
            ? { hermes: { ...preCheck, error: preCheck.error } }
            : {}),
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
            ...(writeRes.profiles.length > 0
              ? { profiles: writeRes.profiles }
              : {}),
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
      try {
        writeRes.clearJournal?.();
      } catch (cleanupErr) {
        const cleanupReason =
          cleanupErr instanceof Error
            ? cleanupErr.message
            : "journal_cleanup_failed";
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
    const started = performance.now();
    const adapter = scopeAdapterKind(input?.scope_key);
    try {
      let reply: Reply;
      let diagMeta: Record<string, unknown> = {};
      if (
        method === "getAdapterToggles" ||
        method === "session-nav.get-adapter-toggles"
      ) {
        reply = this.getAdapterToggles();
      } else if (
        method === "setAdapterToggle" ||
        method === "session-nav.set-adapter-toggle"
      ) {
        reply = this.setAdapterToggle(input);
      } else if (method === "scopes") {
        reply = this.scopes(input.parent_scope);
        if (reply.ok && Array.isArray(reply.scopes)) {
          diagMeta = { scope_count: reply.scopes.length };
        }
      } else {
        const requested = input.scope_key;
        if (typeof requested !== "string" || requested.split(":").length !== 4) {
          reply = { ok: false, error: "invalid_scope" };
        } else {
          const scope = this.resolveScope(requested);
          if (method === "dbChoice") {
            if (!["abort_request", "send_original"].includes(input.choice)) {
              reply = { ok: false, error: "invalid_choice" };
            } else {
              this.decisions.set(scope, input.choice);
              reply = { ok: true };
            }
          } else if (method === "list") {
            const listMeta: {
              row_count?: number;
              hydrated_count?: number;
              page_size?: number;
            } = {};
            reply = this.list(
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
              listMeta,
            );
            diagMeta = listMeta;
            if (this.decisions.get(scope) === "send_original")
              this.decisions.set(scope, "abort_request");
            else this.decisions.delete(scope);
          } else if (this.decisions.has(scope)) {
            reply = {
              ok: false,
              error: "db_error",
              choices: ["abort_request", "send_original"],
            };
          } else if (method === "fork") {
            const effective = this.effectiveScope(scope);
            const destination =
              typeof input.dst_scope_key === "string"
                ? this.resolveScope(input.dst_scope_key)
                : "";
            const denied = this.gate(destination, "hide");
            if (denied) {
              reply = denied;
            } else if (
              this.store
                .items(effective)
                .some((item) => item.compaction_source === "summarize_pending")
            ) {
              const deniedSummary = this.gate(destination, "summarize");
              reply =
                deniedSummary ??
                ({ ok: true, counts: this.store.fork(effective, destination) } as Reply);
            } else {
              reply = {
                ok: true,
                counts: this.store.fork(effective, destination),
              };
            }
          } else if (method === "hide" || method === "unhide") {
            reply = await this.mutate(
              this.effectiveScope(scope),
              input.item_id,
              method,
              input.mode ?? "hide",
              input.expected_version,
            );
          } else if (method === "hideBatch" || method === "unhideBatch") {
            reply = await this.batch(
              this.effectiveScope(scope),
              input,
              method === "hideBatch" ? "hide" : "unhide",
            );
          } else if (method === "manage") {
            reply = await this.manage(this.effectiveScope(scope), input);
          } else {
            reply = { ok: false, error: "unknown_method" };
          }
        }
      }
      recordServerPerf({
        op: method,
        duration_ms: performance.now() - started,
        ok: Boolean(reply.ok),
        ...(reply.ok ? {} : { error_code: sanitizeErrorCode(reply.error ?? "error") }),
        adapter,
        lane: "direct",
        ...diagMeta,
      });
      return reply;
    } catch (error) {
      const reply = this.failure(error);
      recordServerPerf({
        op: method,
        duration_ms: performance.now() - started,
        ok: false,
        error_code: sanitizeErrorCode(reply.error ?? error),
        adapter,
        lane: "direct",
      });
      return reply;
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

  private effectiveScope(scope: string): string {
    if (!scope.startsWith("hermes:")) return scope;
    return resolveHermesEffectiveScope(this.home, scope);
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
      ...([
        "db_error",
        "db_full",
        "unsafe_journal_mode",
        "engine_protocol_incompatible",
      ].includes(code)
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
    const stats = this.store.scopeSummaryStats();
    const scopes = stats.scopeKeys.map((scope) => {
      const reg = stats.registrations.get(scope);
      return {
        scope_key: scope,
        items: stats.itemCounts.get(scope)?.itemCount ?? 0,
        parent_scope: reg?.parent_scope ?? null,
        tool_call_id: reg?.tool_call_id ?? null,
        subagent_id: reg?.subagent_id ?? null,
        capabilities: this.capabilitiesFromStats(scope, stats),
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
              this.capabilitiesFromStats(scopeKey, stats),
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

  private mergeSlotWithOverlay(
    row: Message,
    timelineIndex: number,
    stored: ReadonlyMap<string, Item>,
    units: ReadonlyMap<string, Record<string, unknown>>,
    measuredTokensMap: ReadonlyMap<string, number>,
  ): Message {
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
    const tokens = measuredTokensMap.get(
      row.kind === "tool" ? row.tool_call_id : row.item_id,
    );
    if (tokens !== undefined) {
      Object.assign(merged, {
        tokens,
        tokens_display:
          tokens < 1000
            ? `${tokens} tok`
            : `${(tokens / 1000).toFixed(1)}K tok`,
        tokens_source: "measured allocation",
      });
    }
    return {
      tokens_display: "—",
      ...merged,
      timeline_index: timelineIndex,
    };
  }

  private buildListResponse(
    requestedScope: string,
    effectiveScope: string,
    pageItems: Message[],
    hasOlder: boolean,
    nextBeforeIndex: number | null,
    totals: {
      total_rows: number;
      manageable_count: number;
      hidden_count: number;
      saved_bytes: number;
    },
    serverTimeline: boolean,
    options: {
      recordsCapped?: boolean;
      readError?: string;
      context?: { used_tokens: number; max_tokens: number | null; source: string };
    },
  ): Reply {
    const capabilities = this.capabilities(effectiveScope);
    const pausedAdapter = effectiveScope.startsWith("hermes:")
      ? "hermes"
      : effectiveScope.startsWith("omp:")
        ? "omp"
        : null;
    const paused =
      capabilities.state === "adapter_disabled" && pausedAdapter !== null;
    return {
      ok: true,
      scope_key: requestedScope,
      items: pageItems,
      capabilities,
      ...(paused
        ? {
            paused: true,
            paused_warning:
              pausedAdapter === "hermes"
                ? "adapter paused: hides/summaries are disabled, but stored hidden items are still redacted from outgoing requests (protection-only); capabilities refresh on resume."
                : "adapter paused: hides/summaries are disabled; existing hidden items stay protected (protection-only).",
          }
        : {}),
      server_timeline: serverTimeline,
      has_older: hasOlder,
      next_before_index: nextBeforeIndex,
      totals,
      ...(options.recordsCapped ? { records_capped: true } : {}),
      ...(options.readError
        ? { timeline_read_error: options.readError }
        : {}),
      ...(options.context ? { context: options.context } : {}),
    };
  }

  private selectWindowIndices(
    slots: readonly { kind?: unknown; tool_name?: unknown }[],
    limitParam: number,
    beforeIndexParam: number | undefined,
  ): { startIndex: number; endIndex: number; hasOlder: boolean; nextBeforeIndex: number | null } {
    const limit = Math.min(2000, Math.max(1, Math.trunc(limitParam)));
    const endIndex =
      typeof beforeIndexParam === "number" && Number.isFinite(beforeIndexParam)
        ? Math.max(0, Math.min(slots.length, Math.trunc(beforeIndexParam)))
        : slots.length;
    let startIndex = Math.max(0, endIndex - limit);
    while (
      startIndex > 0 &&
      isToolTimelineRow(slots[startIndex]) &&
      isToolTimelineRow(slots[startIndex - 1])
    ) {
      startIndex--;
    }
    return {
      startIndex,
      endIndex,
      hasOlder: startIndex > 0,
      nextBeforeIndex: startIndex > 0 ? startIndex : null,
    };
  }

  private computeSlotTotals(
    slots: readonly { item_id: string; manageable: boolean; bytes_size: number; kind: string }[],
    stored: ReadonlyMap<string, Item>,
    units: ReadonlyMap<string, Record<string, unknown>>,
  ): {
    total_rows: number;
    manageable_count: number;
    hidden_count: number;
    saved_bytes: number;
  } {
    let manageableCount = 0;
    let hiddenCount = 0;
    let savedBytes = 0;
    for (const slot of slots) {
      if (Boolean(slot.item_id) && slot.manageable !== false) {
        manageableCount++;
      }
      const item = stored.get(slot.item_id);
      if (item) {
        if (item.visibility === "hidden") {
          hiddenCount++;
          const origBytes = bytes(item.original);
          const compBytes = Math.min(Math.max(0, origBytes), Math.max(0, bytes(item.compacted)));
          savedBytes += Math.max(0, origBytes - compBytes);
        }
        continue;
      }
      const unit = units.get(slot.item_id);
      if (unit?.visibility === "hidden") {
        hiddenCount++;
        const post =
          slot.kind === "user" || slot.kind === "assistant" || slot.kind === "agent"
            ? 0
            : 0;
        const clamped = Math.min(Math.max(0, slot.bytes_size), post);
        savedBytes += Math.max(0, slot.bytes_size - clamped);
      }
    }
    return {
      total_rows: slots.length,
      manageable_count: manageableCount,
      hidden_count: hiddenCount,
      saved_bytes: savedBytes,
    };
  }

  private collectSpans(
    items: readonly Item[],
    units: ReadonlyMap<string, Record<string, unknown>>,
  ): [number, number][] {
    const spans: [number, number][] = items
      .filter((item) => item.version > 1 || item.visibility === "hidden")
      .map((item) => [item.created_at, item.updated_at]);
    for (const [key, unit] of units) {
      if (
        key.startsWith("msg:") &&
        (Number(unit.version) > 1 || unit.visibility === "hidden")
      ) {
        spans.push([Number(key.split(":")[2]) / 1000, Number(unit.updated_at)]);
      }
    }
    return spans;
  }

  private list(
    scope: string,
    query = "",
    paging?: { limit?: number; before_index?: number },
    requestedScope?: string,
    diagOut?: { row_count?: number; hydrated_count?: number; page_size?: number },
  ): Reply {
    const adapter = scope.split(":")[0];
    const hasQuery = typeof query === "string" && query.length > 0;
    const hasLimit =
      typeof paging?.limit === "number" &&
      Number.isFinite(paging.limit) &&
      paging.limit > 0;

    if (adapter === "omp" || adapter === "pi") {
      const ompIndex = loadOmpTimelineIndex(this.home, scope);
      if (ompIndex) {
        return this.listFromOmpIndex(
          ompIndex,
          scope,
          requestedScope ?? scope,
          query,
          hasQuery,
          hasLimit ? paging! : undefined,
          diagOut,
        );
      }
    } else if (adapter === "hermes") {
      const hermesRes = loadHermesTimelineIndex(this.home, scope);
      if (hermesRes.readError) {
        return this.listLegacyOrEmpty(
          scope,
          requestedScope ?? scope,
          query,
          paging,
          {
            rows: [],
            records: new Map(),
            history: {
              messages: [],
              boundaries: [],
              injected: [],
              chunkStart: 0,
              readError: hermesRes.readError,
              readErrorDb: hermesRes.readErrorDb,
            },
          },
          diagOut,
        );
      }
      if (hermesRes.index) {
        return this.listFromHermesIndex(
          hermesRes.index,
          requestedScope ?? scope,
          query,
          hasQuery,
          hasLimit ? paging! : undefined,
          diagOut,
        );
      }
    }

    const resolved = this.timeline(scope);
    return this.listLegacyOrEmpty(
      scope,
      requestedScope ?? scope,
      query,
      paging,
      resolved,
      diagOut,
    );
  }

  private listFromOmpIndex(
    index: OmpTimelineIndex,
    effectiveScope: string,
    requestedScope: string,
    query: string,
    hasQuery: boolean,
    paging: { limit?: number; before_index?: number } | undefined,
    diagOut?: { row_count?: number; hydrated_count?: number; page_size?: number },
  ): Reply {
    const items = this.store.items(effectiveScope);
    const rawUnits = this.store.listUnits(effectiveScope);
    const stored = new Map(items.map((item) => [item.item_id, item]));
    const units = new Map(rawUnits.map((unit) => [String(unit.unit_id), unit]));
    const spans = this.collectSpans(items, units);
    const measured = measuredTokensFromSummary(this.home, index.summary, spans);

    if (!index.slots.length) {
      return this.listEmptySlotsWithStoreFallback(
        requestedScope,
        effectiveScope,
        items,
        units,
        measured,
        query,
        hasQuery,
        paging,
        {
          recordsCapped: index.recordsCapped,
        },
        diagOut,
      );
    }

    const totals = this.computeSlotTotals(index.slots, stored, units);

    let selectedIndices: number[];
    let hasOlder = false;
    let nextBeforeIndex: number | null = null;
    if (hasQuery) {
      const storedCompacted = new Map<string, string | undefined>();
      for (const item of items) storedCompacted.set(item.item_id, item.compacted);
      selectedIndices = searchOmpIndex(index, query, storedCompacted);
    } else if (paging) {
      const win = this.selectWindowIndices(
        index.slots,
        paging.limit!,
        paging.before_index,
      );
      hasOlder = win.hasOlder;
      nextBeforeIndex = win.nextBeforeIndex;
      selectedIndices = [];
      for (let i = win.startIndex; i < win.endIndex; i++) selectedIndices.push(i);
    } else {
      selectedIndices = index.slots.map((_, i) => i);
    }

    const selectedSlots = selectedIndices.map((idx) => index.slots[idx]);
    const hydratedRows = hydrateOmpRows(this.home, index, selectedSlots);
    const pageItems = hydratedRows.map((row, pos) =>
      this.mergeSlotWithOverlay(
        row,
        selectedIndices[pos],
        stored,
        units,
        measured.tokens,
      ),
    );

    if (diagOut) {
      diagOut.row_count = index.slots.length;
      diagOut.hydrated_count = selectedSlots.length;
      diagOut.page_size = pageItems.length;
    }

    return this.buildListResponse(
      requestedScope,
      effectiveScope,
      pageItems,
      hasOlder,
      nextBeforeIndex,
      totals,
      true,
      {
        recordsCapped: index.recordsCapped,
        context: measured.context,
      },
    );
  }

  private listFromHermesIndex(
    index: HermesTimelineIndex,
    requestedScope: string,
    query: string,
    hasQuery: boolean,
    paging: { limit?: number; before_index?: number } | undefined,
    diagOut?: { row_count?: number; hydrated_count?: number; page_size?: number },
  ): Reply {
    const effectiveScope = index.effectiveScope;
    const items = this.store.items(effectiveScope);
    const rawUnits = this.store.listUnits(effectiveScope);
    const overlaid = applyHermesOverlay(index, items, rawUnits);
    const stored = new Map(items.map((item) => [item.item_id, item]));
    const units = new Map(rawUnits.map((unit) => [String(unit.unit_id), unit]));
    const measured: {
      tokens: Map<string, number>;
      context?: { used_tokens: number; max_tokens: number | null; source: string };
    } = {
      tokens: new Map(),
      ...(index.usedTokens
        ? {
            context: {
              used_tokens: index.usedTokens,
              max_tokens: null,
              source: "hermes_session_usage",
            },
          }
        : {}),
    };

    if (!overlaid.length) {
      return this.listEmptySlotsWithStoreFallback(
        requestedScope,
        effectiveScope,
        items,
        units,
        measured,
        query,
        hasQuery,
        paging,
        {
          recordsCapped: index.recordsCapped,
        },
        diagOut,
      );
    }

    const totals = this.computeSlotTotals(overlaid, stored, units);

    let selectedIndices: number[];
    let hasOlder = false;
    let nextBeforeIndex: number | null = null;
    if (hasQuery) {
      const storedCompacted = new Map<string, string | undefined>();
      for (const item of items) storedCompacted.set(item.item_id, item.compacted);
      selectedIndices = searchHermesIndex(index, overlaid, query, storedCompacted);
    } else if (paging) {
      const win = this.selectWindowIndices(
        overlaid,
        paging.limit!,
        paging.before_index,
      );
      hasOlder = win.hasOlder;
      nextBeforeIndex = win.nextBeforeIndex;
      selectedIndices = [];
      for (let i = win.startIndex; i < win.endIndex; i++) selectedIndices.push(i);
    } else {
      selectedIndices = overlaid.map((_, i) => i);
    }

    const selectedSlots: HermesOverlaidSlot[] = selectedIndices.map(
      (idx) => overlaid[idx],
    );
    const hydratedRows = hydrateHermesRows(index, selectedSlots);
    const pageItems = hydratedRows.map((row, pos) =>
      this.mergeSlotWithOverlay(
        row,
        selectedIndices[pos],
        stored,
        units,
        measured.tokens,
      ),
    );

    if (diagOut) {
      diagOut.row_count = overlaid.length;
      diagOut.hydrated_count = selectedSlots.length;
      diagOut.page_size = pageItems.length;
    }

    return this.buildListResponse(
      requestedScope,
      effectiveScope,
      pageItems,
      hasOlder,
      nextBeforeIndex,
      totals,
      true,
      {
        recordsCapped: index.recordsCapped,
        context: measured.context,
      },
    );
  }

  private listEmptySlotsWithStoreFallback(
    requestedScope: string,
    effectiveScope: string,
    items: readonly Item[],
    units: ReadonlyMap<string, Record<string, unknown>>,
    measured: {
      tokens: Map<string, number>;
      context?: { used_tokens: number; max_tokens: number | null; source: string };
    },
    query: string,
    hasQuery: boolean,
    paging: { limit?: number; before_index?: number } | undefined,
    options: { recordsCapped?: boolean; readError?: string },
    diagOut?: { row_count?: number; hydrated_count?: number; page_size?: number },
  ): Reply {
    const stored = new Map(items.map((item) => [item.item_id, item]));
    const rows: Message[] = [];
    for (const item of items) rows.push(this.itemRow(item));
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
          (value) => typeof value === "string" && value.toLowerCase().includes(q),
        ),
      );
    } else if (paging) {
      const win = this.selectWindowIndices(
        indexedRows,
        paging.limit!,
        paging.before_index,
      );
      pageItems = indexedRows.slice(win.startIndex, win.endIndex);
      hasOlder = win.hasOlder;
      nextBeforeIndex = win.nextBeforeIndex;
    } else {
      pageItems = indexedRows;
    }
    if (diagOut) {
      diagOut.row_count = indexedRows.length;
      diagOut.hydrated_count = pageItems.length;
      diagOut.page_size = pageItems.length;
    }
    return this.buildListResponse(
      requestedScope,
      effectiveScope,
      pageItems,
      hasOlder,
      nextBeforeIndex,
      totals,
      false,
      {
        recordsCapped: options.recordsCapped,
        readError: options.readError,
        context: measured.context,
      },
    );
  }

  private listLegacyOrEmpty(
    effectiveScope: string,
    requestedScope: string,
    query = "",
    paging: { limit?: number; before_index?: number } | undefined,
    timeline: Timeline,
    diagOut?: { row_count?: number; hydrated_count?: number; page_size?: number },
  ): Reply {
    const items = this.store.items(effectiveScope);
    const rawUnits = this.store.listUnits(effectiveScope);
    const stored = new Map(items.map((item) => [item.item_id, item]));
    const units = new Map(rawUnits.map((unit) => [String(unit.unit_id), unit]));
    const spans = this.collectSpans(items, units);
    const measured = measuredTokens(this.home, timeline.history, spans);
    const seen = new Set<string>();
    const rows = timeline.rows.map((row, idx) => {
      seen.add(row.item_id);
      return this.mergeSlotWithOverlay(row, idx, stored, units, measured.tokens);
    });
    if (!timeline.rows.length) {
      return this.listEmptySlotsWithStoreFallback(
        requestedScope,
        effectiveScope,
        items,
        units,
        measured,
        query,
        typeof query === "string" && query.length > 0,
        typeof paging?.limit === "number" &&
          Number.isFinite(paging.limit) &&
          paging.limit > 0
          ? paging
          : undefined,
        {
          recordsCapped: timeline.history.recordsCapped,
          readError: timeline.history.readError,
        },
        diagOut,
      );
    }
    const hiddenRows = rows.filter((row) => row.status === "hidden");
    const totals = {
      total_rows: rows.length,
      manageable_count: rows.filter(
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
      pageItems = rows.filter((row) =>
        [
          row.item_id,
          row.tool_call_id,
          row.tool_name,
          row.summary_line,
          row.tool_input,
          stored.get(row.item_id)?.compacted,
        ].some(
          (value) => typeof value === "string" && value.toLowerCase().includes(q),
        ),
      );
    } else if (
      typeof paging?.limit === "number" &&
      Number.isFinite(paging.limit) &&
      paging.limit > 0
    ) {
      const win = this.selectWindowIndices(
        rows,
        paging.limit,
        paging.before_index,
      );
      pageItems = rows.slice(win.startIndex, win.endIndex);
      hasOlder = win.hasOlder;
      nextBeforeIndex = win.nextBeforeIndex;
    } else {
      pageItems = rows;
    }
    if (diagOut) {
      diagOut.row_count = rows.length;
      diagOut.hydrated_count = pageItems.length;
      diagOut.page_size = pageItems.length;
    }
    return this.buildListResponse(
      requestedScope,
      effectiveScope,
      pageItems,
      hasOlder,
      nextBeforeIndex,
      totals,
      timeline.rows.length > 0,
      {
        recordsCapped: timeline.history.recordsCapped,
        readError: timeline.history.readError,
        context: measured.context,
      },
    );
  }

  private findMessageRowForHide(scope: string, id: string): Message | undefined {
    const adapter = scope.split(":")[0];
    if (adapter === "omp" || adapter === "pi") {
      const index = loadOmpTimelineIndex(this.home, scope);
      if (index) {
        const slot = index.slots.find(
          (s) => s.item_id === id && s.kind !== "tool",
        );
        return slot ? hydrateOmpRows(this.home, index, [slot])[0] : undefined;
      }
    } else if (adapter === "hermes") {
      const res = loadHermesTimelineIndex(this.home, scope);
      if (res.index) {
        const overlaid = applyHermesOverlay(
          res.index,
          this.store.items(res.index.effectiveScope),
          this.store.listUnits(res.index.effectiveScope),
        );
        const slot = overlaid.find((s) => s.item_id === id && s.kind !== "tool");
        return slot ? hydrateHermesRows(res.index, [slot])[0] : undefined;
      }
    }
    return this.timeline(scope).rows.find(
      (row) => row.item_id === id && row.kind !== "tool",
    );
  }

  private findTimelineRecordById(
    scope: string,
    id: string,
  ): (RecordInput & { options_omitted?: boolean }) | undefined {
    const adapter = scope.split(":")[0];
    if (adapter === "omp" || adapter === "pi") {
      const rec = loadOmpRecordById(this.home, scope, id);
      if (rec) return rec;
      if (loadOmpTimelineIndex(this.home, scope)) return undefined;
    } else if (adapter === "hermes") {
      const res = loadHermesTimelineIndex(this.home, scope);
      if (res.index) {
        const overlaid = applyHermesOverlay(
          res.index,
          this.store.items(res.index.effectiveScope),
          this.store.listUnits(res.index.effectiveScope),
        );
        return loadHermesRecordById(res.index, overlaid, id);
      }
    }
    return [...this.timeline(scope).records.values()].find(
      (candidate) =>
        candidate.call_id === id ||
        itemId(
          scope,
          candidate.call_id,
          candidate.content_sha256,
          candidate.invocation_digest,
          candidate.result_position,
        ) === id,
    );
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
      const unit = this.store
        .listUnits(scope)
        .find((u) => u.unit_id === id);
      if (command === "unhide" && !unit)
        return { ok: false, error: "not_found" };
      let row: Message | undefined;
      let timelineOversized = false;
      if (command === "hide") {
        try {
          row = this.findMessageRowForHide(scope, id);
        } catch (error) {
          if (!(error instanceof HistoryTooLargeError)) throw error;
          timelineOversized = true;
        }
        if (!row && (!unit || !timelineOversized))
          return { ok: false, error: "not_found" };
      }
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
    if (
      item &&
      mode === "summarize" &&
      ["llm", "llm_summary"].includes(item.compaction_source)
    )
      return this.result(
        item.visibility === "hidden"
          ? { ok: true, item }
          : this.store.put(
              scope,
              { ...item, visibility: "hidden", version: item.version + 1 },
              item.version,
            ),
      );
    if (!item) {
      const verifiedTargets = this.store
        .targets(scope)
        .map((target) => this.verifiedTargetRecord(scope, target))
        .filter((target): target is VerifiedTargetRecord => target !== null);
      let matchedTarget =
        verifiedTargets.find((target) => target.item_id === id) ??
        verifiedTargets.find((target) => target.call_id === id);
      const timelineRecord = !matchedTarget
        ? this.findTimelineRecordById(scope, id)
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
      if (
        [
          "db_error",
          "db_full",
          "unsafe_journal_mode",
          "engine_protocol_incompatible",
        ].includes(result.error ?? "")
      )
        return {
          ...result,
          items: results,
          applied: results.filter((entry) => entry.ok).length,
          failed: results.filter((entry) => !entry.ok).length,
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

    let cachedSlots: Array<{ item_id: string; tool_call_id: string; manageable: boolean }> | undefined;
    let timelineOversized = false;
    const timelineSlotRows = (): Array<{
      item_id: string;
      tool_call_id: string;
      manageable: boolean;
    }> => {
      if (cachedSlots) return cachedSlots;
      if (timelineOversized) return [];
      try {
        const adapter = scope.split(":")[0];
        if (adapter === "omp" || adapter === "pi") {
          const idx = loadOmpTimelineIndex(this.home, scope);
          if (idx && idx.slots.length > 0) {
            cachedSlots = idx.slots;
            return cachedSlots;
          }
        } else if (adapter === "hermes") {
          const res = loadHermesTimelineIndex(this.home, scope);
          if (res.index) {
            const overlaid = applyHermesOverlay(
              res.index,
              this.store.items(res.index.effectiveScope),
              this.store.listUnits(res.index.effectiveScope),
            );
            if (overlaid.length > 0) {
              cachedSlots = overlaid;
              return cachedSlots;
            }
          }
        }
        cachedSlots = this.timeline(scope).rows as Array<{
          item_id: string;
          tool_call_id: string;
          manageable: boolean;
        }>;
      } catch (error) {
        if (!(error instanceof HistoryTooLargeError)) throw error;
        timelineOversized = true;
        return [];
      }
      return cachedSlots;
    };

    const existingByCallId = new Map<string, Item>();
    for (const item of this.store.items(scope)) {
      if (!existingByCallId.has(item.tool_call_id)) {
        existingByCallId.set(item.tool_call_id, item);
      }
    }

    const results: Reply[] = [];
    for (const id of new Set<string>(input.tool_call_ids)) {
      const existing = existingByCallId.get(id);
      let resolvedItemId = existing?.item_id;
      if (!resolvedItemId) {
        resolvedItemId = timelineSlotRows().find(
          (row) => row.tool_call_id === id && row.manageable,
        )?.item_id;
      }
      if (!resolvedItemId) {
        results.push({
          tool_call_id: id,
          ok: false,
          ...(timelineOversized
            ? { error: "history_too_large" }
            : { error: "not_found" }),
        });
        continue;
      }
      const result = await this.mutate(
        scope,
        resolvedItemId,
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
