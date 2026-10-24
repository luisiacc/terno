/**
 * Event-loop stalls of the engine's background work with inputs at the
 * edges: a 500k-term vocabulary (sorting it, building with it) and a single
 * 6 MB message body (building with it, applying it). The gap between two
 * yields is the longest the engine kept the thread; the budget is a frame.
 */
import { generateDataset } from "@terno/mock-data";
import { describe, expect, it } from "vitest";
import { corpusFromDataset } from "../conformance";
import type { SearchMessageDoc } from "../search";
import { InstantSearchEngine } from "./engine";
import { SliceClock, sortSliced } from "./slices";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const log = (line: string) => (globalThis as { console?: { log(s: string): void } }).console?.log(line);
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));
const FRAME = 16;

/** A yield that records how long the caller ran since it last resumed. */
function stallMeter() {
  let resumed = performance.now();
  let max = 0;
  const yields = { count: 0 };
  return {
    yield: async () => {
      max = Math.max(max, performance.now() - resumed);
      yields.count++;
      await macrotask();
      resumed = performance.now();
    },
    /** closes the last stretch (after the final yield) */
    done: () => Math.max(max, performance.now() - resumed),
    yields,
  };
}

function words(n: number, seed: number): string[] {
  let s = seed;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const abc = "abcdefghijklmnopqrstuvwxyzñáéíóú0123456789";
  return Array.from({ length: n }, () => {
    let w = "";
    for (let i = 0, len = 5 + Math.floor(rand() * 8); i < len; i++) w += abc[Math.floor(rand() * abc.length)];
    return w;
  });
}

describe("stalls with a 500k-term vocabulary", () => {
  it("sorting it yields at least every frame", async () => {
    const terms = words(500_000, 7);
    const input = new Int32Array(terms.length);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const m = stallMeter();
    const ids = await sortSliced(input, (a, b) => terms[a]! < terms[b]!, new SliceClock({ yield: m.yield, sliceMs: 4 }));
    const stall = m.done();
    for (let i = 1; i < ids.length; i++) expect(terms[ids[i - 1]!]! <= terms[ids[i]!]!).toBe(true);
    log(`sort 500k terms: longest stretch ${stall.toFixed(1)} ms over ${m.yields.count} yields`);
    expect(stall).toBeLessThanOrEqual(FRAME * MULT);
  }, 120_000);

  it("building an index with it yields at least every frame", async () => {
    const vocabulary = words(500_000, 11);
    const base = corpusFromDataset(generateDataset({ threads: 20_000, accounts: 4, seed: 5, now: NOW }));
    // every message carries ~15 rare tokens on top of its text (ids, codes, names): 500k distinct terms
    const messages: SearchMessageDoc[] = base.messages.map((d, i) => ({ ...d, body: `${d.body} ${vocabulary.slice((i * 15) % 499_985, ((i * 15) % 499_985) + 15).join(" ")}` }));
    const m = stallMeter();
    const e = new InstantSearchEngine({ yield: m.yield, sliceMs: 4 });
    e.beginBuild({ epoch: "p", seq: 0 });
    for (let i = 0; i < messages.length; i += 500) {
      await e.loadMessages(messages.slice(i, i + 500));
      await m.yield();
    }
    // in pages, as the indexer loads them
    for (let i = 0; i < base.threads.length; i += 500) {
      e.loadThreads(base.threads.slice(i, i + 500));
      await m.yield();
    }
    await e.finishBuild();
    const stall = m.done();
    log(`build with ${e.stats().terms} terms: longest stretch ${stall.toFixed(1)} ms`);
    expect(e.stats().terms).toBeGreaterThan(450_000);
    expect(stall).toBeLessThanOrEqual(FRAME * MULT);
  }, 300_000);
});

describe("stalls with a 6 MB message body", () => {
  const base = corpusFromDataset(generateDataset({ threads: 3_000, accounts: 2, seed: 9, now: NOW, bodyScale: 4 }));
  // a 6 MB body of real mail text (a long thread quoted in full, a log pasted in)
  let huge = "";
  for (let i = 0; huge.length < 6_000_000; i++) huge += `${base.messages[i % base.messages.length]!.body}\n> `;
  const hugeDoc: SearchMessageDoc = { ...base.messages[0]!, messageId: 9_000_000, body: huge };

  it("building with it yields at least every frame", async () => {
    const m = stallMeter();
    const e = new InstantSearchEngine({ yield: m.yield, sliceMs: 4 });
    e.beginBuild({ epoch: "p", seq: 0 });
    await e.loadMessages([...base.messages.slice(0, 1000), hugeDoc, ...base.messages.slice(1000)]);
    e.loadThreads(base.threads);
    await e.finishBuild();
    const stall = m.done();
    log(`build with a ${(huge.length / 1e6).toFixed(1)} MB body: longest stretch ${stall.toFixed(1)} ms`);
    expect(stall).toBeLessThanOrEqual(FRAME * MULT);
  }, 120_000);

  it("applying it yields at least every frame", async () => {
    let meter = stallMeter();
    const e = new InstantSearchEngine({ yield: () => meter.yield(), sliceMs: 4 });
    e.beginBuild({ epoch: "p", seq: 0 });
    await e.loadMessages(base.messages);
    e.loadThreads(base.threads);
    await e.finishBuild();
    meter = stallMeter();
    const rev = e.revision!;
    const t0 = performance.now();
    await e.apply({ from: rev, to: { epoch: rev.epoch, seq: rev.seq + 1 }, changes: [{ kind: "upsertMessage", doc: hugeDoc }] });
    const stall = meter.done();
    log(`apply a ${(huge.length / 1e6).toFixed(1)} MB body: ${(performance.now() - t0).toFixed(0)} ms, longest stretch ${stall.toFixed(1)} ms`);
    expect(stall).toBeLessThanOrEqual(FRAME * MULT);
  }, 120_000);
});
