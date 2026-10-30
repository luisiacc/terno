import type { BindableValue, Database, PreparedStatement, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { CacheStatus, Row, SqlValue, SqliteConnection, SqliteDriver, SqliteStatement } from "./connection";

/**
 * Whole-file images for the in-memory engine: loaded on open, written back on
 * close. Node tests back it with real files (so node:sqlite and SQLite-WASM
 * can read each other's databases); by default it is a map in this process.
 */
export interface WasmImages {
  read(path: string): Uint8Array | null;
  write(path: string, bytes: Uint8Array): void;
}

export interface WasmDriverOptions {
  /** OPFS through the sahpool VFS (a dedicated worker only): durable, synchronous, one tab at a time */
  pool?: SAHPoolUtil;
  /** without a pool: where a path's bytes live between open and close (default: memory of this process) */
  images?: WasmImages;
}

class WasmStatement implements SqliteStatement {
  private stmt: PreparedStatement | null;
  private names: string[] | null = null;

  constructor(
    stmt: PreparedStatement,
    private readonly conn: WasmConnection,
  ) {
    this.stmt = stmt;
  }

  private live(params: SqlValue[]): PreparedStatement {
    const stmt = this.stmt;
    if (!stmt) throw new Error("statement used after finalize()");
    if (params.length) stmt.bind(params as BindableValue[]);
    return stmt;
  }

  /** Back to the start with no bindings, without masking the error that interrupted a step. */
  private done(stmt: PreparedStatement): void {
    stmt.resetNoThrow(true);
  }

  // Positional arrays with cached column names: half the cost of object rows (the 04 prototype measured 1.54 → 0.88 ms per list).
  private row(stmt: PreparedStatement): Row {
    const names = (this.names ??= stmt.getColumnNames());
    const values = stmt.get([]);
    const row: Row = {};
    for (let i = 0; i < names.length; i++) row[names[i]!] = values[i];
    return row;
  }

  all(...params: SqlValue[]): Row[] {
    const stmt = this.live(params);
    try {
      const rows: Row[] = [];
      while (stmt.step()) rows.push(this.row(stmt));
      return rows;
    } finally {
      this.done(stmt);
    }
  }

  get(...params: SqlValue[]): Row | undefined {
    const stmt = this.live(params);
    try {
      return stmt.step() ? this.row(stmt) : undefined;
    } finally {
      this.done(stmt);
    }
  }

  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const stmt = this.live(params);
    try {
      while (stmt.step());
    } finally {
      this.done(stmt);
    }
    return this.conn.lastChange();
  }

  finalize(): void {
    this.stmt?.finalize();
    this.stmt = null;
  }
}

class WasmConnection implements SqliteConnection {
  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly db: Database,
    private readonly onClose: (db: Database) => void,
  ) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new WasmStatement(this.db.prepare(sql), this);
  }

  function(name: string, options: { deterministic?: boolean }, fn: (...args: SqlValue[]) => SqlValue): void {
    // node:sqlite's arity is fn.length too
    this.db.createFunction({ name, arity: fn.length, deterministic: options.deterministic, xFunc: (_ctx, ...args) => fn(...(args as SqlValue[])) });
  }

  lastChange(): { changes: number; lastInsertRowid: number } {
    return { changes: Number(this.db.changes()), lastInsertRowid: Number(this.sqlite3.capi.sqlite3_last_insert_rowid(this.db)) };
  }

  cacheStatus(): CacheStatus {
    const { capi, wasm } = this.sqlite3;
    const stack = wasm.pstack.pointer;
    try {
      const cur = wasm.pstack.alloc(4);
      const high = wasm.pstack.alloc(4);
      const read = (op: number) => {
        capi.sqlite3_db_status(this.db, op as never, cur, high, 0);
        return Number(wasm.peek32(cur));
      };
      return { hit: read(capi.SQLITE_DBSTATUS_CACHE_HIT), miss: read(capi.SQLITE_DBSTATUS_CACHE_MISS), usedBytes: read(capi.SQLITE_DBSTATUS_CACHE_USED) };
    } finally {
      wasm.pstack.restore(stack);
    }
  }

  get inTransaction(): boolean {
    return this.sqlite3.capi.sqlite3_get_autocommit(this.db) === 0;
  }

  get isOpen(): boolean {
    return this.db.isOpen();
  }

  close(): void {
    if (!this.db.isOpen()) return;
    this.onClose(this.db);
    this.db.close();
  }
}

/**
 * The same SQL, migrations and FTS5 on SQLite-WASM, synchronously. With a
 * sahpool `pool` it is the web's durable store (OPFS, in a dedicated worker);
 * without one, an in-memory engine whose files are whole images (Node tests,
 * the parity host).
 */
export function wasmSqliteDriver(sqlite3: Sqlite3Static, options: WasmDriverOptions = {}): SqliteDriver {
  const { pool } = options;
  const images = options.images ?? memoryImages();
  return {
    id: pool ? "wasm-opfs" : "wasm-memory",
    open(path, { readonly }) {
      if (pool) {
        const db = new pool.OpfsSAHPoolDb(path);
        return new WasmConnection(sqlite3, db, () => {});
      }
      const db = new sqlite3.oo1.DB(":memory:", "c");
      const bytes = path === ":memory:" ? null : images.read(path);
      if (bytes) loadImage(sqlite3, db, bytes);
      return new WasmConnection(sqlite3, db, (closing) => {
        if (path !== ":memory:" && !readonly) images.write(path, sqlite3.capi.sqlite3_js_db_export(closing));
      });
    },
    pragmas({ readonly, memory }) {
      const pragmas = ["temp_store = MEMORY", "cache_size = -65536", "foreign_keys = ON"];
      // OPFS: a rollback journal kept between commits (a sahpool delete re-associates a handle every time); WAL gains nothing there (04 §2)
      if (pool && !readonly && !memory) pragmas.unshift("journal_mode = TRUNCATE");
      // plan 69: first, so a new file gives freed pages back (an old one ignores it)
      if (!readonly && !memory) pragmas.unshift("auto_vacuum = INCREMENTAL");
      return pragmas;
    },
    features: { externalReaders: false, checkpointWorker: false, mmap: false, compactOnOpen: false },
  };
}

function memoryImages(): WasmImages {
  const files = new Map<string, Uint8Array>();
  return { read: (path) => files.get(path) ?? null, write: (path, bytes) => void files.set(path, bytes) };
}

/** Loads a database file's bytes into an open in-memory connection (WAL-mode headers are switched to rollback, as sahpool's importDb does). */
function loadImage(sqlite3: Sqlite3Static, db: Database, source: Uint8Array): void {
  const { capi, wasm } = sqlite3;
  const bytes = source.slice();
  if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) bytes[18] = bytes[19] = 1;
  const p = wasm.allocFromTypedArray(bytes);
  const rc = capi.sqlite3_deserialize(db, "main", p, bytes.length, bytes.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc !== 0) {
    db.close();
    throw new Error(`cannot load the database image (sqlite3_deserialize: ${capi.sqlite3_js_rc_str(rc)})`);
  }
}
