import { Database } from 'bun:sqlite';
import { exactRow, normalizeError, safeNumber, type Driver, type Row, type Value } from '../driver.ts';
export class BunDriver implements Driver {
  private db: Database;
  constructor(path: string) { try { this.db=new Database(path,{create:true,safeIntegers:true}); } catch(e) { throw normalizeError(e); } }
  exec(sql: string): void { try { this.db.exec(sql); } catch(e) { throw normalizeError(e); } }
  get(sql: string, params: Value[]=[]): Row | undefined { try { return exactRow(this.db.query(sql).get(...params) as Row | undefined); } catch(e) { throw normalizeError(e); } }
  all(sql: string, params: Value[]=[]): Row[] { try { return this.db.query(sql).all(...params).map(row=>exactRow(row as Row)!); } catch(e) { throw normalizeError(e); } }
  run(sql: string, params: Value[]=[]): {changes:number;lastInsertRowid:number|bigint} { try { const r=this.db.query(sql).run(...params); return {changes:safeNumber(r.changes),lastInsertRowid:r.lastInsertRowid}; } catch(e) { throw normalizeError(e); } }
  close(): void { this.db.close(); }
}
