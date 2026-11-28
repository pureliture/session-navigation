import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  FILES_EVIDENCE_CAP,
  FILES_REPLACEMENT_LABEL,
  MAX_PROJECTION_LINE_LENGTH,
  Store,
  bytes,
  defaults,
  invocationDigest,
  length,
  projectJsonToolResult,
  requiredEvidence,
  sha256,
  verifyFilesReplacement,
  verifyProjection,
  type Config,
  type JsonProjection,
} from "../src/index.ts";
import { makeDriver } from "./runtime.ts";
interface GenerateSpec {
  kind:
    | "matches_boundary"
    | "repeat"
    | "matches"
    | "matches_realistic"
    | "files"
    | "files_basename"
    | "files_varied"
    | "files_empty"
    | "plain_text";
  evidence?: string;
  prefix_unit?: string;
  suffix_unit?: string;
  prefix_chars?: number;
  suffix_chars?: number;
  prefix?: string;
  char?: string;
  count?: number;
  line_count?: number;
  line_chars?: number;
  special_line?: number;
  special_text?: string;
  file_count?: number;
  evidence_count?: number;
  long_count?: number;
  long_chars?: number;
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
  if (spec.kind === "matches_realistic") {
    const lineCount = spec.line_count ?? 0;
    const evidenceCount = spec.evidence_count ?? lineCount;
    const longCount = spec.long_count ?? 0;
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      const prefix = index < evidenceCount
        ? `synthetic/fixtures/row-${String(index).padStart(3, "0")}.txt evidence=stable `
        : "synthetic filler ";
      const width = index < evidenceCount && index < longCount
        ? (spec.long_chars ?? 361)
        : (spec.line_chars ?? 180);
      lines.push((prefix + "alpha beta gamma ".repeat(40)).slice(0, width));
    }
    return JSON.stringify({
      matches_format: "Synthetic format: path:line:text",
      matches_text: lines.join("\n"),
      total_count: lines.length,
      total_count_is_lower_bound: false,
      truncated: false,
      _hint: "Synthetic hint for the realistic projection.",
    });
  }
  if (spec.kind === "matches_boundary") {
    const fill = (unit: string, width: number): string => {
      const chars = [...unit];
      const repeated = Array.from({ length: Math.floor(width / chars.length) + 1 }, () => unit).join("");
      const clipped = [...repeated].slice(0, width).join("");
      return clipped.endsWith(" ") ? clipped : [...clipped].slice(0, -1).join("") + " ";
    };
    const tokens: Record<string, string> = {
      uuid: "01234567-89ab-cdef-0123-456789abcdef",
      path: "synthetic/fixtures/invoice-2026-11-28.txt",
      protected_error: "ERROR: unresolved synthetic failure remains protected",
      none: "",
    };
    const token = tokens[spec.evidence ?? "uuid"];
    const prefix = fill(spec.prefix_unit ?? "alpha beta gamma ", spec.prefix_chars ?? 184);
    const suffix = " " + fill(spec.suffix_unit ?? "delta epsilon zeta ", (spec.suffix_chars ?? 400) - 1);
    const lines = [prefix + token + suffix, "synthetic tail row after boundary"];
    return JSON.stringify({
      matches_format: "Synthetic format: path:line:text",
      matches_text: lines.join("\n"),
      total_count: lines.length,
      total_count_is_lower_bound: false,
      truncated: false,
      _hint: "Synthetic hint for the long-evidence boundary.",
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
  if (spec.kind === "files_basename") {
    const files: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      files.push(`synthetic-shared-basename-${"x".repeat(250)}-row-${String(index % 20).padStart(2, "0")}.txt`);
    }
    return JSON.stringify({ files, total_count: files.length });
  }
  if (spec.kind === "files_varied") {
    const files = [
      "alpha/first/one.txt", "beta/second/two.txt", "alpha/first/one.txt",
      "gamma/third/three.txt", "", "beta/second/two.txt", "delta/four/four.txt",
    ];
    return JSON.stringify({ files, total_count: files.length });
  }
  if (spec.kind === "files_empty") {
    const files = ["", "synthetic/alpha/one.txt", "synthetic/beta/two.txt", "synthetic/alpha/one.txt"];
    return JSON.stringify({ files, total_count: files.length });
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

function commonPrefix(values: string[]): string {
  let prefix = [...values[0]];
  for (const value of values.slice(1)) {
    const characters = [...value];
    let index = 0;
    while (index < prefix.length && index < characters.length && prefix[index] === characters[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
  }
  return prefix.join("");
}

function decodeFilesProjection(source: string): { prefix: string; suffixes: string[] } {
  const lines = source.split("\n");
  let prefix = "";
  let offset = 0;
  const suffixes: string[] = [];
  let pending: { index: number; chunks: { offset: number; value: string }[] } | undefined;
  const finishPending = (): void => {
    if (!pending) return;
    let expected = 0;
    let value = "";
    for (const chunk of pending.chunks) {
      assert.equal(chunk.offset, expected);
      value += chunk.value;
      expected += [...chunk.value].length;
    }
    assert.equal(pending.index, suffixes.length);
    suffixes.push(value);
    pending = undefined;
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("p;prefix+")) {
      const separator = line.indexOf("=");
      assert.equal(Number(line.slice("p;prefix+".length, separator)), offset);
      const part: unknown = JSON.parse(line.slice(separator + 1));
      assert.equal(typeof part, "string");
      prefix += part as string;
      offset += [...(part as string)].length;
    } else if (line.startsWith("p;suffixes=[")) {
      finishPending();
      const values: unknown = JSON.parse(line.slice(line.indexOf("=") + 1));
      assert.ok(Array.isArray(values));
      assert.ok(values.every((value) => typeof value === "string"));
      suffixes.push(...(values as string[]));
    } else {
      const match = /^p;suffix\+(\d+)\+(\d+)=/.exec(line);
      assert.ok(match, line);
      const index = Number(match![1]);
      const part: unknown = JSON.parse(line.slice(line.indexOf("=") + 1));
      assert.equal(typeof part, "string");
      if (pending && pending.index !== index) finishPending();
      if (!pending) {
        assert.equal(index, suffixes.length);
        pending = { index, chunks: [] };
      }
      pending.chunks.push({ offset: Number(match![2]), value: part as string });
    }
  }
  finishPending();
  return { prefix, suffixes };
}

function escapedFilesContent(paths: string[]): string {
  const escape = (value: string): string =>
    [...value]
      .map((character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
      .join("");
  return `{"files":[${paths.map((path) => `"${escape(path)}"`).join(",")}],"total_count":${paths.length}}`;
}

function decodeEngineReplacement(
  rendered: string,
  itemId: string,
): { lines: string[]; prefix: string; suffixes: string[] } {
  const rows = rendered.split("\n");
  assert.equal(rows[0], `[hidden:${itemId}]`);
  assert.equal(
    rows[rows.length - 1],
    `The remaining result is preserved. Restore it with unhide_context(${itemId}).`,
  );
  const label = `${FILES_REPLACEMENT_LABEL}: `;
  const lines = rows.slice(1, -1).map((row) => {
    assert.ok(row.startsWith(label), `unlabeled replacement line: ${row}`);
    return row.slice(label.length);
  });
  const { prefix, suffixes } = decodeFilesProjection(lines.join("\n"));
  return { lines, prefix, suffixes };
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
    assert.ok(
      projection.required.length <=
        (projection.schema === "search_files_files_v2" ? FILES_EVIDENCE_CAP : config.max_evidence_excerpts),
      entry.id,
    );
    assert.ok(
      projection.lines.every(
        (line) =>
          length(line) <=
          (projection.schema === "search_files_files_v2"
            ? MAX_PROJECTION_LINE_LENGTH
            : Math.min(config.max_excerpt_line_length, 240)),
      ),
      entry.id,
    );
    if (projection.schema === "search_files_files_v2") {
      const original = JSON.parse(content) as { files: string[]; total_count: number };
      const { prefix, suffixes } = decodeFilesProjection(projection.source);
      const expectedPrefix = original.files.some((path) => path === "")
        ? ""
        : commonPrefix(original.files);
      assert.equal(prefix, expectedPrefix, `${entry.id}:prefix`);
      assert.deepEqual(
        suffixes.map((suffix) => prefix + suffix),
        original.files,
        `${entry.id}:reconstruction`,
      );
      const headerMatch =
        /^projected search_files_files_v2 v=2 digest=([0-9a-f]{64}) total_count=(\d+) items=(\d+) verified=(\d+) evidence=(\d+) note=prefix\+suffix;restore=unhide_context$/.exec(
          projection.lines[0],
        );
      assert.ok(headerMatch, `${entry.id}:header`);
      assert.equal(headerMatch![1], sha256(content), `${entry.id}:digest`);
      assert.equal(headerMatch![2], String(original.total_count), `${entry.id}:total_count`);
      assert.equal(headerMatch![3], String(original.files.length), `${entry.id}:items`);
      assert.equal(headerMatch![4], String(original.files.length), `${entry.id}:verified`);
      assert.equal(
        headerMatch![5],
        String(original.files.filter((path) => requiredEvidence(path).length > 0).length),
        `${entry.id}:evidence`,
      );
      assert.ok(projection.required.includes(projection.lines[0]), `${entry.id}:header-required`);
      assert.deepEqual(projection.required, projection.lines, `${entry.id}:all-lines-required`);
      if (entry.id === "files_success") {
        const packed = projection.lines.filter((line) => line.startsWith("p;suffixes=["));
        assert.ok(packed.length > 0, "suffixes stay readable in packed JSON array lines");
      }
      if (entry.id === "files_varied") {
        assert.equal(prefix, "", "empty value disables prefix splitting");
        assert.equal(new Set(original.files).size, original.files.length - 2, "duplicates preserved");
      }
      if (entry.id === "files_empty") {
        assert.equal(prefix, "", "empty value disables prefix splitting");
        assert.ok(suffixes.includes(""), "empty value preserved in suffix array");
      }
    } else {
      assert.equal(
        projection.lines[0],
        `projected search_files_matches_v1 schema-version = 1 digest = ${projection.digest}`,
        entry.id,
      );
      for (const token of ["schema-version", "total_count", "total_count_is_lower_bound", "truncated"]) {
        assert.ok(projection.required.some((line) => line.includes(token)), `${entry.id}:${token}`);
      }
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
    if (projection.schema !== "search_files_files_v2") {
      assert.equal(new Set(projection.required).size, projection.required.length, entry.id);
    }
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

test("files v2 verifier fails closed on tampered projections", () => {
  const entry = fixture.cases.find((candidate) => candidate.id === "files_realistic_shape")!;
  const content = contentFor(entry);
  const projection = projectJsonToolResult(content, "search_files", config).projection!;
  assert.equal(verifyProjection(content, "search_files", projection, config), true);
  const tamperedSuffix = {
    ...projection,
    source: projection.source.replace('p;prefix+0="', 'p;prefix+0="X'),
  };
  assert.equal(verifyProjection(content, "search_files", tamperedSuffix, config), false);
  const tamperedHeader = projection.lines[0].replace("verified=", "verified=9x=");
  assert.equal(
    verifyProjection(
      content,
      "search_files",
      { ...projection, lines: [tamperedHeader, ...projection.lines.slice(1)] },
      config,
    ),
    false,
  );
  assert.equal(verifyProjection(content, "read_file", projection, config), false);
});

test("files v2 engine uses the prefix+suffix label and rejects lost verbatim keep lines", async () => {
  const entry = fixture.cases.find((candidate) => candidate.id === "files_success")!;
  const content = contentFor(entry);
  const invocation = { tool_name: entry.tool_name, arguments: { pattern: "synthetic" } };
  const record = {
    call_id: "call_files_v2", result_position: 0, content,
    content_sha256: sha256(content), invocation,
    invocation_digest: invocationDigest(invocation), status: "ok", host_handle: { index: 1 },
  };
  const scope = { adapter_id: "hermes", host_profile: "test", session_id: "json-files-v2" };
  const directory = mkdtempSync(join(tmpdir(), "navigation-json-files-v2-"));
  const store = new Store(makeDriver(join(directory, "state.db")));
  try {
    const engine = new Engine(store, config);
    const result = await engine.hide(scope, record);
    assert.equal(result.ok, true, result.error ?? "hide failed");
    assert.ok(
      result.plan!.replacement_text.includes("Projected JSON (prefix+suffix; restore with unhide_context):"),
      "files v2 label",
    );
    const conflict = await engine.hide(
      { adapter_id: "hermes", host_profile: "test", session_id: "json-files-v2-conflict" },
      { ...record, call_id: "call_files_v2_conflict" },
      { keep_lines: ["row-000"] },
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "keep_lines_conflict");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("files v2 replacement text preserves every reconstructed path", async () => {
  const sharedPrefix = `shared-${"x".repeat(700)}-item-`;
  const basenames = Array.from(
    { length: 40 },
    (_, index) => `${sharedPrefix}${String(index).padStart(2, "0")}.txt`,
  );
  const chunkedPath = `${sharedPrefix}${"y".repeat(2500)}.txt`;
  const duplicatePaths = Array.from(
    { length: 6 },
    (_, index) => `duplicate-${"z".repeat(80)}-${String(index).padStart(2, "0")}.txt`,
  );
  const mixedPaths = [
    ...Array.from({ length: 40 }, (_, index) => `basename-${"q".repeat(60)}-${index}.txt`),
    ...Array.from({ length: 6 }, (_, index) => `synthetic/fixtures/row-${index}.txt`),
  ];
  const variants = [
    {
      id: "non-evidence-and-chunk-split",
      paths: [...basenames, chunkedPath],
      content: JSON.stringify({
        files: [...basenames, chunkedPath],
        total_count: basenames.length + 1,
      }),
    },
    {
      id: "duplicates-and-blank",
      paths: ["", ...duplicatePaths, ...duplicatePaths, ""],
      content: escapedFilesContent(["", ...duplicatePaths, ...duplicatePaths, ""]),
    },
    {
      id: "mixed-evidence-head-tail",
      paths: mixedPaths,
      content: escapedFilesContent(mixedPaths),
    },
  ];
  for (const variant of variants) {
    const invocation = { tool_name: "search_files", arguments: { pattern: "synthetic" } };
    const record = {
      call_id: `call_${variant.id}`,
      result_position: 0,
      content: variant.content,
      content_sha256: sha256(variant.content),
      invocation,
      invocation_digest: invocationDigest(invocation),
      status: "ok",
      host_handle: { index: 1 },
    };
    const scope = { adapter_id: "hermes", host_profile: "test", session_id: variant.id };
    const directory = mkdtempSync(join(tmpdir(), "navigation-json-replacement-"));
    const store = new Store(makeDriver(join(directory, "state.db")));
    try {
      const engine = new Engine(store, config);
      const result = await engine.hide(scope, record);
      assert.equal(result.ok, true, `${variant.id}: ${result.error}`);
      const rendered = result.plan!.replacement_text;
      const itemId = result.plan!.item_id;
      const projection = projectJsonToolResult(variant.content, "search_files", config).projection!;
      assert.equal(projection.schema, "search_files_files_v2", variant.id);
      const { lines, prefix, suffixes } = decodeEngineReplacement(rendered, itemId);
      assert.deepEqual(lines, projection.lines, `${variant.id}: projection lines`);
      assert.deepEqual(
        suffixes.map((suffix) => prefix + suffix),
        variant.paths,
        `${variant.id}: files list`,
      );
      assert.equal(verifyFilesReplacement(variant.content, itemId, projection, rendered), true, variant.id);
      assert.ok(bytes(rendered) < bytes(variant.content), `${variant.id}: compression`);
      if (variant.id === "non-evidence-and-chunk-split") {
        assert.ok(
          lines.some((line) => line.startsWith("p;suffix+")),
          `${variant.id}: long suffix is chunked`,
        );
      }

      const wrap = (projectionLines: string[]): string =>
        `[hidden:${itemId}]\n` +
        projectionLines.map((line) => `${FILES_REPLACEMENT_LABEL}: ${line}`).join("\n") +
        `\nThe remaining result is preserved. Restore it with unhide_context(${itemId}).`;
      assert.equal(
        verifyFilesReplacement(variant.content, itemId, projection, wrap(lines.slice(0, -1))),
        false,
        `${variant.id}: dropped line`,
      );
      assert.equal(
        verifyFilesReplacement(
          variant.content,
          itemId,
          projection,
          wrap([lines[1], lines[0], ...lines.slice(2)]),
        ),
        false,
        `${variant.id}: reordered lines`,
      );
      assert.equal(
        verifyFilesReplacement(
          variant.content,
          itemId,
          projection,
          wrap([...lines.slice(0, -1), `${lines[lines.length - 1]}X`]),
        ),
        false,
        `${variant.id}: altered line`,
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
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

function largeMatchesContent(): string {
  const lines: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const prefix = index < 8
      ? `synthetic/fixtures/row-${String(index).padStart(3, "0")}.txt evidence=stable `
      : "synthetic filler ";
    lines.push((prefix + "alpha beta gamma ".repeat(8)).slice(0, 100));
  }
  return JSON.stringify({
    matches_format: "Synthetic format: path:line:text",
    matches_text: lines.join("\n"),
    total_count: lines.length,
    total_count_is_lower_bound: false,
    truncated: false,
    _hint: "Synthetic hint for the large matches projection.",
  });
}

test("matches replacement verification is strict about order, evidence and provenance", async () => {
  const fixtureEntry = fixture.cases.find((entry) => entry.id === "matches_success")!;
  const variants = [
    { id: "matches_success", content: contentFor(fixtureEntry) },
    { id: "matches_large", content: largeMatchesContent() },
  ];
  const label = "Projected JSON excerpt: ";
  const restoreMarker = "The remaining result is preserved. Restore it with unhide_context(";
  for (const variant of variants) {
    const projection = projectJsonToolResult(variant.content, "search_files", config).projection!;
    assert.equal(projection.schema, "search_files_matches_v1", variant.id);
    const bogus =
      `[hidden:call-bogus]\nOriginal excerpt: injected row\n` +
      `The remaining result is preserved. Restore it with unhide_context(call-bogus).`;
    assert.equal(verifyFilesReplacement(variant.content, "call-bogus", projection, bogus, config), false, `${variant.id}: bogus`);

    const scope = { adapter_id: "hermes", host_profile: "test", session_id: `json-matches-${variant.id}` };
    const invocation = { tool_name: "search_files", arguments: { pattern: "synthetic" } };
    const record = {
      call_id: `call_${variant.id}`, result_position: 0, content: variant.content,
      content_sha256: sha256(variant.content), invocation,
      invocation_digest: invocationDigest(invocation), status: "ok", host_handle: { index: 1 },
    };
    const directory = mkdtempSync(join(tmpdir(), "navigation-json-matches-"));
    const store = new Store(makeDriver(join(directory, "state.db")));
    try {
      const engine = new Engine(store, config);
      const result = await engine.hide(scope, record);
      assert.equal(result.ok, true, `${variant.id}: ${result.error}`);
      const rendered = result.plan!.replacement_text;
      const itemId = result.plan!.item_id;
      assert.ok(rendered.includes(label), `${variant.id}: label`);
      assert.ok(rendered.includes(restoreMarker), `${variant.id}: restore marker`);
      assert.ok(bytes(rendered) < bytes(variant.content), `${variant.id}: compression`);
      assert.equal(verifyFilesReplacement(variant.content, itemId, projection, rendered, config), true, variant.id);
      assert.ok(projection.required.every((line) => rendered.includes(line)), `${variant.id}: required evidence`);
      assert.equal(store.get(scope, itemId)!.original, variant.content, `${variant.id}: original`);
      const restored = engine.unhide(scope, itemId);
      assert.equal(restored.ok, true, `${variant.id}: restore`);
      assert.equal(restored.item!.original, variant.content, `${variant.id}: restored original`);

      const newline = rendered.indexOf("\n");
      const head = rendered.slice(0, newline);
      const rest = rendered.slice(newline + 1);
      const markerAt = rest.indexOf(restoreMarker);
      const rows = rest.slice(0, markerAt).replace(/\n+$/, "").split("\n");
      const tail = rest.slice(markerAt);
      const wrap = (nextRows: string[]): string => `${head}\n${nextRows.join("\n")}\n${tail}`;
      assert.equal(verifyFilesReplacement(variant.content, itemId, projection, wrap(rows), config), true, `${variant.id}: roundtrip`);
      const requiredRows = rows.filter((row) => projection.required.includes(row.slice(label.length)));
      assert.ok(requiredRows.length > 0, `${variant.id}: required rows`);
      assert.equal(
        verifyFilesReplacement(
          variant.content, itemId, projection,
          wrap(rows.filter((row) => row !== requiredRows[0])), config,
        ),
        false,
        `${variant.id}: dropped required evidence`,
      );
      const reordered = [...rows];
      [reordered[0], reordered[reordered.length - 1]] = [reordered[reordered.length - 1], reordered[0]];
      assert.equal(
        verifyFilesReplacement(variant.content, itemId, projection, wrap(reordered), config),
        false,
        `${variant.id}: reordered rows`,
      );
      assert.equal(
        verifyFilesReplacement(
          variant.content, itemId, projection,
          wrap([...rows, `${label}projected injected evidence`]), config,
        ),
        false,
        `${variant.id}: injected row`,
      );
      assert.equal(
        verifyFilesReplacement(
          variant.content, itemId, projection,
          wrap(rows.map((row) => `Original excerpt: ${row.slice(label.length)}`)), config,
        ),
        false,
        `${variant.id}: wrong label`,
      );
      assert.equal(
        verifyFilesReplacement(variant.content, itemId, projection, wrap(rows.slice(1)), config),
        false,
        `${variant.id}: dropped first required row`,
      );
      const optionalRow = rows.find((row) => !projection.required.includes(row.slice(label.length)));
      if (optionalRow !== undefined) {
        assert.equal(
          verifyFilesReplacement(
            variant.content, itemId, projection,
            wrap(rows.filter((row) => row !== optionalRow)), config,
          ),
          true,
          `${variant.id}: partial excerpt stays valid`,
        );
      }
      assert.equal(
        verifyFilesReplacement(`${variant.content} `, itemId, projection, rendered, config),
        false,
        `${variant.id}: altered source`,
      );
      assert.equal(
        verifyFilesReplacement(
          variant.content, itemId, { ...projection, digest: "0".repeat(64) }, rendered, config,
        ),
        false,
        `${variant.id}: altered digest`,
      );
      assert.equal(
        verifyFilesReplacement(variant.content, itemId, projection, `Hidden:${head.slice(8)}\n${rest}`, config),
        false,
        `${variant.id}: wrong hidden marker`,
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});


test("shared long-evidence boundary vectors refuse in TS", () => {
  const ids = [
    "matches_long_uuid_boundary",
    "matches_long_path_boundary",
    "matches_long_unicode_boundary",
    "matches_long_escape_boundary",
    "matches_long_protected_error",
  ];
  for (const id of ids) {
    const entry = fixture.cases.find((candidate) => candidate.id === id)!;
    const decision = projectJsonToolResult(generatedContent(entry), entry.tool_name, config);
    assert.equal(decision.refusal, entry.expected.refusal, id);
    assert.equal(decision.projection, undefined, id);
  }
});

test("projection parity: files forged digest/trailing injection rejected and empty matches fields emitted", () => {
  const filesPayload = JSON.stringify({
    files: ["synthetic/fixtures/a.txt", "synthetic/fixtures/b.txt"],
    total_count: 2,
  });
  const filesDecision = projectJsonToolResult(filesPayload, "search_files", config);
  assert.ok(filesDecision.projection);
  const filesProj = filesDecision.projection!;
  const itemId = "item_files_parity";
  const validRendered = [
    `[hidden:${itemId}]`,
    ...filesProj.lines.map((line) => `${FILES_REPLACEMENT_LABEL}: ${line}`),
    `The remaining result is preserved. Restore it with unhide_context(${itemId}).`,
  ].join("\n");
  assert.equal(verifyFilesReplacement(filesPayload, itemId, filesProj, validRendered, config), true);
  assert.equal(
    verifyFilesReplacement(
      filesPayload,
      itemId,
      { ...filesProj, digest: "0".repeat(64) },
      validRendered,
      config,
    ),
    false,
  );
  assert.equal(
    verifyFilesReplacement(filesPayload, itemId, filesProj, `${validRendered}\nINJECTED`, config),
    false,
  );
  assert.equal(
    verifyFilesReplacement(filesPayload, itemId, filesProj, `${validRendered} extra`, config),
    false,
  );
  assert.equal(
    verifyFilesReplacement(filesPayload, itemId, filesProj, validRendered, config, "read_file"),
    false,
  );

  const emptyMatches = JSON.stringify({
    matches_format: "",
    matches_text: "synthetic/a.txt:1:alpha\nsynthetic/b.txt:2:beta",
    total_count: 2,
    total_count_is_lower_bound: false,
    truncated: false,
    _hint: "",
  });
  const matchesProj = projectJsonToolResult(emptyMatches, "search_files", config).projection!;
  assert.ok(matchesProj.lines.includes('projected search_files_matches_v1 matches_format+0: ""'));
  assert.ok(matchesProj.lines.includes('projected search_files_matches_v1 _hint+0: ""'));
});
