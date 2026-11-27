import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  bytes,
  defaults,
  length,
  projectJsonToolResult,
  sha256,
  verifyProjection,
  type Config,
  type JsonProjection,
} from "../src/index.ts";

interface GenerateSpec {
  kind: "repeat" | "matches" | "files";
  prefix?: string;
  char?: string;
  count?: number;
  line_count?: number;
  line_chars?: number;
  special_line?: number;
  special_text?: string;
  file_count?: number;
  path_chars?: number;
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

function generatedData(entry: FixtureCase): Record<string, unknown> {
  const spec = entry.generate!;
  if (spec.kind === "repeat") {
    return {
      files: [(spec.prefix ?? "") + (spec.char ?? "").repeat(spec.count ?? 0)],
      total_count: entry.total_count,
    };
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
    return {
      matches_format: "Synthetic format: path:line:text",
      matches_text: lines.join("\n"),
      total_count: lines.length,
      total_count_is_lower_bound: false,
      truncated: false,
      _hint: "Synthetic hint for the matches projection.",
    };
  }
  const count = spec.file_count ?? 0;
  const width = spec.path_chars ?? 96;
  const files: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = `row-${String(index).padStart(3, "0")}.txt`;
    files.push("synthetic/fixtures/" + "x".repeat(Math.max(0, width - 19 - suffix.length)) + suffix);
  }
  return { files, total_count: count };
}

function contentFor(entry: FixtureCase): string {
  if (entry.raw !== undefined) {
    return entry.raw;
  }
  const data = entry.generate ? generatedData(entry) : entry.data;
  return JSON.stringify(data);
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
    assert.ok(
      projection.required.every((line) => projection.lines.includes(line)),
      entry.id,
    );
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
