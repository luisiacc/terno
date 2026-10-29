/**
 * Seeds a fresh Terno database with the deterministic demo mailbox.
 *   tsx src/seed.ts --out <dir> [--accounts 8] [--threads 12000] [--print-fixtures]
 * Used by `pnpm dev:desktop:seeded` so the app opens instantly on a full mailbox.
 * --print-fixtures adds the print test conversations (plan 09) to the first inbox.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, SqlMailStore } from "@terno/db";
import { seedDemo, seedPrintFixtures } from "@terno/backend";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const out = arg("out", "");
if (!out) {
  console.error("usage: seed.ts --out <profile dir> [--accounts 8] [--threads 12000]");
  process.exit(1);
}
const accounts = Number(arg("accounts", "8"));
const threads = Number(arg("threads", "12000"));

mkdirSync(out, { recursive: true });
const dbPath = join(out, "terno.db");
for (const suffix of ["", "-wal", "-shm", ".search"]) rmSync(dbPath + suffix, { force: true });

const db = openDatabase(dbPath);
const store = new SqlMailStore(db);
const now = Date.now();
await seedDemo(store, { accounts, threads, now });
if (process.argv.includes("--print-fixtures")) await seedPrintFixtures(store, { now });
await store.settings.set("app", { ai: { provider: "fake" } });
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
await store.close();
console.log("[seed] demo mailbox ready");
