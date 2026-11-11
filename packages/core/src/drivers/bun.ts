import { Database } from "bun:sqlite";
import {
  exactRow,
  normalizeError,
  safeNumber,
  type Driver,
  type Row,
  type Value,
} from "../driver.ts";
export class BunDriver implements Driver {
  private db: Database;

  constructor(path: string) {
    try {
      this.db = new Database(path, { create: true, safeIntegers: true });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  get(sql: string, params: Value[] = []): Row | undefined {
    try {
      return exactRow(this.db.query(sql).get(...params) as Row | undefined);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  all(sql: string, params: Value[] = []): Row[] {
    try {
      return this.db
        .query(sql)
        .all(...params)
        .map((row) => exactRow(row as Row)!);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  run(
    sql: string,
    params: Value[] = [],
  ): {
    changes: number;
    lastInsertRowid: number | bigint;
  } {
    try {
      const result = this.db.query(sql).run(...params);
      return { changes: safeNumber(result.changes), lastInsertRowid: result.lastInsertRowid };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  close(): void {
    this.db.close();
  }
}
