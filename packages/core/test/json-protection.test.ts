import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  Store,
  invocationDigest,
  isJsonLike,
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
const readEnvelope = `[~/fixture.txt#267D]\n${Array.from({ length: 100 }, (_, index) => `${index + 1}:Output row ${index} details`).join("\n")}`;
const topLevelArray = JSON.stringify(["ERROR: synthetic protected array row", longPad]);

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

test("top-level array with protected error stays in the original", () => {
  assert.equal(refusalReasonForRecord(recordFor(topLevelArray)), "protected_error");
});

test("read-file envelopes are not treated as JSON and both hide and summarize succeed", async () => {
  const relativeEnvelopes = [
    readEnvelope,
    readEnvelope.replace("[~/fixture.txt#267D]", "[fixture.txt#267D]"),
    readEnvelope.replace("[~/fixture.txt#267D]", "[tests/test_json_protection.py#77C3]"),
    readEnvelope.replace("[~/fixture.txt#267D]", "[01-migration.sql#1A2B]"),
    readEnvelope.replace("[~/fixture.txt#267D]", "[.worktrees/session-navigation/pyproject.toml#D83D]"),
    `[Skill file: /opt/skills/paseo/SKILL.md]\n---\n${Array.from({ length: 80 }, (_, index) => `Step ${index}: routine skill instruction line`).join("\n")}`,
  ];
  for (const [idx, envContent] of relativeEnvelopes.entries()) {
    assert.equal(isJsonLike(envContent), false, `isJsonLike envelope ${idx}`);
    assert.equal(refusalReasonForRecord(recordFor(envContent)), undefined, `refusal envelope ${idx}`);
    await withEngine(`read-envelope-hide-${idx}`, async (engine, record, calls) => {
      const result = await engine.hide(
        scopeFor(`read-envelope-hide-${idx}`),
        recordFor(envContent, record.call_id),
      );
      assert.equal(result.ok, true, result.error ?? "hide failed");
      assert.ok(result.item?.compacted.includes("Original excerpt"));
      assert.equal(calls.count, 0);
    });
    await withEngine(`read-envelope-sum-${idx}`, async (engine, record, calls) => {
      const target = recordFor(envContent, record.call_id);
      const result = await engine.summarize(scopeFor(`read-envelope-sum-${idx}`), target, async () => {
        calls.count += 1;
        return { summary };
      });
      assert.equal(result.ok, true, result.error ?? "summarize failed");
      assert.equal(calls.count, 1);
      assert.equal(result.item?.original, envContent);
      assert.ok(result.plan?.replacement_text.includes(`Summary: ${JSON.stringify(summary)}`));
      const restored = engine.unhide(scopeFor(`read-envelope-sum-${idx}`), result.item!.item_id);
      assert.equal(restored.ok, true);
      assert.equal(restored.item?.original, envContent);
    });
  }
});

test("valid clean JSON summarizes while malformed or abnormal-whitespace JSON arrays stay fail closed", async () => {
  const cleanJson = JSON.stringify({
    padding: pad(45),
    status: "ok",
    items: ["alpha", "beta", "gamma"],
  });
  assert.equal(isJsonLike(cleanJson), true);
  assert.equal(refusalReasonForRecord(recordFor(cleanJson)), undefined);
  await withEngine("clean-json-sum", async (engine, record, calls) => {
    const result = await engine.summarize(
      scopeFor("clean-json-sum"),
      recordFor(cleanJson, record.call_id),
      async () => {
        calls.count += 1;
        return { summary };
      },
    );
    assert.equal(result.ok, true, result.error ?? "clean JSON summarize failed");
    assert.equal(calls.count, 1);
    assert.equal(result.item?.original, cleanJson);
  });

  const suspiciousPayloads = [
    `[\f"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[\u00a0"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[\ufeff"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[\x1c"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[\v"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[\u200b"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[,"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `['${pad(45)}', '\\u0045RROR: unresolved synthetic failure']`,
    `[NaN, "${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[invalid, "${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`,
    `[note] ${pad(45)}`,
    `[2026-11-28] ${pad(45)}`,
  ];
  for (const [idx, bad] of suspiciousPayloads.entries()) {
    assert.equal(isJsonLike(bad), true, `isJsonLike suspicious ${idx}`);
    assert.equal(refusalReasonForRecord(recordFor(bad)), "verification_failed", `refusal suspicious ${idx}`);
    await withEngine(`suspicious-${idx}`, async (engine, record, calls) => {
      const hideRes = await engine.hide(scopeFor(`suspicious-h-${idx}`), recordFor(bad, record.call_id));
      assert.equal(hideRes.ok, false);
      assert.equal(hideRes.error, "verification_failed");
      const sumRes = await engine.summarize(
        scopeFor(`suspicious-s-${idx}`),
        recordFor(bad, record.call_id),
        async () => {
          calls.count += 1;
          return { summary };
        },
      );
      assert.equal(sumRes.ok, false);
      assert.equal(sumRes.error, "verification_failed");
      assert.equal(calls.count, 0);
    });
  }
});

test("envelope header prepended to JSON body or nested JSON never bypasses protection", async () => {
  const spoofedJson = `[fixture.txt#267D]\n{"padding":"${pad(45)}","doc":"\\u0045RROR: unresolved charge"}`;
  const spoofedArray = `[fixture.txt#267D]\n[\f"${pad(45)}", "\\u0045RROR: unresolved charge"]`;
  const doubleHeader = `[a.txt#1234]\n[b.txt#5678]\n{"padding":"${pad(45)}","doc":"\\u0045RROR: unresolved charge"}`;
  const nestedSpoof = JSON.stringify({
    padding: pad(45),
    outer: '[fixture.txt#267D]\n{"payload":"\\u0045RROR: unresolved charge"}',
  });
  assert.equal(isJsonLike(spoofedJson), true);
  assert.equal(refusalReasonForRecord(recordFor(spoofedJson)), "protected_error");
  assert.equal(refusalReasonForRecord(recordFor(spoofedArray)), "verification_failed");
  assert.equal(refusalReasonForRecord(recordFor(doubleHeader)), "verification_failed");
  assert.equal(refusalReasonForRecord(recordFor(nestedSpoof)), "protected_error");
  for (const [idx, payload] of [spoofedJson, spoofedArray, doubleHeader, nestedSpoof].entries()) {
    await withEngine(`spoof-${idx}`, async (engine, record, calls) => {
      const hideRes = await engine.hide(scopeFor(`spoof-h-${idx}`), recordFor(payload, record.call_id));
      assert.equal(hideRes.ok, false);
      const sumRes = await engine.summarize(
        scopeFor(`spoof-s-${idx}`),
        recordFor(payload, record.call_id),
        async () => {
          calls.count += 1;
          return { summary };
        },
      );
      assert.equal(sumRes.ok, false);
      assert.equal(calls.count, 0);
    });
  }
});
