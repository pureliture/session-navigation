import { Database } from "bun:sqlite";

export const MINIMUM_SQLITE_VERSION = "3.51.3";

/** OMP requires the upstream WAL-reset fix even when the DB is currently DELETE. */
export function supportedSqliteVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (const [index, minimum] of [3, 51, 3].entries()) {
    if (parts[index] !== minimum) return parts[index] > minimum;
  }
  return true;
}

/** Read the SQLite library OMP has actually loaded, without opening the state DB. */
export function runtimeSqliteVersion(): string {
  const db = new Database(":memory:");
  try {
    const row = db.query("SELECT sqlite_version() AS version").get() as { version?: unknown } | null;
    return typeof row?.version === "string" ? row.version : "unknown";
  } finally {
    db.close();
  }
}
