import { DatabaseSync } from 'node:sqlite';
import { exactRow, normalizeError, safeNumber, type Driver, type Row, type Value } from '../driver.ts';
export class NodeDriver implements Driver {
  private db: DatabaseSync;
  constructor(path: string) { try { this.db=new DatabaseSync(path); } catch(e) { throw normalizeError(e); } }
  private statement(sql: string) { const s=this.db.prepare(sql); s.setReadBigInts(true); return s; }
  exec(sql: string): void { try { this.db.exec(sql); } catch(e) { throw normalizeError(e); } }
  get(sql: string, params: Value[]=[]): Row | undefined { try { return exactRow(this.statement(sql).get(...params) as Row | undefined); } catch(e) { throw normalizeError(e); } }
  all(sql: string, params: Value[]=[]): Row[] { try { return this.statement(sql).all(...params).map(row=>exactRow(row as Row)!); } catch(e) { throw normalizeError(e); } }
  run(sql: string, params: Value[]=[]): {changes:number;lastInsertRowid:number|bigint} { try { const r=this.statement(sql).run(...params); return {changes:safeNumber(r.changes),lastInsertRowid:r.lastInsertRowid}; } catch(e) { throw normalizeError(e); } }
  close(): void { this.db.close(); }
}
