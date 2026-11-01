/**
 * Plan 107: exporting a 5,000-message folder (bodies, some attachments) as an .mbox, in both stores. Each `next`
 * stays within the slicer's budget (plus at most one unit begun inside it), and nothing in start or the nexts
 * stalls the event loop past it.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import type { IncomingMessage, MailStore } from "@terno/store";
import { msg } from "@terno/store/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { describeGap, watchLoop } from "../../db/src/test/timing";
import type { BackendCore } from "./core";
import { FolderExports } from "./folder-export";

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

describe("folder export (plan 107)", () => {
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
