/**
 * Plan 132 through the real backend (RPC, settings, limiter, SQLite), with a scripted model: nothing leaves this
 * process. The eligibility rows of the store are in the conformance suite; here, what the worker does with them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import { createMemoryTransportPair, RpcClient, type RpcError } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { DAILY_REQUESTS } from "./ai-limiter";
import { withoutQuotes } from "./summaries";

const START = new Date(2026, 10, 4, 12).getTime();
const WORDS = "The contract needs one more signature before we can send it to the bank on Friday morning. ".repeat(6);
const ANSWER = { summary: "Ana needs a signature.", items: [{ kind: "action", text: "Sign the contract", message: "m1" }] };

interface Model {
  requests: CompletionRequest[];
  configs: ProviderConfig[];
  answer: (req: CompletionRequest, n: number) => Promise<Completion> | Completion;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const replying = (body: unknown = ANSWER): Completion => ({ text: JSON.stringify(body), stop: "end" });

async function setup(o: { enabled?: boolean; provider?: "fake" | "none"; dir?: string; keep?: boolean; at?: number } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "terno-summaries-"));
  const model: Model = { requests: [], configs: [], answer: () => replying() };
  const clock = { now: o.at ?? START };
  const factory = (config: ProviderConfig, options: AiOptions) => {
    model.configs.push(config);
    return createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          const n = model.requests.push(req) - 1;
          const out = await model.answer(req, n);
          return out;
        },
      },
    });
  };
  const logs: string[] = [];
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now, log: (_level, message, extra) => void logs.push(`${message} ${JSON.stringify(extra ?? null)}`) });
  await backend.store.ready;
  const connect = (clientId: string, origin: "renderer" | "mcp") => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId, origin });
    return new RpcClient(c);
  };
  const client = connect("renderer", "renderer");
  const mcp = connect("mcp", "mcp");
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@terno.test", displayName: "Me", color: "indigo", now: 0 });
  if ((o.provider ?? "fake") === "fake") await client.call("settings.update", { ai: { provider: "fake" } });
  if (o.enabled ?? true) await client.call("settings.update", { summaries: { enabled: true } });
  await settle();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // nothing a test left hanging holds the store open
    model.answer = () => replying();
    await backend.stop();
  };
  cleanups.push(async () => {
    await stop();
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  });

  /** mail arriving from a live sync, or (`live: false`) a first sync or backfill */
  const arrive = async (over: Partial<IncomingMessage> = {}, live = true) => {
    const m = msg({ accountId: account.id, date: clock.now - 60_000, bodyText: WORDS, from: { name: "Ana", email: "ana@books.test" }, ...over });
    const { inserted } = await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, live);
    const thread = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
    return { id: inserted[0]!, thread, m };
  };
  const read = (threadId: number) => client.call("ai.summaries.get", { threadId });
  const row = (threadId: number) => backend.store.aiSummaries.get(threadId);
  return { backend, client, mcp, connect, model, clock, arrive, read, row, account, dir, stop, logs };
}

/** the worker and the RPC have nothing more to do right now (nothing here waits on a real clock) */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
}
const until = (fn: () => void | Promise<void>) => vi.waitFor(fn, { timeout: 3000, interval: 5 });
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: RpcError) => e);
const requestId = () => crypto.randomUUID();

/** A request that stays in flight until the test lets it go; aborts like a provider's would. */
function held(req: CompletionRequest, release: Promise<Completion>): Promise<Completion> {
  return new Promise((resolve, reject) => {
    req.signal.addEventListener("abort", () => reject(new AiError("stopped", "cancelled")), { once: true });
    void release.then(resolve);
  });
}
function gate() {
  let open!: (c: Completion) => void;
  const opened = new Promise<Completion>((r) => (open = r));
  return { open, opened };
}

describe("new mail", () => {
  it("summarizes it as it arrives, tells the windows, and the reader can read it", async () => {
    const { client, model, arrive, read, row } = await setup();
    const heard: number[] = [];
    client.on("aiSummary", ({ threadId }) => heard.push(threadId));
    const { id, thread } = await arrive();
    await until(async () => expect((await row(thread))?.state).toBe("ready"));
    expect(model.requests).toHaveLength(1);
    const prompt = promptText(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("The contract needs one more signature");
    expect(model.requests[0]!.effort).toBe("low");
    await until(() => expect(heard).toEqual([thread]));
    await expect(read(thread)).resolves.toMatchObject({ state: "ready", summary: { threadId: thread, summary: "Ana needs a signature.", items: [{ kind: "action", text: "Sign the contract", messageId: id }], provider: "fake", model: "demo", generatedAt: START } });
  });

  it("while the language follows the system, it's the window's: the backend can't see the system's", async () => {
    const { client, arrive, row } = await setup();
    await client.call("app.locale", { locale: "es" });
    const { thread } = await arrive();
    await until(async () => expect((await row(thread))?.state).toBe("ready"));
    expect((await row(thread))?.language).toBe("es");
    await client.call("settings.update", { language: "en" });
    const second = await arrive({ providerMsgId: "second", providerThreadId: "second", rfcMessageId: "<second@test>", subject: "Another" });
    await until(async () => expect((await row(second.thread))?.state).toBe("ready"));
    expect((await row(second.thread))?.language).toBe("en");
  });

  it("does nothing while off, and mail from before it was on never goes", async () => {
    const { client, backend, model, arrive, row, clock } = await setup({ enabled: false });
    expect(backend.summaries.isActive).toBe(false);
    const before = await arrive();
    await settle();
    expect(model.requests).toHaveLength(0);
    expect(await row(before.thread)).toBeNull();

    clock.now += 1000;
    await client.call("settings.update", { summaries: { enabled: true } });
    expect((await client.call("app.bootstrap", {})).settings.summaries).toMatchObject({ enabled: true, enabledAt: START + 1000 });
    await settle();
    expect(model.requests).toHaveLength(0);
    expect(await row(before.thread)).toBeNull();
    // never sent by anything else either: a new message on another thread leaves the old one out
    const after = await arrive();
    await until(async () => expect((await row(after.thread))?.state).toBe("ready"));
    expect(model.requests).toHaveLength(1);
    expect(await row(before.thread)).toBeNull();
  });

  it("leaves out a first sync or backfill, what's too old, my own, drafts, spam and trash", async () => {
    const { model, arrive, row, clock } = await setup();
    const quiet = [
      await arrive({}, false),
      await arrive({ date: clock.now - 4 * 86_400_000 }),
      await arrive({ from: { name: "Me", email: "ME@terno.test" } }),
      await arrive({ isSent: true }),
      await arrive({ isDraft: true }),
      await arrive({ isSpam: true, inInbox: false }),
      await arrive({ isTrash: true, inInbox: false }),
    ];
    await settle();
    expect(model.requests).toHaveLength(0);
    for (const { thread } of quiet) expect(await row(thread)).toBeNull();
  });

  it("leaves out Promotions, Social and mail a filter archived, and text under 60 words", async () => {
    const { backend, model, arrive, row } = await setup();
    await backend.store.filters.save({ name: "Archive it", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "archive me" }], actions: [{ type: "archive" }] } }, START);
    const quiet = [
      await arrive({ gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
      await arrive({ gmailLabels: ["INBOX", "CATEGORY_SOCIAL"] }),
      await arrive({ inInbox: false }),
      await arrive({ subject: "Please archive me now" }),
      await arrive({ bodyText: "Thanks, see you then." }),
    ];
    await until(async () => {
      for (const { thread } of quiet) expect(await row(thread)).toBeNull();
    });
    expect(model.requests).toHaveLength(0);
    const fine = await arrive({ gmailLabels: ["INBOX", "CATEGORY_UPDATES"] });
    await until(async () => expect((await row(fine.thread))?.state).toBe("ready"));
  });

  it("a new message on an old conversation summarizes the conversation; my reply doesn't trigger one", async () => {
    const { model, arrive, row } = await setup();
    await arrive({ providerThreadId: "t", bodyText: "An old first message about the budget." }, false);
    const reply = await arrive({ providerThreadId: "t" });
    await until(async () => expect((await row(reply.thread))?.state).toBe("ready"));
    expect(promptText(model.requests[0]!.messages[0]!.content)).toContain("about the budget");
    await arrive({ providerThreadId: "t", isSent: true, from: { name: "Me", email: "me@terno.test" } });
    await settle();
    expect(model.requests).toHaveLength(1);
  });

  it("waits for a body and asks once it's here; a short one is dropped then", async () => {
    const { backend, model, arrive, row } = await setup();
    const a = await arrive({ bodyText: null, bodyState: "none" });
    const b = await arrive({ bodyText: null, bodyState: "none" });
    const c = await arrive();
    await until(async () => expect((await row(c.thread))?.state).toBe("ready"));
    // one waiting doesn't stall what's behind it
    expect(model.requests).toHaveLength(1);
    expect((await row(a.thread))?.state).toBe("pending");
    await backend.store.sync.setBody(a.id, WORDS, null, { now: START, classifier: null });
    await backend.store.sync.setBody(b.id, "Too short.", null, { now: START, classifier: null });
    (backend as unknown as { bodyArrived(id: number): void }).bodyArrived(a.id);
    await until(async () => expect((await row(a.thread))?.state).toBe("ready"));
    await until(async () => expect(await row(b.thread)).toBeNull());
    expect(model.requests).toHaveLength(2);
  });

  it("keeps the queue across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-summaries-"));
    const first = await setup({ dir, keep: true });
    const gone = gate();
    first.model.answer = (req) => held(req, gone.opened);
    const { thread } = await first.arrive();
    await until(() => expect(first.model.requests).toHaveLength(1));
    await first.stop();
    const next = await setup({ dir, keep: true });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await until(async () => expect((await next.row(thread))?.state).toBe("ready"));
    expect(next.model.requests).toHaveLength(1);
  });

  it("drops what's been pending past its moment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-summaries-"));
    const first = await setup({ dir, keep: true });
    const gone = gate();
    first.model.answer = (req) => held(req, gone.opened);
    const { thread } = await first.arrive();
    await until(() => expect(first.model.requests).toHaveLength(1));
    await first.stop();
    // a long time offline: back on, nothing of what the user has moved past goes
    const next = await setup({ dir, keep: true, enabled: false, at: START + 3 * 86_400_000 + 1 });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await settle();
    expect(next.model.requests).toHaveLength(0);
    expect(await next.row(thread)).toBeNull();
  });
});

describe("what's sent", () => {
  it("the newest inbound message whole, the 12 newest others without quotes, the rest by from, date and snippet", async () => {
    const { model, arrive, row } = await setup();
    const long = "x".repeat(40_000);
    for (let i = 0; i < 20; i++) await arrive({ providerThreadId: "long", date: START - 90_000 + i, snippet: `snippet ${i}`, bodyText: `body ${i}\nmore words here\n> quoted ${i}\nOn Monday, Ana wrote:\nolder quote ${i}` }, false);
    const last = await arrive({ providerThreadId: "long", bodyText: `${WORDS}${long}` });
    await until(async () => expect((await row(last.thread))?.state).toBe("ready"));
    const prompt = promptText(model.requests[0]!.messages[0]!.content);
    expect(prompt.match(/<message /g)).toHaveLength(21);
    expect(prompt).toContain("snippet 0");
    expect(prompt).not.toContain("body 0");
    expect(prompt).toContain("body 19");
    expect(prompt).not.toContain("quoted 19");
    expect(prompt).not.toContain("older quote 19");
    expect(prompt.length).toBeGreaterThan(16_000);
    expect(prompt.length).toBeLessThan(16_000 + 13 * 1700 + 8 * 200);
    expect(prompt.match(/x+/g)!.at(-1)!.length).toBeLessThan(16_000);
  });

  it("sizes down for a small context window, and keeps the newest message's words", async () => {
    const { client, backend, model, arrive, row } = await setup({ enabled: false });
    const tokens = 2000;
    await backend.store.settings.update("app", {}, (s: Record<string, unknown>) => {
      const ai = (s.ai ?? {}) as Record<string, unknown>;
      return { value: { ...s, ai: { ...ai, capabilities: { "fake|||demo": { output: "json_schema", contextTokens: tokens, embeddings: false, probedAt: 1 } } } }, result: undefined };
    });
    await client.call("settings.update", { summaries: { enabled: true } });
    const m = await arrive({ bodyText: `${WORDS}${"y".repeat(40_000)}` });
    await until(async () => expect((await row(m.thread))?.state).toBe("ready"));
    const prompt = promptText(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("The contract needs");
    expect(prompt.length).toBeLessThan((tokens - 1500) * 4);
  });

  it.each([2000, 4096, 8192])("a %i-token window holds the whole prompt, headers and snippets included, and the answer's allowance", async (tokens) => {
    const { client, backend, model, arrive, row } = await setup({ enabled: false });
    await backend.store.settings.update("app", {}, (s: Record<string, unknown>) => {
      const ai = (s.ai ?? {}) as Record<string, unknown>;
      return { value: { ...s, ai: { ...ai, capabilities: { "fake|||demo": { output: "json_schema", contextTokens: tokens, embeddings: false, probedAt: 1 } } } }, result: undefined };
    });
    await client.call("settings.update", { summaries: { enabled: true } });
    const snippet = "s".repeat(180);
    for (let i = 0; i < 50; i++) await arrive({ providerThreadId: "long", date: START - 90_000 + i, snippet, bodyText: `body ${i} ${"z".repeat(2000)}`, from: { name: "A rather long display name for a person", email: `someone-with-a-long-address-${i}@books.test` } }, false);
    const last = await arrive({ providerThreadId: "long", subject: "q".repeat(900), bodyText: `${WORDS}${"y".repeat(40_000)}` });
    await until(async () => expect((await row(last.thread))?.state).toBe("ready"));
    const req = model.requests[0]!;
    const prompt = promptText(req.messages[0]!.content);
    const LADDER = 1000;
    expect(promptText(req.system).length + LADDER + prompt.length + req.maxTokens * 4).toBeLessThanOrEqual(tokens * 4);
    expect(req.maxTokens).toBe(Math.min(3000, Math.ceil(tokens / 2)));
    expect(prompt).toContain("The contract needs");
    // what's cited still runs m1, m2…: dropping a message leaves no gap
    const labels = [...prompt.matchAll(/<message id="m(\d+)"/g)].map((m) => Number(m[1]));
    expect(labels).toEqual(labels.map((_, i) => i + 1));
  });

  it("keeps an own message's words out of quotes in both languages", () => {
    expect(withoutQuotes("Yes.\n> Are you coming?\nOn Mon, 3 Mar, Ana wrote:\n> old\nmore")).toBe("Yes.");
    expect(withoutQuotes("Sí.\nEl lun, 3 mar, Ana escribió:\nviejo")).toBe("Sí.");
    expect(withoutQuotes("Hello\n----- Original Message -----\nold")).toBe("Hello");
  });

  it("carries no canary to logs or to MCP", async () => {
    const { mcp, arrive, read, row, logs, model } = await setup();
    const canary = "canary-5b1e-in-mail";
    const { thread } = await arrive({ bodyText: `${WORDS}${canary}`, subject: canary });
    model.answer = () => replying({ summary: `Says ${canary}`, items: [] });
    await until(async () => expect((await row(thread))?.state).toBe("ready"));
    await expect(read(thread)).resolves.toMatchObject({ state: "ready" });
    expect(logs.join("\n")).not.toContain(canary);
    expect(await errorOf(mcp.call("ai.summaries.get", { threadId: thread }))).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the queue's states", () => {
  it.each([["rate_limited"], ["unavailable"], ["timeout"]] as const)("%s: an attempt spent and the pass ends; a burst of mail doesn't spend the rest; failed after 3", async (kind) => {
    const { backend, model, arrive, row, clock } = await setup();
    model.answer = () => { throw new AiError("nope", kind); };
    const a = await arrive();
    await until(async () => expect((await row(a.thread))?.attempts).toBe(1));
    const b = await arrive();
    backend.summaries.wake();
    await settle();
    expect(model.requests).toHaveLength(1);
    expect((await row(b.thread))?.attempts).toBe(0);
    clock.now += 61_000;
    backend.summaries.wake();
    await until(async () => expect((await row(a.thread))?.attempts).toBe(2));
    // the network coming back is worth asking again at once
    backend.summaries.wake({ network: true });
    await until(async () => expect(await row(a.thread)).toMatchObject({ state: "failed", attempts: 3, errorKind: kind }));
    await expect(backend.summaries.status()).resolves.toMatchObject({ pending: 1, lastError: kind });
    model.answer = () => replying();
    backend.summaries.wake({ network: true });
    await until(async () => expect((await row(b.thread))?.state).toBe("ready"));
  });

  it.each([["invalid_output"], ["refused"], ["unsupported"]] as const)("%s: failed at once, and the next one runs", async (kind) => {
    const { model, arrive, row } = await setup();
    model.answer = (req) => {
      if (promptText(req.messages[0]!.content).includes("Never works")) throw new AiError("nope", kind);
      return replying();
    };
    const a = await arrive({ subject: "Never works" });
    const b = await arrive();
    await until(async () => expect((await row(b.thread))?.state).toBe("ready"));
    expect(await row(a.thread)).toMatchObject({ state: "failed", errorKind: kind });
  });

  it.each([["auth"], ["not_configured"], ["blocked"]] as const)("%s: paused with no attempt spent; a change in settings resumes it", async (kind) => {
    const { client, backend, model, arrive, row } = await setup();
    model.answer = () => { throw new AiError("That key was refused", kind); };
    const a = await arrive();
    await until(() => expect(model.requests).toHaveLength(1));
    await settle();
    const b = await arrive();
    await settle();
    expect(model.requests).toHaveLength(1);
    expect(await row(a.thread)).toMatchObject({ state: "pending", attempts: 0 });
    expect(await row(b.thread)).toMatchObject({ state: "pending", attempts: 0 });
    await expect(backend.summaries.status()).resolves.toMatchObject({ pending: 2, blockedBy: { kind, message: "That key was refused" } });
    backend.summaries.wake();
    await settle();
    expect(model.requests).toHaveLength(1);
    model.answer = () => replying();
    await client.call("settings.update", { ai: { monthlyLimitUsd: 20 } });
    await until(async () => expect((await row(b.thread))?.state).toBe("ready"));
    expect(await row(a.thread)).toMatchObject({ state: "ready" });
    await expect(backend.summaries.status()).resolves.toMatchObject({ pending: 0, blockedBy: null });
  });

  it("the day's limit stops it with no attempt spent, and the next day's first wake-up goes on; the month's likewise", async () => {
    const { client, backend, model, arrive, row, clock } = await setup({ enabled: false });
    const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    await backend.store.settings.set("ai:usage", { [day(clock.now)]: { summary: { requests: DAILY_REQUESTS.summary, inputTokens: 0, outputTokens: 0, usd: 0 } } });
    await client.call("settings.update", { summaries: { enabled: true } });
    const a = await arrive();
    await settle();
    expect(model.requests).toHaveLength(0);
    expect(await row(a.thread)).toMatchObject({ state: "pending", attempts: 0 });
    await expect(backend.summaries.status()).resolves.toMatchObject({ blockedBy: { limit: "daily" } });
    expect(backend.summaries.timer).toBeNull();
    backend.summaries.wake();
    await settle();
    expect(model.requests).toHaveLength(0);
    clock.now += 86_400_000;
    backend.summaries.wake();
    await until(async () => expect((await row(a.thread))?.state).toBe("ready"));

    // the month: the ceiling set below what's been spent stops it the same way
    const limiter = backend.aiService.limiter as unknown as { book: Record<string, Record<string, unknown>> };
    (limiter.book[day(clock.now)] ??= {}).categorize = { requests: 1, inputTokens: 0, outputTokens: 0, usd: 50 };
    const b = await arrive();
    await settle();
    expect(await row(b.thread)).toMatchObject({ state: "pending", attempts: 0 });
    await expect(backend.summaries.status()).resolves.toMatchObject({ blockedBy: { limit: "monthly" } });
    await client.call("settings.update", { ai: { monthlyLimitUsd: 0 } });
    await until(async () => expect((await row(b.thread))?.state).toBe("ready"));
  });

  it("rate limited with work left: one timer; none while empty, and none at rest", async () => {
    const { backend, model, arrive, row, clock } = await setup();
    expect(backend.summaries.timer).toBeNull();
    model.answer = () => { throw new AiError("slow down", "rate_limited"); };
    const a = await arrive();
    await until(async () => expect((await row(a.thread))?.attempts).toBe(1));
    const timer = backend.summaries.timer;
    expect(timer).not.toBeNull();
    clock.now += 61_000;
    backend.summaries.wake();
    await until(async () => expect((await row(a.thread))?.attempts).toBe(2));
    expect(backend.summaries.timer).toBe(timer);
    model.answer = () => replying();
    clock.now += 61_000;
    backend.summaries.wake();
    await until(async () => expect((await row(a.thread))?.state).toBe("ready"));
    // back to sleep: a settings change clears what was armed, and an empty queue arms nothing
    await backend.server.invoke("settings.update", { ai: { monthlyLimitUsd: 11 } }, { clientId: "x", origin: "dev" });
    await settle();
    expect(backend.summaries.timer).toBeNull();
  });

  it("a change of provider mid-request: cancelled, no attempt spent, it runs on the new one", async () => {
    const { client, model, arrive, row } = await setup();
    const g = gate();
    model.answer = (req, n) => (n === 0 ? held(req, g.opened) : replying());
    const { thread } = await arrive();
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("settings.update", { ai: { tasks: { summary: { provider: "fake", model: "another" } } } });
    await until(async () => expect((await row(thread))?.state).toBe("ready"));
    expect(await row(thread)).toMatchObject({ model: "another", attempts: 0 });
  });

  it("turned off mid-drain: nothing further goes and the queue empties", async () => {
    const { client, model, arrive, row } = await setup();
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const a = await arrive();
    const b = await arrive();
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("settings.update", { summaries: { enabled: false } });
    await settle();
    g.open(replying());
    await settle();
    expect(model.requests).toHaveLength(1);
    expect(await row(a.thread)).toBeNull();
    expect(await row(b.thread)).toBeNull();
    expect((await client.call("app.bootstrap", {})).settings.summaries).toMatchObject({ enabled: false, enabledAt: null });
  });

  it("a newer message mid-request drops the result and goes again, once", async () => {
    const { model, arrive, row } = await setup();
    const g = gate();
    model.answer = (req, n) => (n === 0 ? held(req, g.opened) : replying({ summary: "The newer one.", items: [] }));
    const first = await arrive({ providerThreadId: "t" });
    await until(() => expect(model.requests).toHaveLength(1));
    const second = await arrive({ providerThreadId: "t", bodyText: `${WORDS} And a newer text.` });
    g.open(replying({ summary: "The old one.", items: [] }));
    await until(async () => expect(await row(first.thread)).toMatchObject({ state: "ready", throughMessageId: second.id }));
    expect(JSON.parse((await row(first.thread))!.bodyJson!).summary).toBe("The newer one.");
    expect(model.requests).toHaveLength(2);
  });

  it("marked spam while pending, during the request and after: nothing written; Not spam brings a result back with no request", async () => {
    const { client, backend, model, arrive, read, row } = await setup();
    const act = (threadId: number, action: "spam" | "notSpam") => backend.store.threads.act({ threadIds: [threadId], action, signal: null, now: START });

    // while pending, behind one held in flight
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const during = await arrive();
    await until(() => expect(model.requests).toHaveLength(1));
    const pending = await arrive();
    await act(pending.thread, "spam");
    // during the request
    await act(during.thread, "spam");
    g.open(replying());
    await until(async () => {
      expect(await row(during.thread)).toBeNull();
      expect(await row(pending.thread)).toBeNull();
    });
    expect(model.requests).toHaveLength(1);

    // after: hidden, and back with Not spam, with no request
    model.answer = () => replying();
    const after = await arrive();
    await until(async () => expect((await row(after.thread))?.state).toBe("ready"));
    const calls = model.requests.length;
    await act(after.thread, "spam");
    await expect(read(after.thread)).resolves.toEqual({ state: "none" });
    await act(after.thread, "notSpam");
    await expect(read(after.thread)).resolves.toMatchObject({ state: "ready" });
    await client.call("ai.summaries.get", { threadId: after.thread });
    expect(model.requests).toHaveLength(calls);
  });

  it("stays hidden when a later message of a clean thread is spam", async () => {
    const { client, arrive, read, row, account } = await setup();
    const { thread } = await arrive({ providerThreadId: "mixed" });
    await until(async () => expect((await row(thread))?.state).toBe("ready"));
    await arrive({ providerThreadId: "mixed", isSpam: true, inInbox: false, accountId: account.id });
    await expect(read(thread)).resolves.toEqual({ state: "none" });
    expect(await errorOf(client.call("ai.summarize", { threadId: thread, requestId: requestId() }))).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("by hand", () => {
  /** an old thread, with the setting off and no row */
  async function old(over: Partial<IncomingMessage> = {}) {
    const s = await setup({ enabled: false });
    const m = await s.arrive({ date: START - 400 * 86_400_000, ...over }, false);
    return { ...s, ...m };
  }
  const go = (client: RpcClient, threadId: number, o: { acknowledge?: boolean; id?: string } = {}) => client.call("ai.summarize", { threadId, requestId: o.id ?? requestId(), ...(o.acknowledge ? { acknowledge: true } : {}) });

  it("summarizes an old thread with the setting off, a short one and a Promotions one too", async () => {
    const { client, model, thread, id, read, arrive } = await old();
    await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { threadId: thread, items: [{ messageId: id }] } });
    await expect(read(thread)).resolves.toMatchObject({ state: "ready" });
    expect(model.requests).toHaveLength(1);
    const short = await arrive({ bodyText: "Thanks." }, false);
    await expect(go(client, short.thread)).resolves.toMatchObject({ status: "ready" });
    const promo = await arrive({ gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] }, false);
    await expect(go(client, promo.thread)).resolves.toMatchObject({ status: "ready" });
    const archived = await arrive({ inInbox: false }, false);
    await expect(go(client, archived.thread)).resolves.toMatchObject({ status: "ready" });
  });

  it("is refused in spam and trash", async () => {
    const { client, backend, thread, arrive, model } = await old();
    await backend.store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: START });
    expect(await errorOf(go(client, thread))).toMatchObject({ code: "BAD_REQUEST" });
    const trash = await arrive({}, false);
    await backend.store.threads.act({ threadIds: [trash.thread], action: "trash", signal: null, now: START });
    expect(await errorOf(go(client, trash.thread))).toMatchObject({ code: "BAD_REQUEST" });
    expect(model.requests).toHaveLength(0);
  });

  it("marked spam mid-request writes nothing, and says so", async () => {
    const { client, backend, model, thread, row } = await old();
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const pending = go(client, thread);
    await until(() => expect(model.requests).toHaveLength(1));
    await backend.store.threads.act({ threadIds: [thread], action: "spam", signal: null, now: START });
    g.open(replying());
    expect(await errorOf(pending)).toMatchObject({ code: "BAD_REQUEST" });
    expect(await row(thread)).toBeNull();
  });

  it("cancelling writes nothing; only the connection that asked can stop it", async () => {
    const { client, connect, model, thread, row } = await old();
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const id = requestId();
    const pending = go(client, thread, { id });
    await until(() => expect(model.requests).toHaveLength(1));
    const other = connect("other", "renderer");
    await other.call("ai.cancel", { requestId: id });
    await settle();
    expect(model.requests[0]!.signal.aborted).toBe(false);
    await client.call("ai.cancel", { requestId: id });
    expect(await errorOf(pending)).toMatchObject({ code: "CANCELLED" });
    g.open(replying());
    await settle();
    expect(await row(thread)).toBeNull();
  });

  it("a late answer after a cancel is dropped", async () => {
    const { client, model, thread, row } = await old();
    const g = gate();
    // a provider that ignores the abort and answers anyway
    model.answer = () => g.opened;
    const id = requestId();
    const pending = go(client, thread, { id });
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("ai.cancel", { requestId: id });
    g.open(replying());
    expect(await errorOf(pending)).toMatchObject({ code: "CANCELLED" });
    expect(await row(thread)).toBeNull();
  });

  it("a hash match makes no request and keeps its original provenance; a new message hides it", async () => {
    const { client, model, thread, read, clock, arrive } = await old({ providerThreadId: "t" });
    const first = await go(client, thread);
    const summary = first.status === "ready" ? first.summary : null;
    expect(summary).toMatchObject({ provider: "fake", model: "demo", generatedAt: START });
    expect(model.requests).toHaveLength(1);
    clock.now += 60_000;
    await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { generatedAt: START } });
    expect(model.requests).toHaveLength(1);

    // the setting's off: a new message hides it, and "Update summary" (stale) is what's offered
    await arrive({ providerThreadId: "t", date: clock.now - 1000 }, true);
    await settle();
    await expect(read(thread)).resolves.toEqual({ state: "stale" });
    expect(model.requests).toHaveLength(1);
    await expect(go(client, thread)).resolves.toMatchObject({ status: "ready" });
    expect(model.requests).toHaveLength(2);
    await expect(read(thread)).resolves.toMatchObject({ state: "ready" });
  });

  it("reuse requires the same target: another endpoint asks again, and the result names who wrote it", async () => {
    const { client, model, thread } = await old();
    await go(client, thread);
    expect(model.requests).toHaveLength(1);
    await client.call("settings.update", { ai: { tasks: { summary: { provider: "fake", model: "another" } } } });
    await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { model: "another", generatedAt: START } });
    expect(model.requests).toHaveLength(2);
  });

  it("doesn't count toward the daily cap", async () => {
    const { client, backend, thread } = await old();
    await go(client, thread);
    await settle();
    const usage = await backend.store.settings.get<Record<string, Record<string, unknown>>>("ai:usage", {});
    const today = Object.values(usage)[0]!;
    expect(today.summary).toBeUndefined();
    expect(today.byHand).toMatchObject({ requests: 1 });
    await expect(client.call("ai.usage", {})).resolves.toMatchObject({ today: { requests: 1 }, monthBackgroundUsd: 0 });
  });

  it("the worker and a request on one thread make one call", async () => {
    const { client, model, arrive, read } = await setup();
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const { thread } = await arrive();
    await until(() => expect(model.requests).toHaveLength(1));
    const pending = go(client, thread);
    await settle();
    g.open(replying());
    await expect(pending).resolves.toMatchObject({ status: "ready", summary: { threadId: thread } });
    expect(model.requests).toHaveLength(1);
    await expect(read(thread)).resolves.toMatchObject({ state: "ready" });
  });

  it("and a request ahead of the worker: the worker leaves that thread alone", async () => {
    const { client, model, arrive } = await setup({ enabled: false });
    const { thread } = await arrive({}, false);
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const pending = go(client, thread);
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("settings.update", { summaries: { enabled: true } });
    await settle();
    expect(model.requests).toHaveLength(1);
    g.open(replying());
    await expect(pending).resolves.toMatchObject({ status: "ready" });
  });

  it("a body that isn't here yet says so, and works once it arrives", async () => {
    const { client, backend, thread, id, model } = await old({ bodyText: null, bodyState: "none" });
    await expect(go(client, thread)).resolves.toEqual({ status: "waitingBody" });
    expect(model.requests).toHaveLength(0);
    await backend.store.sync.setBody(id, WORDS, null, { now: START, classifier: null });
    await expect(go(client, thread)).resolves.toMatchObject({ status: "ready" });
  });

  it("gives a provider's failure its kind, and leaves nothing behind", async () => {
    const { client, model, thread, row } = await old();
    model.answer = () => { throw new AiError("That key was refused", "auth"); };
    expect(await errorOf(go(client, thread))).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "auth" } });
    expect(await row(thread)).toBeNull();
  });

  describe("where it goes", () => {
    async function cloud() {
      const s = await setup({ enabled: false, provider: "none" });
      const m = await s.arrive({ date: START - 400 * 86_400_000 }, false);
      return { ...s, ...m };
    }

    it("no provider at all: it asks, and sends nothing", async () => {
      const { client, thread, model } = await cloud();
      expect(await errorOf(go(client, thread))).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "not_configured" } });
      expect(model.requests).toHaveLength(0);
    });

    it("only another provider's key: it asks, and sends nothing to anyone", async () => {
      const { client, backend, thread, model } = await cloud();
      await client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9" } });
      await backend.setSecret("ai:anthropic:apiKey", "sk-ant-not-a-real-key-0000");
      const e = await errorOf(go(client, thread));
      expect(e).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "not_configured" } });
      expect(e?.message).toMatch(/Summaries need a provider/);
      expect(model.requests).toHaveLength(0);
      expect(model.configs).toHaveLength(0);
    });

    it("with an OpenAI key: GPT Luna, told once per provider before sending", async () => {
      const { client, backend, thread, arrive, model } = await cloud();
      await client.call("settings.update", { ai: { provider: "openai", baseURL: "http://127.0.0.1:9/v1" } });
      await client.call("settings.update", { ai: { provider: "none" } });
      await backend.setSecret("ai:openai:apiKey", "sk-openai-not-a-real-key-0000");
      await expect(go(client, thread)).resolves.toEqual({ status: "consent", provider: "openai" });
      expect(model.requests).toHaveLength(0);
      await expect(go(client, thread, { acknowledge: true })).resolves.toMatchObject({ status: "ready", summary: { provider: "openai", model: "gpt-6-luna" } });
      expect(model.requests).toHaveLength(1);
      expect((await client.call("app.bootstrap", {})).settings.summaries.acknowledged).toEqual(["openai"]);
      const next = await arrive({}, false);
      await expect(go(client, next.thread)).resolves.toMatchObject({ status: "ready" });
      expect(model.requests).toHaveLength(2);
    });

    it("\"Use {provider}\" points summaries at it, and a later key doesn't move them", async () => {
      const { client, backend, thread, model } = await cloud();
      await client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9", model: "claude-sonnet-5-5" } });
      await backend.setSecret("ai:anthropic:apiKey", "sk-ant-not-a-real-key-0000");
      await client.call("settings.update", { ai: { tasks: { summary: { provider: "anthropic", model: "claude-sonnet-5-5" } } } });
      await expect(go(client, thread)).resolves.toEqual({ status: "consent", provider: "anthropic" });
      await backend.setSecret("ai:openai:apiKey", "sk-openai-not-a-real-key-0000");
      await expect(go(client, thread, { acknowledge: true })).resolves.toMatchObject({ status: "ready", summary: { provider: "anthropic", model: "claude-sonnet-5-5" } });
      expect(model.requests).toHaveLength(1);
    });
  });

  it("isn't reachable from MCP in any way", async () => {
    const { client, mcp, thread, read } = await old();
    await go(client, thread);
    const heard: unknown[] = [];
    mcp.on("aiSummary", (e) => heard.push(e));
    for (const [method, params] of [["ai.summarize", { threadId: thread, requestId: requestId() }], ["ai.summaries.get", { threadId: thread }], ["ai.summaries.status", {}], ["ai.summaries.clear", {}], ["ai.cancel", { requestId: "x" }], ["ai.usage", {}]] as const) {
      expect(await errorOf(mcp.call(method as never, params as never))).toMatchObject({ code: "FORBIDDEN" });
    }
    await go(client, thread);
    await settle();
    expect(heard).toEqual([]);
    await expect(read(thread)).resolves.toMatchObject({ state: "ready" });
  });

  it("the event goes to the renderer and dev origins only", async () => {
    const { client, mcp, connect, model, arrive, read, backend } = await setup();
    const heard: string[] = [];
    client.on("aiSummary", () => heard.push("renderer"));
    mcp.on("aiSummary", () => heard.push("mcp"));
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "dev", origin: "dev" });
    new RpcClient(c).on("aiSummary", () => heard.push("dev"));
    connect("other", "renderer");
    const { thread } = await arrive();
    await until(async () => expect((await read(thread)).state).toBe("ready"));
    await settle();
    expect(model.requests).toHaveLength(1);
    expect(heard.sort()).toEqual(["dev", "renderer"]);
  });

  it("clears everything from Settings → Storage", async () => {
    const { client, thread, read, row } = await old();
    await go(client, thread);
    await expect(client.call("ai.summaries.clear", {})).resolves.toEqual({ ok: true });
    expect(await row(thread)).toBeNull();
    await expect(read(thread)).resolves.toEqual({ state: "none" });
  });

  it("two requests at once on one thread pay once, and both get the answer", async () => {
    const { client, model, thread } = await old();
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const first = go(client, thread);
    const second = go(client, thread);
    await until(() => expect(model.requests).toHaveLength(1));
    await settle();
    g.open(replying());
    await expect(first).resolves.toMatchObject({ status: "ready" });
    await expect(second).resolves.toMatchObject({ status: "ready" });
    expect(model.requests).toHaveLength(1);
  });

  it("Clear AI data stops a request in flight, and it brings nothing back", async () => {
    const { client, model, thread, row } = await old();
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const asked = errorOf(go(client, thread));
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("ai.summaries.clear", {});
    expect(model.requests[0]!.signal.aborted).toBe(true);
    await expect(asked).resolves.toMatchObject({ code: "CANCELLED" });
    g.open(replying());
    await settle();
    expect(await row(thread)).toBeNull();
  });

  it("an answer that arrives after Clear AI data is thrown away, even from a model that ignored the abort", async () => {
    const { client, model, thread, row } = await old();
    const g = gate();
    model.answer = () => g.opened;
    const asked = errorOf(go(client, thread));
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("ai.summaries.clear", {});
    g.open(replying());
    await expect(asked).resolves.toMatchObject({ code: "CANCELLED" });
    await settle();
    expect(await row(thread)).toBeNull();
  });

  it("the worker's summary in flight stops too", async () => {
    const { client, model, arrive, row } = await setup();
    const g = gate();
    model.answer = () => g.opened;
    const { thread } = await arrive();
    await until(() => expect(model.requests).toHaveLength(1));
    await client.call("ai.summaries.clear", {});
    expect(model.requests[0]!.signal.aborted).toBe(true);
    g.open(replying());
    await settle();
    expect(await row(thread)).toBeNull();
  });
});

describe("settings", () => {
  it("is off by default, and an import never turns it on", async () => {
    const { client, backend } = await setup({ enabled: false });
    const before = await client.call("app.bootstrap", {});
    expect(before.settings.summaries).toEqual({ enabled: false, enabledAt: null, acknowledged: [] });
    const exported = await client.call("app.export", {});
    const file = { ...exported, settings: { ...exported.settings, summaries: { enabled: true, enabledAt: 1, acknowledged: ["openai"] } } };
    await client.call("app.import", { data: file } as never);
    expect((await client.call("app.bootstrap", {})).settings.summaries).toEqual({ enabled: false, enabledAt: null, acknowledged: [] });
    expect(backend.summaries.isActive).toBe(false);
  });

  it("off and on again starts over from the moment it went on", async () => {
    const { client, clock } = await setup();
    const first = (await client.call("app.bootstrap", {})).settings.summaries.enabledAt;
    expect(first).toBe(START);
    clock.now += 5000;
    await client.call("settings.update", { summaries: { enabled: true } });
    expect((await client.call("app.bootstrap", {})).settings.summaries.enabledAt).toBe(START);
    await client.call("settings.update", { summaries: { enabled: false } });
    await client.call("settings.update", { summaries: { enabled: true } });
    expect((await client.call("app.bootstrap", {})).settings.summaries.enabledAt).toBe(START + 5000);
  });
});
