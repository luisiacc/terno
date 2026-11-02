/**
 * Plan 112: the backup before a migration as an APFS clone, made under the
 * mailbox's exclusive lock; any other connection sends it the backup API's
 * way. Real files on the test machine's volume (APFS on macOS; elsewhere the
 * clone path never applies, and these are skipped).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { cloneFile, cpError, sameApfsVolume } from "./clone";
import { SCHEMA_VERSION } from "./migrations";
import { nodeSqliteDriver } from "./node-driver";
import { classifyOpenError } from "./open-errors";
import { openDatabaseWith } from "./portable";
import { migrateHeadroom, prepareUpgrade, type UpgradeOptions } from "./upgrade";
import { oldMailbox } from "./test/old-mailbox";

const PREV = SCHEMA_VERSION - 1;
const GiB = 2 ** 30;
const apfs = process.platform === "darwin" && statfsSync(tmpdir()).type === 26;

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), "terno-clone-"));
  dirs.push(dir);
  return { dir, db: join(dir, "terno.db"), backups: join(dir, "backups") };
}

const opts = (w: { backups: string }, o: Partial<UpgradeOptions> = {}): UpgradeOptions => ({ backupsDir: w.backups, appVersion: "0.3.0", freeBytes: () => 100 * GiB, ...o });

const drafts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, subjects: (db.prepare("SELECT subject FROM drafts ORDER BY id").all() as { subject: string }[]).map((r) => r.subject) };
  } finally {
    db.close();
  }
};

/** the lock is gone: another connection can write at once */
function writable(path: string): boolean {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE; COMMIT");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

const INSERT = "INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (99, 'g', 1, 2, 'new', '[]', '[]', 'only in the WAL', '', '', 5)";

/** A separate process holding the mailbox in one state; resolves once it is there. */
function holder(path: string, state: "untouched" | "read" | "reading" | "writing" | "checkpointing"): Promise<ChildProcess> {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(path)});
    const state = ${JSON.stringify(state)};
    if (state === "read") db.prepare("SELECT count(*) FROM drafts").get();
    if (state === "reading") { db.exec("BEGIN"); db.prepare("SELECT count(*) FROM drafts").get(); }
    if (state === "writing") { db.exec("BEGIN IMMEDIATE"); }
    if (state === "checkpointing") { db.exec("PRAGMA checkpoint_fullfsync = ON"); db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); }
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  procs.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (b: Buffer) => b.toString().includes("ready") && resolve(child));
    child.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
}

describe.skipIf(!apfs)("prepareUpgrade's clone (plan 112)", () => {
  it("clones a mailbox whose commits live only in the WAL (a process that died without closing): every row, one self-contained file", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 2);
    // a Terno that crashed: its last commit is only in the -wal, beside a -shm
    const r = spawnSync(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(w.db)}); db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0"); db.exec(${JSON.stringify(INSERT)}); process.exit(0);`]);
    expect(r.status).toBe(0);
    expect(existsSync(`${w.db}-wal`)).toBe(true);
    let told = 0;
    const plan = await prepareUpgrade(w.db, opts(w, { onBackup: () => told++ }));
    expect(plan).toMatchObject({ made: true, method: "clone", backup: { fromSchema: PREV } });
    expect(told).toBe(1);
    expect(drafts(plan.backup!.file)).toEqual({ version: PREV, subjects: ["draft 1", "draft 2", "only in the WAL"] });
    expect(readdirSync(plan.backup!.dir).sort()).toEqual(["manifest.json", "terno.db"]);
    expect(JSON.parse(readFileSync(join(plan.backup!.dir, "manifest.json"), "utf8"))).toMatchObject({ method: "clone" });
    // the lock went with the clone: the migration opens and writes
    expect(writable(w.db)).toBe(true);
    const db = openDatabaseWith(nodeSqliteDriver, w.db);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(SCHEMA_VERSION);
    db.close();
    expect(drafts(plan.backup!.file).version).toBe(PREV);
  });

  it.each(["read", "reading", "writing", "checkpointing"] as const)("another process that has the file (%s) sends the backup the backup API's way, undisturbed", async (state) => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    const wal = new DatabaseSync(w.db);
    wal.exec("PRAGMA journal_mode = WAL");
    wal.close();
    await holder(w.db, state);
    const plan = await prepareUpgrade(w.db, opts(w));
    expect(plan).toMatchObject({ made: true, method: "copy" });
    expect(drafts(plan.backup!.file).subjects).toEqual(["draft 1"]);
  });

  it("a handle opened and never used holds nothing: the clone goes ahead, and the handle reads after", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    await holder(w.db, "untouched");
    const plan = await prepareUpgrade(w.db, opts(w));
    expect(plan).toMatchObject({ made: true, method: "clone" });
    expect(writable(w.db)).toBe(true);
  });

  it("asks only for the migration's room (a clone is free when made); the copy path asks for the whole file too", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    const size = readFileSync(w.db).length;
    const headroom = migrateHeadroom(size);
    expect(await prepareUpgrade(w.db, opts(w, { freeBytes: () => headroom }))).toMatchObject({ method: "clone" });
    const v = workdir();
    oldMailbox(v.db, PREV, 1);
    const error = await prepareUpgrade(v.db, opts(v, { freeBytes: () => headroom, volume: () => false })).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toMatchObject({ kind: "no-room", stage: "backup", canSkipBackup: true });
  });

  it("a cp that copied in full instead of cloning is said as a copy, and one that leaves too little room is no-room with nothing kept", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    const size = readFileSync(w.db).length;
    let free = 10 * GiB;
    const copied = (src: string, dst: string) => cloneFile(src, dst).then(() => void (free -= size));
    expect(await prepareUpgrade(w.db, opts(w, { freeBytes: () => free, clone: copied }))).toMatchObject({ method: "copy" });
    const v = workdir();
    oldMailbox(v.db, PREV, 1);
    // the copy's bytes count only while it is there: once it goes, the migration alone fits (Codex code review #4)
    const base = migrateHeadroom(size) + size - 1;
    let copy = "";
    const tracked = (src: string, dst: string) => cloneFile(src, (copy = dst));
    const error = await prepareUpgrade(v.db, opts(v, { freeBytes: () => base - (copy && existsSync(copy) ? size : 0), clone: tracked })).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toMatchObject({ kind: "no-room", stage: "backup", canSkipBackup: true, freeBytes: base });
    expect(readdirSync(v.backups)).toEqual([]);
    expect(writable(v.db)).toBe(true);
  });

  it("a backend ended with SIGTERM mid-copy takes its cp with it (Codex code review #2)", async () => {
    const w = workdir();
    // a FIFO nobody writes: cp blocks reading it, as a long copy would
    const fifo = join(w.dir, "slow");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const clone = join(__dirname, "clone.ts");
    const child = spawn(process.execPath, ["-e", `import(${JSON.stringify(clone)}).then((m) => { m.cloneFile(${JSON.stringify(fifo)}, ${JSON.stringify(join(w.dir, "out"))}).catch(() => {}); setTimeout(() => process.stdout.write("ready\\n"), 200); setInterval(() => {}, 1000); });`], { stdio: ["ignore", "pipe", "inherit"] });
    procs.push(child);
    await new Promise<void>((resolve) => child.stdout!.on("data", (b: Buffer) => b.toString().includes("ready") && resolve()));
    const cp = Number(spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).stdout.trim());
    expect(cp).toBeGreaterThan(0);
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    child.kill("SIGTERM");
    // the process still ends as SIGTERM ends it
    expect(await exited).toBe("SIGTERM");
    const alive = () => {
      try {
        process.kill(cp, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });

  it.each([
    ["ENOSPC", "no-room"],
    ["EACCES", "unwritable"],
    ["EIO", "failed"],
  ] as const)("a clone that fails with %s: no partial folder, the mailbox as it was and unlocked, said as %s", async (code, kind) => {
    const w = workdir();
    oldMailbox(w.db, PREV, 2);
    const before = drafts(w.db);
    const error = await prepareUpgrade(w.db, opts(w, { clone: () => Promise.reject(Object.assign(new Error(code), { code })) })).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toMatchObject(kind === "no-room" ? { kind: "no-room", stage: "backup" } : { kind: "failed", reason: kind === "unwritable" ? "unwritable" : "backup" });
    expect(readdirSync(w.backups)).toEqual([]);
    expect(drafts(w.db)).toEqual(before);
    expect(writable(w.db)).toBe(true);
  });

  it("the real cp into a folder it can't write is said as unwritable", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    const ro = join(w.dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const error = await prepareUpgrade(w.db, opts(w, { clone: (src) => cloneFile(src, join(ro, "terno.db")) })).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toMatchObject({ kind: "failed", reason: "unwritable" });
    expect(writable(w.db)).toBe(true);
  });

  it("a clone that doesn't verify (another file) fails, cleaned up and unlocked", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    const other = workdir();
    oldMailbox(other.db, PREV - 1, 1);
    const error = await prepareUpgrade(w.db, opts(w, { clone: (_src, dst) => cloneFile(other.db, dst) })).catch((e: unknown) => e);
    expect(classifyOpenError(error)).toMatchObject({ kind: "failed", reason: "backup" });
    expect(readdirSync(w.backups)).toEqual([]);
    expect(writable(w.db)).toBe(true);
  });

  it("a new backups folder is created only for a backup, beside the mailbox on its volume", async () => {
    const w = workdir();
    oldMailbox(w.db, PREV, 1);
    expect(existsSync(w.backups)).toBe(false);
    expect(sameApfsVolume(w.db, w.backups)).toBe(true);
    await prepareUpgrade(w.db, opts(w));
    expect(readdirSync(w.backups)).toHaveLength(1);
  });
});

describe("cp's words become errno codes", () => {
  it.each([
    ["cp: /x/terno.db: No space left on device", "ENOSPC"],
    ["cp: /x/terno.db: Permission denied", "EACCES"],
    ["cp: /x/terno.db: Read-only file system", "EROFS"],
    ["cp: /x/terno.db: Input/output error", undefined],
  ])("%s", (stderr, code) => {
    expect((cpError(stderr, new Error("Command failed")) as { code?: string }).code).toBe(code);
  });
});
