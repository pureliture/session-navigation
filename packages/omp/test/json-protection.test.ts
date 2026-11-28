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
