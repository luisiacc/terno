/**
 * Plan 107: exporting a 5,000-message folder (bodies, some attachments) as an .mbox, in both stores. Each `next`
 * stays within the slicer's budget (plus at most one unit begun inside it), and nothing in start or the nexts
 * stalls the event loop past it. One 50,000-message conversation's ids are read a bounded stretch at a time.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { BODY_READ } from "@terno/mail/portable";
import type { IncomingMessage, MailStore } from "@terno/store";
import { msg } from "@terno/store/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { describeGap, watchLoop } from "../../db/src/test/timing";
import type { BackendCore } from "./core";
import { FolderExports, sortByDate } from "./folder-export";

const NOW = Date.UTC(2026, 10, 1, 12);
const FOLDER = 5_000;
const OTHER = 3_000;
/** a next: the 15 ms budget plus one unit begun inside it (a batch read, an attachment chunk, a piece) */
const NEXT_MS = 25;
const STALL_MS = 25;
const stats: Stat[] = [];
const dirs: string[] = [];
afterAll(() => {
  report("folder-export.json", "Folder export (plan 107)", { folder: FOLDER, other: OTHER }, stats);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const yieldTurn = () => new Promise<void>((r) => setTimeout(r, 0));

async function seed(store: MailStore): Promise<number> {
  const { account } = await store.accounts.create({ kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo", now: 0 });
  await store.folders.replace(account.id, [{ key: "Label_big", path: ["Clients"], selectable: true }]);
  const bytes = new Uint8Array(200 * 1024).map((_, i) => i % 251);
  const all: IncomingMessage[] = [];
  for (let i = 0; i < FOLDER + OTHER; i++) {
    const inFolder = i < FOLDER;
    all.push(msg({
      accountId: account.id,
      providerMsgId: `x${i}`,
      providerThreadId: `t${Math.floor(i / 3)}`,
      subject: `Asunto ${i}`,
      date: NOW - (i % 4000) * 60_000,
      bodyText: `Hola ${i}\n${"palabra ".repeat(300 + (i % 7) * 100)}\nFrom here`,
      bodyHtml: i % 2 ? `<p>Hola ${i}</p>${"<p>texto</p>".repeat(200)}` : null,
      gmailLabels: inFolder ? ["INBOX", "Label_big"] : ["INBOX"],
      ...(inFolder && i % 100 === 0 ? { hasAttachments: true, attachments: [{ filename: `doc-${i}.bin`, mime: "application/octet-stream", size: bytes.length, bytes }] } : {}),
    }));
  }
  for (let i = 0; i < all.length; i += 500) await store.sync.ingest(all.slice(i, i + 500), { applyFilters: false, now: NOW, classifier: null });
  return account.id;
}

async function exportAll(name: string, store: MailStore, accountId: number) {
  const core = { store, isStopped: false, yieldTurn } as unknown as BackendCore;
  const exports = new FolderExports(core);
  const loop = watchLoop(STALL_MS * BUDGET_MULTIPLIER);
  const startedAt = performance.now();
  const start = await exports.start({ accountId, folder: "Label_big" }, "perf");
  const startMs = performance.now() - startedAt;
  // the renderer's first call comes on a turn of its own, as every later one does
  await yieldTurn();
  const nexts: number[] = [];
  let bytes = 0;
  let last;
  do {
    const t = performance.now();
    last = await exports.next(start.exportId, "perf");
    nexts.push(performance.now() - t);
    bytes += last.text.length;
    await yieldTurn();
  } while (!last.finished);
  const r = loop.stop();
  const sorted = [...nexts].sort((a, b) => a - b);
  const max = sorted.at(-1)!;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  stats.push({ name: `${name}: start ${startMs.toFixed(0)} ms, ${nexts.length} nexts (${(bytes / 1e6).toFixed(1)} MB), max stall ${r.stall.toFixed(1)} ms (longest ${describeGap(r.longest)})`, budgetMs: NEXT_MS, p50: sorted[Math.floor(sorted.length / 2)]!, p95, max, iterations: nexts.length });
  expect(start.total).toBe(FOLDER);
  expect(last).toMatchObject({ done: FOLDER, finished: true, missingAttachments: 0 });
  expect(p95, `${name}: next p95 ${p95.toFixed(1)} ms`).toBeLessThanOrEqual(NEXT_MS * BUDGET_MULTIPLIER);
  expect(r.stall, `${name}: event-loop stall`).toBeLessThanOrEqual(STALL_MS * BUDGET_MULTIPLIER);
}

const CONVERSATION = 50_000;
/** one id read: the slicer's budget plus a stretch begun inside it */
const IDS_MS = 25;

/** one Gmail conversation of CONVERSATION messages (half of them on one date), every one in the folder, beside a few short ones */
async function seedConversation(store: MailStore): Promise<number> {
  const { account } = await store.accounts.create({ kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo", now: 0 });
  await store.folders.replace(account.id, [{ key: "Label_big", path: ["Clients"], selectable: true }]);
  const all: IncomingMessage[] = [];
  for (let i = 0; i < CONVERSATION + 20; i++) {
    const long = i < CONVERSATION;
    all.push(msg({ accountId: account.id, providerMsgId: `c${i}`, providerThreadId: long ? "one" : `s${i}`, subject: `Hilo ${i}`, date: i < CONVERSATION / 2 ? NOW : NOW - (i % 5000) * 60_000, bodyText: `Hola ${i}`, gmailLabels: ["INBOX", "Label_big"] }));
  }
  for (let i = 0; i < all.length; i += 1000) await store.sync.ingest(all.slice(i, i + 1000), { applyFilters: false, now: NOW, classifier: null });
  return account.id;
}

/** start: every id read stays bounded inside the one long conversation, and the loop never stalls (Codex code review round 2 #6) */
async function startConversation(name: string, store: MailStore, accountId: number) {
  const ids = store.folderExport.ids.bind(store.folderExport);
  const reads: number[] = [];
  store.folderExport.ids = async (...a) => {
    const t = performance.now();
    const r = await ids(...a);
    reads.push(performance.now() - t);
    return r;
  };
  const exports = new FolderExports({ store, isStopped: false, yieldTurn } as unknown as BackendCore);
  const loop = watchLoop(STALL_MS * BUDGET_MULTIPLIER);
  const startedAt = performance.now();
  const start = await exports.start({ accountId, folder: "Label_big" }, "perf");
  const startMs = performance.now() - startedAt;
  // the renderer's call comes on a turn of its own
  await yieldTurn();
  const first = await exports.next(start.exportId, "perf");
  const r = loop.stop();
  exports.cancel(start.exportId, "perf");
  const sorted = [...reads].sort((a, b) => a - b);
  const max = sorted.at(-1)!;
  stats.push({ name: `${name}: one ${CONVERSATION}-message conversation, start ${startMs.toFixed(0)} ms, ${reads.length} id reads, max stall ${r.stall.toFixed(1)} ms (longest ${describeGap(r.longest)})`, budgetMs: IDS_MS, p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max, iterations: reads.length });
  expect(start.total).toBe(CONVERSATION + 20);
  expect(first.done).toBeGreaterThan(0);
  // read a stretch at a time, never whole
  expect(reads.length).toBeGreaterThan(CONVERSATION / 5000);
  expect(max, `${name}: one id read`).toBeLessThanOrEqual(IDS_MS * BUDGET_MULTIPLIER);
  expect(r.stall, `${name}: event-loop stall`).toBeLessThanOrEqual(STALL_MS * BUDGET_MULTIPLIER);
}

const BIG = 20 * 1024 * 1024;

/** a message whose stored body is 20 MB of short lines, and a short one */
async function seedBig(store: MailStore): Promise<number> {
  const { account } = await store.accounts.create({ kind: "gmail", email: "me@example.com", displayName: "Me", color: "indigo", now: 0 });
  await store.folders.replace(account.id, [{ key: "Label_big", path: ["Clients"], selectable: true }]);
  const body = Array.from({ length: BIG / 32 }, (_, i) => `línea ${String(i).padStart(9, "0")} con palabras`).join("\n");
  await store.sync.ingest([
    msg({ accountId: account.id, providerMsgId: "big", subject: "Big", date: NOW - 1000, bodyText: body, bodyHtml: null, gmailLabels: ["Label_big"] }),
    msg({ accountId: account.id, providerMsgId: "small", subject: "Small", date: NOW, bodyText: "hola", gmailLabels: ["Label_big"] }),
  ], { applyFilters: false, now: NOW, classifier: null });
  return account.id;
}

/**
 * Codex code review round 6 #4: the body read a stretch at a time from a store opened afresh (nothing cached): no
 * store call hands on more than a stretch, each next stays within budget, and the loop never stalls.
 */
async function exportBig(name: string, store: MailStore, accountId: number) {
  let handed = 0;
  const { messages, body } = store.folderExport;
  store.folderExport.messages = async (ids) => {
    const r = await messages.call(store.folderExport, ids);
    handed = Math.max(handed, JSON.stringify(r).length);
    return r;
  };
  store.folderExport.body = async (...a) => {
    const r = await body.call(store.folderExport, ...a);
    handed = Math.max(handed, r?.text.length ?? 0);
    return r;
  };
  const exports = new FolderExports({ store, isStopped: false, yieldTurn } as unknown as BackendCore);
  const loop = watchLoop(STALL_MS * BUDGET_MULTIPLIER);
  const start = await exports.start({ accountId, folder: "Label_big" }, "perf");
  await yieldTurn();
  const nexts: number[] = [];
  let bytes = 0;
  let last;
  do {
    const t = performance.now();
    last = await exports.next(start.exportId, "perf");
    nexts.push(performance.now() - t);
    bytes += last.text.length;
    await yieldTurn();
  } while (!last.finished);
  const r = loop.stop();
  const sorted = [...nexts].sort((a, b) => a - b);
  const max = sorted.at(-1)!;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  stats.push({ name: `${name}: a 20 MB body, ${nexts.length} nexts (${(bytes / 1e6).toFixed(1)} MB), most handed by one read ${handed}, max stall ${r.stall.toFixed(1)} ms (longest ${describeGap(r.longest)})`, budgetMs: NEXT_MS, p50: sorted[Math.floor(sorted.length / 2)]!, p95, max, iterations: nexts.length });
  expect(last).toMatchObject({ done: 2, finished: true, partialBodies: 0 });
  expect(bytes).toBeGreaterThan(BIG);
  expect(handed, `${name}: the most one store read handed on`).toBeLessThanOrEqual(BODY_READ);
  // a SQLite next is all work; an IndexedDB one also waits on the store's queue, which holds nothing up: its stall says
  if (name === "SQLite") expect(p95, `${name}: next p95 ${p95.toFixed(1)} ms`).toBeLessThanOrEqual(NEXT_MS * BUDGET_MULTIPLIER);
  expect(r.stall, `${name}: event-loop stall`).toBeLessThanOrEqual(STALL_MS * BUDGET_MULTIPLIER);
}

describe("folder export (plan 107)", () => {
  it("SQLite: a 20 MB body read a stretch at a time from disk (Codex code review round 6 #4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-export-perf-"));
    dirs.push(dir);
    const path = join(dir, "perf.db");
    const seeded = new SqlMailStore(openDatabase(path));
    const accountId = await seedBig(seeded);
    await seeded.close();
    const store = new SqlMailStore(openDatabase(path));
    try {
      await exportBig("SQLite", store, accountId);
    } finally {
      await store.close();
    }
  }, 300_000);

  it("IndexedDB: a 20 MB body read a stretch at a time, after a reopen (Codex code review round 6 #4)", async () => {
    const name = `export-big-perf-${Date.now()}`;
    const open = () => IdbMailStore.open({ name, factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: yieldTurn, bodyPreparation: nodePlatform.bodyPreparation }, instantSearch: false });
    const seeded = await open();
    const accountId = await seedBig(seeded);
    await seeded.close();
    const store = await open();
    try {
      await exportBig("IndexedDB", store, accountId);
    } finally {
      await store.close();
    }
  }, 600_000);

  it("SQLite: one 50,000-message conversation's ids, a bounded stretch a read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-export-perf-"));
    dirs.push(dir);
    const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
    try {
      await startConversation("SQLite", store, await seedConversation(store));
    } finally {
      await store.close();
    }
  }, 300_000);

  it("IndexedDB: one 50,000-message conversation's ids, a bounded stretch a read", async () => {
    const store = await IdbMailStore.open({ name: `export-conversation-perf-${Date.now()}`, factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: yieldTurn }, instantSearch: false });
    try {
      await startConversation("IndexedDB", store, await seedConversation(store));
    } finally {
      await store.close();
    }
  }, 900_000);


  it("a 1,000,000-message folder's order (both stores sort it here): every stretch between turns within budget (Codex code review round 9 #4)", async () => {
    const n = 1_000_000;
    const ids = Array.from({ length: n }, (_, i) => n - i);
    const dates = ids.map((id) => (id * 7919) % 100_000);
    const stretches: number[] = [];
    let since = performance.now();
    const sorted = await sortByDate(ids, dates, async () => {
      stretches.push(performance.now() - since);
      await yieldTurn();
      since = performance.now();
    });
    stretches.push(performance.now() - since);
    for (let i = 1; i < n; i++) if (dates[n - sorted[i]!]! < dates[n - sorted[i - 1]!]!) throw new Error(`out of order at ${i}`);
    const ms = [...stretches].sort((a, b) => a - b);
    const max = ms.at(-1)!;
    stats.push({ name: `sortByDate: ${n} ids, ${stretches.length} stretches`, budgetMs: STALL_MS, p50: ms[Math.floor(ms.length / 2)]!, p95: ms[Math.ceil(ms.length * 0.95) - 1]!, max, iterations: stretches.length });
    // before: the last merge and the result's build ran whole between two turns (~56 ms)
    expect(max, `longest of ${stretches.length} stretches`).toBeLessThanOrEqual(STALL_MS * BUDGET_MULTIPLIER);
  }, 300_000);

  it("SQLite: a 5,000-message folder, each next within budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-export-perf-"));
    dirs.push(dir);
    const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
    try {
      await exportAll("SQLite", store, await seed(store));
    } finally {
      await store.close();
    }
  }, 300_000);

  it("IndexedDB: a 5,000-message folder, each next within budget", async () => {
    const store = await IdbMailStore.open({ name: `export-perf-${Date.now()}`, factory: indexedDB, platform: { uuid: () => crypto.randomUUID(), yield: yieldTurn }, instantSearch: false });
    try {
      await exportAll("IndexedDB", store, await seed(store));
    } finally {
      await store.close();
    }
  }, 600_000);
});
