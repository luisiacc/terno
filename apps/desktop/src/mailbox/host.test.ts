import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxGate } from "@terno/core/mailbox";
import { MailboxHost } from "./host";
import { readRestoredMarker, restorePaths } from "./restore";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { alive?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-host-"));
  dirs.push(dir);
  const db = join(dir, "terno.db");
  writeFileSync(db, Buffer.alloc(4096, 1));
  const published: MailboxGate[] = [];
  const logs: string[] = [];
  let starts = 0;
  let alive = o.alive ?? false;
  const host = new MailboxHost({
    dbPath: () => db,
    publish: (g) => published.push(g),
    start: () => {
      starts++;
      alive = true;
    },
    alive: () => alive,
    log: (code, fields) => logs.push(`${code}${fields?.outcome ? `:${fields.outcome}` : ""}`),
    now: () => 0,
    restore: { freeBytes: () => 2 ** 34 },
  });
  return { dir, db, host, published, logs, starts: () => starts, die: () => (alive = false) };
}

const corrupt = (backup: boolean): MailboxGate => ({ kind: "failed", reason: "corrupt", step: null, backup: backup ? { createdAt: 1000, appVersion: "0.2.0", fromSchema: 37 } : null, restoreFailed: null });

function backupIn(dir: string) {
  const gen = join(dir, "backups", "1000-v37-v38");
  mkdirSync(gen, { recursive: true });
  const c = new DatabaseSync(join(gen, "terno.db"));
  c.exec("CREATE TABLE t (v); PRAGMA user_version = 37");
  c.close();
  const size = statSync(join(gen, "terno.db")).size;
  writeFileSync(join(gen, "manifest.json"), JSON.stringify({ file: "terno.db", fromSchema: 37, toSchema: 38, appVersion: "0.2.0", size, createdAt: 1000 }));
}

describe("main's mailbox gate (plan 95)", () => {
  it("a backend that explained its failure isn't restarted, and isn't a crash", () => {
    const t = setup({ alive: true });
    t.host.failed(3, { kind: "newer", schema: 40, supported: 38 });
    expect(t.published.at(-1)).toEqual({ kind: "newer", schema: 40, supported: 38 });
    expect(t.host.exited(3)).toBe(true);
    // another instance's exit is a crash, as before
    expect(t.host.exited(4)).toBe(false);
  });

  it("Try Again while the failed backend is still exiting starts a fresh one once it's gone, exactly once", () => {
    const t = setup({ alive: true });
    t.host.failed(1, corrupt(false));
    expect(t.host.retry()).toBe(true);
    expect(t.starts()).toBe(0);
    t.die();
    t.host.exited(1);
    expect(t.starts()).toBe(1);
  });

  it("Try Again does nothing while the mailbox is open or being upgraded", () => {
    const t = setup();
    t.host.reported({ kind: "upgrading", phase: "migrate", from: 37, to: 38 });
    expect(t.host.retry()).toBe(false);
    expect(t.starts()).toBe(0);
  });

  it("Update Without a Backup is a one-shot, and only where the backup is what failed or didn't fit", () => {
    const t = setup();
    t.host.failed(1, { kind: "no-room", stage: "migrate", needBytes: 1, freeBytes: 0, canSkipBackup: false });
    t.host.exited(1);
    expect(t.host.skipBackup()).toBe(false);
    t.host.failed(2, { kind: "no-room", stage: "backup", needBytes: 10, freeBytes: 0, canSkipBackup: false });
    t.host.exited(2);
    expect(t.host.skipBackup()).toBe(false);
    t.host.failed(3, { kind: "no-room", stage: "backup", needBytes: 10, freeBytes: 5, canSkipBackup: true });
    t.host.exited(3);
    expect(t.host.skipBackup()).toBe(true);
    expect(t.starts()).toBe(1);
    expect(t.host.beforeStart()).toEqual({ skipBackup: true });
    expect(t.host.beforeStart()).toEqual({});
  });

  it("restore: only a damaged mailbox with a backup, never while a backend holds the file; then a fresh start", async () => {
    const t = setup({ alive: true });
    backupIn(t.dir);
    t.host.failed(1, corrupt(true));
    expect(await t.host.restore()).toBe(false);
    t.die();
    t.host.exited(1);
    t.host.failed(2, { ...(corrupt(true) as Extract<MailboxGate, { kind: "failed" }>), reason: "migration" });
    t.host.exited(2);
    expect(await t.host.restore()).toBe(false);
    t.host.failed(3, corrupt(true));
    t.host.exited(3);
    expect(await t.host.restore()).toBe(true);
    expect(t.published.some((g) => g.kind === "restoring")).toBe(true);
    expect(readRestoredMarker(t.db)).toEqual({ createdAt: 1000 });
    expect(t.starts()).toBe(1);
    expect(t.logs).toContain("mailbox.restored");
  });

  it("a restore without room says so on the same screen, and leaves the mailbox as it was", async () => {
    const t = setup();
    backupIn(t.dir);
    const host = new MailboxHost({ dbPath: () => t.db, publish: (g) => t.published.push(g), start: () => {}, alive: () => false, log: () => {}, now: () => 0, restore: { freeBytes: () => 10 } });
    host.failed(1, corrupt(true));
    host.exited(1);
    expect(await host.restore()).toBe(false);
    expect(t.published.at(-1)).toMatchObject({ kind: "failed", reason: "corrupt", restoreFailed: "no-room" });
    expect(existsSync(restorePaths(t.db).aside)).toBe(false);
  });

  it("before a start, a restore a crash cut short is settled and logged", () => {
    const t = setup();
    writeFileSync(restorePaths(t.db).journal, JSON.stringify({ createdAt: 1 }));
    t.host.beforeStart();
    expect(t.logs).toContain("mailbox.restore_reconciled:rolled-back");
  });
});
