import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  Store,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_LINES,
  inspectGenericJson,
  inspectGenericJsonWithEvidence,
  invocationDigest,
  parsedJsonEvidence,
  parsedJsonPolicyLines,
  parsedStringEvidenceLines,
  requiredEvidence,
  sha256,
  type Json,
  type RecordInput,
  type ScopeLike,
  type Summarizer,
} from "../src/index.ts";
import { makeDriver } from "./runtime.ts";

const summaryText = "Synthetic rows retained.";

function recordFor(content: string, callId: string): RecordInput {
  const invocation = { tool_name: "search_files", arguments: { pattern: "synthetic" } };
  return {
    call_id: callId,
    result_position: 0,
    content,
    content_sha256: sha256(content),
    invocation,
    invocation_digest: invocationDigest(invocation),
    status: "ok",
  };
}

function scopeFor(name: string) {
  return { adapter_id: "hermes", host_profile: "test", session_id: `json-evidence-${name}` };
}

async function withEngine(
  name: string,
  run: (engine: Engine, store: Store, scope: ScopeLike) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `navigation-json-evidence-${name}-`));
  const store = new Store(makeDriver(join(directory, "state.db")));
  try {
    await run(new Engine(store), store, scopeFor(name));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function filesContent(count: number, padding = 80, withNote = true): string {
  const files = Array.from(
    { length: count },
    (_, index) => `synthetic/fixtures/${"x".repeat(12)}row-${String(index).padStart(3, "0")}.txt`,
  );
  return JSON.stringify({
    files,
    total_count: count,
    ...(withNote ? { note: summaryText } : {}),
    ...(padding ? { padding: "alpha beta gamma delta ".repeat(padding) } : {}),
  });
}

function matchesContent(lines: string[]): string {
  return JSON.stringify({
    matches_format: "Synthetic format: path:line:text",
    matches_text: lines.join("\n"),
    total_count: lines.length,
    note: summaryText,
  });
}

function adversarialContent(kind: "protected" | "escaped"): string {
  const middle =
    kind === "protected"
      ? "synthetic/fixtures/invoice.txt: FAILED duplicate invoice still unresolved"
      : "synthetic/fixtures/invoice.txt: \\u0045RROR middle result unresolved";
  const content = JSON.stringify({
    matches_format: "Synthetic format: path:line:text",
    matches_text: [
      "synthetic/fixtures/header.txt previous step ok",
      middle,
      "synthetic/fixtures/footer.txt next step ok",
    ].join("\n"),
    padding: "alpha beta gamma delta ".repeat(60),
    total_count: 3,
    note: summaryText,
  });
  // Keep the raw JSON escaped but let the strict parser decode the marker.
  return kind === "escaped" ? content.replace("\\\\u0045RROR", "\\u0045RROR") : content;
}

function isPreserved(result: { ok: boolean; error?: string }): boolean {
  return (
    result.ok || result.error === "verification_failed" || result.error === "compression_insufficient"
  );
}

function verifiedJsonContext(context: Json | undefined): {
  rawKeys: string[];
  verifiedJson: string;
  metadata: Json;
} {
  assert.ok(context && typeof context === "object" && !Array.isArray(context));
  assert.ok("verified_json" in context && typeof context.verified_json === "string");
  const verifiedJson = context.verified_json;
  const metadata: Json = JSON.parse(verifiedJson);
  return { rawKeys: Object.keys(context), verifiedJson, metadata };
}

test("strict inspection and bounded parsed evidence match the shared contract", () => {
  const vectors = [
    {
      content: '{"b":2,"a":1,"n":1e3,"s":"é\\u0000","obj":{"x":true},"list":[10,20,30,40]}',
      evidence: [
        "a: 1",
        "b: 2",
        "list: list(4)",
        "list[0]: 10",
        "list[1]: 20",
        "list[2]: 30",
        "list[3]: 40",
        "n: 1e3",
        "obj: object",
        's: "é\\u0000"',
      ],
    },
    {
      content: '[1,"x",null,true,[2],{"k":3}]',
      evidence: ["items: 6", "[0]: 1", '[1]: "x"'],
    },
    { content: "42", evidence: ["value: 42"] },
    { content: "{}", evidence: [] },
    { content: "[]", evidence: ["items: 0"] },
    { content: '{"a":1,"a":2}', evidence: [] },
    { content: '{"value":NaN}', evidence: [] },
    { content: '{"value":1e999}', evidence: [] },
    { content: '{"value":"a\\u2028b"}', evidence: [] },
  ];
  for (const vector of vectors) {
    assert.deepEqual(parsedJsonEvidence(vector.content), vector.evidence, vector.content);
  }
  assert.equal(inspectGenericJson('{"a":1,"a":2}').refusal, "verification_failed");
  assert.equal(inspectGenericJson('{"value":1e999}').refusal, "verification_failed");
  assert.equal(inspectGenericJson(`{"padding":"${"x".repeat(70_000)}"}`).refusal, "input_too_large");
  assert.equal(inspectGenericJson(null as unknown as string).refusal, "verification_failed");
  assert.equal(inspectGenericJson('{"value":"a\u2028b"}').refusal, "verification_failed");

  const long = parsedJsonEvidence(JSON.stringify({ s: "x".repeat(300) }));
  assert.equal([...long[0]].length, 240);
  assert.ok(long[0].endsWith("..."));
  assert.equal(long[1], "s_chars: 300");
});

test("parsed evidence keeps required and protected lines hidden inside scalars", () => {
  const escaped = adversarialContent("escaped");
  const evidence = parsedJsonEvidence(escaped);
  const decisive = "matches_text: synthetic/fixtures/invoice.txt: ERROR middle result unresolved";
  assert.ok(evidence.includes(decisive), JSON.stringify(evidence));
  assert.ok(parsedJsonPolicyLines(escaped).some((line) => line.includes("ERROR")));
  assert.ok(parsedStringEvidenceLines("ERROR: nested envelope failure").includes("ERROR: nested envelope failure"));
  assert.ok(parsedStringEvidenceLines('{"content":"\\u0045RROR: inner failure"}').includes("ERROR: inner failure"));

  const wrapped = parsedJsonEvidence(JSON.stringify({ payload: '{"content":"\\u0045RROR: inner failure"}' }));
  assert.ok(wrapped.some((line) => line.includes("ERROR: inner failure")), JSON.stringify(wrapped));

  const protectedLines = parsedJsonEvidence(adversarialContent("protected"));
  assert.ok(protectedLines.some((line) => line.includes("FAILED duplicate invoice")));
  assert.ok(protectedLines.length <= MAX_EVIDENCE_LINES);
  assert.ok(
    protectedLines.reduce((total, line) => total + new TextEncoder().encode(line).length, 0) <=
      MAX_EVIDENCE_BYTES,
  );
});

test("over-budget parsed evidence fails closed before any callback or write", async () => {
  const cases = [
    Array.from({ length: 70 }, (_, index) =>
      `synthetic/fixtures/row-${String(index).padStart(3, "0")}.txt duplicate invoice ${"alpha ".repeat(5)}`,
    ).join("\n"),
    Array.from({ length: 40 }, (_, index) =>
      `synthetic/fixtures/row-${String(index).padStart(3, "0")}.txt duplicate invoice ${"alpha ".repeat(50)}`,
    ).join("\n"),
  ];
  for (const [index, text] of cases.entries()) {
    const content = JSON.stringify({ matches_text: text, total_count: text.split("\n").length });
    const inspected = inspectGenericJsonWithEvidence(content);
    assert.equal(inspected.decision.ok, false, `budget ${index}`);
    assert.equal(inspected.decision.refusal, "verification_failed");
    assert.deepEqual(inspected.evidence, []);
    assert.deepEqual(parsedJsonEvidence(content), []);

    await withEngine(`budget-${index}`, async (engine, store, scope) => {
      const record = recordFor(content, `call_budget_${index}`);
      let calls = 0;
      const result = await engine.summarize(scope, record, async () => {
        calls += 1;
        return { summary: summaryText };
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "verification_failed");
      assert.equal(result.item, undefined);
      assert.equal(result.plan, undefined);
      assert.equal(calls, 0);
      assert.equal(store.items(scope).length, 0);
      assert.equal(record.content, content);
      const managed = await engine.manage(scope, [record], [record.call_id], "summarize", async () => {
        calls += 1;
        return { summary: summaryText };
      });
      assert.equal(managed[0].result.error, "verification_failed");
      assert.equal(calls, 0);
    });
  }
});

test("files payload summarize passes parsed evidence and context, keeps and restores the original", async () => {
  const content = filesContent(22);
  const decision = inspectGenericJson(content);
  const evidence = parsedJsonEvidence(content);
  assert.equal(decision.ok, true);
  assert.ok(evidence.includes("files: list(22)"));
  assert.deepEqual(evidence, parsedJsonEvidence(content));
  assert.notDeepEqual(evidence, requiredEvidence(content));
  assert.ok(evidence.length <= MAX_EVIDENCE_LINES);
  assert.ok(
    evidence.reduce((total, line) => total + new TextEncoder().encode(line).length, 0) <=
      MAX_EVIDENCE_BYTES,
  );

  await withEngine("files22", async (engine, store, scope) => {
    const record = recordFor(content, "call_files22");
    const calls: { original: string; evidence: string[]; context?: Json; feedback?: string }[] = [];
    const summarizer: Summarizer = async (original, supplied, _invocation, feedback, context) => {
      calls.push({ original, evidence: supplied, context, feedback });
      return { summary: summaryText };
    };
    const result = await engine.summarize(scope, record, summarizer);
    assert.equal(result.ok, true, result.error ?? "summarize failed");
    assert.equal(result.item?.compaction_source, "llm");
    assert.equal(result.item?.original, content);
    assert.ok(result.plan?.replacement_text.includes(`Summary: ${JSON.stringify(summaryText)}`));
    for (const line of evidence) {
      assert.ok(result.plan!.replacement_text.includes(line), `missing ${line}`);
    }
    assert.equal(store.get(scope, result.plan!.item_id)?.compacted, result.plan?.replacement_text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].original, content);
    assert.deepEqual(calls[0].evidence, evidence);
    assert.equal(calls[0].feedback, undefined);
    const received = verifiedJsonContext(calls[0].context);
    assert.deepEqual(received.rawKeys, ["verified_json"]);
    assert.deepEqual(received.metadata, {
      kind: decision.kind,
      nodes: decision.nodes,
      depth: decision.depth,
      digest: decision.digest,
    });
    assert.equal(received.verifiedJson.includes(content), false);
    assert.equal(record.content, content);

    const restored = engine.unhide(scope, result.plan!.item_id, result.item!.version);
    assert.equal(restored.ok, true, restored.error ?? "unhide failed");
    assert.equal(restored.item?.visibility, "visible");
    assert.equal(restored.item?.original, content);
    assert.equal(record.content, content);
  });
});

test("forty-file payload keeps every parsed evidence line and its summary factual", async () => {
  const content = filesContent(40, 320, false);
  const decision = inspectGenericJson(content);
  const evidence = parsedJsonEvidence(content);
  assert.ok(evidence.includes("files: list(40)"));
  assert.ok(evidence.length <= MAX_EVIDENCE_LINES);
  assert.ok(
    evidence.reduce((total, line) => total + new TextEncoder().encode(line).length, 0) <=
      MAX_EVIDENCE_BYTES,
  );

  await withEngine("files40", async (engine, store, scope) => {
    const record = recordFor(content, "call_files40");
    const calls: string[][] = [];
    const summarizer: Summarizer = async (_original, supplied, _invocation, _feedback, context) => {
      calls.push(supplied);
      assert.deepEqual(verifiedJsonContext(context).metadata, {
        kind: decision.kind,
        nodes: decision.nodes,
        depth: decision.depth,
        digest: decision.digest,
      });
      return { summary: "Found 40 synthetic fixture files." };
    };
    const result = await engine.summarize(scope, record, summarizer);
    assert.equal(result.ok, true, result.error ?? "files40 summarize failed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], evidence);
    for (const line of evidence) {
      assert.ok(result.plan!.replacement_text.includes(line), `missing ${line}`);
    }
    assert.equal(result.item?.original, content);
    assert.equal(store.get(scope, result.plan!.item_id)?.compacted, result.plan?.replacement_text);
    const restored = engine.unhide(scope, result.plan!.item_id, result.item!.version);
    assert.equal(restored.ok, true, restored.error ?? "unhide failed");
    assert.equal(restored.item?.original, content);
  });
});

test("matches payload summarize works with legacy four-argument summarizers and retry feedback", async () => {
  const lines = Array.from(
    { length: 4 },
    (_, index) =>
      `synthetic/fixtures/row-${String(index).padStart(3, "0")}.txt evidence=stable ` +
      "alpha beta gamma ".repeat(80),
  );
  const content = matchesContent(lines);
  const evidence = parsedJsonEvidence(content);
  assert.ok(evidence.includes("total_count: 4"));
  assert.ok(evidence.some((line) => line.includes("row-000.txt")));
  assert.ok(evidence.length <= MAX_EVIDENCE_LINES);

  await withEngine("matches", async (engine, store, scope) => {
    const record = recordFor(content, "call_matches");
    const attempts: { evidence: string[]; feedback?: string; context?: Json }[] = [];
    const legacy: Summarizer = async (_original, supplied, _invocation, feedback) => {
      attempts.push({ evidence: supplied, feedback });
      return attempts.length === 1
        ? { summary: "Unsupported count: 999999." }
        : { summary: summaryText };
    };
    const result = await engine.summarize(scope, record, legacy);
    assert.equal(result.ok, true, result.error ?? "retry failed");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].evidence, evidence);
    assert.deepEqual(attempts[1].evidence, evidence);
    assert.equal(attempts[0].feedback, undefined);
    assert.ok(attempts[1].feedback);
    assert.ok(result.plan?.replacement_text.includes(`Summary: ${JSON.stringify(summaryText)}`));
    assert.equal(store.get(scope, result.plan!.item_id)?.compacted, result.plan?.replacement_text);
    assert.equal(record.content, content);

    const again = await engine.summarize(scope, record, async () => {
      throw new Error("cached summary must not call the model");
    });
    assert.equal(again.ok, true, again.error ?? "summarize failed");
    assert.equal(again.item?.item_id, result.item?.item_id);
    assert.equal(again.item?.version, result.item?.version);
    assert.equal(again.item?.compacted, result.item?.compacted);
    assert.equal(store.items(scope).length, 1);
  });
});

test("fake no-issue summaries cannot drop a critical middle line", async () => {
  for (const kind of ["protected", "escaped"] as const) {
    const content = adversarialContent(kind);
    const key = kind === "protected" ? "duplicate invoice" : "ERROR middle result unresolved";
    const evidence = parsedJsonEvidence(content);
    assert.ok(evidence.some((line) => line.includes(key)), JSON.stringify(evidence));
    if (kind === "escaped") {
      const decisive = "matches_text: synthetic/fixtures/invoice.txt: ERROR middle result unresolved";
      assert.ok(evidence.indexOf(decisive) < evidence.indexOf("total_count: 3"));
    }

    await withEngine(`adversarial-${kind}`, async (engine, store, scope) => {
      const record = recordFor(content, `call_adversarial_${kind}`);
      let calls = 0;
      const summarizer: Summarizer = async () => {
        calls += 1;
        return { summary: "No issues found." };
      };
      const result = await engine.summarize(scope, record, summarizer);
      assert.equal(result.ok, false, `${kind}: expected refusal`);
      assert.equal(calls, 0);
      assert.equal(result.item, undefined);
      assert.equal(result.plan, undefined);
      assert.equal(store.items(scope).length, 0);
      assert.equal(record.content, content);
    });
  }
});

test("dense search evidence fails compression closed instead of inventing a clean result", async () => {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `results/row-${String(index).padStart(3, "0")}.txt:${index + 1}: routine match`,
  );
  lines[20] = "results/row-020.txt:21: FAILED unresolved duplicate invoice";
  const content = matchesContent(lines);
  const evidence = parsedJsonEvidence(content);
  assert.ok(evidence.some((line) => line.includes("duplicate invoice")));

  await withEngine("dense40", async (engine, store, scope) => {
    const record = recordFor(content, "call_dense40");
    const result = await engine.summarize(scope, record, async () => ({
      summary: "Routine matches found; no issues reported.",
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error, "protected_error");
    assert.equal(result.item, undefined);
    assert.equal(result.plan, undefined);
    assert.equal(store.items(scope).length, 0);
    assert.equal(record.content, content);
  });
});

test("invalid JSON and model failures leave the original and store untouched", async () => {
  const invalid = ['{"a":1,"a":2}', '{"value":NaN}', '{"kind":', `{"padding":"${"x".repeat(70_000)}"}`];
  for (const [index, content] of invalid.entries()) {
    await withEngine(`invalid-${index}`, async (engine, store, scope) => {
      const record = recordFor(content, `call_invalid_${index}`);
      let calls = 0;
      const result = await engine.summarize(scope, record, async () => {
        calls += 1;
        return { summary: summaryText };
      });
      assert.equal(result.ok, false);
      assert.equal(calls, 0);
      assert.equal(result.item, undefined);
      assert.equal(result.plan, undefined);
      assert.equal(store.items(scope).length, 0);
      assert.equal(record.content, content);
    });
  }

  const content = filesContent(3);
  await withEngine("model-failure", async (engine, store, scope) => {
    const record = recordFor(content, "call_model_failure");
    const throwing = await engine.summarize(scope, record, async () => {
      throw Object.assign(new Error("model failed"), { reason: "model_unavailable" });
    });
    assert.equal(throwing.error, "model_unavailable");
    assert.equal(store.items(scope).length, 0);
    assert.equal(record.content, content);

    const rejected = await engine.summarize(scope, record, async () => ({
      summary: "Synthetic count 999999.",
    }));
    assert.equal(rejected.ok, false);
    assert.equal(store.items(scope).length, 0);
    assert.equal(record.content, content);
    assert.equal(inspectGenericJson(content).digest, inspectGenericJson(content).digest);
  });
});

test("ordinary hide still projects search_files JSON and unhide restores the original", async () => {
  const content = filesContent(22, 0, false);
  await withEngine("hide-projection", async (engine, store, scope) => {
    const record = recordFor(content, "call_hide_projection");
    const hidden = await engine.hide(scope, record);
    assert.equal(hidden.ok, true, hidden.error ?? "projection failed");
    assert.equal(hidden.item?.compaction_source, "rule");
    assert.match(hidden.item!.compacted, /projected search_files_files_v2/);
    assert.match(hidden.item!.compacted, /total_count=22/);
    assert.match(hidden.item!.compacted, /unhide_context/);
    assert.equal(store.get(scope, hidden.plan!.item_id)?.compacted, hidden.plan?.replacement_text);
    const restored = engine.unhide(scope, hidden.plan!.item_id, hidden.item!.version);
    assert.equal(restored.ok, true, restored.error ?? "unhide failed");
    assert.equal(restored.item?.original, content);
    assert.equal(record.content, content);
  });
});
