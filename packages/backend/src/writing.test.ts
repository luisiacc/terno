/**
 * Plan 133 §5, §6 and §8 through the real backend, with a scripted model: nothing leaves this process.
 */
import { AiError, COMPOSE_MAX_TOKENS, WRITING_RULES, type CompletionRequest } from "@terno/ai";
import { setDiagSink } from "@terno/core/diag";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubbed, STUDY_KEY } from "./voice-learner";
import { PREFS_KEY } from "./writing";
import { cleanUp, errorOf, say, setup, START, textOf, TOM } from "./test/writing-fixture";

afterEach(cleanUp);

const last = (t: { model: { requests: CompletionRequest[] } }) => t.model.requests[t.model.requests.length - 1]!;
const done = async <T extends { status: string }>(p: Promise<T>) => {
  const r = await p;
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}`);
  return r as Extract<T, { status: "done" }>;
};

describe("ai.compose: what goes in", () => {
  it("someone new still gets the user's voice, this account's and their company's; nothing from other people's mail in words", async () => {
    const t = await setup();
    await t.sentMany(20, (i) => ({ to: [{ name: "Ana", email: i % 2 ? "ana@acme.test" : "bea@acme.test" }], bodyText: `The canary-ana-${i} thing is sorted, thanks.` }));
    await t.learned();
    const r = await done(t.compose({ to: [{ name: "Tom", email: "new.person@acme.test" }] }));
    expect(r.used.levels).toEqual(["you", "account", "domain"]);
    expect(r.used.history).toBe("none");
    expect(r.used.examples).toBe(0);
    expect(textOf(last(t))).not.toContain("canary-ana");
  });

  it("someone known adds their level and whole messages to them, newest and of the same kind first", async () => {
    const t = await setup();
    await t.sentMany(10, (i) => ({ bodyText: `Plain note to Tom number ${i} about this`, date: START - 86_400_000 * (i + 1) }));
    await t.sent({ bodyText: "Newest reply to Tom about this", inReplyTo: "x@test", date: START - 1000 });
    await t.sentMany(20, (i) => ({ to: [{ name: "Other", email: `p${i % 3}@else.test` }], bodyText: `canary-other ${i}` }));
    await t.learned();
    const { thread } = await t.received({});
    const r = await done(t.compose({ kind: "reply", threadId: thread }));
    expect(r.used.levels).toContain("person");
    expect(r.used.examples).toBe(4);
    expect(r.used.history).toBe("found");
    const prompt = textOf(last(t));
    expect(prompt).toContain("Newest reply to Tom");
    expect(prompt).not.toContain("canary-other");
    expect(prompt.indexOf("Newest reply to Tom")).toBeLessThan(prompt.indexOf("Plain note to Tom"));
  });

  it("a person written to only from another account: that profile, labelled, and no messages from there", async () => {
    const t = await setup({ accounts: 2 });
    const [a, b] = t.accounts;
    await t.sentMany(20, () => ({ accountId: b!.id, bodyText: "From the other account to Tom." }));
    await t.sentMany(20, () => ({ accountId: a!.id, to: [{ name: "X", email: "x@y.test" }] }));
    await t.learned();
    const r = await done(t.compose({ accountId: a!.id }));
    expect(r.used).toMatchObject({ personFromOtherAccount: true, examples: 0, history: "unavailable" });
    expect(r.used.levels).toContain("person");
    expect(textOf(last(t))).toContain('from="another account"');
    expect(textOf(last(t))).not.toContain("From the other account");
  });

  it("thin evidence says so: before the first pass 'learning', and it never waits for it", async () => {
    const t = await setup();
    await t.sentMany(30);
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const real = t.backend.store.writing.corpus.texts;
    // the learner's pages are of 16: it stops at its first, and the draft goes on regardless
    vi.spyOn(t.backend.store.writing.corpus, "texts").mockImplementation(async (ids) => {
      if (ids.length === 16) await hold;
      return real(ids);
    });
    const r = await done(t.compose());
    release();
    await t.backend.writing.learner.idle();
    expect(r.used.learning).toBe(true);
    expect(r.used.levels).toEqual([]);
    expect(r.used.examples).toBeGreaterThan(0);
  });

  it("uses the language it's writing in: their last message's, a new message's by past mail to them, and the row kept for it", async () => {
    const t = await setup();
    await t.sentMany(20, () => ({ bodyText: "Thanks for the update, that works for me and the team." }));
    await t.sentMany(10, () => ({ bodyText: "Muchas gracias por la información, me parece muy bien y lo vemos con el equipo." }));
    await t.learned();
    const { thread } = await t.received({ bodyText: "Hola, ¿podemos vernos el viernes por la mañana para hablar de la información del equipo?" });
    const es = await done(t.compose({ kind: "reply", threadId: thread, instruction: "say yes", session: "es" }));
    expect(es.used.language).toBe("es");
    const again = await t.received({ bodyText: "Hello, can we meet on Friday morning to talk about the update for the team?", from: { name: "Ana", email: "ana@acme.test" } });
    const en = await done(t.compose({ kind: "reply", threadId: again.thread, to: [TOM], instruction: "di que sí", session: "en" }));
    expect(en.used.language).toBe("en");
    const fresh = await done(t.compose({ session: "new" }));
    expect(fresh.used.language).toBe("en");
  });

  it("instructions layer general then account, or the account's alone, in system; mail only in the user turn", async () => {
    const t = await setup();
    await t.client.call("writing.prefs.set", { global: { instructions: "GENERAL-RULE" }, account: { accountId: t.account.id, prefs: { instructions: "ACCOUNT-RULE" } } });
    await t.received({ bodyText: "MAIL-WORDS please." });
    await done(t.compose({ session: "a" }));
    const system = JSON.stringify(last(t).system);
    expect(system).toContain("GENERAL-RULE");
    expect(system.indexOf("GENERAL-RULE")).toBeLessThan(system.indexOf("ACCOUNT-RULE"));
    await t.client.call("writing.prefs.set", { account: { accountId: t.account.id, prefs: { useGeneral: false } } });
    await done(t.compose({ session: "b" }));
    expect(JSON.stringify(last(t).system)).not.toContain("GENERAL-RULE");
    const { thread } = await t.received({ bodyText: "MAIL-WORDS please." });
    await done(t.compose({ kind: "reply", threadId: thread, session: "c" }));
    expect(JSON.stringify(last(t).system)).not.toContain("MAIL-WORDS");
    expect(JSON.stringify(last(t).messages)).toContain("MAIL-WORDS");
  });

  it("a small window holds its budget: the huge message keeps its start and end, the instruction and the draft's words stay", async () => {
    const t = await setup();
    await t.sentMany(20, (i) => ({ bodyText: `Some earlier long message ${i} `.repeat(200) }));
    await t.learned();
    const { thread } = await t.received({ bodyText: `THE-START ${"lorem ipsum ".repeat(50_000)} THE-END` });
    const r = await done(t.compose({ kind: "reply", threadId: thread, draft: "MY-OWN-WORDS", instruction: "MY-INSTRUCTION" }));
    const prompt = textOf(last(t));
    expect(prompt).toContain("MY-OWN-WORDS");
    expect(prompt).toContain("MY-INSTRUCTION");
    expect(prompt).toContain("THE-START");
    // the fake counts as local: an unknown local window
    expect(prompt.length).toBeLessThan(4096 * 4);
    expect(last(t).maxTokens).toBeLessThan(COMPOSE_MAX_TOKENS);
    expect(r.used.threadMessages).toBe(1);
  });

  it("a request that can't fit says so plainly and sends nothing", async () => {
    const t = await setup();
    await t.client.call("writing.prefs.set", { global: { instructions: "x".repeat(2000) } });
    const before = t.model.requests.length;
    const e = await errorOf(t.compose({ draft: "word ".repeat(10_000) }));
    expect(e.details?.aiErrorKind).toBe("unsupported");
    expect(t.model.requests.length).toBe(before);
  });

  it("never drafts a real answer from a snippet: it waits for the body, and a body too big to keep goes on with the snippet", async () => {
    const t = await setup();
    const { id, thread, m } = await t.received({ bodyText: null, bodyState: "none", snippet: "the snippet" });
    expect(await t.compose({ kind: "reply", threadId: thread })).toEqual({ status: "waitingBody", messageId: id });
    expect(t.model.requests).toEqual([]);
    await t.backend.store.sync.ingest([{ ...m, bodyText: "Here is the full text.", bodyState: "full" }], { applyFilters: false, now: t.clock.now, classifier: null });
    await done(t.compose({ kind: "reply", threadId: thread }));
    expect(textOf(last(t))).toContain("Here is the full text.");
    const big = await t.received({ bodyText: null, bodyState: "none", snippet: "too big to keep", size: 400 * 1024 * 1024 });
    const sources = await t.backend.store.aiSummaries.sources(big.thread);
    if (sources!.messages[0]!.bodyUnavailable) {
      const r = await done(t.compose({ kind: "reply", threadId: big.thread, session: "big" }));
      expect(r.used.inboundSnippetOnly).toBe(true);
    }
  });

  it("a thread gone is NOT_FOUND, an account gone too; off refuses", async () => {
    const t = await setup();
    expect((await errorOf(t.compose({ threadId: 999_999, kind: "reply" }))).code).toBe("NOT_FOUND");
    expect((await errorOf(t.compose({ accountId: 999_999 }))).code).toBe("NOT_FOUND");
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    expect((await errorOf(t.compose())).details?.aiErrorKind).toBe("not_configured");
    expect(t.model.requests).toEqual([]);
  });
});

describe("ai.compose: the refinement snapshot", () => {
  const session = async () => {
    const t = await setup();
    await t.sentMany(20);
    await t.learned();
    const { thread, m: first } = await t.received({});
    const reads = {
      thread: vi.spyOn(t.backend.store.writing, "threadContext"),
      sent: vi.spyOn(t.backend.store.writing, "sentTo"),
      profiles: vi.spyOn(t.backend.store.writing.profiles, "read"),
    };
    await done(t.compose({ kind: "reply", threadId: thread }));
    const count = () => reads.thread.mock.calls.length + reads.sent.mock.calls.length + reads.profiles.mock.calls.length;
    return { ...t, thread, first, count };
  };

  it("'Shorter' assembles nothing: same prefix, a new task", async () => {
    const t = await session();
    const before = t.count();
    const first = last(t);
    const r = await done(t.compose({ kind: "reply", threadId: t.thread, previousDraft: "Fine by me.", instruction: "Shorter. Keep every fact and commitment." }));
    expect(t.count()).toBe(before);
    expect(r.used.reused).toBe(true);
    const second = last(t);
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
    const parts = (req: CompletionRequest) => req.messages[0]!.content as { text: string }[];
    expect(parts(second).slice(0, -1)).toEqual(parts(first).slice(0, -1));
    expect(parts(second).at(-1)!.text).toContain("<previous_draft>");
  });

  it("a new message in the thread, new recipients, a changed signature or instructions assemble again", async () => {
    const t = await session();
    const again = async (over = {}) => {
      const before = t.count();
      const r = await done(t.compose({ kind: "reply", threadId: t.thread, ...over }));
      expect(r.used.reused).toBe(false);
      expect(t.count()).toBeGreaterThan(before);
    };
    await again({ to: [{ name: "Ana", email: "ana@acme.test" }] });
    await t.client.call("writing.prefs.set", { global: { instructions: "New rule" } });
    await again({ to: [{ name: "Ana", email: "ana@acme.test" }] });
    await t.backend.store.accounts.update(t.account.id, { signature: "New signature" } as never);
    await again({ to: [{ name: "Ana", email: "ana@acme.test" }] });
    // same recipients, same settings, one new message in the thread
    const before = t.count();
    const { thread } = await t.received({ inReplyTo: t.first.rfcMessageId, references: [t.first.rfcMessageId!], bodyText: "Something new", date: t.clock.now });
    expect(thread).toBe(t.thread);
    const r = await done(t.compose({ kind: "reply", threadId: t.thread, to: [{ name: "Ana", email: "ana@acme.test" }] }));
    expect(r.used.reused).toBe(false);
    expect(t.count()).toBeGreaterThan(before);
    expect(textOf(last(t))).toContain("Something new");
  });

  it("the session's end lets it go, a window closing too; it's bounded to a few sessions, and never big", async () => {
    const t = await session();
    await t.client.call("ai.composeEnd", { session: "s1" });
    const before = t.count();
    const r = await done(t.compose({ kind: "reply", threadId: t.thread }));
    expect(r.used.reused).toBe(false);
    expect(t.count()).toBeGreaterThan(before);
    for (let i = 0; i < 12; i++) await done(t.compose({ kind: "reply", threadId: t.thread, session: `other-${i}` }));
    const held = (t.backend.writing as unknown as { snapshots: Map<string, unknown> }).snapshots;
    expect(held.size).toBeLessThanOrEqual(8);
    t.backend.writing.disconnected("renderer");
    expect(held.size).toBe(0);
  });
});

describe("ai.compose: the stream", () => {
  it("reaches only the connection that asked, coalesced, in order, and the answer holds the same text", async () => {
    const t = await setup();
    const other = t.connect("other", "renderer");
    const mine: string[] = [];
    const theirs: string[] = [];
    const agents: string[] = [];
    t.client.on("aiCompose", (e) => mine.push(e.text));
    other.on("aiCompose", (e) => theirs.push(e.text));
    t.mcp.on("aiCompose", (e) => agents.push(e.text));
    t.model.stream = async function* () {
      yield { type: "delta", text: "<subject>A subject</subject><email>" };
      for (let i = 0; i < 40; i++) {
        yield { type: "delta", text: `word${i} ` };
        if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      yield { type: "delta", text: "</email>" };
      yield { type: "done", stop: "end", usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const r = await done(t.compose({ needsSubject: true }));
    expect(mine.join("").trim()).toBe(r.text);
    expect(mine.length).toBeLessThan(40);
    expect(mine.join("")).not.toContain("subject");
    expect(theirs).toEqual([]);
    expect(agents).toEqual([]);
    expect(r.subject).toBe("A subject");
    expect(r.stop).toBe("end");
  });

  it("two windows, each its own stream", async () => {
    const t = await setup();
    const other = t.connect("other", "renderer");
    const mine: string[] = [];
    const theirs: string[] = [];
    t.client.on("aiCompose", (e) => mine.push(e.text));
    other.on("aiCompose", (e) => theirs.push(e.text));
    t.model.stream = (req) => say(`<email>${textOf(req).includes("FROM-OTHER") ? "theirs" : "mine"}</email>`);
    await Promise.all([t.compose({ instruction: "first", requestId: "a" }), t.compose({ instruction: "FROM-OTHER", requestId: "b", session: "o" }, other)]);
    expect(mine.join("")).toBe("mine");
    expect(theirs.join("")).toBe("theirs");
  });

  it("flags what isn't in the sources, not what is; selects no placeholder itself and rewrites nothing", async () => {
    const t = await setup();
    const { thread } = await t.received({ bodyText: "Can we meet on 19 March at 10:30? Budget is $400." });
    t.model.stream = () => say("<email>Yes, 19 March works, and $400 is fine. I'll pay $900 by 2 April. Send it to [address].</email>");
    const r = await done(t.compose({ kind: "reply", threadId: thread, instruction: "say yes" }));
    expect(r.text).toContain("$900");
    const flagged = r.checks.specifics.map((f) => f.text).join(" ");
    expect(flagged).toContain("900");
    expect(flagged).toMatch(/2 April/);
    expect(flagged).not.toContain("19 March");
    expect(flagged).not.toContain("400");
    expect(r.checks.placeholders).toEqual(["[address]"]);
  });

  it("thinking out loud outside the tag never reaches the body", async () => {
    const t = await setup();
    const heard: string[] = [];
    t.client.on("aiCompose", (e) => heard.push(e.text));
    t.model.stream = () => say("no opener, lowercase, short.<email>that works</email>and more musing");
    const r = await done(t.compose());
    expect(r.text).toBe("that works");
    expect(heard.join("")).toBe("that works");
  });

  it("a refusal is a kind, length keeps the text, a connection lost keeps what came, and no request retries", async () => {
    const t = await setup();
    const heard: string[] = [];
    t.client.on("aiCompose", (e) => heard.push(e.text));
    t.model.stream = async function* () {
      yield { type: "done", stop: "refusal" };
    };
    expect((await errorOf(t.compose())).details?.aiErrorKind).toBe("refused");

    t.model.stream = async function* () {
      yield { type: "delta", text: "<email>cut" };
      yield { type: "done", stop: "length" };
    };
    expect(await done(t.compose())).toMatchObject({ text: "cut", stop: "length" });

    heard.length = 0;
    const before = t.model.requests.length;
    t.model.stream = async function* () {
      yield { type: "delta", text: "<email>partial words" };
      throw new AiError("The connection dropped.", "unavailable");
    };
    const e = await errorOf(t.compose());
    expect(e.details?.aiErrorKind).toBe("unavailable");
    expect(heard.join("")).toBe("partial words");
    expect(t.model.requests.length).toBe(before + 1);
  });

  it("no provider: a kind the row can act on, and nothing goes out", async () => {
    const t = await setup({ provider: "none" });
    await t.received({});
    const e = await errorOf(t.compose());
    expect(e.details?.aiErrorKind).toBe("not_configured");
    expect(t.model.requests).toEqual([]);
  });
});

describe("ai.compose: stopping", () => {
  const stalled = (t: Awaited<ReturnType<typeof setup>>) => {
    let reached: () => void;
    const at = new Promise<void>((resolve) => (reached = resolve));
    t.model.stream = async function* (req) {
      yield { type: "delta", text: "<email>some" };
      reached();
      await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    return at;
  };

  it("ai.cancel stops it, only from the connection that started it", async () => {
    const t = await setup();
    const at = stalled(t);
    const going = errorOf(t.compose({ requestId: "stop-me" }));
    await at;
    const other = t.connect("other", "renderer");
    await other.call("ai.cancel", { requestId: "stop-me" });
    await t.client.call("ai.cancel", { requestId: "stop-me" });
    expect((await going).code).toBe("CANCELLED");
  });

  it("a provider change stops it, and the next one goes to the new one", async () => {
    const t = await setup();
    const at = stalled(t);
    const going = errorOf(t.compose({ requestId: "p1" }));
    await at;
    await t.client.call("settings.update", { ai: { provider: "none" } });
    expect((await going).code).toBe("CANCELLED");
    const before = t.model.requests.length;
    expect((await errorOf(t.compose({ requestId: "p2" }))).details?.aiErrorKind).toBe("not_configured");
    expect(t.model.requests.length).toBe(before);
  });

  it("a window closing stops it", async () => {
    const t = await setup();
    const at = stalled(t);
    const other = t.connect("gone", "renderer");
    void other.call("ai.compose", { requestId: "gone-1", session: "x", accountId: t.account.id, kind: "new", to: [TOM], instruction: "x" }).catch(() => {});
    await at;
    let aborted = false;
    last(t).signal.addEventListener("abort", () => (aborted = true));
    t.backend.aiService.disconnected("gone");
    expect(aborted).toBe(true);
  });

  it("shutting down stops it", async () => {
    const t = await setup();
    const at = stalled(t);
    const going = errorOf(t.compose({ requestId: "q1" }));
    await at;
    t.backend.abort.abort();
    expect((await going).code).toBe("CANCELLED");
  });

  it("a foreground draft waits for nothing queued behind the background's share but the local model's own slot", async () => {
    const t = await setup();
    const voice = await t.backend.aiService.forTask("voice", { foreground: false });
    let free = () => {};
    const gate = new Promise<void>((resolve) => (free = resolve));
    t.model.answer = async () => {
      await gate;
      return { text: JSON.stringify({ recipient: null }), stop: "end" };
    };
    // one holds the local slot; others wait behind it
    const background = Array.from({ length: 4 }, () => voice.parseIntent({ instruction: "x", candidates: [{ id: "a", name: "A" }] }));
    for (let i = 0; i < 100 && t.model.requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(t.model.requests.length).toBe(1);
    t.model.stream = () => say("<email>right away</email>");
    const going = done(t.compose());
    await new Promise((resolve) => setTimeout(resolve, 10));
    free();
    await expect(going).resolves.toMatchObject({ text: "right away" });
    // first after the one running: ahead of everything the background had queued
    expect(textOf(t.model.requests[1]!)).toContain(WRITING_RULES.slice(0, 40));
    await Promise.all(background);
  });
});

describe("a permission taken back (plan 133 review)", () => {
  /** a draft in flight that only ends when it's aborted */
  const holding = (t: Awaited<ReturnType<typeof setup>>) => {
    t.model.stream = async function* (req) {
      await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new AiError("stopped", "cancelled")), { once: true }));
      yield { type: "done", stop: "end" };
    };
  };

  it("drafting turned off stops a draft at the provider, and it isn't returned", async () => {
    const t = await setup();
    holding(t);
    const asked = errorOf(t.compose());
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    expect(t.model.requests[0]!.signal.aborted).toBe(true);
    await expect(asked).resolves.toMatchObject({ code: "CANCELLED" });
  });

  it("a model that ignores the abort still doesn't get its answer returned", async () => {
    const t = await setup();
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    t.model.stream = async function* () {
      await finished;
      yield* say("<email>Too late.</email>");
    };
    const asked = errorOf(t.compose());
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    finish();
    await expect(asked).resolves.toMatchObject({ code: "CANCELLED" });
  });

  it("drafting turned off stops a 'who is this for' at the provider", async () => {
    const t = await setup();
    const { thread } = await t.received({ from: { name: "Bea", email: "bea@acme.test" }, to: [{ name: "Tom Reed", email: "tom@acme.test" }, { name: "Me", email: t.account.email }] });
    t.model.answer = (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new AiError("stopped", "cancelled")), { once: true }));
    const asked = errorOf(t.client.call("ai.resolveIntent", { requestId: t.requestId(), instruction: "tell tom it's fine", surface: { kind: "thread", threadId: thread }, waitForContacts: true }));
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    expect(t.model.requests[0]!.signal.aborted).toBe(true);
    await expect(asked).resolves.toMatchObject({ code: "CANCELLED" });
  });

  it("learning turned off for one account stops that account's draft and leaves the other's", async () => {
    const t = await setup({ accounts: 2 });
    const [a, b] = t.accounts;
    holding(t);
    const first = errorOf(t.compose({ accountId: a!.id, session: "a" }));
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    // this model takes one request at a time: the other account's waits its turn
    const second = errorOf(t.compose({ accountId: b!.id, session: "b" }));
    await t.client.call("writing.prefs.set", { account: { accountId: a!.id, prefs: { useSentMail: false } } });
    expect(t.model.requests[0]!.signal.aborted).toBe(true);
    await expect(first).resolves.toMatchObject({ code: "CANCELLED" });
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(2));
    expect(t.model.requests[1]!.signal.aborted).toBe(false);
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    await expect(second).resolves.toMatchObject({ code: "CANCELLED" });
  });

  it("a learning change that takes nothing back aborts nothing", async () => {
    const t = await setup();
    holding(t);
    const asked = errorOf(t.compose());
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(1));
    await t.client.call("writing.prefs.set", { global: { instructions: "Be short" } });
    expect(t.model.requests[0]!.signal.aborted).toBe(false);
    await t.client.call("writing.prefs.set", { global: { enabled: false } });
    await asked;
  });
});

describe("clearing what was learned (plan 133 review)", () => {
  /** what's only in a profile: the study's notes, which reach a draft's prompt through nothing else */
  const NOTE = "note: Answers first";
  const studied = async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    await t.client.call("writing.studyStyle", { requestId: "st", confirm: { provider: "fake", accountIds: [t.account.id] } });
    await vi.waitFor(async () => expect((await t.client.call("writing.profiles.list", { scope: "you" })).items[0]?.judgment).toBeTruthy());
    await t.backend.writing.learner.idle();
    return t;
  };

  it("Clear from another window leaves no copy in this window's draft session", async () => {
    const t = await studied();
    await done(t.compose());
    expect(textOf(last(t))).toContain(NOTE);
    expect((await done(t.compose())).used.reused).toBe(true);
    await t.connect("other-window", "renderer").call("writing.profiles.clear", {});
    const after = await done(t.compose());
    expect(after.used.reused).toBe(false);
    expect(textOf(last(t))).not.toContain(NOTE);
  });

  it("Reset does too", async () => {
    const t = await studied();
    await done(t.compose());
    expect((await done(t.compose())).used.reused).toBe(true);
    await t.connect("other-window", "renderer").call("writing.profiles.reset", { scopeKey: "you" });
    expect((await done(t.compose())).used.reused).toBe(false);
  });

  it("an assembly under way when Clear comes starts over rather than keep what it read", async () => {
    const t = await studied();
    const real = t.backend.store.writing.sentTo.bind(t.backend.store.writing);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reading!: () => void;
    const started = new Promise<void>((r) => (reading = r));
    // past the voice levels, which it has read by now, and not yet done
    vi.spyOn(t.backend.store.writing, "sentTo").mockImplementationOnce(async (p) => {
      reading();
      await held;
      return real(p);
    });
    const composing = done(t.compose());
    await started;
    await t.client.call("writing.profiles.clear", {});
    release();
    await composing;
    expect(textOf(last(t))).not.toContain(NOTE);
    const next = await done(t.compose());
    expect(next.used.reused).toBe(true);
    expect(textOf(last(t))).not.toContain(NOTE);
  });
});

describe("a reset undone (plan 161)", () => {
  const studied = async () => {
    const t = await setup();
    await t.sentMany(30);
    await t.learned();
    await t.client.call("writing.studyStyle", { requestId: "st", confirm: { provider: "fake", accountIds: [t.account.id] } });
    await vi.waitFor(async () => expect((await t.client.call("writing.profiles.list", { scope: "you" })).items[0]?.judgment).toBeTruthy());
    await t.backend.writing.learner.idle();
    return t;
  };
  const yours = async (t: Awaited<ReturnType<typeof setup>>) => (await t.client.call("writing.profiles.list", { scope: "you" })).items.map(({ updatedAt: _u, ...p }) => p);

  it("puts back exactly what went, the study's judgment too, after the rebuild the reset started (Codex review)", async () => {
    const t = await studied();
    const before = await yours(t);
    const [p] = before;
    // the rebuild the reset starts is held at its commit, so the Undo comes before it lands
    const real = t.backend.store.writing.profiles.commit.bind(t.backend.store.writing.profiles);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(t.backend.store.writing.profiles, "commit").mockImplementation(async (c) => {
      await held;
      return real(c);
    });
    const { undo } = await t.client.call("writing.profiles.reset", { scopeKey: p!.scopeKey, language: p!.language });
    const restoring = t.client.call("writing.profiles.restore", { undo });
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await restoring).restored).toBe(true);
    await t.backend.writing.learner.idle();
    expect(await yours(t)).toEqual(before);
    // once
    expect((await t.client.call("writing.profiles.restore", { undo })).restored).toBe(false);
  });

  it("Clear all takes a reset's copy with it: its Undo brings nothing back (Codex review)", async () => {
    const t = await studied();
    const [p] = await yours(t);
    const { undo } = await t.client.call("writing.profiles.reset", { scopeKey: p!.scopeKey, language: p!.language });
    await t.client.call("writing.profiles.clear", {});
    expect((await t.client.call("writing.profiles.restore", { undo })).restored).toBe(false);
    expect(await yours(t)).toEqual([]);
  });
});

describe("ai.resolveIntent", () => {
  const ask = (t: Awaited<ReturnType<typeof setup>>, instruction: string, surface: unknown, over = {}) => t.client.call("ai.resolveIntent", { requestId: t.requestId(), instruction, surface: surface as never, waitForContacts: true, ...over });

  it("a person on the thread who also sent last makes no model call, whoever else in the contacts shares the name", async () => {
    const t = await setup();
    await t.sent({ to: [{ name: "Ana Other", email: "ana@elsewhere.test" }] });
    const { thread } = await t.received({ from: { name: "Ana López", email: "ana@acme.test" }, to: [{ name: "Me", email: t.account.email }] });
    const r = await ask(t, "tell ana it's fine", { kind: "thread", threadId: thread });
    expect(r.decision).toMatchObject({ kind: "route", route: { type: "reply", to: { address: "ana@acme.test" } } });
    expect(t.model.requests).toEqual([]);
  });

  it("a participant in the thread: replying to them, in English and Spanish; only one call, instruction and names at most", async () => {
    const t = await setup();
    const canary = "canary-in-the-thread-body";
    await t.received({ from: { name: "Ana López", email: "ana@acme.test" }, to: [{ name: "Tom Reed", email: "tom@acme.test" }, { name: "Me", email: t.account.email }], bodyText: canary, providerMsgId: "t1", rfcMessageId: "t1@test" });
    const { thread } = await t.received({ from: { name: "Bea", email: "bea@acme.test" }, to: [{ name: "Me", email: t.account.email }], bodyText: canary, providerMsgId: "t2", rfcMessageId: "t2@test", inReplyTo: "t1@test", references: ["t1@test"] });
    t.model.answer = (req) => {
      const people = JSON.parse(/^People: (.*)$/m.exec(req.messages[0]!.content as string)?.[1] ?? "[]") as { id: string }[];
      return { text: JSON.stringify({ recipient: people[0]!.id }), stop: "end" };
    };
    for (const sentence of ["tell tom that this is just fine", "dile a tom que está bien"]) {
      const r = await ask(t, sentence, { kind: "thread", threadId: thread });
      expect(r.decision).toMatchObject({ kind: "route", route: { type: "reply", to: { address: "tom@acme.test" }, includeEveryone: 3 } });
      const prompt = textOf(last(t));
      expect(prompt).not.toContain(canary);
      expect(prompt).toContain(sentence);
    }
    expect(t.model.requests.length).toBe(2);
  });

  it("'Mark the invoice as paid' with a participant Mark addresses nobody; when the model can't say, the route stays and the row says so", async () => {
    const t = await setup();
    const { thread } = await t.received({ from: { name: "Bea", email: "bea@acme.test" }, to: [{ name: "Mark", email: "mark@acme.test" }, { name: "Me", email: t.account.email }] });
    t.model.answer = () => ({ text: JSON.stringify({ recipient: null }), stop: "end" });
    const r = await ask(t, "Mark the invoice as paid", { kind: "thread", threadId: thread });
    expect(r.decision).toMatchObject({ kind: "route", route: { type: "reply", to: null, answering: "bea@acme.test" } });
    expect(r.confirmFailed).toBe(false);
    t.model.answer = () => {
      throw new AiError("nope", "unavailable");
    };
    const failed = await ask(t, "Mark the invoice as paid", { kind: "thread", threadId: thread });
    expect(failed.confirmFailed).toBe(true);
    expect(failed.decision).toMatchObject({ kind: "route", route: { type: "reply", to: null } });
  });

  it("someone not on the thread is a question, never a default; from the list, a recent thread is a question too", async () => {
    const t = await setup();
    await t.sent({ to: [{ name: "Zoe Quinn", email: "zoe@far.test" }], date: t.clock.now - 60_000, subject: "Recent one" });
    await t.backend.warmAutocomplete();
    const { thread } = await t.received({ from: { name: "Bea", email: "bea@acme.test" } });
    t.model.answer = (req) => ({ text: JSON.stringify({ recipient: (JSON.parse(/^People: (.*)$/m.exec(req.messages[0]!.content as string)![1]!) as { id: string }[])[0]!.id }), stop: "end" });
    const onThread = await ask(t, "tell zoe it's fine", { kind: "thread", threadId: thread });
    expect(onThread.decision).toMatchObject({ kind: "ask", question: { type: "forward-or-new", to: { address: "zoe@far.test" } } });
    const fromList = await ask(t, "tell zoe it's fine", { kind: "list" });
    expect(fromList.decision).toMatchObject({ kind: "ask", question: { type: "new-or-reply", to: { address: "zoe@far.test", name: "Zoe Quinn" }, thread: { subject: "Recent one" } } });
    expect(fromList.fromAccountId).toBe(t.account.id);
    t.clock.now += 40 * 86_400_000;
    const later = await ask(t, "tell zoe it's fine", { kind: "list" });
    expect(later.decision).toMatchObject({ kind: "route", route: { type: "new", to: { address: "zoe@far.test" } } });
  });

  it("an address is taken as is, with no call; a draft's recipients don't move; nobody asks who", async () => {
    const t = await setup();
    const direct = await ask(t, "write to nora@elsewhere.test about it", { kind: "list" });
    expect(direct.decision).toMatchObject({ kind: "route", route: { type: "new", to: { address: "nora@elsewhere.test" } } });
    const kept = await ask(t, "just say hi", { kind: "draft", recipients: [TOM] });
    expect(kept.decision).toMatchObject({ kind: "route", route: { type: "keep-draft" } });
    const who = await ask(t, "just say hi", { kind: "list" });
    expect(who.decision).toMatchObject({ kind: "ask", question: { type: "who" } });
    expect(t.model.requests).toEqual([]);
  });

  it("a cold index says wait, not 'nobody'; asked again with waitForContacts it answers when warm, with nothing polling", async () => {
    const t = await setup();
    await t.sent({ to: [{ name: "Zoe Quinn", email: "zoe@far.test" }] });
    const cold = await t.client.call("ai.resolveIntent", { requestId: "c1", instruction: "tell zoe it's fine", surface: { kind: "list" } });
    expect(cold.decision).toMatchObject({ kind: "wait" });
    expect((cold.decision as { tokens: string[] }).tokens).toContain("zoe");
    t.model.answer = (req) => ({ text: JSON.stringify({ recipient: (JSON.parse(/^People: (.*)$/m.exec(req.messages[0]!.content as string)![1]!) as { id: string }[])[0]!.id }), stop: "end" });
    const warm = await ask(t, "tell zoe it's fine", { kind: "list" });
    expect(warm.decision.kind).not.toBe("wait");
  });
});

describe("nothing reaches MCP, bootstrap, account events, diagnostics or the logger", () => {
  const CANARY = "canary-7f3a";
  const METHODS: [string, unknown][] = [
    ["ai.compose", { requestId: "m1", session: "s", accountId: 1, kind: "new", to: [TOM] }],
    ["ai.composeEnd", { session: "s" }],
    ["ai.resolveIntent", { requestId: "m2", instruction: "x", surface: { kind: "list" } }],
    ["writing.activate", {}],
    ["writing.prefs.get", {}],
    ["writing.prefs.set", { global: { enabled: false } }],
    ["writing.profiles.list", {}],
    ["writing.profiles.edit", { scopeKey: "you", phrases: [] }],
    ["writing.profiles.reset", { scopeKey: "you" }],
    ["writing.profiles.rebuild", {}],
    ["writing.profiles.clear", {}],
    ["writing.studyStyle", { requestId: "m3" }],
    ["writing.commitGeneration", { accountId: 1, draftId: 1, draftGeneration: "x", address: "a@x.test", text: "x" }],
  ];

  it("MCP can call none of it", async () => {
    const t = await setup();
    for (const [method, params] of METHODS) expect((await errorOf(t.mcp.call(method as never, params as never))).code).toBe("FORBIDDEN");
  });

  it("prompts and profiles stay out of bootstrap, the export, events, the logs and diagnostics, on the good path and when it goes wrong", async () => {
    const t = await setup();
    const records: unknown[] = [];
    setDiagSink({ write: (entry) => void records.push(entry), capture: (record) => void records.push(record) });
    const events: string[] = [];
    for (const name of ["accounts", "changed", "aiCompose", "aiStudy", "counts", "drafts"] as const) t.mcp.on(name, (e) => events.push(JSON.stringify(e)));
    const accounts: string[] = [];
    t.client.on("accounts", (e) => accounts.push(JSON.stringify(e)));
    await t.client.call("writing.prefs.set", { global: { instructions: `${CANARY}-instruction` }, account: { accountId: t.account.id, prefs: { instructions: `${CANARY}-account` } } });
    await t.sentMany(30, (i) => ({ bodyText: `Thanks ${CANARY}-sent-mail ${i}, sounds good to me.`, to: [{ name: "Ana", email: `p${i % 3}@else.test` }] }));
    await t.learned();
    await t.backend.store.writing.profiles.edit({ scopeKey: `account:${t.account.id}`, language: "", phrasesJson: JSON.stringify([`${CANARY}-phrase`]), now: START });
    const { thread } = await t.received({ bodyText: `${CANARY}-thread`, subject: "Hi" });

    // the good path
    t.model.stream = () => say(`<email>Draft says ${CANARY}-output</email>`);
    await done(t.compose({ kind: "reply", threadId: thread, instruction: `${CANARY}-oneoff` }));
    expect(textOf(last(t))).toContain(`${CANARY}-thread`);

    // the model's output malformed, the stream failing in every way, each error carrying the prompt's words
    t.model.answer = () => ({ text: `not json ${CANARY}-bad-output`, stop: "end" });
    t.model.stream = async function* () {
      yield { type: "delta", text: "<email>x" };
      throw new AiError(`${CANARY}-provider-says`, "unavailable");
    };
    await errorOf(t.compose({ session: "s2", instruction: `${CANARY}-oneoff` }));
    t.model.stream = async function* () {
      yield { type: "delta", text: "<email>x" };
      throw new Error(`${CANARY}-raw-error`);
    };
    const raw = await errorOf(t.compose({ session: "s3", instruction: `${CANARY}-oneoff` }));
    expect(raw.message).not.toContain(CANARY);
    t.model.stream = () => {
      throw new TypeError(`${CANARY}-thrown`);
    };
    await errorOf(t.compose({ session: "s4" }));
    await t.client.call("writing.studyStyle", { requestId: "st", confirm: { provider: "fake", accountIds: [t.account.id] } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.client.call("ai.resolveIntent", { requestId: "rs", instruction: `tell ${CANARY}-who@x.test`, surface: { kind: "list" }, waitForContacts: true });

    const bootstrap = JSON.stringify(await t.client.call("app.bootstrap", {}));
    const mcpBootstrap = JSON.stringify(await t.mcp.call("app.bootstrap", {}));
    const exported = JSON.stringify(await t.client.call("app.export", {}));
    setDiagSink(undefined);
    expect(records.length).toBeGreaterThan(0);
    const report = JSON.stringify(records);
    for (const [what, text] of Object.entries({ bootstrap, mcpBootstrap, exported, logs: t.logs.join("\n"), events: events.join("\n"), accounts: accounts.join("\n"), report })) expect(text, what).not.toContain(CANARY);
  });

  it("a learner that trips over something reports where, never what it was reading", () => {
    const parser = new SyntaxError(`Unexpected token '${CANARY}' is not valid JSON`);
    const out = scrubbed(parser);
    expect(`${out.name} ${out.message} ${out.stack}`).not.toContain(CANARY);
    expect(out.message).toBe("SyntaxError");
    expect(out.stack).toContain(" at ");
    expect(scrubbed(new AiError(`${CANARY} provider words`, "refused")).message).toBe("AiError:refused");
  });

  it("nothing about drafting lives in AppSettings or an account's DTO", async () => {
    const t = await setup();
    await t.client.call("writing.prefs.set", { global: { instructions: "PREFS-WORDS" } });
    const boot = await t.client.call("app.bootstrap", {});
    expect(JSON.stringify(boot)).not.toContain("PREFS-WORDS");
    expect(Object.keys(boot.settings).filter((k) => /writing|drafting|voice/i.test(k))).toEqual([]);
    expect(Object.keys(boot.accounts[0]!).filter((k) => /writing|voice|instruction/i.test(k))).toEqual([]);
    expect(await t.backend.store.settings.get(PREFS_KEY, null)).not.toBeNull();
  });

  it("no provider and no study means no network at all, and plan 157: nothing counted either", async () => {
    const t = await setup({ provider: "none" });
    await t.sentMany(30);
    await t.learned();
    expect(t.model.requests).toEqual([]);
    expect(await t.backend.store.settings.get(STUDY_KEY, null)).toBeNull();
    expect(await t.backend.store.writing.profiles.list({ limit: 5 })).toEqual([]);
  });
});

describe("provenance (§8)", () => {
  const drafted = async (t: Awaited<ReturnType<typeof setup>>, text: string, subject = "Hello") => {
    const draft = (await t.backend.store.drafts.save({ accountId: t.account.id, subject, bodyText: `${text}\n\n-- \nSignature`, to: [TOM], cc: [], bcc: [], mode: "new" } as never, t.clock.now))!;
    expect(await t.client.call("writing.commitGeneration", { accountId: t.account.id, draftId: draft.id, draftGeneration: draft.generation ?? "", address: TOM.email, text })).toEqual({ ok: true });
    return { draft, send: { accountId: t.account.id, to: [TOM], subject, draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision } };
  };

  it("a commit to a draft gone or of another generation is refused, with no error for the writer", async () => {
    const t = await setup();
    expect(await t.client.call("writing.commitGeneration", { accountId: t.account.id, draftId: 999_999, draftGeneration: "x", address: TOM.email, text: "Hi" })).toEqual({ ok: false });
  });

  it("the signature and quote don't make it edited, nor do line endings; HTML is compared as authored text", async () => {
    const t = await setup();
    const { send } = await drafted(t, "Hi Tom,\n\nThat works.");
    const { messageId } = await t.client.call("compose.send", { ...send, bodyText: "Hi Tom,\n\nThat works.\n\n-- \nSignature\n\nOn Friday Tom wrote:\n> quote", bodyHtml: "<div>Hi Tom,</div><div><br></div><div>That works.</div><blockquote>quote</blockquote>", authoredText: "Hi Tom,\r\n\r\nThat works.\n" });
    expect(await t.backend.store.writing.generations.forMessage(messageId)).toMatchObject({ final: null });
    expect(await t.backend.store.writing.corpus.usable([messageId])).toEqual([]);
  });

  it("a real edit is a pair, kept, and the message counts as the user's", async () => {
    const t = await setup();
    const { send } = await drafted(t, "Hi Tom,\n\nThat works.");
    const { messageId } = await t.client.call("compose.send", { ...send, bodyText: "Tom, that works!", authoredText: "Tom, that works!" });
    expect(await t.backend.store.writing.generations.forMessage(messageId)).toMatchObject({ generated: "Hi Tom,\n\nThat works.", final: "Tom, that works!" });
    expect(await t.backend.store.writing.corpus.usable([messageId])).toEqual([messageId]);
  });

  it("an agent can't speak for what was typed: it reads as the model's", async () => {
    const t = await setup();
    await t.client.call("settings.update", { allowAgentSend: true });
    const { send } = await drafted(t, "Hi Tom.");
    const { messageId } = await t.mcp.call("compose.send", { ...send, bodyText: "Hi Tom.", authoredText: "Something else entirely" });
    expect(await t.backend.store.writing.generations.forMessage(messageId)).toMatchObject({ final: null });
  });

  it("travels through Send Later, across a restart", async () => {
    const t = await setup({ keep: true });
    const { send, draft } = await drafted(t, "Hi Tom,\n\nThat works.");
    const later = t.clock.now + 3600_000;
    await t.client.call("compose.schedule", { ...send, bodyText: "Tom, that works!\n\n-- \nSignature", authoredText: "Tom, that works!", sendAt: later, draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision });
    expect(await t.backend.store.writing.generations.forDraft(draft.id)).toMatchObject({ generated: "Hi Tom,\n\nThat works." });
    await t.stop();
    const again = await setup({ dir: t.dir });
    again.clock.now = later + 1;
    await again.backend.scheduled.refresh();
    const pairs = await again.backend.store.writing.generations.pairs({ accountId: again.account.id, limit: 5 });
    expect(pairs).toEqual([{ generated: "Hi Tom,\n\nThat works.", final: "Tom, that works!", address: TOM.email, at: later + 1 }]);
  });

  it("discarding a draft keeps no text", async () => {
    const t = await setup();
    const { draft } = await drafted(t, "Hi Tom.");
    await t.client.call("drafts.delete", { id: draft.id, generation: draft.generation ?? "" });
    expect(await t.backend.store.writing.generations.forDraft(draft.id)).toBeNull();
  });

  it("corrections only count when repeated, at the narrowest level they fit, and back off when they stop", async () => {
    const t = await setup();
    await t.sentMany(30, (i) => ({ to: [{ name: "Tom", email: i % 2 ? TOM.email : "ana@acme.test" }] }));
    await t.learned();
    const generated = "Hi Tom,\n\nThat works, thanks for sending it over to me today!";
    const correct = async (to: typeof TOM, i: number, final: string) => {
      const draft = (await t.backend.store.drafts.save({ accountId: t.account.id, subject: `C${i}`, bodyText: "x", to: [to], cc: [], bcc: [], mode: "new" } as never, t.clock.now))!;
      await t.client.call("writing.commitGeneration", { accountId: t.account.id, draftId: draft.id, draftGeneration: draft.generation ?? "", address: to.email, text: generated });
      t.clock.now += 1000;
      await t.client.call("compose.send", { accountId: t.account.id, to: [to], subject: `C${i}`, bodyText: final, draftId: draft.id, draftGeneration: draft.generation ?? "", draftRevision: draft.revision, authoredText: final });
    };
    const promptTo = async (to: typeof TOM, session: string) => {
      await done(t.compose({ to: [to], session }));
      return JSON.stringify(last(t).messages);
    };
    await correct(TOM, 1, "That works, thanks for sending it over to me today!");
    await correct(TOM, 2, "That works, thanks for sending it over to me today!");
    expect(await promptTo(TOM, "twice")).not.toContain("remove the greeting");
    await correct(TOM, 3, "That works, thanks for sending it over to me today!");
    const third = await promptTo(TOM, "thrice");
    expect(third).toContain("they remove the greeting (3 times)");
    expect(third).toContain('<voice scope=\\"person\\"');
    // to Tom, and only to Tom, it's about Tom; once everyone's getting it, it's about the account
    expect(await promptTo({ name: "Ana", email: "ana@acme.test" }, "ana-1")).toContain("they remove the greeting (3 times)");
    for (let i = 4; i < 10; i++) await correct(TOM, i, "Hi Tom,\n\nThat works, thanks for sending it over to me today.");
    // six newer without it: it stopped recurring, so it's gone
    expect(await promptTo(TOM, "stopped")).not.toContain("remove the greeting");
    expect(WRITING_RULES).not.toContain("remove the greeting");
  });
});
