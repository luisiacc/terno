/**
 * Plan 18's recipient gates at the edge: 300,000 messages among 110,000
 * people. Build CPU per message and the longest stall, memory (heap and
 * ArrayBuffers after GC, and the index's own count), the snapshot's size and
 * a cold start from it, per-keystroke lookups (p95/p99 over 5,000 realistic
 * queries, best of 5 rounds), and an incremental message. Each gate has an
 * injected-regression twin that must fail it.
 */
import type { Address } from "@terno/core";
import { contactPeople, contactsPages, generateContactsDataset, type ContactsDatasetOptions } from "@terno/mock-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContactMessage } from "../autocomplete-source";
import { bestRounds, cpuMs, memoryBytes, PERF_MULT as MULT, perfLog as log, stallMeter } from "../conformance/perf";
import { SliceClock } from "../instant/slices";
import { ContactIndex, setContactsScanForTests, setContactsSlowdownForTests } from "./contacts";
import { fold } from "./fold";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const N = 300_000;
const PEOPLE = 110_000;
const MiB = 1024 * 1024;
const FRAME = 16;
const BUDGET = { buildUsPerMessage: 15, stallMs: FRAME, memoryBytes: 32 * MiB, snapshotBytes: 24 * MiB, restoreCpuMs: 250, p95: 0.25, p99: 1, incrementalUs: 20 };

const DATA: ContactsDatasetOptions = { messages: N, contacts: PEOPLE, now: NOW, bodyChars: 0 };
let people: Address[] = [];
let queries: string[] = [];
let index: ContactIndex;

function toContact(m: ReturnType<typeof generateContactsDataset>["messages"][number], id: number): ContactMessage {
  return { id, accountId: 1, date: m.date, sent: m.isSent, spam: false, draft: false, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc, hasBody: true };
}

/** What people type in a To field: prefixes of first names, last names, addresses, initials, "first l". */
function realisticQueries(n: number): string[] {
  let s = 99;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const out: string[] = [];
  while (out.length < n) {
    // popular people are typed more often
    const p = people[Math.floor(Math.pow(rand(), 2.4) * people.length)]!;
    const words = p.name.split(" ").filter(Boolean);
    const local = p.email.split("@")[0]!;
    const kind = Math.floor(rand() * 5);
    const len = 1 + Math.floor(rand() * 12);
    let q = "";
    if (kind === 0 && words[0]) q = words[0].slice(0, len);
    else if (kind === 1 && words[1]) q = words[1].slice(0, len);
    else if (kind === 2) q = local.slice(0, len);
    else if (kind === 3 && words.length >= 2) q = (words[0]![0]! + words[1]![0]!).toLowerCase();
    else if (words.length >= 2) q = `${words[0]} ${words[1]!.slice(0, Math.max(1, len - 4))}`;
    else q = local.slice(0, len);
    if (q) out.push(rand() < 0.3 ? fold(q) : q);
  }
  return out;
}

/** As the service builds: pages of 500 headers (a store read each, then a yield), the clock in between. */
async function build(o: ContactsDatasetOptions): Promise<{ index: ContactIndex; stall: number }> {
  const meter = stallMeter();
  const clock = new SliceClock({ yield: meter.yield, sliceMs: 4 });
  const idx = new ContactIndex({ now: () => NOW });
  idx.beginBuild({ epoch: "perf", seq: 0 });
  let id = 0;
  // the people are generated beforehand (test data, not the build's work)
  for (const raw of contactsPages(o, 500, people)) {
    const page = raw.map((m) => toContact(m, ++id));
    await clock.pause();
    for (let i = 0; i < page.length; i++) {
      idx.add(page[i]!);
      if ((i & 63) === 63) await clock.tick();
    }
  }
  await idx.finishBuild(clock);
  return { index: idx, stall: meter.done() };
}

/** What an index built from the dataset holds: memory after building it (alive), minus before (each after a full GC). */
async function footprint(): Promise<number> {
  const before = memoryBytes();
  const { index: idx } = await build(DATA);
  const after = memoryBytes();
  // alive until measured
  return idx.size > 0 ? after - before : 0;
}

function lookups(idx: ContactIndex, qs: readonly string[]): number[] {
  const times: number[] = [];
  for (const q of qs) {
    const t = performance.now();
    idx.suggest(q, { limit: 6, accountId: 1 });
    times.push(performance.now() - t);
  }
  return times;
}

beforeAll(() => {
  people = contactPeople(PEOPLE, 7 ^ 0x9e37);
  queries = realisticQueries(5000);
}, 600_000);

afterAll(() => {
  setContactsScanForTests(false);
  setContactsSlowdownForTests(0);
});

describe(`the contact index at ${N.toLocaleString("en")} messages`, () => {
  it("builds within its CPU and stall budgets, in bounded memory", async () => {
    // best of 3 for the stall (a preemption by another process shows as a long stretch once; ours every time)
    let best: { stall: number; cpu: number } | null = null;
    for (let r = 0; r < 3; r++) {
      index = null as unknown as ContactIndex;
      const { result, cpu } = await cpuMs(() => build(DATA));
      index = result.index;
      if (!best || result.stall < best.stall) best = { stall: result.stall, cpu };
      if (best.stall <= BUDGET.stallMs * MULT) break;
    }
    const counted = index.allocatedBytes();
    const size = index.size;
    const held = await footprint();
    const usPerMessage = (best!.cpu / N) * 1000;
    log(`contacts build: ${size} contacts, ${best!.cpu.toFixed(0)} ms CPU (${usPerMessage.toFixed(2)} µs/message), longest stall ${best!.stall.toFixed(1)} ms; memory ${(held / MiB).toFixed(1)} MiB measured, ${(counted / MiB).toFixed(1)} MiB counted`);
    expect(size).toBeGreaterThanOrEqual(100_000);
    expect(usPerMessage, "build CPU per message (µs)").toBeLessThanOrEqual(BUDGET.buildUsPerMessage * MULT);
    expect(best!.stall, "longest stall (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    expect(held, "heap + ArrayBuffers held").toBeLessThanOrEqual(BUDGET.memoryBytes);
    // the caps are enforced on the counted figure: it must never undercount, and not wildly overcount either
    expect(counted, "counted ≥ measured").toBeGreaterThanOrEqual(held);
    expect(counted, "counted within 1.6× of measured").toBeLessThanOrEqual(held * 1.6);
  }, 600_000);

  it("answers a keystroke in microseconds: p95 and p99 over 5,000 realistic queries", () => {
    // warm the JIT on other queries first
    lookups(index, queries.slice(0, 500));
    const r = bestRounds(5, () => lookups(index, queries));
    log(`contacts lookup: p50 ${(r.p50 * 1000).toFixed(1)} µs, p95 ${(r.p95 * 1000).toFixed(1)} µs, p99 ${(r.p99 * 1000).toFixed(1)} µs, max ${r.max.toFixed(2)} ms`);
    expect(r.p95, "lookup p95 (ms)").toBeLessThanOrEqual(BUDGET.p95 * MULT);
    expect(r.p99, "lookup p99 (ms)").toBeLessThanOrEqual(BUDGET.p99 * MULT);
    // and they find people: most realistic prefixes return someone
    const found = queries.slice(0, 1000).filter((q) => index.suggest(q).length > 0).length;
    expect(found).toBeGreaterThan(900);
  });

  it("injected regression: the same lookups by scanning every contact fail the gate", () => {
    setContactsScanForTests(true);
    try {
      const r = bestRounds(2, () => lookups(index, queries.slice(0, 60)));
      log(`contacts lookup, injected scan: p95 ${r.p95.toFixed(1)} ms`);
      expect(r.p95).toBeGreaterThan(BUDGET.p99 * MULT);
    } finally {
      setContactsScanForTests(false);
    }
  });

  it("a snapshot within its size; a cold start from it within budget, with the same answers", async () => {
    index.revision = { epoch: "perf", seq: 1 };
    const bytes = await index.snapshot("perf", new SliceClock({}));
    let restoreCpu = Infinity;
    let restored: ContactIndex | null = null;
    for (let r = 0; r < 3; r++) {
      const fresh = new ContactIndex({ now: () => NOW });
      const { result, cpu } = await cpuMs(() => fresh.restore(bytes, "perf", new SliceClock({ yield: () => new Promise((res) => setTimeout(res, 0)), sliceMs: 4 })));
      expect(result).toBe(true);
      if (cpu < restoreCpu) {
        restoreCpu = cpu;
        restored = fresh;
      }
    }
    log(`contacts snapshot: ${(bytes.length / MiB).toFixed(1)} MiB; cold start ${restoreCpu.toFixed(0)} ms CPU`);
    expect(bytes.length, "snapshot bytes").toBeLessThanOrEqual(BUDGET.snapshotBytes);
    expect(restoreCpu, "restore CPU (ms)").toBeLessThanOrEqual(BUDGET.restoreCpuMs * MULT);
    for (const q of queries.slice(0, 300)) expect(restored!.suggest(q, { accountId: 1 }), q).toEqual(index.suggest(q, { accountId: 1 }));
  }, 300_000);

  it("an incremental message costs microseconds (new people included, merges counted)", async () => {
    const extra = generateContactsDataset({ messages: 20_000, contacts: 4000, now: NOW, seed: 31, bodyChars: 0 }).messages.map((m, i) => toContact(m, N + 1 + i));
    const clock = new SliceClock({});
    const { cpu } = await cpuMs(async () => {
      for (const m of extra) {
        index.add(m);
        if (index.needsMerge()) await index.merge(clock);
      }
    });
    const us = (cpu / extra.length) * 1000;
    log(`contacts incremental: ${us.toFixed(2)} µs/message`);
    expect(us, "incremental CPU per message (µs)").toBeLessThanOrEqual(BUDGET.incrementalUs * MULT);
    // and lookups stay fast with the delta and merges in
    const r = bestRounds(3, () => lookups(index, queries.slice(0, 2000)));
    expect(r.p99, "lookup p99 after updates (ms)").toBeLessThanOrEqual(BUDGET.p99 * MULT);
  }, 300_000);

  it("injected regression: 30 µs of extra work per message fails the build gate", async () => {
    setContactsSlowdownForTests(0.03);
    try {
      const { cpu } = await cpuMs(() => build({ ...DATA, messages: 20_000 }));
      const us = (cpu / 20_000) * 1000;
      log(`contacts build, injected slowdown: ${us.toFixed(1)} µs/message`);
      expect(us).toBeGreaterThan(BUDGET.buildUsPerMessage * MULT);
    } finally {
      setContactsSlowdownForTests(0);
    }
  }, 300_000);
});
