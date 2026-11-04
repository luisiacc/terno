import { describe, expect, it } from "vitest";
import { AiError, type CompletionRequest, type ModelTransport } from "@terno/ai";
import { AiLimiter, DAILY_REQUESTS, DailyLimitError, MonthlyLimitError } from "./ai-limiter";

function host(limit = 10, clock = { now: new Date(2026, 10, 4, 12).getTime() }) {
  const values = new Map<string, unknown>();
  return {
    clock,
    limit,
    store: {
      settings: {
        get: async <T,>(key: string, fallback: T) => (values.has(key) ? (values.get(key) as T) : fallback),
        set: async (key: string, value: unknown) => void values.set(key, value),
      },
    } as never,
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
});
