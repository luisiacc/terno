import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { endianness } from "node:os";
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
const checkpoint = () => {
  try { stmt.get(); } catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
};
const timer = setInterval(checkpoint, workerData.intervalMs);
parentPort.on("message", (m) => {
  if (m === "checkpoint") {
    checkpoint();
    parentPort.postMessage("checkpointed");
  } else if (m === "stop") {
    clearInterval(timer);
    try { db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch {}
    db.close();
    parentPort.postMessage("stopped");
  }
});
`;

/** Past this much WAL, bulk writers let the checkpoint catch up so the next write starts it over. */
const WAL_BUDGET = 16 * 2 ** 20;
/**
 * They wait only once no more than this is left to copy, which is right after
 * the worker's periodic pass: one short extra pass (a few ms and its fsyncs).
 * Asking for passes of its own as soon as the budget is crossed copied the
 * hot pages more often: +16% process CPU on a 14k-message import.
 */
const WAL_FINAL_COPY = 2 * 2 ** 20;
/** Past this they wait however much is left: the journal_size_limit, so a restart never truncates much. */
const WAL_HARD_LIMIT = 64 * 2 ** 20;

/**
 * How long the WAL is and how much of it is checkpointed, from the
 * wal-index header at the start of the -shm file (sqlite.org/walformat.html:
 * two copies of a 48-byte header, equal when not mid-update, then the
 * checkpoint info; native byte order). Null when it can't be read reliably.
 */
function walIndexReader(path: string): { read(): { frameBytes: number; frames: number; unchecked: number } | null; close(): void } {
  const buf = new Uint8Array(136);
  const view = new DataView(buf.buffer);
  const le = endianness() === "LE";
  let fd: number | null = null;
  return {
    read() {
      try {
        fd ??= openSync(`${path}-shm`, "r");
        if (readSync(fd, buf, 0, 136, 0) < 136) return null;
      } catch {
        return null;
      }
      // iVersion 3007000, isInit, and both copies equal
      if (view.getUint32(0, le) !== 3007000 || buf[12] !== 1) return null;
      for (let i = 0; i < 48; i++) if (buf[i] !== buf[48 + i]) return null;
      const page = view.getUint16(14, le);
      const frames = view.getUint32(16, le);
      const backfilled = view.getUint32(96, le);
      return { frameBytes: (page === 1 ? 65536 : page) + 24, frames, unchecked: Math.max(0, frames - backfilled) };
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

function startNodeCheckpointWorker(path: string, onExit: () => void, intervalMs: number): CheckpointWorker {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path, intervalMs } });
  worker.unref();
  const wal = walIndexReader(path);
  let stopped = false;
  let exited = false;
  /** a checkpoint asked for and not answered yet */
  let asked: Promise<void> | null = null;
  const answered = new Set<() => void>();
  worker.on("message", (m) => {
    if (m !== "checkpointed") return;
    asked = null;
    for (const done of answered) done();
    answered.clear();
  });
  worker.on("exit", () => {
    exited = true;
    for (const done of answered) done();
    answered.clear();
    if (!stopped) onExit();
  });
  const checkpointNow = () =>
    (asked ??= new Promise<void>((resolve) => {
      if (stopped || exited) return resolve();
      answered.add(resolve);
      worker.postMessage("checkpoint");
    }));
  return {
    async settle() {
      const s = wal.read();
      if (stopped || exited || !s || s.frames * s.frameBytes <= WAL_BUDGET || s.unchecked === 0) return;
      // copying is the worker's periodic pass: the caller keeps writing until little is left (right after a pass)
      if (s.unchecked * s.frameBytes > WAL_FINAL_COPY && s.frames * s.frameBytes < WAL_HARD_LIMIT) return;
      // a checkpoint that started before the caller's last write can't cover it: wait for it, then one that can
      await asked;
      const left = wal.read();
      if (left && left.unchecked > 0) await checkpointNow();
    },
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        wal.close();
        const done = () => resolve();
        worker.on("message", (m) => (m === "stopped" ? void worker.terminate().then(done) : undefined));
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
