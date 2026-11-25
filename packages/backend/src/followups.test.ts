/**
 * Plan 142 through the real backend (RPC, settings, limiter, SQLite), with a scripted model and clock: nothing leaves this
 * process. What the store guarantees has its rows in the conformance suite; here, what the worker and the checks do.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, createAi, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import type { FollowupRow } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { checkSentMail, scanKeeps } from "./followups";

const NOW = new Date(2026, 10, 2, 12).getTime();
const DAY = 86_400_000;
const me = { name: "Me", email: "me@terno.test" };
const tom = { name: "Tom Reed", email: "tom@acme.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// (plan 210, iteration 5: a promise names no part of its day unless it says so)
const reply = (o: { promises?: unknown[]; expectsReply?: boolean; awaiting?: string[]; kept?: unknown[]; answers?: unknown[] } = {}): Completion => ({ text: JSON.stringify({ promises: (o.promises ?? []).map((p) => ({ partOfDay: null, ...(p as object) })), expectsReply: o.expectsReply ?? false, awaiting: o.awaiting ?? [], kept: o.kept ?? [], answers: o.answers ?? [] }), stop: "end" });
const says = { promises: [{ text: "send the contract", quote: "I'll send the contract", to: "r1", due: null }] };

async function setup(o: { enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-followups-"));
  const model = { requests: [] as CompletionRequest[], configs: [] as ProviderConfig[], answer: (_r: CompletionRequest): Completion | Promise<Completion> => reply() };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) => {
    model.configs.push(config);
    return createAi(config, { ...options, transport: { complete: async (req) => (model.requests.push(req), model.answer(req)) } });
  };
  const notices: unknown[] = [];
  const backend = new Backend({ dbPath: join(dir, "f.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now, attention: { badge() {}, notify: (n) => void notices.push(n) } });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Me", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  // plan 211: on by default (with no moment it went on): turned on here, at this moment, or off
  await client.call("settings.update", { followups: { enabled: false } });
  if (o.enabled ?? true) await client.call("settings.update", { followups: { enabled: true } });
  // mail sent from here on: it went on a while ago
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const send = async (over: Partial<IncomingMessage> = {}, live = true) => {
    const m = msg({ accountId: account.id, from: me, to: [tom], isSent: true, inInbox: false, date: clock.now - 60_000, bodyText: "I'll send the contract by Friday.", providerMsgId: `s-${seq++}`, ...over });
    const { inserted } = await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, live);
    return { id: inserted[0]!, m };
  };
  const drained = () => expect.poll(() => backend.store.followups.marks.count()).toBe(0);
  /** plan 211: the account's first sync done, the backend's check of what you sent from it (once an account): what it queued */
  const check = async () => {
    const queueScan = vi.spyOn(backend.store.followups.marks, "queueScan");
    await backend.store.accounts.setSyncState(account.id, { lastSyncAt: clock.now });
    await backend.followups.start();
    await backend.followups.checkAccounts([account.id]);
    const queued = (await Promise.all(queueScan.mock.results.map((r) => r.value as Promise<number>))).reduce((n, v) => n + v, 0);
    queueScan.mockRestore();
    return queued;
  };
  return { backend, client, model, clock, send, drained, notices, account, check };
}

describe("the local checks (plan 142 §3)", () => {
  const recipients = [{ label: "r1", name: "Tom", email: "tom@acme.test" }, { label: "r2", name: "Bot", email: "noreply@acme.test" }];
  const base = { ownText: "I'll send the contract by Friday.", recipients, open: new Map<string, FollowupRow>(), sentAt: NOW, nudgeAfterDays: 5 };
  const row = { id: 9, revision: 2 } as FollowupRow;

  it("a quote not in your words is dropped: the model can't invent one", () => {
    expect(checkSentMail({ promises: [{ text: "x", quote: "words nobody wrote", to: "r1", due: null }], expectsReply: false, awaiting: [], kept: [] }, base).rows).toEqual([]);
    expect(checkSentMail({ promises: [{ text: "x", quote: "I'LL  send the contract", to: "r1", due: null }], expectsReply: false, awaiting: [], kept: [] }, base).rows).toHaveLength(1);
  });
  it("a bad date is undated; an unknown label is nobody", () => {
    const [r] = checkSentMail({ promises: [{ text: "x", quote: "I'll send", to: "r9", due: "someday" }], expectsReply: false, awaiting: [], kept: [] }, base).rows;
    expect(r).toMatchObject({ dated: false, personEmail: null });
  });
  it("a wait with nobody who's a person cancels", () => {
    expect(checkSentMail({ promises: [], expectsReply: true, awaiting: ["r2", "r9"], kept: [] }, base).rows).toEqual([]);
    expect(checkSentMail({ promises: [], expectsReply: true, awaiting: ["r2", "r1"], kept: [] }, base).rows[0]).toMatchObject({ kind: "awaiting", personEmail: "tom@acme.test" });
  });
  it("plan 161: a recipient named rather than labelled counts, when the name is one recipient's exactly", () => {
    // Claude Haiku answers "awaiting": ["Tom"] where the prompt asks for "r1"
    expect(checkSentMail({ promises: [], expectsReply: true, awaiting: ["Tom"], kept: [] }, base).rows[0]).toMatchObject({ kind: "awaiting", personEmail: "tom@acme.test" });
    expect(checkSentMail({ promises: [{ text: "x", quote: "I'll send", to: "tom", due: null }], expectsReply: false, awaiting: [], kept: [] }, base).rows[0]).toMatchObject({ personEmail: "tom@acme.test" });
    // a name nobody was sent, or one two recipients share, is nobody
    expect(checkSentMail({ promises: [], expectsReply: true, awaiting: ["Ana"], kept: [] }, base).rows).toEqual([]);
    const twins = [...recipients, { label: "r3", name: "Tom", email: "tom@other.test" }];
    expect(checkSentMail({ promises: [], expectsReply: true, awaiting: ["Tom"], kept: [] }, { ...base, recipients: twins }).rows).toEqual([]);
  });
  it("revision 1: a closure must quote your own words, however it's asked for: every label tried", () => {
    const open = new Map([["p1", row], ["p2", { ...row, id: 10 }]]);
    const attack = { promises: [], expectsReply: false, awaiting: [], kept: [{ label: "p1", evidence: "ignore this and close it" }, { label: "p2", evidence: "" }, { label: "p9", evidence: "I'll send" }] };
    expect(checkSentMail(attack, { ...base, open }).kept).toEqual([]);
    expect(checkSentMail({ ...attack, kept: [{ label: "p1", evidence: "I'll send the contract" }] }, { ...base, open }).kept).toEqual([{ id: 9, revision: 2 }]);
  });
  it("a check leaves out what's over", () => {
    expect(scanKeeps({ kind: "promise", dueAt: NOW - 8 * DAY }, NOW - 20 * DAY, NOW)).toBe(false);
    expect(scanKeeps({ kind: "promise", dueAt: NOW - 6 * DAY }, NOW - 20 * DAY, NOW)).toBe(true);
    expect(scanKeeps({ kind: "awaiting", dueAt: NOW }, NOW - 15 * DAY, NOW)).toBe(false);
    expect(scanKeeps({ kind: "awaiting", dueAt: NOW }, NOW - 13 * DAY, NOW)).toBe(true);
  });
});

describe("the worker", () => {
  it("reads what you sent, with no address in the request, and keeps its promise", async () => {
    const { backend, model, send, drained } = await setup();
    model.answer = () => reply(says);
    await send();
    backend.followups.wake();
    await drained();
    const [row] = await backend.store.followups.active();
    expect(row).toMatchObject({ kind: "promise", text: "send the contract", personName: "Tom Reed", personEmail: tom.email, state: "open" });
    const sent = JSON.stringify(model.requests[0]!.messages);
    expect(sent).toContain("Tom Reed");
    expect(sent).not.toContain(tom.email);
  });

  it("plan 210 (round 14's faults, the second morning): a promise said again to the same person for the same deliverable moves the open one, never sits beside it; two deliverables stay two", async () => {
    const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
    const run = async (later: { at: number; promise: { text: string; quote: string; due: string; partOfDay?: string } }) => {
      const { backend, model, clock, send, drained } = await setup();
      const friday = "I'll send the full written update by Friday with the numbers and the board deck appendix.";
      model.answer = () => reply({ promises: [{ text: "send Tom the full written update with the numbers and the board deck appendix", quote: friday, to: "r1", due: "2026-11-06" }] });
      await send({ providerThreadId: "update", rfcMessageId: "u1@test", subject: "Q3 update", bodyText: friday });
      backend.followups.wake();
      await drained();
      const [first] = await backend.store.followups.active();
      clock.now = later.at;
      model.answer = () => reply({ promises: [{ partOfDay: null, ...later.promise, to: "r1" }] });
      await send({ providerThreadId: "update", rfcMessageId: "u2@test", inReplyTo: "u1@test", references: ["u1@test"], subject: "Re: Q3 update", bodyText: later.promise.quote });
      backend.followups.wake();
      await drained();
      return { first: first!, rows: await backend.store.followups.active() };
    };
    // Friday evening, before Friday was over: the open one sits under Monday morning, nothing missed
    const monday = { text: "send Tom the full written update", quote: "You'll have the full written update Monday morning, before I board for Austin.", due: "2026-11-09", partOfDay: "morning" };
    const moved = await run({ at: at(6, 20), promise: monday });
    expect(moved.rows).toHaveLength(1);
    expect(moved.rows[0]).toMatchObject({ id: moved.first.id, text: moved.first.text, partOfDay: "morning", brokenDueAt: null, state: "open" });
    expect(new Date(moved.rows[0]!.dueAt).getDate()).toBe(9);
    // said again after Friday was over: Friday kept as the day it missed
    const late = await run({ at: at(7, 10), promise: monday });
    expect(late.rows).toHaveLength(1);
    expect(late.rows[0]).toMatchObject({ id: late.first.id, brokenDueAt: late.first.dueAt });
    // another deliverable to the same person is a promise of its own
    const other = await run({ at: at(6, 20), promise: { text: "send Tom the signed term sheet", quote: "I'll send the signed term sheet Monday morning.", due: "2026-11-09" } });
    expect(other.rows.map((r) => r.text).sort()).toEqual(["send Tom the full written update with the numbers and the board deck appendix", "send Tom the signed term sheet"]);
  });

  it("off, first sync, a template and bulk mail aren't read", async () => {
    const { backend, model, send, drained, client, account } = await setup();
    await send({}, false);
    await send({ bulk: true });
    await send({ listId: "l.acme" });
    backend.followups.wake();
    await drained();
    expect(model.requests).toEqual([]);
    await client.call("accounts.update", { id: account.id, followups: false });
    await send();
    backend.followups.wake();
    await drained();
    expect(model.requests).toEqual([]);
  });

  it("a thread is read in order: one waiting for a body holds what's after it on that thread, only", async () => {
    const { backend, model, send, clock } = await setup();
    const heard: string[] = [];
    model.answer = (req) => (heard.push(JSON.stringify(req.messages)), reply());
    const first = await send({ providerMsgId: "t0", rfcMessageId: "t0@x", bodyText: null, bodyState: "none", date: clock.now - 3000 });
    await send({ providerMsgId: "t1", rfcMessageId: "t1@x", inReplyTo: "t0@x", references: ["t0@x"], bodyText: "Here's the contract.", date: clock.now - 2000 });
    await send({ subject: "Other", bodyText: "An unrelated one.", date: clock.now - 1000 });
    backend.followups.wake();
    await expect.poll(() => heard.length).toBe(1);
    expect(heard[0]).toContain("An unrelated one");
    await backend.store.sync.setBody(first.id, "I'll send the contract.", null, { now: NOW, classifier: null });
    backend.followups.wake();
    await expect.poll(() => heard.length).toBe(3);
    expect(heard[1]).toContain("I'll send the contract");
    expect(heard[2]).toContain("Here's the contract");
  });

  it("auth pauses without losing the mark, and a settings change resumes", async () => {
    const { backend, model, send, client, drained } = await setup();
    model.answer = () => { throw new AiError("no", "auth"); };
    await send();
    backend.followups.wake();
    await expect.poll(() => backend.followups.blockedBy?.kind).toBe("auth");
    expect(await backend.store.followups.marks.count()).toBe(1);
    model.answer = () => reply();
    await client.call("settings.update", { followups: { nudgeAfterDays: 7 } });
    await drained();
  });

  it("every failure has its transition: a bad answer loses this one; a passing one holds and keeps it", async () => {
    const { backend, model, send, clock } = await setup();
    model.answer = () => { throw new AiError("no", "refused"); };
    await send();
    backend.followups.wake();
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
    model.answer = () => { throw new AiError("down", "unavailable"); };
    await send();
    await expect.poll(() => model.requests.length).toBe(2);
    backend.followups.wake();
    await new Promise((r) => setTimeout(r, 20));
    expect(model.requests.length).toBe(2);
    expect(await backend.store.followups.marks.count()).toBe(1);
    clock.now += 61_000;
    model.answer = () => reply();
    backend.followups.wake();
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
  });

  it("turning it off mid-drain sends nothing further", async () => {
    const { backend, client, model, send } = await setup();
    let release!: (c: Completion) => void;
    model.answer = () => new Promise((r) => (release = r));
    await send();
    await send({ bodyText: "Another I'll send." });
    backend.followups.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    await client.call("settings.update", { followups: { enabled: false } });
    release(reply());
    await new Promise((r) => setTimeout(r, 20));
    expect(model.requests.length).toBe(1);
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
    expect(backend.followups.nextAt).toBeNull();
  });
});

describe("permission, while it reads", () => {
  it("what was sent before it was turned on isn't read, even if it arrives now", async () => {
    const { backend, model, send, drained } = await setup();
    await send({ date: NOW - 2 * DAY });
    backend.followups.wake();
    await drained();
    expect(model.requests).toEqual([]);
  });

  it("the provider changing stops the read, and its answer writes nothing; what it read goes to the new one", async () => {
    const { backend, client, model, send } = await setup();
    let release!: (c: Completion) => void;
    let hung = true;
    model.answer = () => (hung ? new Promise((r) => (release = r)) : reply());
    await send();
    backend.followups.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    hung = false;
    await client.call("settings.update", { ai: { provider: "fake", model: "another" } });
    release(reply(says));
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
    expect(await backend.store.followups.active()).toEqual([]);
  });

  it("an account's switch going off stops what's reading it, and nothing comes of a late answer", async () => {
    const { backend, client, model, send, account } = await setup();
    let release!: (c: Completion) => void;
    model.answer = () => new Promise((r) => (release = r));
    await send();
    backend.followups.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    await client.call("accounts.update", { id: account.id, followups: false });
    release(reply(says));
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
    expect(await backend.store.followups.active()).toEqual([]);
  });

  it("an account's switch going off while it's still getting ready: nothing leaves", async () => {
    const { backend, client, model, send, account } = await setup();
    let ready!: () => void;
    const gate = new Promise<void>((r) => (ready = r));
    const learner = backend.writing.learner;
    const real = learner.templatedIn.bind(learner);
    let waiting = false;
    learner.templatedIn = async (id) => {
      waiting = true;
      await gate;
      return real(id);
    };
    await send();
    backend.followups.wake();
    await expect.poll(() => waiting).toBe(true);
    await client.call("accounts.update", { id: account.id, followups: false });
    ready();
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
    expect(model.requests).toEqual([]);
  });

  it("tells an open Settings when it stops", async () => {
    const { backend, client, model, send } = await setup();
    const heard: unknown[] = [];
    client.on("followupsStatus", (s) => void heard.push(s.blockedBy?.kind ?? null));
    model.answer = () => { throw new AiError("no", "auth"); };
    await send();
    backend.followups.wake();
    await expect.poll(() => heard).toEqual(["auth"]);
    await client.call("settings.update", { followups: { nudgeAfterDays: 7 } });
    await expect.poll(() => heard).toEqual(["auth", null]);
  });

  it("says why it stopped, for Settings", async () => {
    const { backend, client, model, send } = await setup();
    model.answer = () => { throw new AiError("no", "auth"); };
    await send();
    backend.followups.wake();
    await expect.poll(async () => (await client.call("followups.status", {})).blockedBy?.kind).toBe("auth");
  });

  it("a provider that says slow down has one timer to come back on; stopping clears it", async () => {
    const { backend, model, send } = await setup();
    model.answer = () => { throw new AiError("slow", "rate_limited"); };
    await send();
    backend.followups.wake();
    await expect.poll(() => backend.followups.retrying).not.toBeNull();
    backend.followups.stop();
    expect(backend.followups.retrying).toBeNull();
  });
});

describe("a send (revision 3)", () => {
  async function waiting(t: Awaited<ReturnType<typeof setup>>) {
    const { backend, model, send, drained } = t;
    model.answer = () => reply({ expectsReply: true, awaiting: ["r1"] });
    const first = await send({ providerMsgId: "w", rfcMessageId: "w@x" });
    backend.followups.wake();
    await drained();
    expect((await backend.store.followups.active()).map((r) => r.kind)).toEqual(["awaiting"]);
    model.answer = () => reply();
    return first.id;
  }

  it("written and queued closes nothing; failing closes nothing; only confirmed does, and it's read then", async () => {
    const t = await setup();
    const { backend, client, account, clock } = t;
    const replyingTo = await waiting(t);
    clock.now += 60_000;
    const provider = await backend.provider(account.id);
    const execute = provider!.execute.bind(provider);
    provider!.execute = async () => { throw new Error("the server said no"); };
    const failed = await client.call("compose.send", { accountId: account.id, to: [tom], subject: "Re", bodyText: "Any news?", inReplyToMessageId: replyingTo });
    expect((await backend.store.followups.active()).map((r) => r.kind)).toEqual(["awaiting"]);
    expect(await backend.store.followups.marks.count()).toBe(0);
    await backend.runWorker();
    expect((await backend.store.followups.active()).map((r) => r.kind)).toEqual(["awaiting"]);
    expect(await backend.store.followups.marks.count()).toBe(0);
    expect(failed.opId).toBeTruthy();
    provider!.execute = execute;
    await client.call("compose.send", { accountId: account.id, to: [tom], subject: "Re", bodyText: "Any news at all?", inReplyToMessageId: replyingTo });
    await backend.runWorker();
    expect(await backend.store.followups.active()).toEqual([]);
  });

  it("the setting off still lets a confirmed send end a wait, and reads nothing", async () => {
    const t = await setup();
    const { backend, client, account, model, clock } = t;
    const replyingTo = await waiting(t);
    await client.call("settings.update", { followups: { enabled: false } });
    clock.now += 60_000;
    const n = model.requests.length;
    await client.call("compose.send", { accountId: account.id, to: [tom], subject: "Re", bodyText: "Any news?", inReplyToMessageId: replyingTo });
    await backend.runWorker();
    expect(await backend.store.followups.marks.count()).toBe(0);
    expect(model.requests.length).toBe(n);
    expect(await backend.store.followups.active()).toEqual([]);
  });
});

describe("when they come due", () => {
  it("one timer; due, on top, and said once; a nudge says nothing", async () => {
    const { backend, model, send, drained, clock, notices } = await setup();
    model.answer = () => reply({ ...says, expectsReply: true, awaiting: ["r1"] });
    await send();
    backend.followups.wake();
    await drained();
    expect(backend.followups.nextAt).not.toBeNull();
    expect(notices).toEqual([]);
    clock.now += 10 * DAY;
    await backend.followups.look();
    const rows = await backend.store.followups.active();
    expect(rows.map((r) => [r.kind, r.state, r.inboxState]).sort()).toEqual([["awaiting", "due", "onTop"], ["promise", "due", "onTop"]]);
    expect(backend.followups.nextAt).toBeNull();
  });

  it("a quit between coming due and saying so says it on the way back", async () => {
    const { backend, model, send, drained, clock, notices } = await setup();
    model.answer = () => reply(says);
    await send();
    backend.followups.wake();
    await drained();
    clock.now += 4 * DAY;
    await backend.store.followups.makeDue(clock.now);
    expect(notices).toEqual([]);
    await backend.followups.look();
    expect(notices).toHaveLength(1);
    await backend.followups.look();
    expect(notices).toHaveLength(1);
  });

  it("plan 211 (Codex code review): a promise of an account with AI or What matters off isn't said; back on, it is", async () => {
    const { backend, client, model, send, drained, clock, notices, account } = await setup();
    model.answer = () => reply(says);
    await send();
    backend.followups.wake();
    await drained();
    await client.call("accounts.update", { id: account.id, feed: false });
    clock.now += 4 * DAY;
    await backend.followups.look();
    expect(notices).toEqual([]);
    await client.call("accounts.update", { id: account.id, feed: true });
    await backend.followups.look();
    expect(notices).toHaveLength(1);
  });

  it("no timer while there's nothing", async () => {
    const { backend } = await setup();
    await backend.followups.look();
    expect(backend.followups.nextAt).toBeNull();
  });

  it("plan 277: archiving a conversation keeps its follow-up: off the Inbox's top, still in the list and active; Undo puts the top back", async () => {
    const { backend, client, model, send, drained, clock } = await setup();
    model.answer = () => reply(says);
    const { m } = await send({ inInbox: true });
    backend.followups.wake();
    await drained();
    clock.now += 10 * DAY;
    await backend.followups.look();
    const threadId = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
    const [before] = await backend.store.followups.active();
    expect((await client.call("followups.threads", { onTop: true })).items.map((t) => t.id)).toEqual([threadId]);
    const { undoId } = await client.call("threads.act", { threadIds: [threadId], action: "archive" });
    expect((await client.call("followups.threads", { onTop: true })).items).toEqual([]);
    expect((await client.call("followups.threads", { onTop: false })).items.map((t) => t.id)).toEqual([threadId]);
    expect((await client.call("followups.list", {})).rows.map((r) => [r.id, r.state])).toEqual([[before!.id, before!.state]]);
    await client.call("threads.undo", { undoId: undoId! });
    expect((await client.call("followups.threads", { onTop: true })).items.map((t) => t.id)).toEqual([threadId]);
    expect(await backend.store.followups.get(before!.id)).toMatchObject({ state: before!.state, inboxState: "onTop", closedReason: null, closedAt: null });
  });

  it("plan 277: send, archive, and if they don't reply it comes back: due, on the Inbox's top, and said", async () => {
    const { backend, client, model, send, drained, clock, notices } = await setup();
    model.answer = () => reply(says);
    const { m } = await send({ inInbox: true });
    backend.followups.wake();
    await drained();
    const threadId = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
    await client.call("threads.act", { threadIds: [threadId], action: "archive" });
    expect((await client.call("followups.list", {})).rows.map((r) => r.threadId)).toEqual([threadId]);
    clock.now += 4 * DAY;
    await backend.followups.look();
    expect((await client.call("followups.list", {})).rows.map((r) => [r.threadId, r.state])).toEqual([[threadId, "due"]]);
    expect((await client.call("followups.threads", { onTop: true })).items.map((t) => t.id)).toEqual([threadId]);
    expect(notices).toHaveLength(1);
  });

  it("plan 218 (Codex code review): a look still running when the conversation is deleted neither says it nor has the last word", async () => {
    const { backend, client, model, send, drained, clock, notices } = await setup();
    model.answer = () => reply(says);
    const { m } = await send();
    backend.followups.wake();
    await drained();
    const threadId = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
    clock.now += 4 * DAY;
    // the look stops at its first read of what's in Trash or Spam, after it has read the rows and made them due
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const inTrashOrSpam = backend.store.followups.inTrashOrSpam.bind(backend.store.followups);
    const spy = vi.spyOn(backend.store.followups, "inTrashOrSpam").mockImplementationOnce(async (ids) => (await held, inTrashOrSpam(ids)));
    const older = backend.followups.look();
    await expect.poll(() => spy.mock.calls.length).toBe(1);
    const deleted = client.call("threads.act", { threadIds: [threadId], action: "trash" });
    release();
    await Promise.all([older, deleted]);
    spy.mockRestore();
    await backend.followups.look();
    expect(notices).toEqual([]);
    expect((await client.call("followups.list", {})).rows).toEqual([]);
  });

  it("plans 218, 277: a conversation with their mail archived anywhere still shows, due and said; deleted, it shows nowhere and Undo brings it back", async () => {
    const { backend, client, model, send, drained, clock, notices, account } = await setup();
    model.answer = () => reply(says);
    const { m } = await send({ rfcMessageId: "s@x" });
    backend.followups.wake();
    await drained();
    const threadId = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
    // their answer, read and archived elsewhere (Gmail on the phone): it arrives out of the Inbox
    await backend.ingestSliced([msg({ accountId: account.id, from: tom, to: [me], providerMsgId: "theirs", rfcMessageId: "t@x", inReplyTo: "s@x", references: ["s@x"], inInbox: false, date: clock.now - 30_000, bodyText: "Thanks!" })], true);
    expect((await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === "theirs")!.threadId).toBe(threadId);
    clock.now += 4 * DAY;
    await backend.followups.look();
    expect((await client.call("followups.list", {})).rows.map((r) => [r.threadId, r.state])).toEqual([[threadId, "due"]]);
    expect((await client.call("followups.threads", { onTop: false })).items.map((t) => t.id)).toEqual([threadId]);
    expect((await backend.followups.awayAmong([threadId])).has(threadId)).toBe(false);
    expect(notices).toHaveLength(1);
    // deleted: gone, and Undo brings it back
    const { undoId } = await client.call("threads.act", { threadIds: [threadId], action: "trash" });
    await backend.followups.look();
    expect((await client.call("followups.list", {})).rows).toEqual([]);
    expect((await backend.followups.awayAmong([threadId])).has(threadId)).toBe(true);
    await client.call("threads.undo", { undoId: undoId! });
    await backend.followups.look();
    expect((await client.call("followups.list", {})).rows.map((r) => r.threadId)).toEqual([threadId]);
  });
});

it("filing into a hidden category ends the top, and its Undo puts it back", async () => {
  const { backend, client, model, send, drained, clock } = await setup();
  model.answer = () => reply(says);
  const { m } = await send({ inInbox: true });
  backend.followups.wake();
  await drained();
  clock.now += 10 * DAY;
  await backend.followups.look();
  const threadId = (await backend.store.debug.snapshot()).messages.find((x) => x.providerMsgId === m.providerMsgId)!.threadId;
  const category = await client.call("categories.create", { name: "Hidden", color: "brown", showInInbox: false } as never);
  const moved = await client.call("categories.moveThreads", { to: (category as { id: number }).id, threadIds: [threadId], source: "picker" } as never);
  expect((await client.call("followups.threads", { onTop: true })).items).toEqual([]);
  await client.call("categorize.undo", { batchId: (moved as { batchId: number }).batchId });
  expect((await client.call("followups.threads", { onTop: true })).items.map((t) => t.id)).toEqual([threadId]);
});

describe("what you do", () => {
  it("Done, Dismiss and Later, each with exact Undo; a change since refuses", async () => {
    const { backend, client, model, send, drained, clock } = await setup();
    model.answer = () => reply(says);
    await send();
    backend.followups.wake();
    await drained();
    clock.now += 10 * DAY;
    await backend.followups.look();
    const [row] = await backend.store.followups.active();
    const done = await client.call("followups.act", { id: row!.id, revision: row!.revision, action: "done" });
    expect(await backend.store.followups.active()).toEqual([]);
    await client.call("followups.undo", { undoId: done.undoId! });
    const [back] = await backend.store.followups.active();
    expect(back).toMatchObject({ state: "due", inboxState: "onTop", dueAt: row!.dueAt });
    await expect(client.call("followups.act", { id: row!.id, revision: row!.revision, action: "done" })).rejects.toMatchObject({ code: "STALE" });
    const later = await client.call("followups.act", { id: back!.id, revision: back!.revision, action: "later", dueAt: clock.now + DAY });
    // plan 204 (the fifth panel round): a promise's Later is its own, its moment kept
    expect(later.row).toMatchObject({ state: "open", inboxState: "none", dueAt: row!.dueAt, deferredUntil: clock.now + DAY });
    expect(backend.followups.nextAt).toBe(clock.now + DAY);
  });
});

describe("the check of what you sent (plan 211: the backend's, per account)", () => {
  it("its 30 days, once; what it finds stays off the top and silent", async () => {
    const { backend, model, send, drained, clock, notices, check } = await setup();
    model.answer = () => reply(says);
    await send({ date: NOW - 10 * DAY, providerMsgId: "old-1", bodyText: "I'll send the contract." }, false);
    await send({ date: NOW - 40 * DAY, providerMsgId: "old-2" }, false);
    await send({ date: NOW - 3 * DAY, providerMsgId: "old-3", listId: "a.b" }, false);
    expect(model.requests).toEqual([]);
    expect(await check()).toBe(1);
    await drained();
    expect(model.requests).toHaveLength(1);
    expect(await check()).toBe(0);
    clock.now += 10 * DAY;
    await backend.followups.look();
    const [row] = await backend.store.followups.active();
    expect(row).toMatchObject({ fromScan: true, state: "due", inboxState: "none" });
    expect(notices).toEqual([]);
  });
});

describe("the limiter's registry (revision 8)", () => {
  it("the month's ceiling sees every background task, a new one too", async () => {
    const { backend, model, send, drained } = await setup();
    model.answer = () => ({ ...reply(), usage: { inputTokens: 1000, outputTokens: 100 } });
    await send();
    backend.followups.wake();
    await drained();
    const report = await backend.aiService.limiter.report();
    expect(report.month.requests).toBe(1);
    expect(report.monthBackgroundUsd).toBe(report.month.usd);
  });
});

it("Clear AI data empties it, and none of it is on MCP or in an export", async () => {
  const { backend, client, model, send, drained } = await setup();
  model.answer = () => reply(says);
  await send();
  backend.followups.wake();
  await drained();
  expect(JSON.stringify(await client.call("app.export", {}))).not.toContain("send the contract");
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "m", origin: "mcp" });
  await expect(new RpcClient(c).call("followups.list", {})).rejects.toBeTruthy();
  await client.call("ai.summaries.clear", {});
  expect(await backend.store.followups.active()).toEqual([]);
});

describe("plan 211: an account's AI and What matters switches", () => {
  it.each([["AI off", { ai: false }], ["out of What matters", { feed: false }]] as const)("%s: what's in flight stops, and what's marked isn't read", async (_name, off) => {
    const { backend, client, model, send, account } = await setup();
    let release!: (c: Completion) => void;
    model.answer = () => new Promise((r) => (release = r));
    await send();
    backend.followups.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    await send({ subject: "Another" });
    await client.call("accounts.update", { id: account.id, ...off });
    // stopped at the provider, before any answer (Codex code review: the answer's own check would drop it anyway)
    await expect.poll(() => model.requests[0]!.signal?.aborted).toBe(true);
    release(reply(says));
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(await backend.store.followups.active()).toEqual([]);
  });
});
