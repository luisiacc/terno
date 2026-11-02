import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterAll, expect, it, vi } from "vitest";
import type { CheckpointWorker, SqliteDriver } from "../connection";
import { nodeSqliteDriver } from "../node-driver";
import { Db } from "../sqlite";
import { checkpointFixture } from "./checkpoint-fixture";

const observed = vi.hoisted(() => ({ workers: [] as Worker[] }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        observed.workers.push(this);
      }
    },
  };
});

const dir = mkdtempSync(join(tmpdir(), "terno-checkpoint-fixture-"));
const witnesses: unknown[] = [];
const databases: Db[] = [];
const owned: { worker: Worker; handle: CheckpointWorker }[] = [];
const cases: {
  name: string;
  db: Db;
  worker: Worker;
  initialThreadId: number;
  handle: CheckpointWorker;
  events: string[];
  completed: number;
}[] = [];

for (const name of ["operation", "assertion", "success", "body-cleanup", "cleanup-only"]) {
  it(`body ${name}`, () => {
    const events: string[] = [];
    let handle: CheckpointWorker | undefined;
    let worker: Worker | undefined;
    const driver: SqliteDriver = {
      ...nodeSqliteDriver,
      startCheckpointWorker(path, onExit, intervalMs) {
        const before = observed.workers.length;
        const real = nodeSqliteDriver.startCheckpointWorker!(path, onExit, intervalMs);
        worker = observed.workers[before]!;
        handle = real;
        owned.push({ worker, handle });
        expect(observed.workers).toHaveLength(before + 1);
        worker.once("error", () => events.push("unexpected-error"));
        worker.once("exit", () => events.push("exit"));
        return {
          settle: () => real.settle(),
          async stop() {
            events.push("stop-called");
            await real.stop();
            events.push("stop-resolved");
          },
        };
      },
    };
    class Writer extends Db {
      override exec(sql: string) {
        super.exec(sql);
        if (sql === "PRAGMA wal_autocheckpoint = 1000") {
          events.push("restored");
          if (name.includes("cleanup")) throw new Error(`cleanup sentinel ${name}`);
        }
      }
    }
    const db = new Writer(driver, join(dir, `${name}.db`));
    databases.push(db);
    checkpointFixture(db);
    expect(worker).toBeDefined();
    expect(handle).toBeDefined();
    const record = { name, db, worker: worker!, initialThreadId: worker!.threadId, handle: handle!, events, completed: 0 };
    cases.push(record);
    expect(record.initialThreadId).toBeGreaterThan(0);
    expect(db.get("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 0 });
    db.exec("CREATE TABLE synthetic (value INTEGER)");
    db.run("INSERT INTO synthetic VALUES (1)");
    if (name === "operation" || name === "body-cleanup") db.exec("INSERT INTO checkpoint_missing_operation VALUES (1)");
    if (name === "assertion") expect(db.get("SELECT value FROM synthetic"), "assertion sentinel").toEqual({ value: 2 });
    record.completed++;
  });

  it(`witness ${name}`, () => {
    const record = cases.find((entry) => entry.name === name)!;
    expect(record).toBeDefined();
    const snapshot = {
      name, pid: process.pid, initialThreadId: record.initialThreadId,
      finalThreadId: record.worker.threadId, events: [...record.events],
      pragma: record.db.get("PRAGMA wal_autocheckpoint"),
    };
    witnesses.push(snapshot);
    expect(snapshot).toEqual({
      name, pid: process.pid, initialThreadId: record.initialThreadId,
      finalThreadId: -1, events: ["stop-called", "exit", "stop-resolved", "restored"],
      pragma: { wal_autocheckpoint: 1000 },
    });
    expect(record.db.get("SELECT value FROM synthetic")).toEqual({ value: 1 });
    expect(record.completed).toBe(name === "success" || name === "cleanup-only" ? 1 : 0);
  });
}

afterAll(async () => {
  let finalizerCompleted = false;
  if (process.env.TERNO_CHECKPOINT_FAIL_SAFETY === "1") {
    databases[0]!.onClose(() => { throw new Error("safety close sentinel"); });
  }
  try {
    const joined = await Promise.allSettled(owned.map(async ({ worker, handle }) => {
      if (worker.threadId !== -1) await handle.stop();
    }));
    const closed = await Promise.allSettled(databases.map(async (db) => db.close()));
    const failures = [...joined, ...closed].filter((result) => result.status === "rejected");
    expect(failures, "safety finalizer failures").toEqual([]);
    finalizerCompleted = true;
  } finally {
    for (const db of databases) if (db.isOpen) db.close();
    if (process.env.TERNO_CHECKPOINT_EVIDENCE) {
      writeFileSync(process.env.TERNO_CHECKPOINT_EVIDENCE, JSON.stringify({
        finalizerCompleted, nodeOptionsHash: createHash("sha256").update(process.env.NODE_OPTIONS ?? "").digest("hex"),
        witnesses, safety: cases.map((record) => ({
          name: record.name, pid: process.pid, initialThreadId: record.initialThreadId,
          events: record.events, finalThreadId: record.worker.threadId,
        })),
      }));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
