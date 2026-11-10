import { readFileSync } from "node:fs";
import {
  Engine,
  Store,
  canonical,
  invocationDigest,
  itemId,
  normalizeKeepLines,
  parseCanonicalJson,
  refusalReason,
  requiredEvidence,
  scopeAliases,
  selectRule,
  selectableText,
  sha256,
  splitLines,
  validateSummary,
  verifiedFacts,
  isDestructive,
  type Json,
  type RecordInput,
} from "../src/index.ts";
import { makeDriver } from "./runtime.ts";
export interface TextVector {
  name: string;
  line: string;
  repeat: number;
  suffix: string;
  envelope?: boolean;
  numbered?: boolean;
  keep?: Json[];
  summary?: string;
}
export interface FixtureVectors {
  scope: string;
  canonical: string[];
  policies: TextVector[];
  summaries: {
    source: string;
    text: string;
  }[];
  commands: string[];
  engine: TextVector[];
}
export const fixtures: FixtureVectors = JSON.parse(
  readFileSync(new URL("../../../contracts/fixtures/core.json", import.meta.url), "utf8"),
) as FixtureVectors;
export function body(vector: TextVector): string {
  let content =
    Array(vector.repeat).fill(vector.line).join("\n") + (vector.suffix ? "\n" + vector.suffix : "");
  if (vector.numbered) {
    content = splitLines(content)
      .map((line, index) => `${index + 1}|${line}`)
      .join("\n");
  }
  return vector.envelope ? JSON.stringify({ content, exit_code: 0 }) : content;
}
export function record(content: string, itemIdentity = "call"): RecordInput {
  const invocation = { tool_name: "read_file", arguments: { path: "source.txt" } };
  return {
    call_id: itemIdentity,
    result_position: 0,
    content,
    content_sha256: sha256(content),
    invocation,
    invocation_digest: invocationDigest(invocation),
    status: "ok",
  };
}
export function snapshot(store: Store): unknown {
  return Object.fromEntries(
    ["meta", "items", "identities", "units", "calls", "adapter_sessions", "adapter_targets"].map(
      (table) => [
        table,
        store.driver.all(`SELECT * FROM ${table} ORDER BY 1,2`).map((row) => {
          const result = { ...row };
          for (const key of ["created_at", "updated_at", "recorded_at", "last_seen"]) {
            if (key in result) {
              result[key] = 0;
            }
          }
          for (const key of [
            "excerpt_lines",
            "invocation_snapshot",
            "context_hint",
            "capabilities",
          ]) {
            if (typeof result[key] === "string") {
              result[key] = JSON.parse(String(result[key])) as never;
            }
          }
          return result;
        }),
      ],
    ),
  );
}
const summarizeResult = (result: Awaited<ReturnType<Engine["hide"]>>) => ({
  ok: result.ok,
  error: result.error ?? null,
  plan: result.plan ?? null,
  item: result.item ? { ...result.item, created_at: 0, updated_at: 0 } : null,
  keep_lines_ignored: result.keep_lines_ignored ?? [],
  keep_lines_normalized: result.keep_lines_normalized ?? [],
});
function policyVectors(): unknown[] {
  return fixtures.policies.map((vector) => {
    const content = body(vector);
    const toolRecord = record(content);
    const retention = normalizeKeepLines(selectableText(content), vector.keep ?? []);
    return {
      name: vector.name,
      sha: sha256(content),
      digest: toolRecord.invocation_digest,
      id: itemId(
        fixtures.scope,
        toolRecord.call_id,
        toolRecord.content_sha256,
        toolRecord.invocation_digest,
      ),
      refusal: refusalReason(toolRecord) ?? null,
      source: selectableText(content),
      evidence: requiredEvidence(content),
      selected: selectRule(selectableText(content), retention.accepted) ?? null,
      retention,
      facts: verifiedFacts(content),
    };
  });
}

async function mutationVectors(): Promise<unknown[]> {
  const operations = [];
  for (const vector of fixtures.engine) {
    const store = new Store(makeDriver(":memory:"));
    const engine = new Engine(store);
    const toolRecord = record(body(vector));
    const hide = await engine.hide(
      fixtures.scope,
      toolRecord,
      vector.summary ? { summarizer: async () => ({ summary: vector.summary }) } : {},
    );
    const itemIdentity = itemId(
      fixtures.scope,
      toolRecord.call_id,
      toolRecord.content_sha256,
      toolRecord.invocation_digest,
    );
    const conflict = engine.unhide(fixtures.scope, itemIdentity, 99);
    const unhide = engine.unhide(fixtures.scope, itemIdentity, 1);
    const rehide = await engine.hide(fixtures.scope, toolRecord);
    const fork = store.fork(fixtures.scope, "hermes:default:child:unknown");
    operations.push({
      name: vector.name,
      hide: summarizeResult(hide),
      conflict: summarizeResult(conflict),
      unhide: summarizeResult(unhide),
      rehide: summarizeResult(rehide),
      fork,
      rows: snapshot(store),
    });
    store.close();
  }
  return operations;
}

async function sharedStoreVectors(): Promise<{ shared: unknown; pending: unknown[] }> {
  const store = new Store(makeDriver(":memory:"));
  const scope = fixtures.scope;
  const registration = {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: false, unhide: true },
    enabled: true,
    instance_id: "fixture",
  };
  const registered = [
    store.register(scope, registration, 100),
    store.register(scope, registration, 101),
    store.register(scope, registration, 400),
  ];
  const capability = [
    store.can(scope, "hide"),
    store.can(scope, "summarize"),
    store.can(scope.replace(/unknown$/, "default"), "hide"),
  ];
  const targets = Array.from({ length: 258 }, (_, index) => ({
    record: record(`original ${index}`, String(index)),
  }));
  store.publishTargets(scope, targets);
  const targetCalls = store.targets(scope).map((row) => row.tool_call_id);
  store.ensureMessages(scope, [
    { unit_id: "message", kind: "user", content_sha256: sha256("hi"), char_count: 2 },
  ]);
  const messages = [
    store.setMessageVisibility(scope, "message", "user", sha256("hi"), 2, "hidden", 1),
    store.setMessageVisibility(scope, "message", "user", sha256("hi"), 2, "visible", 1),
  ];
  store.recordCall(scope, "usage", 10, 20, 30, 0.25, 100);
  const schemaInfo = Object.fromEntries(
    ["meta", "items", "identities", "units", "calls", "adapter_sessions", "adapter_targets"].map(
      (table) => [table, store.driver.all(`PRAGMA table_info(${table})`)],
    ),
  );
  const shared = {
    registered,
    capability,
    targetCalls,
    messages,
    hidden: store.hiddenMessages(scope),
    rows: snapshot(store),
    schemaInfo,
  };
  const engine = new Engine(store);
  const toolRecord = record(body(fixtures.engine[0]), "pending");
  const item = (await engine.hide(scope, toolRecord)).item!;
  store.put(scope, { ...item, compaction_source: "summarize_pending", version: 2 }, 1);
  const pending = [
    summarizeResult(
      engine.settlePending(
        scope,
        item.item_id,
        2,
        "Routine catalog annotation with no special facts.",
      ),
    ),
    summarizeResult(engine.settlePending(scope, item.item_id, 2, "Routine catalog annotation.")),
  ];
  store.close();
  return { shared, pending };
}

export async function runVectors(): Promise<unknown> {
  const policies = policyVectors();
  const operations = await mutationVectors();
  const { shared, pending } = await sharedStoreVectors();
  return {
    canonical: fixtures.canonical.map((raw) => canonical(parseCanonicalJson(raw))),
    aliases: scopeAliases(fixtures.scope),
    policies,
    summaries: fixtures.summaries.map(
      (vector) => validateSummary(vector.source, { summary: vector.text }, []) ?? null,
    ),
    commands: fixtures.commands.map((command) => isDestructive("bash", { command })),
    operations,
    shared,
    pending,
  };
}
