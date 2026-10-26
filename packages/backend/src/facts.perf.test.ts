/**
 * Plan 17's backfill at scale on SQLite (node:sqlite): 300,000 messages, in
 * 145,000 conversations and one of 50,000 messages, from the migration's
 * state to every thread's facts, through the backend's runner (slices sized
 * by the slicer at the backend's budget). The gate is the event loop's
 * longest stall (test/timing.ts: rare OS holds excused on a busy machine,
 * collections inside a gap left out; a run over budget is run again, up to
 * three times, the best counting). Then a kill: the backfill in a child
 * process, SIGKILLed past 40% of the threads; a new store resumes from what
 * committed and ends where an uninterrupted one does.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, seedDataset, sqlDb, SqlMailStore } from "@terno/db";
import { generateDataset, type MockDataset } from "@terno/mock-data";
import type { IncomingMessage, MailStore } from "@terno/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUDGET_MULTIPLIER as MULT, report, type Stat } from "../../db/src/test/perf";
import { describeGap, stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";
import { FACTS_SLICE, FactsBackfill } from "./facts";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
/** two frames: a slice, its commit and whatever the loop owes besides */
const STALL_MS = 32;
const ATTEMPTS = 3;
const CHILD = process.env.TERNO_FACTS_CHILD;
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

/** One conversation of `n` messages, a person and you taking turns (the skewed case: one thread is a fifth of the mail). */
function giantThread(accountId: number, me: string, n: number): IncomingMessage[] {
  return Array.from({ length: n }, (_, i) => {
    const mine = i % 3 === 2;
    return {
      accountId,
      providerMsgId: `giant-${i}`,
      providerThreadId: "giant",
      rfcMessageId: `giant-${i}@perf.test`,
      inReplyTo: i ? `giant-${i - 1}@perf.test` : null,
      references: i ? [`giant-${i - 1}@perf.test`] : [],
      from: mine ? { name: "Me", email: me } : { name: "Carlos", email: "carlos@acme.com" },
      to: [mine ? { name: "Carlos", email: "carlos@acme.com" } : { name: "Me", email: me }],
      cc: [],
      bcc: [],
      subject: i ? "Re: el proyecto" : "El proyecto",
      date: NOW - (n - i) * 60_000,
      snippet: "",
      bodyText: `Mensaje ${i}`,
      bodyHtml: null,
      bodyState: "full",
      listId: null,
      isRead: true,
      isStarred: false,
      inInbox: !mine,
      isSent: mine,
      isDraft: false,
      isTrash: false,
      isSpam: false,
      hasAttachments: false,
      size: 100,
    };
  });
}

const factsRows = (store: SqlMailStore) => sqlDb(store).all<{ id: number; person: number | null; waiting_since: number | null }>("SELECT id, person, waiting_since FROM threads ORDER BY id");

/** The backend's runner over a store, to the end: what a start does. */
async function runBackfill(store: MailStore): Promise<number> {
  let slices = 0;
  const counted: MailStore = { ...store, isOpen: true, settle: store.settle?.bind(store), facts: { idle: () => store.facts.idle(), backfill: (o) => (slices++, store.facts.backfill(o)) } } as MailStore;
  const runner = new FactsBackfill({ store: counted, platform: { yield: yieldTurn }, notifyChanged: () => {}, log: () => {} }, FACTS_SLICE);
  runner.wake();
  await runner.idle();
  return slices;
}

if (CHILD) {
  // the child of the kill test: backfills the given database, a line of progress per slice, until it is killed
  it("child: backfills until killed", { timeout: 1_200_000 }, async () => {
    const store = new SqlMailStore(openDatabase(CHILD), { checkpointWorker: true });
    writeFileSync(`${CHILD}.pid`, String(process.pid));
    for (;;) {
      const r = await store.facts.backfill({ limit: 200 });
      appendFileSync(`${CHILD}.progress`, `${r.phase} ${r.processed}\n`);
      if (!r.more) break;
      await yieldTurn();
    }
  });
} else {
  describe("the facts backfill at 300,000 messages (SQLite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-facts-perf-"));
    const path = join(dir, "perf.db");
    const killPath = join(dir, "kill.db");
    let store: SqlMailStore;
    let expected: ReturnType<typeof factsRows>;
    const stats: Stat[] = [];
    const meta: Record<string, unknown> = {};

    beforeAll(async () => {
      // as the desktop backend opens it: WAL checkpoints on their worker (settle() waits for them between slices)
      store = new SqlMailStore(openDatabase(path), { checkpointWorker: true });
      const data: MockDataset = generateDataset({ threads: 145_000, accounts: 4, seed: 17, now: NOW, bodyScale: 1 });
      const seeded = seedDataset(sqlDb(store), data, { now: NOW, chunkSize: 2000 });
      const giant = giantThread(seeded.accountIds[0]!, data.accounts[0]!.email, 50_000);
      for (let i = 0; i < giant.length; i += 5000) await store.sync.ingest(giant.slice(i, i + 5000), { applyFilters: false, now: NOW, classifier: null });
      expected = factsRows(store);
      meta.messages = sqlDb(store).get<{ c: number }>("SELECT count(*) AS c FROM messages")!.c;
      meta.threads = expected.length;
      expect(meta.messages as number).toBeGreaterThanOrEqual(300_000);
      expect(expected.some((r) => r.person === 1) && expected.some((r) => r.waiting_since !== null)).toBe(true);
      await store.debug.resetFacts();
      sqlDb(store).exec(`VACUUM INTO '${killPath}'`);
    }, 1_800_000);

    afterAll(async () => {
      report("facts.json", "Plan 17: the facts backfill (SqlMailStore, node:sqlite)", meta, stats);
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it(`backfills in slices, the event loop never held past ${STALL_MS} ms, to what ingest computes`, { timeout: 1_800_000 }, async () => {
      const runs: { stall: number; ms: number; slices: number; line: string }[] = [];
      for (let attempt = 1; attempt <= ATTEMPTS && !(runs.length && Math.min(...runs.map((r) => r.stall)) <= STALL_MS * MULT); attempt++) {
        if (attempt > 1) await store.debug.resetFacts();
        // the reset is the test's own bulk write (every thread, not a migration's few indexes): its WAL goes before the clock starts
        sqlDb(store).exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const loop = watchLoop(STALL_MS * MULT);
        const gc = watchGc();
        const started = performance.now();
        const slices = await runBackfill(store);
        const ms = performance.now() - started;
        const r = loop.stop();
        const pauses = await gc.stop();
        const stall = stallLessGc(r, pauses);
        runs.push({ stall, ms: ms - r.held, slices, line: `${(ms - r.held).toFixed(0)} ms, ${slices} slices, stall ${stall.toFixed(1)} ms less GC (${r.stall.toFixed(1)} with it; longest gap ${describeGap(r.longest)}; ${r.descheduled.length} descheduled)` });
        expect(factsRows(store)).toEqual(expected);
      }
      for (const run of runs) console.log(`facts backfill: ${run.line}`);
      const best = runs.reduce((a, b) => (b.stall < a.stall ? b : a));
      const first = runs[0]!;
      stats.push({ name: `backfill ${meta.threads} threads / ${meta.messages} msgs: ${first.ms.toFixed(0)} ms, ${Math.round((meta.threads as number) / (first.ms / 1000))} threads/s, ${first.slices} slices; longest stall ${best.stall.toFixed(1)} ms`, budgetMs: STALL_MS, p50: best.stall, p95: best.stall, max: best.stall, iterations: runs.length });
      expect(best.stall, `longest stall: ${best.line}`).toBeLessThanOrEqual(STALL_MS * MULT);
    });

    it("killed mid-way (SIGKILL, in a child process), a new store resumes from what committed and ends the same", { timeout: 1_800_000 }, async () => {
      const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
      const child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--project", "perf", fileURLToPath(import.meta.url), "-t", "child"], {
        cwd: root,
        env: { ...process.env, TERNO_FACTS_CHILD: killPath },
        stdio: "ignore",
      });
      const threads = expected.length;
      const done = () => (existsSync(`${killPath}.progress`) ? readFileSync(`${killPath}.progress`, "utf8").split("\n").filter((l) => l.startsWith("threads")).reduce((n, l) => n + Number(l.split(" ")[1]), 0) : 0);
      const started = performance.now();
      while (done() < threads * 0.4) {
        if (performance.now() - started > 1_200_000) throw new Error("the child never got past 40%");
        if (child.exitCode !== null) throw new Error(`the child ended first (${child.exitCode})`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // the test's own worker, then the runner that forked it: both started here
      process.kill(Number(readFileSync(`${killPath}.pid`, "utf8")), "SIGKILL");
      child.kill("SIGKILL");
      await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r(null) : child.once("exit", r)));
      const resumed = new SqlMailStore(openDatabase(killPath), { checkpointWorker: true });
      try {
        const pending = sqlDb(resumed).get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE person IS NULL")!.c;
        meta.killedAt = `${Math.round((1 - pending / threads) * 100)}%`;
        expect(pending).toBeGreaterThan(0);
        expect(pending).toBeLessThan(threads * 0.6 + 1);
        expect(await resumed.facts.idle()).toBe(false);
        await runBackfill(resumed);
        expect(await resumed.facts.idle()).toBe(true);
        expect(factsRows(resumed)).toEqual(expected);
      } finally {
        await resumed.close();
      }
    });
  });
}
