import { generateDataset, type GenerateOptions } from "@terno/mock-data";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../index";
import { MIGRATIONS } from "../migrations";
import { nodeSqliteDriver } from "../node-driver";
import { seedDataset, type SeedResult } from "../seed";
import { Db } from "../sqlite";
import { writeLegacyCopy } from "./legacy";

/**
 * The perf gates' SQLite mailboxes, seeded once and copied (plan 139): a seed is 15 to 30 s, a copy a clone.
 * Seeding is deterministic, so what's built stays on disk under a hash of everything that shapes it (the seed's and the
 * store's sources, the dataset, Node's SQLite): an unchanged tree reuses it, a changed one seeds again.
 *
 * A copy isn't always a seeded mailbox, so each caller says what it wants (Codex's revision 5):
 *
 * - `"closed"`: checkpointed and closed, with the seed's `PRAGMA optimize` statistics in the file: what a reopened
 *   mailbox is. Reads go through mmap.
 * - `"wal"`: the files as they stood with the seeding connection still open, so a new connection finds the last writes'
 *   hot pages in its WAL (read without mmap), as the app does right after a large sync. perf.perf and store.perf hold
 *   their budgets to this.
 *
 * What writes under load (ingest's paired rounds, instant's history) starts from "closed" and writes its own.
 * Not for a gate about what seeding itself costs; that has no gate here (`store.perf`'s ingest slices write their own).
 */
export interface MailboxSpec {
  key: string;
  dataset: GenerateOptions;
}

export const MAILBOX_NOW = Date.UTC(2026, 9, 22, 15, 30);

/** 51k messages with realistic bodies across 8 accounts: what the navigation, search and instant budgets are written for */
export const PERF_MAILBOX: MailboxSpec = { key: "perf", dataset: { threads: 29_500, accounts: 8, seed: 2026, now: MAILBOX_NOW, bodyScale: 4 } };

/** 57k threads and 100k+ messages: the store's "50k+ threads", for everything held to a mailbox that size */
export const LARGE_MAILBOX: MailboxSpec = { key: "large", dataset: { threads: 57_000, accounts: 8, seed: 64, now: MAILBOX_NOW, bodyScale: 2 } };

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" || e.name === "conformance" || e.name === "node_modules" ? [] : sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

let cachedDir: string | null = null;
/** this tree's snapshot directory; other trees' (older than a day: another checkout may be using theirs) are removed so the disk stays bounded */
function snapshots(): string {
  if (cachedDir) return cachedDir;
  const hash = createHash("sha256");
  hash.update(`${process.versions.node} ${process.versions.sqlite}\n`);
  const files = [...["core", "db", "mock-data", "store"].flatMap((p) => sources(join(packages, p, "src"))), join(here, "perf-mailbox.ts"), join(here, "legacy.ts")].sort();
  for (const f of files) hash.update(relative(packages, f)).update(readFileSync(f));
  const root = join(tmpdir(), "terno-perf-mailboxes");
  mkdirSync(root, { recursive: true });
  const dir = join(root, hash.digest("hex").slice(0, 16));
  for (const other of readdirSync(root)) {
    const p = join(root, other);
    if (p !== dir && Date.now() - statSync(p).mtimeMs > 86_400_000) rmSync(p, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return (cachedDir = dir);
}

/** Builds `name` in a scratch directory and renames it in: a reader never sees half of one. */
function once(name: string, build: (scratch: string) => void): string {
  const dir = join(snapshots(), name);
  if (existsSync(dir)) return dir;
  const scratch = mkdtempSync(join(snapshots(), `${name}-building-`));
  try {
    build(scratch);
    renameSync(scratch, dir);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function seeded(spec: MailboxSpec): string {
  return once(spec.key, (scratch) => {
    const path = join(scratch, "m.db");
    const db = openDatabase(path);
    const result = seedDataset(db, generateDataset(spec.dataset), { now: spec.dataset.now });
    writeFileSync(join(scratch, "result.json"), JSON.stringify(result));
    // the WAL as the last write left it, with the connection open (nothing else writes here)
    mkdirSync(join(scratch, "wal"));
    copyFileSync(path, join(scratch, "wal", "m.db"));
    copyFileSync(`${path}-wal`, join(scratch, "wal", "m.db-wal"));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  });
}

const clone = (from: string, to: string) => copyFileSync(from, to, constants.COPYFILE_FICLONE);

/** Puts a copy of the mailbox at `path`, and says what's in it. */
export function copyMailbox(spec: MailboxSpec, path: string, warmth: "closed" | "wal" = "closed"): SeedResult {
  const dir = seeded(spec);
  if (warmth === "closed") {
    clone(join(dir, "m.db"), path);
  } else {
    clone(join(dir, "wal", "m.db"), path);
    clone(join(dir, "wal", "m.db-wal"), `${path}-wal`);
  }
  return JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as SeedResult;
}

/** the migration that seeds the legacy-body upgrade's marker (an older copy has no such row) */
const BODY_PARTS_VERSION = MIGRATIONS.find((m) => m.sql.includes("'body_parts_upgrade'"))!.version;

/**
 * `spec`'s rows in the schema of `version` (≥ 6, when bodies moved out of messages): as writeLegacyCopy, in SQL rather
 * than row by row and with the triggers down while they go in (the rows already hold what they'd write), and the FTS
 * index rebuilt whole. A migration reads none of the index, so its timing doesn't see the difference.
 */
function writeFastLegacyCopy(source: string, path: string, version: number): void {
  const db = new Db(nodeSqliteDriver, path);
  try {
    for (const m of MIGRATIONS.filter((x) => x.version <= version)) db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${version}`);
    db.exec("PRAGMA foreign_keys = OFF");
    const triggers = db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'");
    for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    db.run("ATTACH DATABASE ? AS src", source);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").map((r) => r.name);
    db.tx(() => {
      for (const table of tables) {
        const list = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((c) => `"${c.name}"`).join(", ");
        const skip = table === "settings" && version < BODY_PARTS_VERSION ? " WHERE key != 'body_parts_upgrade'" : "";
        db.exec(`INSERT OR REPLACE INTO main."${table}" (${list}) SELECT ${list} FROM src."${table}"${skip}`);
      }
    });
    db.exec("DETACH DATABASE src");
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    for (const t of triggers) db.exec(t.sql);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/** Puts a copy of `spec` in the schema of `version` at `path`, as an install of that version would hold it. */
export function copyLegacyMailbox(spec: MailboxSpec, version: number, path: string): void {
  const dir = once(`${spec.key}-v${version}`, (scratch) => writeFastLegacyCopy(join(seeded(spec), "m.db"), join(scratch, "m.db"), version));
  clone(join(dir, "m.db"), path);
}

/**
 * Today's mailbox and a row-by-row copy of it in an older schema, for a gate that compares the two: the old triggers
 * build the old copy's FTS index as they did, and today's is vacuumed so neither has the other's page layout.
 */
export function copyPairedMailboxes(spec: MailboxSpec, version: number, today: string, old: string): SeedResult {
  const dir = once(`${spec.key}-paired-v${version}`, (scratch) => {
    const path = join(scratch, "today.db");
    clone(join(seeded(spec), "m.db"), path);
    const db = openDatabase(path);
    writeLegacyCopy(db, join(scratch, "old.db"), version);
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  });
  clone(join(dir, "today.db"), today);
  clone(join(dir, "old.db"), old);
  return JSON.parse(readFileSync(join(seeded(spec), "result.json"), "utf8")) as SeedResult;
}

/** A scratch directory for a test's copies, gone with `done()`. */
export function scratchDir(name: string): { dir: string; path(file: string): string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), `terno-${name}-`));
  return { dir, path: (file) => join(dir, file), done: () => rmSync(dir, { recursive: true, force: true }) };
}
