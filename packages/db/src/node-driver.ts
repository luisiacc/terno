import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { Platform, PlatformFiles } from "@terno/store";
import type { CheckpointWorker, Row, SqlValue, SqliteConnection, SqliteDriver, SqliteStatement } from "./connection";

class NodeStatement implements SqliteStatement {
  private stmt: StatementSync | null;

  constructor(stmt: StatementSync) {
    this.stmt = stmt;
  }

  private live(): StatementSync {
    if (!this.stmt) throw new Error("statement used after finalize()");
    return this.stmt;
  }

  all(...params: SqlValue[]): Row[] {
    return this.live().all(...params) as Row[];
  }

  get(...params: SqlValue[]): Row | undefined {
    return this.live().get(...params) as Row | undefined;
  }

  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.live().run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  // node:sqlite finalizes on garbage collection or close; dropping the handle is all there is to do
  finalize(): void {
    this.stmt = null;
  }
}

class NodeConnection implements SqliteConnection {
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  function(name: string, options: { deterministic?: boolean }, fn: (...args: SqlValue[]) => SqlValue): void {
    this.db.function(name, options, fn as (...args: unknown[]) => SqlValue);
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Moves WAL checkpoints off the writer's thread. With autocheckpoint on, the
 * commit that crosses the threshold copies pages back and F_FULLFSYNCs on the
 * writer's event loop (measured: 30–80 ms stalls during imports). A worker with
 * its own connection runs PASSIVE checkpoints instead; the writer keeps going.
 * The worker source is inlined (eval) so it survives bundling.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA busy_timeout = 1000");
db.exec("PRAGMA checkpoint_fullfsync = ON");
const stmt = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
const timer = setInterval(() => {
  try { stmt.get(); } catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
}, workerData.intervalMs);
parentPort.on("message", (m) => {
  if (m === "stop") {
    clearInterval(timer);
    try { db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    db.close();
    parentPort.postMessage("stopped");
  }
});
`;

function startNodeCheckpointWorker(path: string, onExit: () => void, intervalMs: number): CheckpointWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path, intervalMs } });
  worker.unref();
  let stopped = false;
  worker.on("exit", () => {
    if (!stopped) onExit();
  });
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        const done = () => resolve();
        worker.once("message", (m) => (m === "stopped" ? void worker.terminate().then(done) : undefined));
        worker.once("exit", done);
        worker.postMessage("stop");
        setTimeout(() => void worker.terminate().then(done), 2000).unref();
      }),
  };
}

/** Desktop: node:sqlite with WAL, mmap and full fsync at checkpoints. */
export const nodeSqliteDriver: SqliteDriver = {
  id: "node-sqlite",
  open(path, options) {
    return new NodeConnection(new DatabaseSync(path, { readOnly: options.readonly, enableForeignKeyConstraints: true }));
  },
  pragmas({ readonly, memory }) {
    const pragmas = ["busy_timeout = 2000", "temp_store = MEMORY", "cache_size = -65536", "mmap_size = 268435456", "foreign_keys = ON"];
    if (!readonly && !memory) {
      pragmas.unshift("journal_mode = WAL");
      pragmas.push("synchronous = NORMAL", "checkpoint_fullfsync = ON", "journal_size_limit = 67108864");
    }
    return pragmas;
  },
  features: { externalReaders: true, checkpointWorker: true, mmap: true },
  startCheckpointWorker: startNodeCheckpointWorker,
};

/**
 * Whole-file replace through a temp file and rename (atomic within the
 * directory). Not fsynced: these files are caches whose readers verify a
 * checksum, so a crash that loses the bytes behind a rename costs a rebuild,
 * never a wrong answer, and quitting doesn't wait for the disk.
 */
const nodeFiles: PlatformFiles = {
  async read(path) {
    try {
      const b = await readFile(path);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async replace(path, bytes) {
    const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

/** What the backend can't get portably on Node: node:crypto ids, the macrotask yield and files. */
export const nodePlatform: Platform = {
  uuid: randomUUID,
  yield: () => yieldToLoop(),
  files: nodeFiles,
};
