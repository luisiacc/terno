import { describe, expect, it, vi } from "vitest";
import { AiError, type CompletionRequest, type ModelTransport } from "@terno/ai";
import { AiLimiter, DAILY_REQUESTS, DailyLimitError, MonthlyLimitError } from "./ai-limiter";

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function host(limit = 10, clock = { now: new Date(2026, 10, 4, 12).getTime() }) {
  const values = new Map<string, unknown>();
  return {
    clock,
    limit,
    // as on disk: a write is a copy, so what a crash would leave is only what was written
    store: {
      settings: {
        get: async <T,>(key: string, fallback: T) => (values.has(key) ? (JSON.parse(values.get(key) as string) as T) : fallback),
        set: async (key: string, value: unknown) => void values.set(key, JSON.stringify(value)),
        update: async <R,>(): Promise<R> => { throw new Error("the limiter doesn't use this"); },
      },
    },
    now() { return clock.now; },
    async monthlyLimitUsd() { return this.limit; },
  };
}

const req = (signal = new AbortController().signal): CompletionRequest => ({ system: "s", messages: [], output: "text", maxTokens: 10, signal });
const free: ModelTransport = { complete: async () => ({ text: "", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } }) };

describe("AiLimiter", () => {
  it("stops a background task at its daily limit, and starts again the next day", async () => {
    const h = host();
    const limiter = new AiLimiter(h);
    const t = limiter.wrap(free, { task: "summary", model: "gpt-6-luna", local: false, foreground: false });
    // only the daily ceiling is under test: an hour between requests keeps clear of the per-minute share
    for (let i = 0; i < DAILY_REQUESTS.summary; i++) {
      await t.complete(req());
      h.clock.now += 1;
      if (i % 19 === 18) h.clock.now += 61_000;
    }
    h.clock.now += 61_000;
    await expect(t.complete(req())).rejects.toBeInstanceOf(DailyLimitError);
    h.clock.now += 86_400_000;
    await expect(t.complete(req())).resolves.toBeTruthy();
  });

  it("stops background work at the monthly ceiling but never a person's own request", async () => {
    const h = host(0.0001);
    const limiter = new AiLimiter(h);
    const big: ModelTransport = { complete: async () => ({ text: "", stop: "end", usage: { inputTokens: 1_000_000, outputTokens: 0 } }) };
    await limiter.wrap(big, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(req());
    await expect(limiter.wrap(free, { task: "categorize", model: "gpt-6-luna", local: false, foreground: false }).complete(req())).rejects.toBeInstanceOf(MonthlyLimitError);
    await expect(limiter.wrap(free, { task: "writing", model: "claude-sonnet-5-5", local: false, foreground: true }).complete(req())).resolves.toBeTruthy();
  });

  it("plan 132: a summary asked for by hand counts as spent, never toward the day's or the month's ceilings", async () => {
    const h = host(0.0001);
    const limiter = new AiLimiter(h);
    const big: ModelTransport = { complete: async () => ({ text: "", stop: "end", usage: { inputTokens: 1_000_000, outputTokens: 0 } }) };
    const byHand = limiter.wrap(big, { task: "summary", model: "gpt-6-luna", local: false, foreground: true });
    for (let i = 0; i < DAILY_REQUESTS.summary + 1; i++) await byHand.complete(req());
    const report = await limiter.report();
    expect(report.today.requests).toBe(DAILY_REQUESTS.summary + 1);
    expect(report.month.usd).toBeGreaterThan(0);
    expect(report.monthBackgroundUsd).toBe(0);
    await expect(limiter.wrap(free, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(req())).resolves.toBeTruthy();
  });

  it("counts a failed request, so a failing provider can't be retried past the ceiling", async () => {
    const h = host();
    const limiter = new AiLimiter(h);
    const failing: ModelTransport = { complete: async () => { throw new AiError("x", "unavailable"); } };
    await expect(limiter.wrap(failing, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(req())).rejects.toThrow();
    await new Promise((r) => setTimeout(r));
    expect((await limiter.report()).today.requests).toBe(1);
  });

  it("gives a local model one request at a time, foreground first", async () => {
    const limiter = new AiLimiter(host());
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = new Promise<void>((r) => (finishFirst = r));
    const slow: ModelTransport = { complete: async () => (await first, order.push("first"), { text: "", stop: "end" }) };
    const quick = (name: string): ModelTransport => ({ complete: async () => (order.push(name), { text: "", stop: "end" }) });
    const running = limiter.wrap(slow, { task: "summary", model: "m", local: true, foreground: false }).complete(req());
    await new Promise((r) => setTimeout(r));
    const background = limiter.wrap(quick("background"), { task: "categorize", model: "m", local: true, foreground: false }).complete(req());
    await new Promise((r) => setTimeout(r));
    const foreground = limiter.wrap(quick("foreground"), { task: "writing", model: "m", local: true, foreground: true }).complete(req());
    await new Promise((r) => setTimeout(r));
    finishFirst();
    await Promise.all([running, background, foreground]);
    expect(order).toEqual(["first", "foreground", "background"]);
  });

  it("drops a waiter whose request was cancelled, and the queue moves on", async () => {
    const limiter = new AiLimiter(host());
    let finishFirst!: () => void;
    const first = new Promise<void>((r) => (finishFirst = r));
    const slow: ModelTransport = { complete: async () => (await first, { text: "", stop: "end" }) };
    const running = limiter.wrap(slow, { task: "writing", model: "m", local: true, foreground: true }).complete(req());
    await new Promise((r) => setTimeout(r));
    const controller = new AbortController();
    const cancelled = limiter.wrap(free, { task: "writing", model: "m", local: true, foreground: true }).complete(req(controller.signal));
    await new Promise((r) => setTimeout(r));
    controller.abort();
    await expect(cancelled).rejects.toBeTruthy();
    finishFirst();
    await running;
    await expect(limiter.wrap(free, { task: "writing", model: "m", local: true, foreground: true }).complete(req())).resolves.toBeTruthy();
  });

  it("counts every request of a stream and reports the month's cost", async () => {
    const limiter = new AiLimiter(host());
    const streaming: ModelTransport = {
      complete: free.complete,
      async *stream() {
        yield { type: "delta", text: "a" };
        yield { type: "done", stop: "end", usage: { inputTokens: 1_000_000, outputTokens: 0 } };
      },
    };
    const wrapped = limiter.wrap(streaming, { task: "writing", model: "claude-sonnet-5-5", local: false, foreground: true });
    for await (const _ of wrapped.stream!(req())) { /* drained */ }
    await new Promise((r) => setTimeout(r));
    const report = await limiter.report();
    expect(report.month.requests).toBe(1);
    expect(report.month.usd).toBeCloseTo(2, 5);
    expect(report.monthBackgroundUsd).toBe(0);
  });

  describe("an unknown price (plan 131 review)", () => {
    const chars = "x".repeat(2_500); // 1,000 estimated input tokens
    const sized = (maxTokens = 1_000): CompletionRequest => ({ system: chars, messages: [], output: "text", maxTokens, signal: new AbortController().signal });

    it("a cloud model nobody priced counts at the fallback, so the ceiling bites and the report says it's an estimate", async () => {
      const h = host(0.5);
      const limiter = new AiLimiter(h);
      const used: ModelTransport = { complete: async () => ({ text: "", stop: "end", usage: { inputTokens: 10_000, outputTokens: 10_000 } }) };
      const unpriced = limiter.wrap(used, { task: "summary", model: "mystery-1", local: false, foreground: false });
      await unpriced.complete(sized());
      const report = await limiter.report();
      expect(report.month.usd).toBeCloseTo((10_000 * 10 + 10_000 * 50) / 1e6, 8);
      expect(report.estimated).toBe(true);
      await expect(unpriced.complete(sized())).rejects.toBeInstanceOf(MonthlyLimitError);
    });

    it("admission uses the fallback before anything is sent", async () => {
      const limiter = new AiLimiter(host(0.05));
      let sent = 0;
      const counting: ModelTransport = { complete: async () => (sent++, { text: "", stop: "end" }) };
      // $0.01 of input and $0.05 of output at the fallback: past a $0.05 ceiling on its own
      await expect(limiter.wrap(counting, { task: "summary", model: "mystery-1", local: false, foreground: false }).complete(sized())).rejects.toBeInstanceOf(MonthlyLimitError);
      expect(sent).toBe(0);
    });

    it("a local model costs nothing, whatever it's called, and isn't an estimate", async () => {
      const limiter = new AiLimiter(host());
      const silent: ModelTransport = { complete: async () => ({ text: "", stop: "end" }) };
      await limiter.wrap(silent, { task: "summary", model: "claude-opus-5-5", local: true, foreground: false }).complete(sized());
      const report = await limiter.report();
      expect(report.month.usd).toBe(0);
      expect(report.estimated).toBe(false);
    });

    it("a known price with usage reported isn't an estimate", async () => {
      const limiter = new AiLimiter(host());
      await limiter.wrap(free, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(sized());
      expect((await limiter.report()).estimated).toBe(false);
    });

    it("a person's request on an unknown price is counted too, never refused", async () => {
      const limiter = new AiLimiter(host(0.0001));
      await limiter.wrap(free, { task: "writing", model: "mystery-1", local: false, foreground: true }).complete(sized());
      const report = await limiter.report();
      expect(report.month.usd).toBeGreaterThan(0);
      expect(report.estimated).toBe(true);
    });
  });

  describe("the worst case stands when nothing says otherwise (plan 131 review)", () => {
    const chars = "x".repeat(2_500);
    const sized = (): CompletionRequest => ({ system: chars, messages: [], output: "text", maxTokens: 1_000, signal: new AbortController().signal });
    const worst = (1_000 * 2.5 + 1_000 * 10) / 1e6; // sonnet: input at the cache-write price, plus every output token

    it("a response with no usage keeps its reservation", async () => {
      const limiter = new AiLimiter(host());
      const silent: ModelTransport = { complete: async () => ({ text: "", stop: "end" }) };
      await limiter.wrap(silent, { task: "summary", model: "claude-sonnet-5-5", local: false, foreground: false }).complete(sized());
      const report = await limiter.report();
      expect(report.monthBackgroundUsd).toBeCloseTo(worst, 10);
      expect(report.estimated).toBe(true);
    });

    it("a server reporting zero tokens has told us nothing", async () => {
      const limiter = new AiLimiter(host());
      const zero: ModelTransport = { complete: async () => ({ text: "", stop: "end", usage: { inputTokens: 0, outputTokens: 0 } }) };
      await limiter.wrap(zero, { task: "summary", model: "claude-sonnet-5-5", local: false, foreground: false }).complete(sized());
      expect((await limiter.report()).monthBackgroundUsd).toBeCloseTo(worst, 10);
    });

    it("a failed request keeps its reservation", async () => {
      const limiter = new AiLimiter(host());
      const failing: ModelTransport = { complete: async () => { throw new AiError("x", "unavailable"); } };
      await expect(limiter.wrap(failing, { task: "summary", model: "claude-sonnet-5-5", local: false, foreground: false }).complete(sized())).rejects.toThrow();
      expect((await limiter.report()).monthBackgroundUsd).toBeCloseTo(worst, 10);
    });

    it("a stream stopped early keeps its reservation, and one that finished settles", async () => {
      const limiter = new AiLimiter(host());
      const streaming: ModelTransport = {
        complete: free.complete,
        async *stream() {
          yield { type: "delta", text: "a" };
          yield { type: "done", stop: "end", usage: { inputTokens: 1_000, outputTokens: 1 } };
        },
      };
      const wrapped = limiter.wrap(streaming, { task: "writing", model: "claude-sonnet-5-5", local: false, foreground: true });
      for await (const event of wrapped.stream!(sized())) { expect(event.type).toBe("delta"); break; }
      expect((await limiter.report()).month.usd).toBeCloseTo(worst, 10);
      for await (const _ of wrapped.stream!(sized())) { /* drained */ }
      expect((await limiter.report()).month.usd).toBeCloseTo(worst + (1_000 * 2 + 1 * 10) / 1e6, 10);
    });

    it("a request settled on a later day corrects the day it was charged to", async () => {
      const h = host();
      const limiter = new AiLimiter(h);
      let finish!: () => void;
      const slow: ModelTransport = { complete: async () => (await new Promise<void>((r) => (finish = r)), { text: "", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } }) };
      const running = limiter.wrap(slow, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(sized());
      await vi.waitFor(() => expect(finish).toBeTruthy());
      h.clock.now += 86_400_000;
      finish();
      await running;
      const usage = await h.store.settings.get<Record<string, Record<string, { requests: number; usd: number }>>>("ai:usage", {});
      expect(Object.keys(usage)).toHaveLength(1);
      expect(Object.values(usage)[0]!.summary!.usd).toBeCloseTo((0.1 + 0.4) / 1e6, 12);
    });
  });

  describe("admission (plan 131 review)", () => {
    const usage = { complete: async () => ({ text: "", stop: "end" as const, usage: { inputTokens: 1, outputTokens: 1 } }) };

    it("concurrent callers can't pass one remaining request: the one that reproduced 301 at a ceiling of 300", async () => {
      const h = host();
      await h.store.settings.set("ai:usage", { [dayKey(h.clock.now)]: { summary: { requests: DAILY_REQUESTS.summary - 1, inputTokens: 0, outputTokens: 0, usd: 0 } } });
      const limiter = new AiLimiter(h);
      let sent = 0;
      const counting: ModelTransport = { complete: async () => (sent++, await usage.complete()) };
      const t = limiter.wrap(counting, { task: "summary", model: "gpt-6-luna", local: false, foreground: false });
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => t.complete(req())));
      expect(sent).toBe(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await limiter.report()).today.requests).toBe(DAILY_REQUESTS.summary);
    });

    it("concurrent callers can't pass one remaining dollar: the incoming worst case counts, in flight", async () => {
      const limiter = new AiLimiter(host(0.015));
      let sent = 0;
      let finish!: () => void;
      const stalled: ModelTransport = { complete: async () => (sent++, await new Promise<void>((r) => (finish = r)), { text: "", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } }) };
      const big = (): CompletionRequest => ({ system: "s", messages: [], output: "text", maxTokens: 1_000, signal: new AbortController().signal }); // $0.01 on sonnet
      const t = limiter.wrap(stalled, { task: "summary", model: "claude-sonnet-5-5", local: false, foreground: false });
      const first = t.complete(big());
      await vi.waitFor(() => expect(sent).toBe(1));
      await expect(t.complete(big())).rejects.toBeInstanceOf(MonthlyLimitError);
      finish();
      await first;
      // settled to what it really cost, there's room again
      await expect(limiter.wrap(free, { task: "summary", model: "claude-sonnet-5-5", local: false, foreground: false }).complete(big())).resolves.toBeTruthy();
    });

    it("two first callers share one book: the second can't overwrite what the first charged", async () => {
      const h = host();
      const limiter = new AiLimiter(h);
      const t = limiter.wrap(free, { task: "summary", model: "gpt-6-luna", local: false, foreground: false });
      await Promise.all([t.complete(req()), t.complete(req()), t.complete(req())]);
      expect((await limiter.report()).today.requests).toBe(3);
    });

    it("a crash mid-request leaves it counted, durably, before the request left", async () => {
      const h = host();
      let dispatched!: () => void;
      const reached = new Promise<void>((r) => (dispatched = r));
      const hanging: ModelTransport = { complete: () => (dispatched(), new Promise(() => {})) };
      void new AiLimiter(h).wrap(hanging, { task: "summary", model: "claude-sonnet-5-5", local: false, foreground: false }).complete({ ...req(), maxTokens: 1_000 });
      await reached;
      // what a new process reads back from disk
      const report = await new AiLimiter(h).report();
      expect(report.today.requests).toBe(1);
      expect(report.monthBackgroundUsd).toBeGreaterThanOrEqual(0.01);
      expect(report.estimated).toBe(true);
    });

    it("refuses background work when the reservation can't be written, and sends nothing", async () => {
      const h = host();
      const limiter = new AiLimiter(h);
      let sent = 0;
      const counting: ModelTransport = { complete: async () => (sent++, await usage.complete()) };
      const set = h.store.settings.set;
      h.store.settings.set = async () => { throw new Error("disk full"); };
      const t = limiter.wrap(counting, { task: "summary", model: "gpt-6-luna", local: false, foreground: false });
      await expect(t.complete(req())).rejects.toMatchObject({ kind: "unavailable" });
      expect(sent).toBe(0);
      expect((await limiter.report()).today.requests).toBe(0);
      // the disk came back: it runs, and the chain of writes isn't stuck
      h.store.settings.set = set;
      await expect(t.complete(req())).resolves.toBeTruthy();
      expect(sent).toBe(1);
    });

    it("a person's own request goes even when nothing can be written or read, and is still counted", async () => {
      const h = host();
      const limiter = new AiLimiter(h);
      h.store.settings.set = async () => { throw new Error("disk full"); };
      await expect(limiter.wrap(free, { task: "writing", model: "gpt-6-luna", local: false, foreground: true }).complete(req())).resolves.toBeTruthy();
      expect((await limiter.report()).today.requests).toBe(1);
      const unreadable = new AiLimiter(h);
      h.store.settings.get = async () => { throw new Error("disk gone"); };
      await expect(unreadable.wrap(free, { task: "writing", model: "gpt-6-luna", local: false, foreground: true }).complete(req())).resolves.toBeTruthy();
      await expect(unreadable.wrap(free, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(req())).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("rechecks after waiting for a local slot: what got ahead of it used the last request", async () => {
      const h = host();
      await h.store.settings.set("ai:usage", { [dayKey(h.clock.now)]: { summary: { requests: DAILY_REQUESTS.summary - 2, inputTokens: 0, outputTokens: 0, usd: 0 } } });
      const limiter = new AiLimiter(h);
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const slow: ModelTransport = { complete: async () => (await hold, { text: "", stop: "end" }) };
      // holds the local model, and takes 299 of 300
      const holding = limiter.wrap(slow, { task: "summary", model: "m", local: true, foreground: false }).complete(req());
      await vi.waitFor(async () => expect((await limiter.report()).today.requests).toBe(DAILY_REQUESTS.summary - 1));
      let sent = 0;
      const waiting = limiter.wrap({ complete: async () => (sent++, await usage.complete()) }, { task: "summary", model: "m", local: true, foreground: false }).complete(req());
      await new Promise((r) => setTimeout(r));
      // a cloud request takes the last one while the other waits
      await limiter.wrap(free, { task: "summary", model: "gpt-6-luna", local: false, foreground: false }).complete(req());
      release();
      await holding;
      await expect(waiting).rejects.toBeInstanceOf(DailyLimitError);
      expect(sent).toBe(0);
    });

    it("rechecks after waiting for a slot in the minute: the ceiling can move meanwhile", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const h = host(10);
        const limiter = new AiLimiter(h);
        let sent = 0;
        const t = limiter.wrap({ complete: async () => (sent++, await usage.complete()) }, { task: "summary", model: "gpt-6-luna", local: false, foreground: false });
        for (let i = 0; i < 20; i++) await t.complete(req());
        const waiting = t.complete(req());
        const caught = waiting.catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(10);
        expect(sent).toBe(20);
        h.limit = 0.0000001;
        h.clock.now += 61_000;
        await vi.advanceTimersByTimeAsync(61_000);
        await expect(caught).resolves.toBeInstanceOf(MonthlyLimitError);
        expect(sent).toBe(20);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a request cancelled while it waited isn't charged", async () => {
      const limiter = new AiLimiter(host());
      let finish!: () => void;
      const holding = limiter.wrap({ complete: async () => (await new Promise<void>((r) => (finish = r)), { text: "", stop: "end" }) }, { task: "summary", model: "m", local: true, foreground: false }).complete(req());
      await vi.waitFor(() => expect(finish).toBeTruthy());
      const before = (await limiter.report()).today.requests;
      const controller = new AbortController();
      const cancelled = limiter.wrap(free, { task: "summary", model: "m", local: true, foreground: false }).complete(req(controller.signal));
      await new Promise((r) => setTimeout(r));
      controller.abort();
      await expect(cancelled).rejects.toBeTruthy();
      expect((await limiter.report()).today.requests).toBe(before);
      finish();
      await holding;
    });
  });
});
