import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  Store,
  invocationDigest,
  refusalReasonForRecord,
  sha256,
  type RecordInput,
  type ScopeLike,
} from "../src/index.ts";
import { makeDriver } from "./runtime.ts";

const pad = (count: number): string => "routine synthetic line ".repeat(count);
const longPad = pad(500);
const summary = "Synthetic compact note retained.";

function recordFor(content: string, callId = "call-protection"): RecordInput {
  const invocation = { tool_name: "read", arguments: { path: "synthetic.md" } };
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

function scopeFor(name: string): ScopeLike {
  return { adapter_id: "omp", host_profile: "synthetic", session_id: `protection-${name}` };
}

async function withEngine(
  name: string,
  fn: (engine: Engine, record: RecordInput, calls: { count: number }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `json-protection-${name}-`));
  const store = new Store(makeDriver(join(directory, "state.db")));
  const calls = { count: 0 };
  try {
    await fn(new Engine(store), recordFor(pad(40), `call-${name}`), calls);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const docExample = JSON.stringify({ padding: pad(40), doc: "ERROR: example in handling documentation" });
const nestedEscaped = JSON.stringify({
  padding: pad(40),
  outer: '{"payload":"\\u0045RROR: unresolved charge"}',
});
const literalBackslash = JSON.stringify({ padding: pad(40), outer: "\\u0045RROR: unresolved charge" });
const longNestedEscaped = JSON.stringify({
  padding: longPad,
  outer: '{"payload":"\\u0045RROR: unresolved charge"}',
});
const duplicateKeys = `{"padding":"${pad(40)}","v":"routine","v":"\\u0045RROR: unresolved charge"}`;
const deep = `[${"[".repeat(300)}"${pad(40)}\\u0045RROR: unresolved charge"${"}".repeat(300)}]`;

test("protected expression in a document example stays in the original", async () => {
  assert.equal(refusalReasonForRecord(recordFor(docExample)), "protected_error");
  await withEngine("doc", async (engine, record, calls) => {
    const result = await engine.summarize(scopeFor("doc"), recordFor(docExample, record.call_id), async () => {
      calls.count += 1;
      return { summary };
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "protected_error");
    assert.equal(calls.count, 0);
  });
});

test("valid nested JSON with escaped error is protected", async () => {
  assert.equal(refusalReasonForRecord(recordFor(nestedEscaped)), "protected_error");
  await withEngine("nested", async (engine, record, calls) => {
    const result = await engine.summarize(scopeFor("nested"), recordFor(nestedEscaped, record.call_id), async () => {
      calls.count += 1;
      return { summary };
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "protected_error");
    assert.equal(calls.count, 0);
  });
});

test("long padded nested JSON with escaped error is protected", async () => {
  assert.equal(refusalReasonForRecord(recordFor(longNestedEscaped)), "protected_error");
  await withEngine("long-nested", async (engine, record, calls) => {
    const result = await engine.summarize(scopeFor("long-nested"), recordFor(longNestedEscaped, record.call_id), async () => {
      calls.count += 1;
      return { summary };
    });
    assert.equal(result.ok, false);
    assert.ok(result.error === "protected_error" || result.error === "verification_failed");
    assert.equal(calls.count, 0);
  });
});

test("JSON-like prefix whitespace stays fail closed", () => {
  for (const prefix of ["\ufeff", "\x1c", "\x1f", "\x85"]) {
    assert.equal(refusalReasonForRecord(recordFor(prefix + longNestedEscaped)), "verification_failed");
  }
});

test("literal backslash-u text is ordinary text and is never re-unescaped", () => {
  assert.equal(refusalReasonForRecord(recordFor(literalBackslash)), undefined);
});

test("duplicate keys and over-depth JSON keep the original", async () => {
  for (const [name, content] of [["duplicate", duplicateKeys], ["deep", deep]] as const) {
    const reason = refusalReasonForRecord(recordFor(content));
    assert.ok(reason);
    await withEngine(name, async (engine, record, calls) => {
      const result = await engine.summarize(scopeFor(name), recordFor(content, record.call_id), async () => {
        calls.count += 1;
        return { summary };
      });
      assert.equal(result.ok, false);
      assert.equal(result.item, undefined);
      assert.equal(calls.count, 0);
    });
  }
});
