import { EngineError } from "./driver.ts";
import { evaluateCompaction, type Choice } from "./compaction.ts";
import {
  defaults,
  itemId,
  scopeKey,
  type Config,
  type Item,
  type Json,
  type Plan,
  type RecordInput,
  type Result,
  type ScopeLike,
} from "./model.ts";
import {
  isDestructive,
  normalizeKeepLines,
  refusalReason,
  requiredEvidence,
  selectRule,
  selectableText,
} from "./policy.ts";
import { validateSummary, summarySource, summaryWithRetry } from "./summary.ts";
import { Store } from "./store.ts";
export type Summarizer = (
  original: string,
  evidence: string[],
  invocation: Json,
  feedback?: string,
) => Promise<unknown>;

export interface HideOptions {
  keep_lines?: Json;
  options_omitted?: boolean;
  summarizer?: Summarizer;
  allow_fallback?: boolean;
}

export class Engine {
  private pending = new Set<string>();
  readonly store: Store;
  readonly config: Config;

  constructor(store: Store, config: Config = defaults) {
    this.store = store;
    this.config = config;
  }

  private replacementPlan(item: Item, record: RecordInput): Plan {
    return {
      item_id: item.item_id,
      expected_content_sha256: record.content_sha256,
      replacement_text: item.compacted,
      visibility_version: item.version,
      tool_call_id: record.call_id,
      ...(record.host_handle === undefined ? {} : { host_handle: record.host_handle }),
    };
  }

  async hide(scope: ScopeLike, record: RecordInput, options: HideOptions = {}): Promise<Result> {
    if (options.keep_lines !== undefined && options.summarizer) {
      return { ok: false, error: "invalid_keep_lines_action" };
    }
    if (options.keep_lines !== undefined && !Array.isArray(options.keep_lines)) {
      return { ok: false, error: "invalid_keep_lines" };
    }
    const retention = normalizeKeepLines(
      selectableText(record.content),
      (options.keep_lines ?? []) as Json[],
    );
    const diagnostics = {
      keep_lines_ignored: retention.ignored,
      keep_lines_normalized: retention.normalized,
    };
    try {
      return { ...(await this.apply(scope, record, retention.accepted, options)), ...diagnostics };
    } catch (error) {
      if (error instanceof EngineError) {
        return { ok: false, error: error.code, ...diagnostics };
      }
      throw error;
    }
  }

  summarize(
    scope: ScopeLike,
    record: RecordInput,
    summarizer: Summarizer,
    options_omitted = false,
  ): Promise<Result> {
    return this.hide(scope, record, { summarizer, allow_fallback: false, options_omitted });
  }

  private async apply(
    scope: ScopeLike,
    record: RecordInput,
    keepLines: string[],
    options: HideOptions,
  ): Promise<Result> {
    const refused = refusalReason(record, this.config);
    if (refused) {
      return { ok: false, error: refused };
    }
    const itemIdentity = itemId(
      scope,
      record.call_id,
      record.content_sha256,
      record.invocation_digest,
      record.result_position,
    );
    const existing = this.store.get(scope, itemIdentity);
    const upgrade = existing && options.summarizer && options.allow_fallback === false && !["llm", "llm_summary"].includes(existing.compaction_source);
    if (existing && !upgrade) {
      return this.rehideExisting(scope, record, existing, keepLines);
    }
    if (existing && existing.invocation_digest !== record.invocation_digest)
      return { ok: false, error: "invocation_conflict" };
    const baseline = selectRule(selectableText(record.content), keepLines, this.config);
    if (!baseline) {
      return { ok: false, error: keepLines.length && selectRule(selectableText(record.content), [], this.config)
        ? "keep_lines_too_broad" : "verification_failed" };
    }
    const reservationKey = `${scopeKey(scope)}\0${itemIdentity}`;
    if (this.pending.has(reservationKey)) {
      return { ok: false, error: "in_progress" };
    }
    if (this.pending.size >= this.config.max_pending) {
      return { ok: false, error: "pending_full" };
    }
    this.pending.add(reservationKey);
    try {
      let summary: unknown;
      if (options.summarizer) {
        try {
          summary =
            (await summaryWithRetry(summarySource(record.content), requiredEvidence(record.content),
              feedback => options.summarizer!(record.content, requiredEvidence(record.content), record.invocation, feedback),
              record.invocation)) ?? null;
        } catch (error) {
          if (options.allow_fallback === false) {
            return {
              ok: false,
              error: this.summarizationError(error),
            };
          }
          summary = undefined;
        }
      }
      const evaluated = evaluateCompaction(
        record.content,
        itemIdentity,
        selectableText(record.content),
        baseline,
        summary,
        record.invocation,
        options.options_omitted,
        options.allow_fallback !== false,
      );
      if (evaluated.error || !evaluated.choice || evaluated.rendered === undefined) {
        return { ok: false, error: evaluated.error ?? "verification_failed" };
      }
      const item = this.newItem(
        itemIdentity,
        record,
        evaluated.choice,
        evaluated.rendered,
        options,
      );
      if (existing) {
        const updated = { ...existing, compacted: item.compacted, excerpt_lines: item.excerpt_lines,
          compaction_source: item.compaction_source, invocation_snapshot: item.invocation_snapshot,
          invocation_options_omitted: item.invocation_options_omitted, visibility: "hidden" as const,
          version: existing.version + 1 };
        const result = this.store.put(scope, updated, existing.version);
        return result.ok ? { ...result, plan: this.replacementPlan(updated, record) } : result;
      }
      if (this.store.get(scope, itemIdentity)) {
        return { ok: false, error: "version_conflict" };
      }
      const result = this.store.put(scope, item, undefined, true);
      return result.ok ? { ...result, plan: this.replacementPlan(item, record) } : result;
    } finally {
      this.pending.delete(reservationKey);
    }
  }

  private summarizationError(error: unknown): string {
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : "summarization_failed";
  }

  private rehideExisting(
    scope: ScopeLike,
    record: RecordInput,
    existing: Item,
    keepLines: string[],
  ): Result {
    if (keepLines.some((line) => !existing.compacted.includes(line))) {
      return { ok: false, error: "keep_lines_conflict" };
    }
    if (existing.invocation_digest !== record.invocation_digest) {
      return { ok: false, error: "invocation_conflict" };
    }
    const result =
      existing.visibility === "hidden"
        ? { ok: true, item: existing }
        : this.store.put(
            scope,
            { ...existing, visibility: "hidden", version: existing.version + 1 },
            existing.version,
          );
    return result.ok ? { ...result, plan: this.replacementPlan(result.item!, record) } : result;
  }

  private newItem(
    itemIdentity: string,
    record: RecordInput,
    choice: Choice,
    rendered: string,
    options: HideOptions,
  ): Item {
    return {
      item_id: itemIdentity,
      tool_call_id: record.call_id,
      result_position: record.result_position,
      content_sha256: record.content_sha256,
      invocation_digest: record.invocation_digest,
      original: record.content,
      compacted: rendered,
      excerpt_lines: choice.lines,
      visibility: "hidden",
      version: 1,
      tool_name:
        typeof record.invocation.tool_name === "string" ? record.invocation.tool_name : null,
      compaction_source: choice.source,
      invocation_snapshot: choice.source === "llm" ? record.invocation : null,
      context_hint: null,
      invocation_options_omitted: choice.source === "llm" && !!options.options_omitted,
      created_at: 0,
      updated_at: 0,
    };
  }

  unhide(scope: ScopeLike, itemIdentity: string, version?: number): Result {
    try {
      return this.store.restore(scope, itemIdentity, version);
    } catch (error) {
      if (error instanceof EngineError) {
        return { ok: false, error: error.code };
      }
      throw error;
    }
  }

  project(scope: ScopeLike, records: RecordInput[]): Plan[] {
    return records.flatMap((record) => {
      const item = this.store.get(
        scope,
        itemId(
          scope,
          record.call_id,
          record.content_sha256,
          record.invocation_digest,
          record.result_position,
        ),
      );
      return item?.visibility === "hidden" ? [this.replacementPlan(item, record)] : [];
    });
  }

  listItems(scope: ScopeLike, query = ""): Item[] {
    return this.store
      .items(scope)
      .filter(
        (item) =>
          !query ||
          item.compacted.toLowerCase().includes(query.toLowerCase()) ||
          item.item_id.toLowerCase().includes(query.toLowerCase()),
      );
  }

  async manage(
    scope: ScopeLike,
    records: RecordInput[],
    ids: string[],
    action: "hide" | "summarize" | "auto",
    summarizer?: Summarizer,
    keep_lines?: Json,
  ): Promise<
    {
      id: string;
      result: Result;
    }[]
  > {
    const results: {
      id: string;
      result: Result;
    }[] = [];
    for (const itemIdentity of [...new Set(ids)]) {
      const matches = records.filter((candidate) => candidate.call_id === itemIdentity);
      let result: Result;
      if (!matches.length) {
        result = { ok: false, error: "not_found" };
      } else if (matches.length > 1) {
        result = { ok: false, error: "ambiguous" };
      } else {
        const record = matches[0];
        const item = this.store.get(
          scope,
          itemId(
            scope,
            itemIdentity,
            record.content_sha256,
            record.invocation_digest,
            record.result_position,
          ),
        );
        if (item?.visibility === "hidden") {
          result = { ok: false, error: "already_hidden" };
        } else if (isDestructive(record.invocation.tool_name, record.invocation.arguments)) {
          result = { ok: false, error: "destructive_command" };
        } else if (action === "summarize" && !summarizer) {
          result = { ok: false, error: "summarizer_unavailable" };
        } else {
          result = await this.hide(scope, record, {
            keep_lines,
            summarizer: action === "hide" ? undefined : summarizer,
            allow_fallback: action !== "summarize",
          });
        }
      }
      results.push({ id: itemIdentity, result });
    }
    return results;
  }

  settlePending(scope: ScopeLike, itemIdentity: string, version: number, text?: string): Result {
    const item = this.store.get(scope, itemIdentity);
    if (!item || item.version !== version) {
      return { ok: false, error: "version_conflict", item };
    }
    if (item.visibility !== "hidden" || item.compaction_source !== "summarize_pending") {
      return { ok: false, error: "not_pending", item };
    }
    const words = new Set(item.original.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
    const valid =
      typeof text === "string" &&
      [...text].length < [...item.original].length &&
      (text.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []).some((word) => words.has(word)) &&
      validateSummary(
        item.original,
        { summary: text },
        requiredEvidence(item.original),
        item.invocation_snapshot,
      );
    const result = this.store.put(
      scope,
      {
        ...item,
        compacted: valid ? text! : item.compacted,
        compaction_source: valid ? "llm_summary" : "explicit_user_hide",
        version: version + 1,
      },
      version,
    );
    return result.ok && text !== undefined && !valid
      ? { ...result, ok: false, error: "verification_failed" }
      : result;
  }
}
