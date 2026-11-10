export type Value = string | number | bigint | null;
export type Row = {
  [key: string]: Value;
};
export interface Driver {
  exec(sql: string): void;
  get(sql: string, params?: Value[]): Row | undefined;
  all(sql: string, params?: Value[]): Row[];
  run(
    sql: string,
    params?: Value[],
  ): {
    changes: number;
    lastInsertRowid: number | bigint;
  };
  close(): void;
}
export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
    this.name = "EngineError";
  }
}
export function normalizeError(error: unknown): EngineError {
  if (error instanceof EngineError) {
    return error;
  }
  const sqliteError = error as {
    code?: string;
    errcode?: number;
    errno?: number;
    message?: string;
  };
  return new EngineError(
    sqliteError.errcode === 13 ||
    sqliteError.errno === 13 ||
    /database or disk is full/i.test(sqliteError.message ?? "")
      ? "db_full"
      : "db_error",
    sqliteError.message,
  );
}
export function safeNumber(value: Value | undefined): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new EngineError("db_error", "Unsafe integer conversion");
  }
  return number;
}
export function exactRow(row: Row | undefined): Row | undefined {
  if (!row) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" &&
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value,
    ]),
  );
}
