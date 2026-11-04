import { describe, expect, it } from "vitest";
import { streamCompletion, transportFor, type CompletionRequest } from "@terno/ai";
import { realKeys, realTasks, spendReport } from "./harness";

/** The cheapest possible check that each wire shape is right: a handful of tokens each. */
const ask = (text: string, cache = false): CompletionRequest => ({
  system: [{ text: "Answer in one word.", cache }],
  messages: [{ role: "user", content: text }],
  output: "text",
  maxTokens: 2000,
  signal: new AbortController().signal,
});

describe("real transports", () => {
  it("JEV picks a category and abstains", async () => {
    const tasks = realTasks({ provider: "jev", model: "jev-latest" }, "smoke");
    const labels = ["invoices", "travel"] as const;
    const [hit, none] = await tasks.classify({
      labels,
      instructions: "These are a person's mail categories.",
      items: [
        { id: "1", text: "From: billing@acme.com\nSubject: Invoice 4471 is due\nYour invoice for October is attached. Amount due: $120." },
        { id: "2", text: "From: mum@family.org\nSubject: Sunday\nAre you coming for lunch on Sunday?" },
      ],
    });
    console.log("jev", hit, none, spendReport());
    expect(hit!.label).toBe("invoices");
    expect(none!.label).not.toBe("invoices");
  });

  // needs credit on the OpenAI account: run alone with `-t Luna` once it has some
  it.skipIf(process.env.TERNO_AI_LUNA !== "1")("OpenAI streams on Luna and reports usage", async () => {
    const config = { id: "openai" as const, model: "gpt-6-luna", apiKey: realKeys().openai, fetch: globalThis.fetch, timeoutMs: 60_000, maxRetries: 0 };
    const { budgetedTransport } = await import("@terno/ai");
    const { fileLedger } = await import("./harness");
    const transport = budgetedTransport(transportFor(config), config.model, fileLedger(), "smoke");
    let deltas = 0;
    const started = Date.now();
    const result = await streamCompletion(transport, ask("What colour is the sky?"), () => deltas++, { idleMs: 30_000, firstMs: 60_000 });
    console.log("luna", { text: result.text, stop: result.stop, usage: result.usage, deltas, ms: Date.now() - started }, spendReport());
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  });

  it("Anthropic streams on Sonnet 5.5, and caches a long enough prefix", async () => {
    const config = { id: "anthropic" as const, model: "claude-sonnet-5-5", apiKey: realKeys().anthropic, fetch: globalThis.fetch, timeoutMs: 60_000, maxRetries: 0 };
    const { budgetedTransport } = await import("@terno/ai");
    const { fileLedger } = await import("./harness");
    const transport = budgetedTransport(transportFor(config), config.model, fileLedger(), "smoke");
    const long = "This sentence only makes the stable part of the prompt long enough to cache. ".repeat(60);
    const request = (q: string): CompletionRequest => ({ system: [{ text: long, cache: true }], messages: [{ role: "user", content: q }], output: "text", maxTokens: 2000, signal: new AbortController().signal });
    let first = 0;
    const started = Date.now();
    const one = await streamCompletion(transport, request("What colour is the sky? One word."), () => (first ||= Date.now() - started), { idleMs: 30_000, firstMs: 60_000 });
    const two = await streamCompletion(transport, request("What colour is grass? One word."), () => {}, { idleMs: 30_000, firstMs: 60_000 });
    console.log("sonnet", { one: one.text, firstTokenMs: first, usage1: one.usage, two: two.text, usage2: two.usage }, spendReport());
    expect(one.text.length).toBeGreaterThan(0);
    expect(two.usage?.cacheReadTokens).toBeGreaterThan(0);
  });
});
