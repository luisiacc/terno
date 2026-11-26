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
import { DAILY_GUARD } from "./ai-limiter";
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

async function setup(o: { enabled?: boolean | "default"; provider?: "fake" | "none"; dir?: string; keep?: boolean; at?: number; devAi?: { openai: string } } = {}) {
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
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, ...(o.devAi ? { devAi: o.devAi, lookup: async () => [{ address: "93.184.216.34", family: 4 as const }] } : {}), now: () => clock.now, log: (_level, message, extra) => void logs.push(`${message} ${JSON.stringify(extra ?? null)}`) });
  await backend.store.ready;
  const connect = (clientId: string, origin: "renderer" | "mcp") => {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId, origin });
    return new RpcClient(c);
  };
  const client = connect("renderer", "renderer");
  const mcp = connect("mcp", "mcp");
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "me@terno.test", displayName: "Me", color: "brown", now: 0 });
  // plan 211: What matters' readers are on by default too; these count summaries' requests alone
  await client.call("settings.update", { dated: { enabled: false }, followups: { enabled: false } });
  if ((o.provider ?? "fake") === "fake") await client.call("settings.update", { ai: { provider: "fake" } });
  // "default": nobody touched the switch. A later launch of the same profile keeps what it saved.
  if (o.enabled !== "default" && !(o.enabled === false && o.dir)) await client.call("settings.update", { summaries: { enabled: o.enabled ?? true } });
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

  it("plan 261: a verification code's mail, however long, asks for no summary; a long mail arriving beside it still does", async () => {
    const { model, arrive, row } = await setup();
    const code = await arrive({ subject: "Action required: Verify your email address", bodyText: `${WORDS}\n\nPlease verify your email address by entering this code: 391372` });
    await until(async () => expect(await row(code.thread)).toBeNull());
    expect(model.requests).toHaveLength(0);
    // in one conversation: the code's arrival is no reading, the other's is
    const talk = await arrive({ rfcMessageId: "talk@test" });
    await arrive({ inReplyTo: "talk@test", references: ["talk@test"], subject: "Re: books", bodyText: `${WORDS}\n\nYour code: 482913`, date: START - 30_000 });
    await until(async () => expect((await row(talk.thread))?.state).toBe("ready"));
  });

  it("plan 269: a machine's notice is read by its prose: its template asks for no summary, the same text from a person does, and by hand still works", async () => {
    const { backend, client, model, arrive, row, account, clock } = await setup();
    const notice = `1 new message awaits your response\n\nMara Velez\nLawyer at Velez & Ortiz\n\nView message: https://social.test/messaging/thread/2-YTk2ZjQ1NzQtOGRhZC00?midToken=AQH\n\nInstall the Social widgets\nStay updated at a glance\nAdd widget: https://social.test/widgets\n\n----------------------------------------\nThis email was intended for Rafa Ortiz (Founder at Ortiz Legal)\nLearn why we included this: https://social.test/help/4788\nYou are receiving Social notification emails.\nUnsubscribe: https://social.test/psettings/email-unsubscribe\n© 2026 Social Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085.`;
    const machine = await arrive({ subject: "Mara just messaged you", from: { name: "Mara Velez via Social", email: "messaging-digest-noreply@social.test" }, bodyText: notice });
    await until(async () => expect(await row(machine.thread)).toBeNull());
    expect(model.requests).toHaveLength(0);
    // a person's mail is counted as it always was
    const person = await arrive({ subject: "Mara's note", bodyText: notice });
    await until(async () => expect((await row(person.thread))?.state).toBe("ready"));
    expect(model.requests).toHaveLength(1);
    // in one conversation arriving together, a notice doesn't hide a long message: one request reads both
    const [talk, ping] = [
      msg({ accountId: account.id, rfcMessageId: "talk-269@test", subject: "Lease", date: clock.now - 60_000, bodyText: WORDS, from: { name: "Ana", email: "ana@books.test" } }),
      msg({ accountId: account.id, inReplyTo: "talk-269@test", references: ["talk-269@test"], subject: "Re: Lease", date: clock.now - 30_000, bodyText: notice, from: { name: "Social", email: "messaging-digest-noreply@social.test" } }),
    ];
    await backend.ingestSliced([talk, ping], true, undefined, undefined, undefined, undefined, undefined, true);
    const both = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === talk.providerMsgId)!.threadId;
    expect((await backend.store.debug.snapshot()).messages.filter((x) => x.threadId === both)).toHaveLength(2);
    await until(async () => expect((await row(both))?.state).toBe("ready"));
    expect(model.requests).toHaveLength(2);
    expect(promptText(model.requests[1]!.messages[0]!.content)).toContain("awaits your response");
    await expect(client.call("ai.summarize", { threadId: machine.thread, requestId: requestId() })).resolves.toMatchObject({ summary: expect.anything() });
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

  it("plan 151: says who's reading and who each message went to, so a copied reader isn't handed the work", async () => {
    const { model, arrive, row, backend } = await setup();
    const account = (await backend.store.accounts.list())[0]!;
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@x.test` }));
    const copied = await arrive({ from: { name: "Ana", email: "ana@x.test" }, to: many, cc: [{ name: "Me Myself", email: account.email.toUpperCase() }] });
    await until(async () => expect((await row(copied.thread))?.state).toBe("ready"));
    const prompt = promptText(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain(`<reader name="Me Myself" email="${account.email.toLowerCase()}" />`);
    expect(prompt).toContain('reader-on="cc"');
    expect(prompt).toContain("and 4 more");
    expect(prompt).not.toContain("Person 8");
  });

  it("plan 153: the last message keeps what it quotes when it's the reader's, since that can be the only copy here", async () => {
    const { model, arrive, row } = await setup();
    await arrive({ providerThreadId: "own-last", date: START - 120_000, bodyText: `${WORDS} older words\n> older quote` });
    await arrive({ providerThreadId: "own-last", date: START - 90_000, bodyText: `${WORDS} newest inbound` });
    const m = await arrive({ providerThreadId: "own-last", date: START - 60_000, isSent: true, from: { name: "Me", email: "me@terno.test" }, bodyText: "Thanks.\n\n-----Original Message-----\nFrom: Ann\nThe documentation went out on Friday." });
    await until(async () => expect((await row(m.thread))?.state).toBe("ready"));
    const prompt = promptText(model.requests.at(-1)!.messages[0]!.content);
    expect(prompt).toContain("The documentation went out on Friday.");
    expect(prompt).not.toContain("older quote");
    // what the reader wrote comes first, whatever the size of what they quote
    const huge = await arrive({ providerThreadId: "huge", date: START - 30_000, isSent: true, from: { name: "Me", email: "me@terno.test" }, bodyText: `${"> quoted line\n".repeat(600)}Already signed it.` });
    await arrive({ providerThreadId: "huge", date: START - 40_000, bodyText: WORDS });
    await until(async () => expect((await row(huge.thread))?.state).toBe("ready"));
    expect(promptText(model.requests.at(-1)!.messages[0]!.content)).toContain("Already signed it.");
  });

  it("plan 151: on a small window, long recipient lists go before the message's words", async () => {
    const { client, backend, model, arrive, row } = await setup({ enabled: false });
    await backend.store.settings.update("app", {}, (s: Record<string, unknown>) => {
      const ai = (s.ai ?? {}) as Record<string, unknown>;
      return { value: { ...s, ai: { ...ai, capabilities: { "fake|||demo": { output: "json_schema", contextTokens: 2000, embeddings: false, probedAt: 1 } } } }, result: undefined };
    });
    await client.call("settings.update", { summaries: { enabled: true } });
    const crowd = (at: string) => Array.from({ length: 8 }, (_, i) => ({ name: `${at} ${i} ${"n".repeat(70)}`, email: `${at}${i}@x.test` }));
    const m = await arrive({ to: crowd("t"), cc: crowd("c") });
    await until(async () => expect((await row(m.thread))?.state).toBe("ready"));
    const prompt = promptText(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain("The contract needs");
    expect(prompt).not.toContain("nnnnnnnn");
    expect(prompt).toContain('reader-on="none"');
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
    expect(req.maxTokens).toBe(Math.min(5000, Math.ceil(tokens * 0.3)));
    expect(prompt).toContain("The contract needs");
    // what's cited still runs m1, m2…: dropping a message leaves no gap
    const labels = [...prompt.matchAll(/<message id="m(\d+)"/g)].map((m) => Number(m[1]));
    expect(labels).toEqual(labels.map((_, i) => i + 1));
  });

  it.each([2000, 4096, 8192, 32_000])("plan 279: a %i-token window with new mail after what was read still holds, and asks for a since only of what's sent", async (tokens) => {
    const { client, backend, model, arrive, row } = await setup({ enabled: false });
    await backend.store.settings.update("app", {}, (s: Record<string, unknown>) => {
      const ai = (s.ai ?? {}) as Record<string, unknown>;
      return { value: { ...s, ai: { ...ai, capabilities: { "fake|||demo": { output: "json_schema", contextTokens: tokens, embeddings: false, probedAt: 1 } } } }, result: undefined };
    });
    await client.call("settings.update", { summaries: { enabled: true } });
    const snippet = "s".repeat(180);
    // every one of the 50 (Codex code review 11: `||=` stopped at the first)
    let first = 0;
    for (let i = 0; i < 50; i++) {
      const { thread } = await arrive({ providerThreadId: "long", date: START - 90_000 + i, snippet, bodyText: `body ${i} ${"z".repeat(2000)}`, from: { name: "A rather long display name for a person", email: `someone-with-a-long-address-${i}@books.test` } }, false);
      first = thread;
    }
    await backend.store.threads.act({ threadIds: [first], action: "markRead", signal: null, now: START });
    const last = await arrive({ providerThreadId: "long", subject: "q".repeat(900), bodyText: `${WORDS}${"y".repeat(40_000)}` });
    await until(async () => expect((await row(last.thread))?.state).toBe("ready"));
    const req = model.requests[0]!;
    const prompt = promptText(req.messages[0]!.content);
    expect(promptText(req.system).length + 1000 + prompt.length + req.maxTokens * 4).toBeLessThanOrEqual(tokens * 4);
    const marked = [...prompt.matchAll(/<message id="m(\d+)"[^\n]*?( new="yes")?>\n/g)];
    const asked = promptText(req.system).includes('<since>');
    // asked exactly when the new message went with something before it, and never of the compact prompt
    expect(asked).toBe(marked.length > 1 && marked.at(-1)![2] !== undefined && marked[0]![2] === undefined);
    expect(marked.filter((m) => m[2]).length).toBe(asked ? 1 : 0);
    if (tokens >= 8192) expect(asked).toBe(true);
    if (tokens === 2000) expect(asked).toBe(false);
  });

  it("keeps an own message's words out of quotes in both languages", () => {
    // plan 151: an answer between quoted lines is theirs, and an unmarked quote still ends it
    expect(withoutQuotes("Yes.\n> Are you coming?\nOn Mon, 3 Mar, Ana wrote:\n> old\nAlready sent it.")).toBe("Yes.\nAlready sent it.");
    expect(withoutQuotes("El lun, 3 mar, Ana escribió:\n> ¿Lo enviaste?\nYa lo envié.")).toBe("Ya lo envié.");
    expect(withoutQuotes("Fine.\nOn Mon, 3 Mar, Ana wrote:\nunmarked old text")).toBe("Fine.");
    expect(withoutQuotes("On Mon, Ana wrote:\n> intro\nFrom: Bob <bob@x.test>\nSent: Monday\nPlease approve")).toBe("");
    // a forward stays: what it carries is nowhere else, and Ask searches it
    expect(withoutQuotes("FYI\n----- Forwarded message -----\nThe door code is 4932")).toContain("4932");
    expect(withoutQuotes("FYI\nFrom: Bob <bob@x.test>\nSent: Monday\nThe door code is 4932")).toContain("4932");
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

  it("plans 150, 157: Dev mode's switch off: new mail queues nothing and nothing is asked, whatever is saved; on, new mail goes with no restart, and what came before stays out", async () => {
    const { arrive, backend, client, model, read, row } = await setup({ devAi: { openai: "env-openai" } });
    expect(backend.summaries.isActive).toBe(false);
    const before = await arrive();
    await settle();
    expect(model.requests).toHaveLength(0);
    expect(await row(before.thread)).toBeNull();
    await expect(backend.summaries.status()).resolves.toMatchObject({ pending: 0, blockedBy: null });
    await client.call("settings.update", { devAi: true });
    expect(backend.summaries.isActive).toBe(true);
    const { thread } = await arrive();
    await vi.waitFor(async () => expect((await read(thread)).state).toBe("ready"));
    expect(model.requests).toHaveLength(1);
    expect(model.configs.at(-1)).toMatchObject({ id: "openai", apiKey: "env-openai" });
    expect(await row(before.thread)).toBeNull();
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

  it("the day's guard (plan 239) stops it with no attempt spent, and the next day's first wake-up goes on; the month's likewise", async () => {
    const { client, backend, model, arrive, row, clock } = await setup({ enabled: false });
    const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    await backend.store.settings.set("ai:usage", { [day(clock.now)]: { summary: { requests: DAILY_GUARD.requests, inputTokens: 0, outputTokens: 0, usd: 0 } } });
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
    await client.call("settings.update", { ai: { model: "another" } });
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
  const go = (client: RpcClient, threadId: number, o: { id?: string } = {}) => client.call("ai.summarize", { threadId, requestId: o.id ?? requestId() });

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

  describe("plan 242: Dev mode's Summarize again", () => {
    const again = (client: RpcClient, threadId: number, id = requestId()) => client.call("ai.summarize", { threadId, requestId: id, again: true });
    /** a local build with Dev mode's switch on, and an old thread summarized once by hand */
    async function local() {
      const s = await setup({ enabled: false, devAi: { openai: "env-openai" } });
      await s.client.call("settings.update", { devAi: true });
      const m = await s.arrive({ date: START - 400 * 86_400_000 }, false);
      await go(s.client, m.thread);
      expect(s.model.requests).toHaveLength(1);
      return { ...s, ...m };
    }
    const NEW = { summary: "Ana still needs the signature.", items: [] };

    it("asks the model although what's stored would do, and keeps the new one", async () => {
      const { client, model, clock, thread, read } = await local();
      await go(client, thread);
      expect(model.requests).toHaveLength(1);
      model.answer = () => replying(NEW);
      clock.now += 1000;
      await expect(again(client, thread)).resolves.toMatchObject({ status: "ready", summary: { summary: NEW.summary, generatedAt: START + 1000 } });
      expect(model.requests).toHaveLength(2);
      await expect(read(thread)).resolves.toMatchObject({ state: "ready", summary: { summary: NEW.summary } });
    });

    it("doesn't take the answer of a run it finds on the thread", async () => {
      const { client, model, arrive } = await local();
      const { thread } = await arrive({ date: START - 400 * 86_400_000 }, false);
      const g = gate();
      model.answer = (req, n) => (n === 1 ? held(req, g.opened) : replying(NEW));
      // the reader's ordinary request, stopped at the model: its answer is one Summarize again doesn't take
      const first = go(client, thread);
      await until(() => expect(model.requests).toHaveLength(2));
      const mine = again(client, thread);
      await settle();
      g.open(replying());
      await expect(first).resolves.toMatchObject({ status: "ready", summary: { summary: ANSWER.summary } });
      await expect(mine).resolves.toMatchObject({ status: "ready", summary: { summary: NEW.summary } });
      expect(model.requests).toHaveLength(3);
    });

    it("cancelled, what was stored stays", async () => {
      const { client, model, thread, read } = await local();
      const g = gate();
      model.answer = (req) => held(req, g.opened);
      const id = requestId();
      const pending = again(client, thread, id);
      await until(() => expect(model.requests).toHaveLength(2));
      await client.call("ai.cancel", { requestId: id });
      expect(await errorOf(pending)).toMatchObject({ code: "CANCELLED" });
      await expect(read(thread)).resolves.toMatchObject({ state: "ready", summary: { summary: ANSWER.summary } });
    });

    it("is refused outside a local build, and nothing is asked", async () => {
      const { client, model, thread } = await old();
      await go(client, thread);
      expect(await errorOf(again(client, thread))).toMatchObject({ code: "BAD_REQUEST" });
      expect(model.requests).toHaveLength(1);
    });
  });

  it("reuse requires the same target: another endpoint asks again, and the result names who wrote it", async () => {
    const { client, model, thread } = await old();
    await go(client, thread);
    expect(model.requests).toHaveLength(1);
    await client.call("settings.update", { ai: { model: "another" } });
    await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { model: "another", generatedAt: START } });
    expect(model.requests).toHaveLength(2);
  });

  it("plan 202: a summary made with the shorter prompt isn't reused once the window has room for the whole one", async () => {
    // short enough that both windows send the same words
    const { client, backend, model, thread } = await old({ bodyText: "Can you send the signed contract by Friday? Thanks." });
    const window = async (contextTokens: number) => {
      await backend.store.settings.update("app", {}, (s: Record<string, unknown>) => {
        const ai = (s.ai ?? {}) as Record<string, unknown>;
        return { value: { ...s, ai: { ...ai, capabilities: { "fake|||demo": { output: "json_schema", contextTokens, embeddings: false, probedAt: 1 } } } }, result: undefined };
      });
      await client.call("settings.update", { summaries: { enabled: false } });
    };
    await window(2000);
    await go(client, thread);
    expect(promptText(model.requests[0]!.system)).not.toMatch(/<whose_is_it>/);
    await window(8192);
    await go(client, thread);
    expect(model.requests).toHaveLength(2);
    expect(promptText(model.requests[1]!.system)).toMatch(/<whose_is_it>/);
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

    it("only a Claude key: Haiku, since this runs on every new mail (plan 168: Terno picks, nothing asks)", async () => {
      const { client, backend, thread, model } = await cloud();
      await client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9" } });
      await backend.setSecret("ai:anthropic:apiKey", "sk-ant-not-a-real-key-0000");
      await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { provider: "anthropic", model: "claude-haiku-5-5" } });
      expect(model.requests).toHaveLength(1);
    });

    it("AI off with a key still saved: nothing goes anywhere", async () => {
      const { client, backend, thread, model } = await cloud();
      await backend.setSecret("ai:openai:apiKey", "sk-openai-not-a-real-key-0000");
      expect(await errorOf(go(client, thread))).toMatchObject({ code: "UNAVAILABLE", details: { aiErrorKind: "not_configured" } });
      expect(model.configs).toHaveLength(0);
    });

    it("a local model keeps them here, whatever OpenAI key is saved", async () => {
      const { client, backend, thread, model } = await cloud();
      await backend.setSecret("ai:openai:apiKey", "sk-openai-not-a-real-key-0000");
      await client.call("settings.update", { ai: { provider: "ollama", baseURL: "http://127.0.0.1:9/v1", model: "qwen" } });
      await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { provider: "ollama", model: "qwen" } });
      expect(model.configs.every((c) => c.id === "ollama")).toBe(true);
    });

    it("with an OpenAI key: GPT Luna, at once, with nothing asked first (plan 131: no per-use consent)", async () => {
      const { client, backend, thread, arrive, model } = await cloud();
      await client.call("settings.update", { ai: { provider: "openai", baseURL: "http://127.0.0.1:9/v1" } });
      await backend.setSecret("ai:openai:apiKey", "sk-openai-not-a-real-key-0000");
      await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { provider: "openai", model: "gpt-6-luna" } });
      expect(model.requests).toHaveLength(1);
      const next = await arrive({}, false);
      await expect(go(client, next.thread)).resolves.toMatchObject({ status: "ready" });
      expect(model.requests).toHaveLength(2);
    });

    it("a Claude key, then an OpenAI one: summaries move to Luna, the rest stays on Claude", async () => {
      const { client, backend, thread, model } = await cloud();
      await client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9" } });
      await backend.setSecret("ai:anthropic:apiKey", "sk-ant-not-a-real-key-0000");
      await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { provider: "anthropic", model: "claude-haiku-5-5" } });
      await client.call("settings.update", { ai: { provider: "openai", baseURL: "http://127.0.0.1:9/v1" } });
      await client.call("settings.update", { ai: { provider: "anthropic" } });
      await backend.setSecret("ai:openai:apiKey", "sk-openai-not-a-real-key-0000");
      await client.call("ai.summaries.clear", {});
      await expect(go(client, thread)).resolves.toMatchObject({ status: "ready", summary: { provider: "openai", model: "gpt-6-luna" } });
      expect(model.requests).toHaveLength(2);
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
  it("is on by default, and an import never changes that, nor a switch someone turned off", async () => {
    const { client, backend } = await setup({ enabled: "default" });
    const on = { enabled: true, enabledAt: null };
    expect((await client.call("app.bootstrap", {})).settings.summaries).toEqual(on);
    expect(backend.summaries.isActive).toBe(true);
    const exported = await client.call("app.export", {});
    await client.call("app.import", { data: { ...exported, settings: { ...exported.settings, summaries: { enabled: false, enabledAt: null, acknowledged: ["openai"] } } } } as never);
    expect((await client.call("app.bootstrap", {})).settings.summaries).toEqual(on);

    const off = await setup({ enabled: false });
    const file = await off.client.call("app.export", {});
    await off.client.call("app.import", { data: { ...file, settings: { ...file.settings, summaries: { enabled: true, enabledAt: 1, acknowledged: ["openai"] } } } } as never);
    expect((await off.client.call("app.bootstrap", {})).settings.summaries).toEqual({ enabled: false, enabledAt: null });
    expect(off.backend.summaries.isActive).toBe(false);
  });

  it("off and on again starts over from the moment it went on", async () => {
    const { client, clock } = await setup({ enabled: "default" });
    expect((await client.call("app.bootstrap", {})).settings.summaries.enabledAt).toBeNull();
    clock.now += 5000;
    await client.call("settings.update", { summaries: { enabled: true } });
    expect((await client.call("app.bootstrap", {})).settings.summaries.enabledAt).toBeNull();
    await client.call("settings.update", { summaries: { enabled: false } });
    await client.call("settings.update", { summaries: { enabled: true } });
    expect((await client.call("app.bootstrap", {})).settings.summaries.enabledAt).toBe(START + 5000);
  });

  describe("plan 157: it follows AI", () => {
    it("with no provider it does nothing; a provider starts it with no backfill; going away drops the queue", async () => {
      const { client, backend, model, arrive, row } = await setup({ enabled: "default", provider: "none" });
      expect(backend.summaries.isActive).toBe(false);
      const before = await arrive();
      await settle();
      expect(await row(before.thread)).toBeNull();

      await client.call("settings.update", { ai: { provider: "fake" } });
      expect(backend.summaries.isActive).toBe(true);
      await settle();
      expect(model.requests).toHaveLength(0);
      const after = await arrive();
      await until(async () => expect((await row(after.thread))?.state).toBe("ready"));
      expect(await row(before.thread)).toBeNull();

      const stuck = gate();
      model.answer = (req) => held(req, stuck.opened);
      const waiting = await arrive();
      await until(() => expect(model.requests).toHaveLength(2));
      await client.call("settings.update", { ai: { provider: "none" } });
      expect(backend.summaries.isActive).toBe(false);
      await until(async () => expect(await row(waiting.thread)).toBeNull());
    });

    it("plan 168: a Claude key alone brings them, on Haiku: Terno picks, nothing waits for a choice; AI off stops them", async () => {
      const { client, backend, arrive, row } = await setup({ enabled: "default", provider: "none" });
      await client.call("settings.update", { ai: { provider: "anthropic", baseURL: "http://127.0.0.1:9" } });
      await backend.setSecret("ai:anthropic:apiKey", "sk-ant-not-a-real-key-0000");
      backend.summaries.settingsChanged((await client.call("app.bootstrap", {})).settings as never);
      expect(backend.summaries.isActive).toBe(true);
      const { thread } = await arrive();
      await until(async () => expect(await row(thread)).toMatchObject({ state: "ready", provider: "anthropic", model: "claude-haiku-5-5" }));
      await client.call("settings.update", { ai: { provider: "none" } });
      expect(backend.summaries.isActive).toBe(false);
    });

    it("someone's own off stays off, through AI coming and going", async () => {
      const { client, backend } = await setup({ enabled: false, provider: "none" });
      await client.call("settings.update", { ai: { provider: "fake" } });
      expect(backend.summaries.isActive).toBe(false);
      expect((await client.call("app.bootstrap", {})).settings.summaries.enabled).toBe(false);
    });

    it("a launch without AI clears what a quit left queued, so AI coming back sends nothing old", async () => {
      const dir = mkdtempSync(join(tmpdir(), "terno-summaries-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const first = await setup({ dir, keep: true, enabled: "default" });
      const gone = gate();
      first.model.answer = (req) => held(req, gone.opened);
      const { thread } = await first.arrive();
      await until(() => expect(first.model.requests).toHaveLength(1));
      // written straight in: a key gone from the environment, say, which no running backend hears of
      await first.backend.store.settings.update("app", {}, (s: Record<string, unknown>) => ({ value: { ...s, ai: { provider: "none" } }, result: undefined }));
      await first.stop();
      const next = await setup({ dir, keep: true, enabled: "default", provider: "none" });
      // what a host does at start
      await next.backend.summaries.start();
      await settle();
      await next.client.call("settings.update", { ai: { provider: "fake" } });
      await settle();
      expect(next.model.requests).toHaveLength(0);
      expect(await next.row(thread)).toBeNull();
    });

    it("an imported provider is AI coming: it starts", async () => {
      const { client, backend } = await setup({ enabled: "default", provider: "none" });
      const file = await client.call("app.export", {});
      await client.call("app.import", { data: { ...file, settings: { ...file.settings, aiProvider: "fake", ai: { provider: "fake" } } } } as never);
      expect((await client.call("app.bootstrap", {})).settings.ai.provider).toBe("fake");
      expect(backend.summaries.isActive).toBe(true);
    });
  });
});

describe("plan 211: an account with AI off", () => {
  it("stops what's in flight on its mail, sends nothing queued of it, hides what it made, and refuses by hand; back on, it's there", async () => {
    const { client, model, arrive, read, row, account } = await setup();
    const made = await arrive();
    await until(async () => expect((await row(made.thread))?.state).toBe("ready"));
    const g = gate();
    model.answer = (req) => held(req, g.opened);
    const flying = await arrive({ providerMsgId: "flying", providerThreadId: "flying", rfcMessageId: "<flying@test>", subject: "Flying" });
    await until(() => expect(model.requests).toHaveLength(2));
    const queued = await arrive({ providerMsgId: "queued", providerThreadId: "queued", rfcMessageId: "<queued@test>", subject: "Queued" });
    await client.call("accounts.update", { id: account.id, ai: false });
    g.open(replying());
    await settle();
    expect(model.requests).toHaveLength(2);
    expect((await row(flying.thread))?.state).not.toBe("ready");
    expect(await row(queued.thread)).toBeNull();
    await expect(read(made.thread)).resolves.toEqual({ state: "none" });
    const refused = await errorOf(client.call("ai.summarize", { threadId: made.thread, requestId: requestId() }));
    expect(refused).toMatchObject({ code: "BAD_REQUEST", message: "AI is off for this account. Turn it on in Settings → Accounts." });
    expect(model.requests).toHaveLength(2);
    // kept until Clear AI data: back on, it shows again
    await client.call("accounts.update", { id: account.id, ai: true });
    await expect(read(made.thread)).resolves.toMatchObject({ state: "ready" });
  });
});

describe("plan 279: what's new since you read", () => {
  const SINCE = { ...ANSWER, since: "Ana sent the signed copy to the bank." };
  const promptOf = (req: CompletionRequest) => promptText(req.messages[0]!.content);
  /** a conversation already here (a first sync: nothing summarized), read */
  async function readConversation(s: Awaited<ReturnType<typeof setup>>, n = 1) {
    const here = [];
    for (let i = 0; i < n; i++) here.push(await s.arrive({ providerThreadId: "since", bodyText: `${WORDS} (${i})` }, false));
    await s.backend.store.threads.act({ threadIds: [here[0]!.thread], action: "markRead", signal: null, now: START });
    return here;
  }

  it("new mail after what was read: only it is marked new, and the since is stored and read with where it starts", async () => {
    const s = await setup();
    await readConversation(s);
    s.model.answer = () => replying(SINCE);
    const next = await s.arrive({ providerThreadId: "since" });
    await until(async () => expect((await s.row(next.thread))?.state).toBe("ready"));
    expect(promptOf(s.model.requests[0]!)).toMatch(/<message id="m2"[^\n]* new="yes">/);
    expect(promptOf(s.model.requests[0]!)).not.toMatch(/<message id="m1"[^\n]* new="yes">/);
    expect(promptText(s.model.requests[0]!.system)).toContain('<since>');
    await expect(s.read(next.thread)).resolves.toMatchObject({ state: "ready", summary: { since: { from: next.id, text: SINCE.since } } });
  });

  it("mail read on arrival (another device, or the dwell before the summary) is still what's new: its mark says so", async () => {
    const s = await setup();
    await readConversation(s);
    s.model.answer = () => replying(SINCE);
    const next = await s.arrive({ providerThreadId: "since", isRead: true });
    await until(async () => expect((await s.row(next.thread))?.state).toBe("ready"));
    expect(promptOf(s.model.requests[0]!)).toMatch(/<message id="m2"[^\n]* new="yes">/);
  });

  it("a conversation with nothing read before asks for no since; an empty since keeps where the new mail starts, for its rows (Codex code review 5)", async () => {
    const s = await setup();
    s.model.answer = () => replying(SINCE);
    const only = await s.arrive();
    await until(async () => expect((await s.row(only.thread))?.state).toBe("ready"));
    expect(promptOf(s.model.requests[0]!)).not.toContain('new="yes"');
    expect(promptText(s.model.requests[0]!.system)).not.toContain('"since"');
    expect(JSON.parse((await s.row(only.thread))!.bodyJson!)).not.toHaveProperty("since");

    await readConversation(s);
    s.model.answer = () => replying({ ...ANSWER, since: "" });
    const thanks = await s.arrive({ providerThreadId: "since" });
    await until(async () => expect((await s.row(thanks.thread))?.state).toBe("ready"));
    expect(promptText(s.model.requests[1]!.system)).toContain('<since>');
    expect(JSON.parse((await s.row(thanks.thread))!.bodyJson!).since).toMatchObject({ from: thanks.id, text: "" });
    await expect(s.read(thanks.thread)).resolves.toMatchObject({ summary: { since: { from: thanks.id, text: "" } } });
  });

  it("by hand, what the reader saw unread in this showing; the same again reuses it, with or without the snapshot", async () => {
    const s = await setup({ enabled: false });
    const [, second] = await readConversation(s, 2);
    s.model.answer = () => replying(SINCE);
    const got = await s.client.call("ai.summarize", { threadId: second!.thread, requestId: requestId(), since: second!.id });
    expect(got).toMatchObject({ status: "ready", summary: { since: { from: second!.id } } });
    expect(promptOf(s.model.requests[0]!)).toMatch(/<message id="m2"[^\n]* new="yes">/);
    // a stored since stays until newer mail: made again with nothing new, it keeps where it starts and costs nothing
    for (const since of [second!.id, undefined]) await s.client.call("ai.summarize", { threadId: second!.thread, requestId: requestId(), ...(since ? { since } : {}) });
    expect(s.model.requests).toHaveLength(1);
  });

  it("a request joins a run only about the same new mail; otherwise it asks with its own once that ends", async () => {
    const s = await setup();
    const [, second] = await readConversation(s, 2);
    const g = gate();
    s.model.answer = (req, n) => (n === 0 ? held(req, g.opened) : replying({ ...ANSWER, since: "Mine." }));
    const third = await s.arrive({ providerThreadId: "since" });
    await until(() => expect(s.model.requests).toHaveLength(1));
    // the worker's run starts at the new message; the reader saw the one before it unread too
    const asked = s.client.call("ai.summarize", { threadId: third.thread, requestId: requestId(), since: second!.id });
    await settle();
    g.open(replying({ ...ANSWER, since: "Worker's." }));
    await expect(asked).resolves.toMatchObject({ status: "ready", summary: { since: { from: second!.id, text: "Mine." } } });
    expect(s.model.requests).toHaveLength(2);
  });

  it("the panel: new mail whose summary failed says so while it's unread, and nothing once it's read", async () => {
    const s = await setup();
    s.model.answer = () => {
      throw new AiError("no", "refused");
    };
    const failed = await s.arrive();
    await until(async () => expect((await s.row(failed.thread))?.state).toBe("failed"));
    await expect(s.read(failed.thread)).resolves.toEqual({ state: "failed" });
    await s.backend.store.threads.act({ threadIds: [failed.thread], action: "markRead", signal: null, now: START });
    await expect(s.read(failed.thread)).resolves.toEqual({ state: "none" });
  });

  it("the panel: a row keeps its day and whether replying does it", async () => {
    const s = await setup();
    s.model.answer = () => replying({ summary: "Ana needs a signature.", items: [{ kind: "action", text: "Sign at the notary", message: "m1", due: "2026-11-13", byReply: false }, { kind: "waiting", text: "Ana: the final draft", message: "m1", due: null, byReply: true }] });
    const got = await s.arrive();
    await until(async () => expect((await s.row(got.thread))?.state).toBe("ready"));
    await expect(s.read(got.thread)).resolves.toMatchObject({ summary: { items: [{ kind: "action", text: "Sign at the notary", messageId: got.id, due: "2026-11-13", byReply: false }, { kind: "waiting", text: "Ana: the final draft", messageId: got.id }] } });
  });

  it("a short reply from a person in a conversation that had a summary is summarized (the 60 words aren't asked)", async () => {
    const s = await setup();
    const [first] = await readConversation(s);
    await s.client.call("ai.summarize", { threadId: first!.thread, requestId: requestId() });
    s.model.answer = () => replying({ ...ANSWER, since: "Ana moved it to Thursday." });
    const short = await s.arrive({ providerThreadId: "since", bodyText: "Let's do Thursday instead." });
    await until(async () => expect(await s.read(short.thread)).toMatchObject({ summary: { since: { from: short.id } } }));
    // with no summary before, a short mail still gets none
    const alone = await s.arrive({ bodyText: "Let's do Thursday instead." });
    await settle();
    expect(await s.row(alone.thread)).toBeNull();
  });
});
