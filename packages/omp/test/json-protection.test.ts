import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Json } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { OmpService } from "../src/service.ts";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const pad = (count: number): string => "routine synthetic line ".repeat(count);

function service(): OmpService {
  const directory = mkdtempSync(join(tmpdir(), "omp-protection-"));
  directories.push(directory);
  const store = new Store(new BunDriver(join(directory, "state.db")));
  stores.push(store);
  return new OmpService(store);
}

test("sequence_verified auto cannot compact protected nested JSON", async () => {
  const adapter = service();
  const content = JSON.stringify({
    padding: pad(40),
    outer: '{"payload":"\\u0045RROR: unresolved charge"}',
  });
  const record: Record<string, Json> = {
    call_id: "call-protected",
    tool_name: "read",
    arguments: { path: "synthetic.md" },
    result_position: 0,
    content,
  };
  const prepared = await adapter.handle("prepare", {
    session_id: "a",
    snapshot_id: "protected",
    records: [record],
  });
  expect(prepared.ok).toBe(true);
  const result = await adapter.handle("manage", {
    session_id: "a",
    snapshot_id: "protected",
    tool_call_ids: ["call-protected"],
    action: "auto",
    summaries: { "call-protected": "Synthetic compact note retained." },
    sequence_verified: true,
  });
  expect(result.ok).toBe(false);
  const items = Array.isArray(result.items) ? result.items : [];
  expect(items.length).toBe(1);
  const first = items[0];
  expect(first && typeof first === "object" && "error" in first ? first.error : null).toBe("protected_error");
});

test("OMP summarize and sequence manage allow read envelopes while blocking abnormal-whitespace JSON arrays", async () => {
  const adapter = service();
  const readEnvTilde = `[~/fixture.txt#267D]\n${Array.from({ length: 80 }, (_, i) => `${i + 1}:Routine output row ${i}`).join("\n")}`;
  const readEnvRel = `[fixture.txt#267D]\n${Array.from({ length: 80 }, (_, i) => `${i + 1}:Routine output row ${i}`).join("\n")}`;
  const badArray = `[\f"${pad(45)}", "\\u0045RROR: unresolved synthetic failure"]`;
  const spoofEnvJson = `[fixture.txt#267D]\n{"padding":"${pad(45)}","doc":"\\u0045RROR: unresolved synthetic failure"}`;
  const p1 = await adapter.handle("prepare", {
    session_id: "env-session",
    snapshot_id: "snap-1",
    records: [
      { call_id: "c-tilde", tool_name: "read", arguments: { path: "~/fixture.txt" }, result_position: 0, content: readEnvTilde },
      { call_id: "c-rel", tool_name: "read", arguments: { path: "fixture.txt" }, result_position: 0, content: readEnvRel },
    ],
  });
  expect(p1.ok).toBe(true);
  const p2 = await adapter.handle("prepare", {
    session_id: "env-session",
    snapshot_id: "snap-1",
    append: true,
    records: [
      { call_id: "c-bad-arr", tool_name: "read", arguments: { path: "bad.json" }, result_position: 0, content: badArray },
      { call_id: "c-spoof-env", tool_name: "read", arguments: { path: "spoof.json" }, result_position: 0, content: spoofEnvJson },
    ],
  });
  expect(p2.ok).toBe(true);
  expect(p2.candidate_ids).toEqual(["c-rel", "c-tilde"]);

  const sumDirect = await adapter.handle("manage", {
    session_id: "env-session",
    snapshot_id: "snap-1",
    tool_call_ids: ["c-tilde"],
    action: "summarize",
    summaries: { "c-tilde": "Routine output rows summarized." },
  });
  expect(sumDirect.ok).toBe(true);

  const seqMixed = await adapter.handle("manage", {
    session_id: "env-session",
    snapshot_id: "snap-1",
    tool_call_ids: ["c-rel", "c-bad-arr", "c-spoof-env"],
    action: "summarize",
    summaries: {
      "c-rel": "Routine output rows summarized.",
      "c-bad-arr": "Attempted summary of malformed array.",
      "c-spoof-env": "Attempted summary of spoofed envelope JSON.",
    },
    sequence_verified: true,
  });
  expect(seqMixed.ok).toBe(false);
  const items = Array.isArray(seqMixed.items) ? (seqMixed.items as Array<Record<string, unknown>>) : [];
  expect(items).toHaveLength(3);
  expect(items[0]).toMatchObject({ tool_call_id: "c-rel", ok: true });
  expect(items[1]).toMatchObject({ tool_call_id: "c-bad-arr", ok: false, error: "verification_failed" });
  expect(items[2]).toMatchObject({ tool_call_id: "c-spoof-env", ok: false, error: "protected_error" });
});
