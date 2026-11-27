import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  Store,
  bytes,
  defaults,
  invocationDigest,
  length,
  projectJsonToolResult,
  requiredEvidence,
  sha256,
  verifyProjection,
  type Config,
  type JsonProjection,
} from "../src/index.ts";
import { makeDriver } from "./runtime.ts";
interface GenerateSpec {
  kind: "repeat" | "matches" | "files" | "plain_text";
  prefix?: string;
  char?: string;
  count?: number;
  line_count?: number;
  line_chars?: number;
  special_line?: number;
  special_text?: string;
  file_count?: number;
  evidence_count?: number;
  path_chars?: number;
  padding_chars?: number;
}

interface FixtureCase {
  id: string;
  tool_name: string;
  data?: Record<string, unknown>;
  raw?: string;
  generate?: GenerateSpec;
  total_count?: number;
  expected: { schema: string | null; refusal: string | null };
}

const fixturePath = new URL(
  "../../../contracts/fixtures/json_projection.json",
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: FixtureCase[] };
const config: Config = { ...defaults };

function generatedContent(entry: FixtureCase): string {
  const spec = entry.generate!;
  if (spec.kind === "repeat") {
    return JSON.stringify({
      files: [(spec.prefix ?? "") + (spec.char ?? "").repeat(spec.count ?? 0)],
      total_count: entry.total_count,
    });
  }
  if (spec.kind === "matches") {
    const width = spec.line_chars ?? 180;
    const lines: string[] = [];
    for (let index = 0; index < (spec.line_count ?? 0); index += 1) {
      const text = index === spec.special_line
        ? (spec.special_text ?? "")
        : `Synthetic match row ${String(index).padStart(2, "0")} ` + "alpha beta gamma ".repeat(12);
      lines.push(text.slice(0, width));
    }
    return JSON.stringify({
      matches_format: "Synthetic format: path:line:text",
      matches_text: lines.join("\n"),
      total_count: lines.length,
      total_count_is_lower_bound: false,
      truncated: false,
      _hint: "Synthetic hint for the matches projection.",
    });
  }
  if (spec.kind === "plain_text") {
    const width = spec.line_chars ?? 160;
    const lines: string[] = [];
    for (let index = 0; index < (spec.line_count ?? 0); index += 1) {
      const text = `Synthetic plain text row ${String(index).padStart(3, "0")} ` + "alpha beta gamma ".repeat(20);
      lines.push(text.slice(0, width));
    }
    return lines.join("\n");
  }
  const count = spec.file_count ?? 0;
  const evidenceCount = spec.evidence_count ?? count;
  const pathWidth = spec.path_chars ?? 96;
  const paddingWidth = spec.padding_chars ?? pathWidth;
  const files: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index < evidenceCount) {
      const suffix = `row-${String(index).padStart(3, "0")}.txt`;
      files.push("synthetic/fixtures/" + "x".repeat(Math.max(0, pathWidth - 19 - suffix.length)) + suffix);
    } else {
      files.push(("synthetic filler " + "alpha beta gamma ".repeat(40)).slice(0, paddingWidth));
    }
  }
  return JSON.stringify({ files, total_count: count });
}

function contentFor(entry: FixtureCase): string {
  if (entry.raw !== undefined) {
    return entry.raw;
  }
  return entry.generate ? generatedContent(entry) : JSON.stringify(entry.data);
}

test("shared synthetic JSON projection vectors", () => {
  for (const entry of fixture.cases) {
    const content = contentFor(entry);
    const decision = projectJsonToolResult(content, entry.tool_name, config);
    assert.equal(decision.projection?.schema ?? null, entry.expected.schema, entry.id);
    assert.equal(decision.refusal ?? null, entry.expected.refusal, entry.id);
    if (!decision.projection) {
      continue;
    }
    const projection: JsonProjection = decision.projection;
    assert.equal(verifyProjection(content, entry.tool_name, projection, config), true, entry.id);
    assert.equal(projection.digest, sha256(content), entry.id);
    assert.ok(projection.lines.length <= 512, entry.id);
    assert.ok(bytes(projection.source) <= 32 * 1024, entry.id);
    assert.ok(projection.required.length <= config.max_evidence_excerpts, entry.id);
    assert.ok(
      projection.lines.every(
        (line) => length(line) <= Math.min(config.max_excerpt_line_length, 240),
      ),
      entry.id,
    );
    assert.equal(
      projection.lines[0],
      `projected ${projection.schema} schema-version = 1 digest = ${projection.digest}`,
      entry.id,
    );
    const tokens = projection.schema === "search_files_matches_v1"
      ? ["schema-version", "total_count", "total_count_is_lower_bound", "truncated"]
      : ["schema-version", "total_count"];
    for (const token of tokens) {
      assert.ok(projection.required.some((line) => line.includes(token)), `${entry.id}:${token}`);
    }
    const evidence = requiredEvidence(projection.source);
    assert.ok(evidence.every((line) => projection.required.includes(line)), `${entry.id}:evidence`);
    if (entry.id === "matches_success") {
      const middle = projection.required.find((line) => line.includes("synthetic/middle/evidence.txt"));
      assert.ok(middle, "middle evidence preserved");
    }
    if (entry.id === "metadata_substring") {
      assert.equal(projection.required.length, 4);
      assert.ok(!projection.required.some((line) => line.includes("total_count = synthetic note")));
    }
    assert.ok(projection.required.every((line) => projection.lines.includes(line)), entry.id);
    assert.equal(new Set(projection.required).size, projection.required.length, entry.id);
  }
});

test("strict parser rejects malformed and dangerous JSON", () => {
  const rejected = [
    '{"files":["synthetic/a.txt"],"total_count":1,"total_count":2}',
    '{"files":["synthetic/a.txt"],"total_count":NaN}',
    '{"files":["synthetic/a.txt"],"total_count":Infinity}',
    '{"files":["synthetic/a.txt"],"total_count":-Infinity}',
    '{"files":["synthetic/a.txt"],"total_count":1.0}',
    '{"files":["synthetic/a.txt"],"total_count":true}',
    '{"files":[{"path":"synthetic/a.txt"}],"total_count":1}',
    '{"files":["synthetic/a.txt"],"total_count":1} trailing',
  ];
  for (const raw of rejected) {
    const decision = projectJsonToolResult(raw, "search_files", config);
    assert.equal(decision.projection, undefined, raw);
    assert.equal(decision.refusal, "verification_failed", raw);
  }
});

test("budget limits and digest verification fail closed", () => {
  const success = fixture.cases.find((entry) => entry.id === "matches_success")!;
  const content = contentFor(success);
  const decision = projectJsonToolResult(content, "search_files", config);
  const projection = decision.projection!;
  assert.equal(verifyProjection(content, "search_files", projection, config), true);
  assert.equal(verifyProjection(`${content} `, "search_files", projection, config), false);
  assert.equal(
    projectJsonToolResult(content, "search_files", { ...config, max_excerpt_line_length: 95 }).refusal,
    "verification_failed",
  );
  assert.equal(
    projectJsonToolResult(content, "search_files", { ...config, max_evidence_excerpts: 2 }).refusal,
    "verification_failed",
  );
});
test("plain text fallback preserves legacy engine behavior", async () => {
  for (const id of ["plain_text_success", "plain_text_large"]) {
    const entry = fixture.cases.find((candidate) => candidate.id === id)!;
    const content = contentFor(entry);
    const decision = projectJsonToolResult(content, entry.tool_name, config);
    assert.equal(decision.projection, undefined, id);
    assert.equal(decision.refusal, undefined, id);
    const directory = mkdtempSync(join(tmpdir(), "navigation-json-fallback-"));
    const store = new Store(makeDriver(join(directory, "state.db")));
    try {
      const invocation = { tool_name: entry.tool_name, arguments: { pattern: "synthetic" } };
      const record = {
        call_id: `call_${id}`, result_position: 0, content,
        content_sha256: sha256(content), invocation,
        invocation_digest: invocationDigest(invocation), status: "ok", host_handle: { index: 1 },
      };
      const result = await new Engine(store).hide({ adapter_id: "hermes", host_profile: "test", session_id: id }, record);
      assert.equal(result.ok, true, `${id}: ${result.error}`);
      assert.ok(result.plan!.replacement_text.includes("Original excerpt:"), id);
      assert.ok(!result.plan!.replacement_text.includes("Projected JSON excerpt:"), id);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
