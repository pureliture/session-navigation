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
  type Item,
  type RecordInput,
  type Result,
} from "../../packages/core/src/index.ts";
import { bindAgents } from "./mapping.ts";
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

export class PaseoService {
  readonly engine: Engine;
  private readonly decisions = new Map<string, string>();
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
    const state =
      !registration || scope.startsWith("pi:")
        ? "adapter_not_detected"
        : registration.adapter_protocol !== 1
          ? "incompatible_protocol"
          : !registration.enabled
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
              : "Install and enable @session-navigation/omp in the session host.",
          }
        : {}),
    };
  }

  async handle(method: string, input: Record<string, any>): Promise<Reply> {
    try {
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
        const result = this.list(scope, input.query);
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
        const destination =
          typeof input.dst_scope_key === "string"
            ? this.resolveScope(input.dst_scope_key)
            : "";
        const denied = this.gate(destination, "hide");
        if (denied) return denied;
        if (
          this.store
            .items(scope)
            .some((item) => item.compaction_source === "summarize_pending")
        ) {
          const deniedSummary = this.gate(destination, "summarize");
          if (deniedSummary) return deniedSummary;
        }
        return { ok: true, counts: this.store.fork(scope, destination) };
      }
      if (method === "hide" || method === "unhide")
        return await this.mutate(
          scope,
          input.item_id,
          method,
          input.mode ?? "hide",
          input.expected_version,
        );
      if (method === "hideBatch" || method === "unhideBatch")
        return await this.batch(
          scope,
          input,
          method === "hideBatch" ? "hide" : "unhide",
        );
      if (method === "manage") return await this.manage(scope, input);
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

  private failure(error: unknown): Reply {
    const code = error instanceof EngineError ? error.code : "engine_error";
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
    return { ok: true, scopes: bindAgents(this.home, scopes.filter((row) =>
      parentScope === undefined || row.parent_scope === parentScope)) };
  }

  private timeline(scope: string): Timeline {
    const timeline = loadTimeline(this.home, scope);
    if (!scope.startsWith("hermes:") && !this.store.registration(scope)?.parent_scope) return timeline;
    for (const target of this.store.targets(scope)) {
      if (timeline.records.has(String(target.tool_call_id))) continue;
      const invocation = JSON.parse(String(target.invocation_snapshot));
      const record: RecordInput = {
        call_id: String(target.tool_call_id),
        content: String(target.original),
        content_sha256: String(target.content_sha256),
        invocation,
        invocation_digest: String(target.invocation_digest),
        result_position: Number(target.result_position),
        status: "ok",
      };
      if (
        sha256(record.content) !== record.content_sha256 ||
        (!target.invocation_options_omitted &&
          invocationDigest(invocation) !== record.invocation_digest) ||
        itemId(
          scope,
          record.call_id,
          record.content_sha256,
          record.invocation_digest,
          record.result_position,
        ) !== target.item_id
      )
        continue;
      timeline.records.set(record.call_id, record);
      timeline.rows.push({
        item_id: String(target.item_id),
        tool_call_id: record.call_id,
        tool_name: target.tool_name,
        kind: "tool",
        manageable: true,
        summary_line: summaryLine(record.content),
        tool_input: preview(invocation.arguments),
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
        summaryLine(
          item.visibility === "hidden" ? item.compacted : item.original,
        ) || summaryLine(item.original),
      bytes_size: bytes(item.original),
      tool_output: preview(item.original),
      ...(item.invocation_snapshot &&
      typeof item.invocation_snapshot === "object" &&
      "arguments" in item.invocation_snapshot
        ? { tool_input: preview(item.invocation_snapshot.arguments) }
        : {}),
      ...(item.visibility === "hidden"
        ? {
            replacement_text: preview(item.compacted),
            summary_pending: item.compaction_source === "summarize_pending",
          }
        : {}),
    };
  }

  private list(scope: string, query = ""): Reply {
    const timeline = this.timeline(scope);
    const items = this.store.items(scope);
    const stored = new Map(items.map((item) => [item.item_id, item]));
    const units = new Map(
      this.store.listUnits(scope).map((unit) => [String(unit.unit_id), unit]),
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
      if (item)
        merged = {
          ...row,
          ...this.itemRow(item),
          ...(row.tool_input !== undefined
            ? { tool_input: row.tool_input }
            : {}),
        };
      else {
        const unit = units.get(row.item_id);
        const hidden = unit?.visibility === "hidden";
        const version = Number(unit?.version ?? 1);
        merged = {
          status: hidden ? "hidden" : version > 1 ? "unhidden" : "visible",
          visibility: hidden ? "hidden" : "visible",
          version,
          tokens_display: "—",
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
    for (const item of items)
      if (!seen.has(item.item_id)) rows.push(this.itemRow(item));
    if (!timeline.rows.length) {
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
    const filtered = rows
      .filter(
        (row) =>
          !query ||
          [
            row.item_id,
            row.tool_call_id,
            row.summary_line,
            stored.get(row.item_id)?.compacted,
          ].some(
            (value) =>
              typeof value === "string" &&
              value.toLowerCase().includes(query.toLowerCase()),
          ),
      )
      .map((row) => ({ tokens_display: "—", ...row }));
    return {
      ok: true,
      scope_key: scope,
      items: filtered,
      capabilities: this.capabilities(scope),
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
    if (!item) {
      const record = [...this.timeline(scope).records.values()].find(
        (record) =>
          record.call_id === id ||
          itemId(
            scope,
            record.call_id,
            record.content_sha256,
            record.invocation_digest,
            record.result_position,
          ) === id,
      );
      if (!record) return { ok: false, error: "not_found" };
      if (expected !== undefined && expected !== 1)
        return { ok: false, error: "version_conflict" };
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
            itemId(
              scope,
              record.call_id,
              record.content_sha256,
              record.invocation_digest,
              record.result_position,
            ),
            selectableText(record.content),
            baseline,
            undefined,
            record.invocation,
            false,
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
        const fallback: Item = {
          item_id: itemId(
            scope,
            record.call_id,
            record.content_sha256,
            record.invocation_digest,
            record.result_position,
          ),
          tool_call_id: record.call_id,
          result_position: record.result_position,
          content_sha256: record.content_sha256,
          invocation_digest: record.invocation_digest,
          original: record.content,
          compacted:
            evaluated?.rendered ??
            `[hidden: ${record.invocation.tool_name} ${record.call_id}]\n${excerpt}`,
          excerpt_lines: evaluated?.choice?.lines ?? [...head, ...tail],
          visibility: "hidden",
          version: evaluated?.rendered ? 2 : 1,
          tool_name: String(record.invocation.tool_name),
          compaction_source: source,
          invocation_snapshot: record.invocation,
          context_hint: null,
          invocation_options_omitted: false,
          created_at: 0,
          updated_at: 0,
        };
        const saved = this.store.put(scope, fallback, undefined, true);
        return this.result(saved);
      }
    }
    if (!item) return { ok: false, error: "not_found" };
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
