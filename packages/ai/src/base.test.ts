import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fileLedger } from "./file-ledger";
import { budgetedTransport, BudgetExceededError, type SpendLedger } from "./spend";
import { costOf } from "./prices";
import { streamCompletion } from "./stream";
import { createAi } from "./tasks";
import { jevModels, jevTasks } from "./jev";
import { AiError, type CompletionRequest, type ModelTransport, type ProviderConfig } from "./types";

const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({ system: "s", messages: [{ role: "user", content: "hello" }], output: "text", maxTokens: 1000, signal: new AbortController().signal, ...over });

function ledger(capUsd: number): SpendLedger {
  const held = new Map<string, number>();
  const spent = () => [...held.values()].reduce((n, usd) => n + usd, 0);
  return {
    capUsd,
    spent,
    reserve(e) {
      if (spent() + e.usd > capUsd) return null;
      const id = String(held.size);
      held.set(id, e.usd);
      return id;
    },
    settle: (id, e) => void held.set(id, e.usd),
  };
}

const answers: ModelTransport = { complete: async () => ({ text: "hi", stop: "end", usage: { inputTokens: 100, outputTokens: 50 } }) };

describe("the spend guard", () => {
  it("records what a request really cost", async () => {
    const book = ledger(1);
    await budgetedTransport(answers, "claude-sonnet-5-5", book).complete(req());
    expect(book.spent()).toBeCloseTo((100 * 2 + 50 * 10) / 1e6, 10);
  });

  it("never sends a request whose worst case passes the cap", async () => {
    const book = ledger(0.001);
    let sent = 0;
    const counting: ModelTransport = { complete: async () => ((sent++), { text: "", stop: "end" }) };
    // 1,000 output tokens at $10/M is $0.01, past the cap on its own
    await expect(budgetedTransport(counting, "claude-sonnet-5-5", book).complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toBe(0);
  });

  it("refuses a model with no known price, since it can't be held to a ceiling", async () => {
    await expect(budgetedTransport(answers, "some-unknown-model", ledger(100)).complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("charges the worst case when a request fails, since it may have been billed", async () => {
    const book = ledger(1);
    const failing: ModelTransport = { complete: async () => { throw new AiError("nope", "unavailable"); } };
    await expect(budgetedTransport(failing, "claude-sonnet-5-5", book).complete(req())).rejects.toThrow();
    expect(book.spent()).toBeGreaterThanOrEqual((1000 * 10) / 1e6);
  });

  it("charges the worst case for a stream stopped early", async () => {
    const book = ledger(1);
    const streaming: ModelTransport = {
      complete: answers.complete,
      async *stream() {
        yield { type: "delta", text: "a" };
        yield { type: "delta", text: "b" };
        yield { type: "done", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const guarded = budgetedTransport(streaming, "claude-sonnet-5-5", book);
    for await (const event of guarded.stream!(req())) {
      expect(event.type).toBe("delta");
      break;
    }
    expect(book.spent()).toBeGreaterThanOrEqual((1000 * 10) / 1e6);
  });

  it("counts a request in flight, so a second can't share what's left of the cap", async () => {
    // one worst case is about $0.010; the cap holds one, not two
    const book = ledger(0.015);
    let sent = 0;
    let finish!: () => void;
    const stalled: ModelTransport = { complete: async () => (sent++, await new Promise<void>((r) => (finish = r)), { text: "", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } }) };
    const held = budgetedTransport(stalled, "claude-sonnet-5-5", book);
    const first = held.complete(req());
    await expect(held.complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(sent).toBe(1);
    expect(book.spent()).toBeGreaterThanOrEqual(0.01);
    finish();
    await first;
    expect(book.spent()).toBeLessThan(0.001);
  });

  it("keeps the answer when the settle can't be written, and the worst case stands", async () => {
    const book = ledger(1);
    book.settle = () => { throw new Error("disk"); };
    await expect(budgetedTransport(answers, "claude-sonnet-5-5", book).complete(req())).resolves.toMatchObject({ text: "hi" });
    expect(book.spent()).toBeGreaterThanOrEqual(0.01);
  });
});

describe("the ledger on disk", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "terno-ledger-"));
  const worstCase = (1000 * 10 + 5 * 2.5) / 1e6;

  it("reserve and settle lines add up to what's really spent, and a process that died stays counted", () => {
    const path = join(dir(), "spend.jsonl");
    const book = fileLedger(path, 1);
    const a = book.reserve({ model: "m", usd: 0.5 })!;
    expect(book.spent()).toBeCloseTo(0.5, 10);
    book.settle(a, { model: "m", usd: 0.1 });
    expect(book.spent()).toBeCloseTo(0.1, 10);
    // never settled: the run that made it is gone, and a new one still sees it
    book.reserve({ model: "m", usd: 0.2 });
    expect(fileLedger(path, 1).spent()).toBeCloseTo(0.3, 10);
    expect(fileLedger(path, 1).reserve({ model: "m", usd: 0.8 })).toBeNull();
  });

  it("still counts a ledger written before reservations", () => {
    const path = join(dir(), "spend.jsonl");
    writeFileSync(path, `${JSON.stringify({ at: "x", model: "m", usd: 0.25 })}\n`);
    expect(fileLedger(path, 1).spent()).toBeCloseTo(0.25, 10);
  });

  it("refuses rather than guess when a line can't be read", () => {
    const path = join(dir(), "spend.jsonl");
    writeFileSync(path, `{"type":"reserve","id":"a","us`);
    expect(() => fileLedger(path, 1).reserve({ model: "m", usd: 0.01 })).toThrow();
  });

  it("refuses when the lock stays held, and never breaks it", () => {
    const path = join(dir(), "spend.jsonl");
    mkdirSync(`${path}.lock`);
    expect(() => fileLedger(path, 1, 20).reserve({ model: "m", usd: 0.01 })).toThrow(/locked/);
    expect(existsSync(`${path}.lock`)).toBe(true);
  });

  it("five real processes reserving at once pass no cap: the one that reproduced $0.020 against $0.015", async () => {
    const path = join(dir(), "spend.jsonl");
    const module = pathToFileURL(fileURLToPath(new URL("./file-ledger.ts", import.meta.url))).href;
    const script = `import { fileLedger } from ${JSON.stringify(module)}; const id = fileLedger(${JSON.stringify(path)}, 0.015).reserve({ model: "m", usd: ${worstCase} }); process.stdout.write(id ? "held" : "refused");`;
    const run = () => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    const results = await Promise.all(Array.from({ length: 5 }, run));
    expect(results.filter((r) => r === "held")).toHaveLength(1);
    expect(fileLedger(path, 0.015).spent()).toBeLessThanOrEqual(0.015);
  });
});

describe("out of credit", () => {
  it("is told apart from a rate limit, because waiting won't help", async () => {
    const { mapSdkError } = await import("./sdk-errors");
    class APIError extends Error { status = 429; code = "credit_balance_exhausted"; type = "insufficient_quota"; }
    class Other extends Error {}
    const sdk = { APIError, APIUserAbortError: Other, APIConnectionError: Other, APIConnectionTimeoutError: Other } as never;
    expect(mapSdkError(new APIError("You have no credits remaining."), sdk, { label: "OpenAI", local: false, host: "api.openai.com" }).kind).toBe("auth");
    class Limited extends APIError { override code = "rate_limit_exceeded"; override type = "requests"; }
    expect(mapSdkError(new Limited("Slow down."), sdk, { label: "OpenAI", local: false, host: "api.openai.com" }).kind).toBe("rate_limited");
  });
});

describe("prices", () => {
  it("knows what the defaults cost, and says nothing about what it doesn't know", () => {
    expect(costOf("gpt-6-luna", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.1, 6);
    expect(costOf("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2, 6);
    expect(costOf("who-knows", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe("streamCompletion", () => {
  const timing = { idleMs: 200, firstMs: 200 };

  it("gives one terminal result, with the deltas on the way", async () => {
    const seen: string[] = [];
    const transport: ModelTransport = {
      complete: answers.complete,
      async *stream() {
        yield { type: "delta", text: "He" };
        yield { type: "delta", text: "llo" };
        yield { type: "done", stop: "end", usage: { inputTokens: 1, outputTokens: 2 } };
      },
    };
    const result = await streamCompletion(transport, req(), (d) => seen.push(d), timing);
    expect(seen).toEqual(["He", "llo"]);
    expect(result).toEqual({ text: "Hello", stop: "end", usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it("yields one chunk when the transport can't stream", async () => {
    const seen: string[] = [];
    const result = await streamCompletion(answers, req(), (d) => seen.push(d), timing);
    expect(seen).toEqual(["hi"]);
    expect(result.text).toBe("hi");
  });

  it("reports silence as a timeout, not a hang", async () => {
    const transport: ModelTransport = {
      complete: answers.complete,
      stream: async function* (r) {
        yield { type: "delta", text: "a" };
        await new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    };
    await expect(streamCompletion(transport, req(), () => {}, { idleMs: 20, firstMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports the caller's abort as cancelled", async () => {
    const controller = new AbortController();
    const transport: ModelTransport = {
      complete: answers.complete,
      stream: async function* (r) {
        controller.abort();
        yield { type: "delta", text: "a" };
        r.signal.throwIfAborted();
      },
    };
    await expect(streamCompletion(transport, req({ signal: controller.signal }), () => {}, timing)).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("treats a stream with no terminal event as cut off", async () => {
    const transport: ModelTransport = {
      complete: answers.complete,
      async *stream() {
        yield { type: "delta", text: "a" };
      },
    };
    await expect(streamCompletion(transport, req(), () => {}, timing)).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("JEV", () => {
  const config = (fetcher: typeof fetch): ProviderConfig => ({ id: "jev", model: "jev-latest", apiKey: "k", fetch: fetcher, timeoutMs: 1000, maxRetries: 0 });
  const respond = (choice: string, p: number): typeof fetch => (async () => new Response(JSON.stringify({ model: "jev-1", answers: { label: { type: "choice", choice, confidence: 0.5, probabilities: { [choice]: p } } }, usage: { input_tokens: 10, output_tokens: 0 } }))) as typeof fetch;
  const input = { items: [{ id: "1", text: "Your invoice" }], labels: ["c1", "c2"] as const, instructions: "Pick a category." };

  it("calls the documented endpoint with a Bearer key and the options as criteria", async () => {
    let url = "";
    let init: RequestInit = {};
    const tasks = jevTasks(config((async (u: string, i: RequestInit) => ((url = u), (init = i), respond("c1", 0.99)(u, i))) as typeof fetch));
    const [r] = await tasks.classify({ ...input, evidence: { c1: { name: "Invoices", samples: [] } } });
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body.questions.label.criteria)).toEqual(["c1", "c2", "none_of_these"]);
    expect(body.state.message).toBe("Your invoice");
    expect(r).toEqual({ id: "1", label: "c1", confidence: 0.99 });
  });

  it("abstains when none fits", async () => {
    const [r] = await jevTasks(config(respond("none_of_these", 0.9))).classify(input);
    expect(r!.label).toBeNull();
  });

  it("never returns a label it wasn't offered", async () => {
    const [r] = await jevTasks(config(respond("made_up", 1))).classify(input);
    expect(r!.label).toBeNull();
  });

  it("declares itself calibrated, and can't write", () => {
    const tasks = createAi(config(respond("c1", 1)));
    expect(tasks.calibrated).toBe(true);
    expect(tasks.providerId).toBe("jev");
    expect(() => tasks.generateFilter("x", { now: 0, categories: [], accounts: [] })).toThrow();
  });

  it("maps a rejected key and a rate limit", async () => {
    const status = (s: number): typeof fetch => (async () => new Response("{}", { status: s })) as typeof fetch;
    await expect(jevTasks(config(status(401))).classify(input)).rejects.toMatchObject({ kind: "auth" });
    await expect(jevTasks(config(status(429))).classify(input)).rejects.toMatchObject({ kind: "rate_limited" });
  });

  describe("a deadline over the whole request (plan 134 review)", () => {
    const soon = (fetcher: typeof fetch): ProviderConfig => ({ ...config(fetcher), timeoutMs: 20 });

    it("a server that never answers is a timeout, and the request is aborted", async () => {
      let seen: AbortSignal | undefined;
      const silent = ((_u: string, init: RequestInit) => ((seen = init.signal ?? undefined), new Promise(() => {}))) as unknown as typeof fetch;
      await expect(jevTasks(soon(silent)).classify(input)).rejects.toMatchObject({ kind: "timeout" });
      expect(seen?.aborted).toBe(true);
    });

    it("a response whose body stalls is a timeout too: it can't hold the only drain", async () => {
      const stalled = (async () => {
        const res = new Response("{}");
        Object.defineProperty(res, "json", { value: () => new Promise(() => {}) });
        return res;
      }) as typeof fetch;
      await expect(jevTasks(soon(stalled)).classify(input)).rejects.toMatchObject({ kind: "timeout" });
    });

    it("the caller's own cancel stays a cancel", async () => {
      const controller = new AbortController();
      const silent = (() => new Promise(() => {})) as unknown as typeof fetch;
      const asked = jevTasks(config(silent)).classify(input, controller.signal);
      controller.abort();
      await expect(asked).rejects.toMatchObject({ kind: "cancelled" });
    });

    it("what isn't JSON says so, not that it couldn't connect", async () => {
      const garbled = (async () => new Response("<html>")) as typeof fetch;
      await expect(jevTasks(config(garbled)).classify(input)).rejects.toMatchObject({ kind: "invalid_output" });
    });

    it("listing models has the same deadline", async () => {
      const silent = (() => new Promise(() => {})) as unknown as typeof fetch;
      await expect(jevModels(soon(silent)).listModels!(new AbortController().signal)).rejects.toMatchObject({ kind: "timeout" });
    });
  });
});
