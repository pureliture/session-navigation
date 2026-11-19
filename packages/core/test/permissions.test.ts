import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeDriver } from "./runtime.ts";

test("driver creates the state database with user-only permissions", () => {
  const home = mkdtempSync(join(tmpdir(), "session-nav-perms-"));
  const path = join(home, "state.sqlite3");
  try {
    const driver = makeDriver(path);
    driver.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("driver tightens an existing world-readable database", () => {
  const home = mkdtempSync(join(tmpdir(), "session-nav-perms-"));
  const path = join(home, "state.sqlite3");
  try {
    const first = makeDriver(path);
    first.close();
    chmodSync(path, 0o644);
    const second = makeDriver(path);
    second.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
