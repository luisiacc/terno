import "fake-indexeddb/auto";
/**
 * Plan 18 end to end on IndexedDB (fake-indexeddb in Node: the adapter's own
 * CPU and stalls) at 300,000 messages among 110,000 people: the service
 * builds both models from the in-memory rows and lazily read bodies in
 * slices, a command answers meanwhile, a cold start restores from the
 * snapshots, new mail is followed at a bounded cost per message.
 * Stalls are the event loop's (db's test/timing.ts: on a busy machine a rare
 * hold of the OS counts at its CPU time, and a wall time leaves out what such
 * holds took). What can be measured again is, up to three times in all, the
 * best counting: a regression is slow every time, a busy moment of the machine
 * isn't. That is a build's or a start's stall (another build, another start)
 * and a catch-up (other new mail, after an untimed warm-up); a start's time is
 * the first start's, since only that one is cold.
 */
import { contactsPages, CONTACTS_ACCOUNT, type ContactsDatasetOptions } from "@terno/mock-data";
import type { Platform } from "@terno/store";
import { Autocomplete, WEB_AUTOCOMPLETE_PEAK, WEB_CONTACT_CAPS, WEB_PHRASE_CAPS } from "@terno/store/autocomplete";
import { cpuMs, memoryFiles, PERF_MULT as MULT, perfLog as log } from "@terno/store/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeGap, stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";
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
const ATTEMPTS = 3;

/**
 * The longest stall while `fn` ran (rare holds of the OS excused on a busy machine), and the same with the
 * collections inside each gap left out; the longest GC pause meanwhile; its wall time less what those holds took.
 */
async function stalls<T>(budgetMs: number, fn: () => Promise<T>): Promise<{ result: T; stall: number; lessGc: number; maxGc: number; ms: number; held: number; longest: string; descheduled: number }> {
  const loop = watchLoop(budgetMs);
  const gc = watchGc();
  const started = performance.now();
  let stopped = false;
  try {
    const result = await fn();
    const ms = performance.now() - started;
    const r = loop.stop();
    stopped = true;
    const pauses = await gc.stop();
    const maxGc = Math.max(0, ...pauses.map((x) => x.end - x.start));
    return { result, stall: r.stall, lessGc: stallLessGc(r, pauses), maxGc, ms: ms - r.held, held: r.held, longest: describeGap(r.longest), descheduled: r.descheduled.length };
  } finally {
    if (!stopped) {
      loop.stop();
      await gc.stop();
    }
  }
}

/** a run's line in the log */
const described = (r: { stall: number; lessGc: number; maxGc: number; ms: number; held: number; longest: string; descheduled: number }) =>
  `${r.ms.toFixed(0)} ms, stall ${r.stall.toFixed(1)} ms (${r.lessGc.toFixed(1)} less its GC, longest GC ${r.maxGc.toFixed(1)}; longest gap ${r.longest}; ${r.descheduled} descheduled, ${r.held.toFixed(0)} ms held)`;

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
    const best = { stall: Infinity, commandMs: Infinity, ms: Infinity };
    const runs: string[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS && !(best.stall <= BUDGET.stallMs * MULT && best.commandMs <= BUDGET.commandMs * MULT); attempt++) {
      if (attempt > 1) {
        // a build again: without the snapshots the last one wrote
        await ac.close();
        await ac.reset();
      }
      ac = service();
      ac.setOwn([CONTACTS_ACCOUNT.email]);
      let commandMs = 0;
      const run = await stalls(BUDGET.stallMs * MULT, async () => {
        const warm = ac.warm();
        await new Promise((r) => setTimeout(r, 200));
        const t = performance.now();
        await store.settings.set("probe", 1);
        commandMs = performance.now() - t;
        await warm;
        await ac.idle(1_800_000);
      });
      expect(ac.report.contacts.build, "a build, not a restore").toBeDefined();
      runs.push(`${described(run)}, a command ${commandMs.toFixed(1)} ms`);
      // ours: each gap less the collections inside it (of a heap that isn't ours)
      best.stall = Math.min(best.stall, run.lessGc);
      best.commandMs = Math.min(best.commandMs, commandMs);
      // the wall time is the first build's (later ones run code already compiled)
      if (attempt === 1) best.ms = run.ms;
    }
    log(`idb autocomplete build: ${(best.ms / 1000).toFixed(1)} s (contacts ${(ac.report.contacts.build!.ms / 1000).toFixed(1)} s, phrases ${(ac.report.phrases.build!.ms / 1000).toFixed(1)} s for ${ac.report.phrases.build!.messages} sent), max event-loop stall less GC ${best.stall.toFixed(1)} ms, a command during it ${best.commandMs.toFixed(1)} ms; ${ac.report.contacts.size} contacts [${runs.join("; ")}]`);
    expect(ac.report.contacts.size).toBeGreaterThanOrEqual(100_000);
    expect(best.stall, "max event-loop stall, less GC (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    expect(best.commandMs, "a command during the build (ms)").toBeLessThanOrEqual(BUDGET.commandMs * MULT);
    expect(best.ms, "build wall time (ms)").toBeLessThanOrEqual(BUDGET.buildMs * MULT);
    expect(ac.suggestRecipients("ana").items.length).toBeGreaterThan(0);
    expect(ac.suggestText({ before: "Let me know if" })).toBe(" you have any questions.");
  }, 5_400_000);

  it("a cold start restores from the snapshots instead of rebuilding", async () => {
    const best = { ms: Infinity, stall: Infinity };
    const runs: string[] = [];
    // a start is cold once: the time is the first one's (less rare holds of the OS on a busy machine), while a stall
    // over budget (the restore's slices) is measured again
    for (let attempt = 1; attempt <= ATTEMPTS && !(best.stall <= BUDGET.stallMs * MULT); attempt++) {
      await ac.close();
      ac = service();
      const run = await stalls(BUDGET.stallMs * MULT, () => ac.warm());
      runs.push(described(run));
      expect(ac.report.contacts.restore).toBeDefined();
      if (attempt === 1) best.ms = run.ms;
      best.stall = Math.min(best.stall, run.stall);
      // the phrases restore after it; then a start again, if this one ran over
      await ac.idle(300_000);
      expect(ac.report.phrases.restore).toBeDefined();
    }
    log(`idb autocomplete cold start: ${best.ms.toFixed(0)} ms to recipients, max stall ${best.stall.toFixed(1)} ms [${runs.join("; ")}]`);
    expect(best.ms, "cold start to recipients (ms)").toBeLessThanOrEqual(BUDGET.coldStartMs * MULT);
    expect(best.stall, "max stall while restoring (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
  }, 1_200_000);

  it("new mail is followed at a bounded cost per message", async () => {
    let best = Infinity;
    const runs: string[] = [];
    let warmup = 0;
    // a warm-up first, untimed: the first catch-up after a start compiles its code and reads what the store keeps
    // lazily, about a second of CPU however few the messages (4 ms a message of 300), so a first catch-up of 3,000 was
    // mostly that, and one measured again would be warm; then each catch-up follows other new mail (new people among
    // it), never what is already applied, and one over budget is measured again
    for (let attempt = 0; attempt <= ATTEMPTS && !(best <= BUDGET.incrementalUs * MULT); attempt++) {
      const extra = [...contactsPages({ ...DATA, messages: attempt ? 3000 : 300, contacts: attempt ? 1000 : 100, seed: 76 + attempt }, 3000)][0]!.map((m) => ({ ...m, providerMsgId: `x${attempt}-${m.providerMsgId}`, rfcMessageId: `<x${attempt}-${m.rfcMessageId}>`, accountId }));
      await store.sync.ingest(extra, { applyFilters: false, now: NOW, classifier: null });
      const snapshotsBefore = ac.report.snapshots;
      const { cpu } = await cpuMs(async () => {
        ac.notify();
        await ac.idle(300_000);
      });
      expect(ac.report.snapshots, "no snapshot inside the catch-up measurement").toBe(snapshotsBefore);
      const us = (cpu / extra.length) * 1000;
      if (!attempt) {
        warmup = cpu;
        continue;
      }
      runs.push(us.toFixed(1));
      best = Math.min(best, us);
    }
    log(`idb autocomplete catch-up: ${best.toFixed(1)} µs CPU per message [${runs.join(", ")}]; the warm-up (300) ${warmup.toFixed(0)} ms`);
    expect(best, "catch-up CPU per message (µs)").toBeLessThanOrEqual(BUDGET.incrementalUs * MULT);
  }, 1_800_000);
});
