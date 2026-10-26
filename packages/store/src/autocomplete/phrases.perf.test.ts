/**
 * Plan 18's body-suggestion gates: the phrase model learned from 100,000 sent
 * messages (greetings, habits, filler, quotes to strip), in pages as the
 * store serves them. Build CPU per message and the longest stall, memory
 * (heap and ArrayBuffers after GC, within the fixed table), and suggestion
 * latency for windows up to 1,000 characters and for a 1 MB line before the
 * caret (only its end is read). Each gate has an injected-regression twin.
 * The build's stall is the event loop's (timing.ts: on a busy machine a rare
 * hold of the OS counts at its CPU time), and a build over either budget is
 * measured again, up to three in all, the best of each counting: a regression
 * is slow every time.
 */
import type { Address } from "@terno/core";
import { contactPeople, sentBody } from "@terno/mock-data";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SentText } from "../autocomplete-source";
import { describeGap, watchLoop } from "../../../db/src/test/timing";
import { bestRounds, cpuMs, memoryBytes, PERF_MULT as MULT, perfLog as log } from "../conformance/perf";
import { SliceClock } from "../instant/slices";
import { PhraseModel, setPhrasesSlowdownForTests, setPhrasesUnboundedForTests } from "./phrases";

const N = 100_000;
const MiB = 1024 * 1024;
const BUDGET = { buildUsPerMessage: 60, stallMs: 16, memoryBytes: 24 * MiB, p95: 0.1, p99: 0.5 };

let people: Address[] = [];
let model: PhraseModel;
let windows: string[] = [];

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sent mail in pages of 16 (the service's page), ~400 characters of the user's own text plus a quote. */
function* sentPages(n: number, seed = 3): Generator<SentText[]> {
  const rand = prng(seed);
  let page: SentText[] = [];
  for (let i = 0; i < n; i++) {
    const to = people[Math.floor(Math.pow(rand(), 2) * people.length)]!;
    page.push({ id: i + 1, accountId: 1, date: 0, fromName: "Luis Cordero", to: [to], text: sentBody(rand, to, rand() < 0.4, 400) });
    if (page.length === 16) {
      yield page;
      page = [];
    }
  }
  if (page.length) yield page;
}

async function build(n: number): Promise<{ model: PhraseModel; stall: number; longest: string; descheduled: number }> {
  const loop = watchLoop(BUDGET.stallMs * MULT);
  const clock = new SliceClock({ yield: () => new Promise((r) => setTimeout(r, 0)), sliceMs: 4 });
  const m = new PhraseModel();
  for (const page of sentPages(n)) {
    await clock.pause();
    for (const t of page) {
      m.learn(t);
      await clock.tick();
    }
    if (m.needsPrune()) await m.prune(clock);
  }
  const r = loop.stop();
  return { model: m, stall: r.stall, longest: describeGap(r.longest), descheduled: r.descheduled.length };
}

async function footprint(): Promise<number> {
  const before = memoryBytes();
  const { model: m } = await build(N);
  const after = memoryBytes();
  return m.messages > 0 ? after - before : 0;
}

/** What is before a caret: the start of a habit, mid-word or after a word, after some text of the draft. */
function realisticWindows(n: number): string[] {
  const rand = prng(17);
  const starts = ["Let me know if you", "Let me know if", "Thanks for the qu", "I hope you're do", "Please find the doc", "Sounds good", "Quedo atento a tus", "Gracias por la res", "Espero que estés", "Te comparto el", "Hi Ana,\nLet me kn", "The budget review is", "Nothing like this at all"];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const prefix = "the project timeline and the budget review for the client. ".repeat(Math.floor(rand() * 16));
    out.push(prefix + starts[Math.floor(rand() * starts.length)]!);
  }
  return out;
}

function suggestions(m: PhraseModel, list: readonly string[]): number[] {
  const times: number[] = [];
  for (const before of list) {
    const t = performance.now();
    m.suggest({ before, names: ["Beatriz Quintana"], me: "Luis Cordero" });
    times.push(performance.now() - t);
  }
  return times;
}

beforeAll(() => {
  people = contactPeople(20_000, 5);
  windows = realisticWindows(5000);
}, 600_000);

afterAll(() => {
  setPhrasesSlowdownForTests(0);
  setPhrasesUnboundedForTests(false);
});

describe(`the phrase model from ${N.toLocaleString("en")} sent messages`, () => {
  it("learns within its CPU and stall budgets, in bounded memory", async () => {
    // a build over either budget is measured again, up to three in all, the best of each counting (CPU time too
    // inflates when every core is contended, from shared caches and SMT; a regression is slow in every build)
    const best = { stall: Infinity, us: Infinity };
    const runs: string[] = [];
    for (let r = 0; r < 3 && !(best.stall <= BUDGET.stallMs * MULT && best.us <= BUDGET.buildUsPerMessage * MULT); r++) {
      const { result, cpu } = await cpuMs(() => build(N));
      model = result.model;
      const us = (cpu / N) * 1000;
      runs.push(`${us.toFixed(1)} µs/message, stall ${result.stall.toFixed(1)} ms (longest gap ${result.longest}, ${result.descheduled} descheduled)`);
      best.stall = Math.min(best.stall, result.stall);
      best.us = Math.min(best.us, us);
    }
    const held = await footprint();
    log(`phrases build: ${best.us.toFixed(1)} µs CPU a message, longest stall ${best.stall.toFixed(1)} ms [${runs.join("; ")}]; memory ${(held / MiB).toFixed(1)} MiB measured, ${(model.allocatedBytes() / MiB).toFixed(1)} MiB counted`);
    expect(best.us, "build CPU per message (µs)").toBeLessThanOrEqual(BUDGET.buildUsPerMessage * MULT);
    expect(best.stall, "longest stall (ms)").toBeLessThanOrEqual(BUDGET.stallMs * MULT);
    expect(held, "heap + ArrayBuffers held").toBeLessThanOrEqual(BUDGET.memoryBytes);
    expect(model.allocatedBytes(), "counted ≥ measured").toBeGreaterThanOrEqual(held * 0.9);
    // and it learned the habits, not the quotes
    expect(model.suggest({ before: "Let me know if" })).toBe(" you have any questions.");
    expect(model.suggest({ before: "Hi ", names: ["Beatriz Quintana"] })).toBe("Beatriz,");
  }, 900_000);

  it("suggests in microseconds: p95 and p99 over 5,000 windows", () => {
    suggestions(model, windows.slice(0, 500));
    const r = bestRounds(5, () => suggestions(model, windows));
    log(`phrases suggest: p50 ${(r.p50 * 1000).toFixed(1)} µs, p95 ${(r.p95 * 1000).toFixed(1)} µs, p99 ${(r.p99 * 1000).toFixed(1)} µs`);
    expect(r.p95, "suggest p95 (ms)").toBeLessThanOrEqual(BUDGET.p95 * MULT);
    expect(r.p99, "suggest p99 (ms)").toBeLessThanOrEqual(BUDGET.p99 * MULT);
  });

  it("a 1 MB line before the caret costs the same (only its end is read); unbounded, it would fail the gate", () => {
    const huge = Array.from({ length: 20 }, (_, i) => `${"the project timeline and the budget review ".repeat(25_000)}${i % 2 ? "Let me know if" : "Thanks for the qu"}`);
    const bounded = bestRounds(3, () => suggestions(model, huge));
    log(`phrases suggest after 1 MB: p99 ${(bounded.p99 * 1000).toFixed(1)} µs`);
    expect(bounded.p99, "suggest p99 after a 1 MB line (ms)").toBeLessThanOrEqual(BUDGET.p99 * MULT);
    setPhrasesUnboundedForTests(true);
    try {
      const unbounded = bestRounds(2, () => suggestions(model, huge));
      log(`phrases suggest after 1 MB, injected unbounded window: p50 ${unbounded.p50.toFixed(1)} ms`);
      expect(unbounded.p50).toBeGreaterThan(BUDGET.p99 * MULT);
    } finally {
      setPhrasesUnboundedForTests(false);
    }
  });

  it("injected regression: 80 µs of extra work per message fails the build gate", async () => {
    setPhrasesSlowdownForTests(0.08);
    try {
      const { cpu } = await cpuMs(() => build(5000));
      const us = (cpu / 5000) * 1000;
      log(`phrases build, injected slowdown: ${us.toFixed(1)} µs/message`);
      expect(us).toBeGreaterThan(BUDGET.buildUsPerMessage * MULT);
    } finally {
      setPhrasesSlowdownForTests(0);
    }
  }, 300_000);

  it("a snapshot round trip keeps the suggestions", async () => {
    model.revision = { epoch: "p", seq: 1 };
    const bytes = await model.snapshot("p", new SliceClock({}));
    const r = new PhraseModel();
    const { result, cpu } = await cpuMs(() => r.restore(bytes, "p", new SliceClock({})));
    log(`phrases snapshot: ${(bytes.length / MiB).toFixed(1)} MiB, restore ${cpu.toFixed(0)} ms CPU`);
    expect(result).toBe(true);
    for (const w of windows.slice(0, 200)) expect(r.suggest({ before: w })).toBe(model.suggest({ before: w }));
  }, 120_000);
});
