import "fake-indexeddb/auto";
/**
 * Plan 18 end to end on IndexedDB (fake-indexeddb in Node: the adapter's own
 * CPU and stalls) at 300,000 messages among 110,000 people: the service
 * builds both models from the in-memory rows and lazily read bodies in
 * slices, a command answers meanwhile, a cold start restores from the
 * snapshots, new mail is followed at a bounded cost per message.
 */
import { contactsPages, CONTACTS_ACCOUNT, type ContactsDatasetOptions } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { Autocomplete, WEB_AUTOCOMPLETE_PEAK, WEB_CONTACT_CAPS, WEB_PHRASE_CAPS } from "@terno/store/autocomplete";
import { cpuMs, eventLoopStalls, memoryFiles, PERF_MULT as MULT, perfLog as log } from "@terno/store/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdbMailStore } from "./store";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const N = 300_000;
const DATA: ContactsDatasetOptions = { messages: N, contacts: 110_000, now: NOW, bodyChars: 200 };
// fake-indexeddb's own synchronous cloning shows in the stalls (Chromium does it off the main thread)
const BUDGET = { stallMs: 48, commandMs: 100, buildMs: 300_000, coldStartMs: 3000, incrementalUs: 300 };
const files = memoryFiles();
const platform: Pick<Platform, "uuid" | "yield" | "files"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)), files };
const name = `ac-perf-${Date.now()}`;
let store: IdbMailStore;
let ac: Autocomplete;
let accountId = 0;
/** after the build and on close only: the catch-up gate measures applying changes (a snapshot is its own, amortized cost, reported) */
const SNAPSHOTS = { changes: 1_000_000, ms: 3_600_000 };

const service = () =>
  new Autocomplete({ source: store.autocomplete, platform, settleMs: 0, now: () => NOW, snapshotEvery: SNAPSHOTS, contactCaps: WEB_CONTACT_CAPS, phraseCaps: WEB_PHRASE_CAPS, peakBytes: WEB_AUTOCOMPLETE_PEAK, sliceMs: 6 });

beforeAll(async () => {
  store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
  accountId = (await store.accounts.create({ kind: CONTACTS_ACCOUNT.kind, email: CONTACTS_ACCOUNT.email, displayName: CONTACTS_ACCOUNT.displayName, color: "indigo", now: NOW })).account.id;
  for (const page of contactsPages(DATA, 2000)) await store.sync.ingest(page.map((m) => ({ ...m, accountId })), { applyFilters: false, now: NOW, classifier: null });
}, 3_600_000);

afterAll(async () => {
  await ac?.close();
  await store?.close();
});

describe(`autocomplete on IndexedDB at ${N.toLocaleString("en")} messages`, () => {
  it("builds both models in slices; a command answers meanwhile", async () => {
    ac = service();
    ac.setOwn([CONTACTS_ACCOUNT.email]);
    let commandMs = 0;
    const run = await eventLoopStalls(async () => {
      const warm = ac.warm();
      await new Promise((r) => setTimeout(r, 200));
      const t = performance.now();
      await store.settings.set("probe", 1);
      commandMs = performance.now() - t;
      await warm;
      await ac.idle(1_800_000);
    });
    log(`idb autocomplete build: ${(run.ms / 1000).toFixed(1)} s wall (contacts ${(ac.report.contacts.build!.ms / 1000).toFixed(1)} s, phrases ${(ac.report.phrases.build!.ms / 1000).toFixed(1)} s for ${ac.report.phrases.build!.messages} sent), max event-loop stall ${run.maxStall.toFixed(1)} ms (longest GC ${run.maxGc.toFixed(1)} ms), a command during it ${commandMs.toFixed(1)} ms; ${ac.report.contacts.size} contacts`);
    expect(ac.report.contacts.size).toBeGreaterThanOrEqual(100_000);
    // ours: the stall less the longest garbage collection meanwhile (a collection of a heap that isn't ours)
    expect(run.maxStall - run.maxGc, "max event-loop stall, less GC (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    expect(commandMs, "a command during the build (ms)").toBeLessThanOrEqual(BUDGET.commandMs * MULT);
    expect(run.ms, "build wall time (ms)").toBeLessThanOrEqual(BUDGET.buildMs * MULT);
    expect(ac.suggestRecipients("ana").items.length).toBeGreaterThan(0);
    expect(ac.suggestText({ before: "Let me know if" })).toBe(" you have any questions.");
  }, 1_800_000);

  it("a cold start restores from the snapshots instead of rebuilding", async () => {
    await ac.close();
    ac = service();
    const run = await eventLoopStalls(() => ac.warm());
    log(`idb autocomplete cold start: ${run.ms.toFixed(0)} ms to recipients, max stall ${run.maxStall.toFixed(1)} ms`);
    expect(ac.report.contacts.restore).toBeDefined();
    expect(run.ms, "cold start to recipients (ms)").toBeLessThanOrEqual(BUDGET.coldStartMs * MULT);
    expect(run.maxStall, "max stall while restoring (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    await ac.idle(300_000);
    expect(ac.report.phrases.restore).toBeDefined();
  }, 600_000);

  it("new mail is followed at a bounded cost per message", async () => {
    const extra = [...contactsPages({ ...DATA, messages: 3000, contacts: 1000, seed: 77 }, 3000)][0]!.map((m) => ({ ...m, providerMsgId: `x${m.providerMsgId}`, rfcMessageId: `<x${m.rfcMessageId}>`, accountId }));
    await store.sync.ingest(extra, { applyFilters: false, now: NOW, classifier: null });
    const snapshotsBefore = ac.report.snapshots;
    const { cpu } = await cpuMs(async () => {
      ac.notify();
      await ac.idle(300_000);
    });
    const us = (cpu / extra.length) * 1000;
    expect(ac.report.snapshots, "no snapshot inside the catch-up measurement").toBe(snapshotsBefore);
    log(`idb autocomplete catch-up: ${us.toFixed(1)} µs CPU per message`);
    expect(us, "catch-up CPU per message (µs)").toBeLessThanOrEqual(BUDGET.incrementalUs * MULT);
  }, 600_000);
});
