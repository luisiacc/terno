import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

export interface OpenOptions {
  readonly?: boolean;
  /** statement cache capacity (LRU) */
  statementCacheSize?: number;
}

/**
 * Thin synchronous wrapper over node:sqlite with an LRU prepared-statement
 * cache, tuned pragmas, and nested transactions via savepoints.
 */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private readonly cache = new Map<string, StatementSync>();
  private readonly cacheSize: number;
  private txDepth = 0;

  constructor(path: string, options: OpenOptions = {}) {
    this.path = path;
    this.cacheSize = options.statementCacheSize ?? 400;
    this.raw = new DatabaseSync(path, { readOnly: options.readonly ?? false, enableForeignKeyConstraints: true });
    const pragmas = [
      "busy_timeout = 2000",
      "temp_store = MEMORY",
      "cache_size = -65536",
      "mmap_size = 268435456",
      "foreign_keys = ON",
    ];
    if (!options.readonly && path !== ":memory:") {
      pragmas.unshift("journal_mode = WAL");
      pragmas.push("synchronous = NORMAL", "checkpoint_fullfsync = ON", "journal_size_limit = 67108864");
    }
    for (const p of pragmas) this.raw.exec(`PRAGMA ${p}`);
  }

  prepare(sql: string): StatementSync {
    const hit = this.cache.get(sql);
    if (hit) {
      // refresh LRU position
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    const stmt = this.raw.prepare(sql);
    this.cache.set(sql, stmt);
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
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
    const r = this.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs fn in a transaction (IMMEDIATE at top level, savepoint when nested). */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `sp${depth}`;
    this.raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("Db.tx callbacks must be synchronous");
      this.raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /** Changes made by *other* connections since the last call (MCP / external writers). */
  dataVersion(): number {
    return Number((this.raw.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

/** Build "?,?,?" for IN clauses. */
export function placeholders(n: number): string {
  return n === 0 ? "NULL" : Array.from({ length: n }, () => "?").join(",");
}
