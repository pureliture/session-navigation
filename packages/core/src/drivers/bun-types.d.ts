declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: {create?:boolean; safeIntegers?:boolean});
    exec(sql: string): void;
    query(sql: string): {get(...params: import('../driver.ts').Value[]): unknown; all(...params: import('../driver.ts').Value[]): unknown[];run(...params: import('../driver.ts').Value[]): {changes:number;lastInsertRowid:number|bigint}};
    close(): void;
  }
}
