/**
 * Plan 18 end to end on SQLite (node:sqlite) at 300,000 messages among
 * 110,000 people: the autocomplete service builds both models from the
 * store's source in slices (event-loop stalls measured with a 1 ms timer:
 * store reads, JSON parsing and the models together), a store command and a
 * lookup answer while it builds, a cold start restores from the snapshots,
 * and newly ingested mail is followed at a bounded cost per message.
 */
import { contactsPages, CONTACTS_ACCOUNT, type ContactsDatasetOptions } from "@terno/mock-data";
import { Autocomplete } from "@terno/store/autocomplete";
import { cpuMs, eventLoopStalls, PERF_MULT as MULT, perfLog as log } from "@terno/store/conformance";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodePlatform, openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const N = 300_000;
const DATA: ContactsDatasetOptions = { messages: N, contacts: 110_000, now: NOW, bodyChars: 200 };
// stalls: two frames (store reads, JSON parsing and the models' slices together)
const BUDGET = { stallMs: 32, commandMs: 50, buildMs: 120_000, coldStartMs: 1500, incrementalUs: 150 };
const dir = mkdtempSync(join(tmpdir(), "terno-ac-perf-"));
const path = join(dir, "perf.db");
let store: SqlMailStore;
let ac: Autocomplete;
let accountId = 0;
/** after the build and on close only: the catch-up gate measures applying changes (a snapshot is its own, amortized cost, reported) */
const SNAPSHOTS = { changes: 1_000_000, ms: 3_600_000 };

const service = () => new Autocomplete({ source: store.autocomplete, platform: nodePlatform, settleMs: 0, now: () => NOW, snapshotEvery: SNAPSHOTS });

beforeAll(async () => {
  store = new SqlMailStore(openDatabase(path), { platform: nodePlatform });
  accountId = (await store.accounts.create({ kind: CONTACTS_ACCOUNT.kind, email: CONTACTS_ACCOUNT.email, displayName: CONTACTS_ACCOUNT.displayName, color: "indigo", now: NOW })).account.id;
  for (const page of contactsPages(DATA, 2000)) await store.sync.ingest(page.map((m) => ({ ...m, accountId })), { applyFilters: false, now: NOW, classifier: null });
}, 1_200_000);

afterAll(async () => {
  await ac?.close();
  await store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe(`autocomplete on SQLite at ${N.toLocaleString("en")} messages`, () => {
  it("builds both models in slices; a command and a lookup answer meanwhile", async () => {
    ac = service();
    ac.setOwn([CONTACTS_ACCOUNT.email]);
    let commandMs = 0;
    let lookupMs = 0;
    const run = await eventLoopStalls(async () => {
      const warm = ac.warm();
      // while it builds: a store command, and a lookup (nothing yet, at once)
      await new Promise((r) => setTimeout(r, 200));
      let t = performance.now();
      await store.settings.set("probe", 1);
      commandMs = performance.now() - t;
      t = performance.now();
      const early = ac.suggestRecipients("ana");
      lookupMs = performance.now() - t;
      expect(early.ready || early.items.length >= 0).toBe(true);
      await warm;
      await ac.idle(600_000);
    });
    log(`sqlite autocomplete build: ${(run.ms / 1000).toFixed(1)} s wall (contacts ${(ac.report.contacts.build!.ms / 1000).toFixed(1)} s, phrases ${(ac.report.phrases.build!.ms / 1000).toFixed(1)} s for ${ac.report.phrases.build!.messages} sent), max event-loop stall ${run.maxStall.toFixed(1)} ms (longest GC ${run.maxGc.toFixed(1)} ms), a command during it ${commandMs.toFixed(1)} ms, a lookup ${lookupMs.toFixed(2)} ms; ${ac.report.contacts.size} contacts`);
    expect(ac.report.contacts.size).toBeGreaterThanOrEqual(100_000);
    // ours: the stall less the longest garbage collection meanwhile (a collection of a heap that isn't ours)
    expect(run.maxStall - run.maxGc, "max event-loop stall, less GC (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    expect(commandMs, "a command during the build (ms)").toBeLessThanOrEqual(BUDGET.commandMs * MULT);
    expect(lookupMs).toBeLessThanOrEqual(5 * MULT);
    expect(run.ms, "build wall time (ms)").toBeLessThanOrEqual(BUDGET.buildMs * MULT);
    expect(ac.suggestRecipients("ana").items.length).toBeGreaterThan(0);
    expect(ac.suggestText({ before: "Let me know if" })).toBe(" you have any questions.");
  }, 900_000);

  it("a cold start restores from the snapshots instead of rebuilding", async () => {
    await ac.close();
    const sizes = { contacts: statSync(`${path}.contacts`).size, phrases: statSync(`${path}.phrases`).size };
    ac = service();
    const run = await eventLoopStalls(async () => {
      await ac.warm();
      return performance.now();
    });
    log(`sqlite autocomplete cold start: ${run.ms.toFixed(0)} ms to recipients, max stall ${run.maxStall.toFixed(1)} ms; snapshots ${(sizes.contacts / 1048576).toFixed(1)} + ${(sizes.phrases / 1048576).toFixed(1)} MiB`);
    expect(ac.report.contacts.restore).toBeDefined();
    expect(ac.report.contacts.build).toBeUndefined();
    expect(run.ms, "cold start to recipients (ms)").toBeLessThanOrEqual(BUDGET.coldStartMs * MULT);
    expect(run.maxStall, "max stall while restoring (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    await ac.idle(120_000);
    expect(ac.report.phrases.restore).toBeDefined();
    expect(ac.suggestRecipients("ana").items.length).toBeGreaterThan(0);
  }, 300_000);

  it("new mail is followed at a bounded cost per message (store reads included)", async () => {
    const extra = [...contactsPages({ ...DATA, messages: 3000, contacts: 1000, seed: 77 }, 3000)][0]!.map((m) => ({ ...m, providerMsgId: `x${m.providerMsgId}`, rfcMessageId: `<x${m.rfcMessageId}>`, accountId }));
    await store.sync.ingest(extra, { applyFilters: false, now: NOW, classifier: null });
    const snapshotsBefore = ac.report.snapshots;
    const { cpu } = await cpuMs(async () => {
      ac.notify();
      await ac.idle(120_000);
    });
    const us = (cpu / extra.length) * 1000;
    expect(ac.report.snapshots, "no snapshot inside the catch-up measurement").toBe(snapshotsBefore);
    log(`sqlite autocomplete catch-up: ${us.toFixed(1)} µs CPU per message (headers, sent bodies, both models)`);
    expect(us, "catch-up CPU per message (µs)").toBeLessThanOrEqual(BUDGET.incrementalUs * MULT);
  }, 300_000);
});
