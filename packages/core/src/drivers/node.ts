import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  exactRow,
  normalizeError,
  safeNumber,
  type Driver,
  type Row,
  type Value,
} from "../driver.ts";
export class NodeDriver implements Driver {
  private db: DatabaseSync;

  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private statement(sql: string): StatementSync {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
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
      return exactRow(this.statement(sql).get(...params) as Row | undefined);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  all(sql: string, params: Value[] = []): Row[] {
    try {
      return this.statement(sql)
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
      const result = this.statement(sql).run(...params);
      return { changes: safeNumber(result.changes), lastInsertRowid: result.lastInsertRowid };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  close(): void {
    this.db.close();
  }
}
