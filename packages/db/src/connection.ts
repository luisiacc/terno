/**
 * The subset of SQLite that Db uses. Drivers (node:sqlite on desktop,
 * SQLite-WASM on the web) implement it synchronously, so the SQL layer and
 * its transactions stay synchronous on every platform.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

export interface SqliteStatement {
  all(...params: SqlValue[]): Row[];
  get(...params: SqlValue[]): Row | undefined;
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  /** Releases the prepared statement. Using it afterwards throws. */
  finalize(): void;
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  function(name: string, options: { deterministic?: boolean }, fn: (...args: SqlValue[]) => SqlValue): void;
  readonly isOpen: boolean;
  close(): void;
}

export interface CheckpointWorker {
  stop(): Promise<void>;
}

export interface SqliteDriver {
  readonly id: "node-sqlite" | "wasm-opfs" | "wasm-memory" | (string & {});
  open(path: string, options: { readonly: boolean }): SqliteConnection;
  /** applied by Db right after open */
  pragmas(options: { readonly: boolean; memory: boolean }): string[];
  readonly features: {
    /** other connections may read or write the file (MCP, checkpoint worker) */
    externalReaders: boolean;
    checkpointWorker: boolean;
    mmap: boolean;
  };
  /** runs WAL checkpoints off the writer's thread (desktop) */
  startCheckpointWorker?(path: string, onExit: () => void, intervalMs: number): CheckpointWorker;
}
