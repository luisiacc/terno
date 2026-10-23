import type { CacheStatus, Row, SqlValue, SqliteConnection, SqliteDriver, SqliteStatement } from "./connection";

export type Param = SqlValue;
export type { Row } from "./connection";

export interface OpenOptions {
  readonly?: boolean;
  /** statement cache capacity (LRU) */
  statementCacheSize?: number;
  /** ids that must be globally unique (ops, the owner's user id) */
  uuid?: () => string;
  /** how much search log engines may catch up on before it is pruned */
  searchLogBytes?: number;
}

/**
 * Thin synchronous wrapper over a SqliteConnection with an LRU prepared-statement
 * cache (evicted statements are finalized), the driver's pragmas, and nested
 * transactions via savepoints.
 */
export class Db {
  readonly path: string;
  readonly driver: SqliteDriver;
  readonly uuid: () => string;
  private readonly conn: SqliteConnection;
  private readonly cache = new Map<string, SqliteStatement>();
  private readonly cacheSize: number;
  private txDepth = 0;
  private readonly beforeCommit: (() => void)[] = [];
  private readonly afterCommit: (() => void)[] = [];

  constructor(driver: SqliteDriver, path: string, options: OpenOptions = {}) {
    this.path = path;
    this.driver = driver;
    this.cacheSize = options.statementCacheSize ?? 400;
    this.uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
    const readonly = options.readonly ?? false;
    this.conn = driver.open(path, { readonly });
    for (const p of driver.pragmas({ readonly, memory: path === ":memory:" })) this.conn.exec(`PRAGMA ${p}`);
  }

  prepare(sql: string): SqliteStatement {
    const hit = this.cache.get(sql);
    if (hit) {
      // refresh LRU position
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    const stmt = this.conn.prepare(sql);
    this.cache.set(sql, stmt);
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.get(oldest)!.finalize();
      this.cache.delete(oldest);
    }
    return stmt;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    return this.prepare(sql).run(...params);
  }

  exec(sql: string): void {
    this.conn.exec(sql);
  }

  /** Registers a scalar SQL function on this connection. */
  function(name: string, options: { deterministic?: boolean }, fn: (...args: SqlValue[]) => SqlValue): void {
    this.conn.function(name, options, fn);
  }

  /** Runs inside every top-level transaction right before COMMIT; throwing rolls the transaction back. */
  onBeforeCommit(fn: () => void): void {
    this.beforeCommit.push(fn);
  }

  /** Runs after every top-level COMMIT (never after a rollback); must not throw or write. */
  onCommit(fn: () => void): void {
    this.afterCommit.push(fn);
  }

  /** Runs fn in a transaction (IMMEDIATE at top level, savepoint when nested). */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `sp${depth}`;
    this.conn.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    let result: T;
    try {
      result = fn();
      if (result instanceof Promise) throw new Error("Db.tx callbacks must be synchronous");
      if (depth === 0) for (const hook of this.beforeCommit) hook();
      this.conn.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    } catch (error) {
      this.conn.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.txDepth--;
    }
    if (depth === 0) for (const hook of this.afterCommit) hook();
    return result;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  get isOpen(): boolean {
    return this.conn.isOpen;
  }

  /** page cache hits and misses since open, where the driver can tell */
  cacheStatus(): CacheStatus | null {
    return this.conn.cacheStatus?.() ?? null;
  }

  /** Changes made by *other* connections since the last call (MCP / external writers). */
  dataVersion(): number {
    return Number(this.get<{ data_version: number }>("PRAGMA data_version")!.data_version);
  }

  close(): void {
    for (const stmt of this.cache.values()) stmt.finalize();
    this.cache.clear();
    this.conn.close();
  }
}

/** Build "?,?,?" for IN clauses. */
export function placeholders(n: number): string {
  return n === 0 ? "NULL" : Array.from({ length: n }, () => "?").join(",");
}
