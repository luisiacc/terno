/**
 * Plan 280: the follow-ups reader's reading of received mail, through a real backend and a scripted model: promises owed to
 * you, read in the order mail came, gated as Follow-ups is, never Spam, closed only by the debtor, late one working day after
 * their day.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

// Monday 2 November 2026, noon
const NOW = new Date(2026, 10, 2, 12).getTime();
const DAY = 86_400_000;
const me = { name: "Me", email: "me@terno.test" };
const alex = { name: "Alex Reed", email: "alex@acme.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Their = { promises?: unknown[]; kept?: unknown[]; moved?: unknown[]; withdrawn?: unknown[] };
const theirs = (o: Their = {}): Completion => ({ text: JSON.stringify({ promises: (o.promises ?? []).map((p) => ({ partOfDay: null, firm: true, ...(p as object) })), kept: o.kept ?? [], moved: o.moved ?? [], withdrawn: o.withdrawn ?? [] }), stop: "end" });
const sentReply = (o: { expectsReply?: boolean; awaiting?: string[] } = {}): Completion => ({ text: JSON.stringify({ promises: [], expectsReply: o.expectsReply ?? false, awaiting: o.awaiting ?? [], kept: [], answers: [], theirs: [], owedKept: [] }), stop: "end" });
const schemaOf = (req: CompletionRequest) => (req as { schema?: { name?: string } }).schema?.name ?? "";
const promise = { text: "send you the contract", quote: "I'll send you the contract by Thursday", due: "2026-11-05" };

async function setup(o: { enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-owed-"));
  const model = { requests: [] as CompletionRequest[], their: (_r: CompletionRequest): Completion => theirs(), sent: (_r: CompletionRequest): Completion => sentReply() };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, { ...options, transport: { complete: async (req) => (model.requests.push(req), schemaOf(req) === "their_mail" ? model.their(req) : schemaOf(req) === "sent_mail" ? model.sent(req) : sentReply()) } });
  const backend = new Backend({ dbPath: join(dir, "o.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now, attention: { badge() {}, notify() {} } });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Nora Quill", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  await client.call("settings.update", { followups: { enabled: false } });
  if (o.enabled ?? true) await client.call("settings.update", { followups: { enabled: true } });
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const ingest = async (over: Partial<IncomingMessage>) => {
    const m = msg({ accountId: account.id, from: alex, to: [me], date: clock.now - 60_000, providerMsgId: `o-${seq++}`, ...over });
    const { inserted } = await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    return { id: inserted[0]!, m };
  };
  const got = (over: Partial<IncomingMessage> = {}) => ingest({ bodyText: "Hi Nora, I'll send you the contract by Thursday.", ...over });
  const send = (over: Partial<IncomingMessage> = {}) => ingest({ from: me, to: [alex], isSent: true, inInbox: false, gmailLabels: ["SENT"], bodyText: "Could you send me the contract?", ...over });
  const drained = async () => {
    backend.followups.wake();
    await expect.poll(async () => (await backend.store.followups.owed.marks.count()) + (await backend.store.followups.marks.count())).toBe(0);
  };
  const owed = async () => (await backend.store.followups.active()).filter((r) => r.kind === "theirs");
  const asked = () => model.requests.filter((r) => schemaOf(r) === "their_mail");
  return { backend, client, model, clock, got, send, drained, owed, asked, account };
}

describe("reading their mail (plan 280)", () => {
  it("a person's promise to you is theirs: in your Follow-ups, no address in the request, the mark consumed", async () => {
    const { model, got, drained, owed, asked } = await setup();
    model.their = () => theirs({ promises: [promise] });
    await got();
    await drained();
    expect(await owed()).toEqual([expect.objectContaining({ kind: "theirs", text: "send you the contract", personName: "Alex Reed", personEmail: alex.email, dueDay: "2026-11-05", dated: true, firm: true, state: "open" })]);
    const sent = JSON.stringify(asked()[0]!.messages);
    expect(sent).toContain("Alex Reed");
    expect(sent).not.toContain(alex.email);
  });

  it("reads nothing in Spam, from a newsletter with no one owing you, or a person's mail with nothing to read", async () => {
    const { got, drained, asked } = await setup();
    await got({ isSpam: true, inInbox: false });
    await got({ from: { name: "Deals", email: "news@shop.test" }, listId: "deals.shop.test", bodyText: "We'll send you 20% off!" });
    await got({ bodyText: "Thanks, see you soon." });
    await drained();
    expect(asked()).toEqual([]);
  });

  it("nothing is marked or read while Follow-ups is off", async () => {
    const { backend, got, asked } = await setup({ enabled: false });
    await got();
    expect(await backend.store.followups.owed.marks.count()).toBe(0);
    backend.followups.wake();
    expect(asked()).toEqual([]);
  });

  it("only the debtor's later mail keeps it, even in a new conversation; a relay naming them only hints", async () => {
    const { model, got, drained, owed, clock } = await setup();
    model.their = () => theirs({ promises: [promise] });
    await got({ subject: "Contract" });
    await drained();
    const [row] = await owed();
    clock.now += DAY;
    // a service's notice naming Alex's address: a hint, never a close
    model.their = () => theirs({ kept: [{ label: "t1", evidence: "alex@acme.test signed the contract" }] });
    await got({ from: { name: "SignFlow", email: "noreply@signflow.test" }, listId: "signflow.test", subject: "Completed", bodyText: "alex@acme.test signed the contract. View it online." });
    await drained();
    expect((await owed())[0]).toMatchObject({ id: row!.id, state: "open" });
    expect((await owed())[0]!.arrivedHint).toBeGreaterThan(0);
    // someone else can't keep it
    model.their = () => theirs({ kept: [{ label: "t1", evidence: "Here's the contract." }] });
    await got({ from: { name: "Bea", email: "bea@acme.test" }, subject: "Re: Contract", bodyText: "Here's the contract. I'll send you the notes too." });
    await drained();
    expect(await owed()).toHaveLength(1);
    // Alex, in a new conversation, delivers
    await got({ subject: "Signed copy", bodyText: "Here's the contract." });
    await drained();
    expect(await owed()).toEqual([]);
  });

  it("your question, then their 'will do by Thursday': the wait ends and the promise takes its place", async () => {
    const { model, send, got, drained, owed, backend, clock, asked } = await setup();
    model.sent = () => sentReply({ expectsReply: true, awaiting: ["r1"] });
    await send({ rfcMessageId: "q@x", subject: "Contract" });
    await drained();
    expect((await backend.store.followups.active()).map((r) => r.kind)).toEqual(["awaiting"]);
    clock.now += 3600_000;
    model.their = () => theirs({ promises: [{ ...promise, quote: "Will do, by Thursday" }] });
    await got({ inReplyTo: "q@x", references: ["q@x"], subject: "Re: Contract", bodyText: "Will do, by Thursday" });
    await drained();
    await backend.followups.look();
    expect((await backend.store.followups.active()).map((r) => r.kind)).toEqual(["theirs"]);
    // what it answered was sent, as material
    expect(JSON.stringify(asked().at(-1)!.messages)).toContain("<answering>\\nCould you send me the contract?");
    expect(await owed()).toHaveLength(1);
  });

  it("late one working day after its day: a firm one on the Inbox's top, a tentative one never; over after 30 days", async () => {
    const { model, got, drained, owed, clock, backend } = await setup();
    model.their = () => theirs({ promises: [promise, { ...promise, text: "send you the deck", quote: "I'll try to send you the deck by Thursday", firm: false }] });
    await got({ bodyText: "I'll send you the contract by Thursday. I'll try to send you the deck by Thursday." });
    await drained();
    // Thursday evening: not yet
    clock.now = new Date(2026, 10, 5, 20).getTime();
    await backend.followups.look();
    expect((await owed()).map((r) => r.state)).toEqual(["open", "open"]);
    // Friday 9:00
    clock.now = new Date(2026, 10, 6, 9).getTime();
    await backend.followups.look();
    const rows = await owed();
    expect(rows.map((r) => [r.firm, r.state, r.inboxState])).toEqual([[true, "due", "onTop"], [false, "due", "none"]]);
    clock.now += 31 * DAY;
    await backend.followups.look();
    expect(await owed()).toEqual([]);
    expect((await backend.store.followups.get(rows[0]!.id))).toMatchObject({ state: "dismissed", closedReason: "expired" });
  });

  it("a mail moved to Spam before its reading leaves goes nowhere", async () => {
    const { backend, model, got, drained, asked } = await setup();
    let moved = false;
    model.their = () => theirs({ promises: [promise] });
    const a = await got();
    // at the transport's last look, the conversation is in Spam
    const holding = backend.followups.holdingUp.bind(backend.followups);
    backend.followups.holdingUp = async () => {
      if (!moved) {
        moved = true;
        await backend.store.sync.ingest([{ ...a.m, isSpam: true, inInbox: false }], { applyFilters: false, now: Date.now(), classifier: null });
      }
      return holding();
    };
    await drained();
    expect(asked()).toEqual([]);
    expect((await backend.store.followups.active()).filter((r) => r.kind === "theirs")).toEqual([]);
  });

  it("the code review: a cue-free reply to a send of yours is read, its wait gone or not", async () => {
    const { model, send, got, drained, owed, clock, backend } = await setup();
    await send({ rfcMessageId: "q2@x", subject: "Floor plan", bodyText: "Could you send me the floor plan this week?" });
    await drained();
    clock.now += 3600_000;
    model.their = () => theirs({ promises: [{ text: "send you the floor plan", quote: "Friday.", due: "2026-11-06" }] });
    await got({ inReplyTo: "q2@x", references: ["q2@x"], subject: "Re: Floor plan", bodyText: "Friday." });
    await backend.followups.look();
    await drained();
    expect(await owed()).toEqual([expect.objectContaining({ text: "send you the floor plan", dueDay: "2026-11-06" })]);
  });

  it("the code review: a promise of theirs your mail records, read after their delivery was, reads the delivery again and is kept", async () => {
    const { model, send, got, drained, owed, clock, backend, asked } = await setup();
    // their delivery arrives first: nothing is owed yet and it has no cue, so it's passed over unasked
    model.their = () => theirs({ kept: [{ label: "t1", evidence: "Here's the contract." }] });
    await got({ subject: "Contract attached", bodyText: "Here's the contract.", date: clock.now - 30_000 });
    await drained();
    // your earlier message, which records their promise, is read only now (a send confirmed late)
    model.sent = () => ({ text: JSON.stringify({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [], theirs: [{ text: "send you the contract", quote: "as agreed, you'll send the contract Thursday", who: "r1", due: "2026-11-05", partOfDay: null, firm: true }], owedKept: [] }), stop: "end" });
    await send({ subject: "Contract", bodyText: "Thanks Alex, as agreed, you'll send the contract Thursday.", date: clock.now - 90_000 });
    await drained();
    await backend.followups.look();
    // the delivery was marked again and read with the promise now open (t1), and kept it
    expect(asked()).toHaveLength(1);
    expect(JSON.stringify(asked()[0]!.messages)).toContain("t1");
    expect(await owed()).toEqual([]);
    const all = await backend.store.followups.ofThread((await backend.store.threads.searchText({ query: 'subject:"Contract"', limit: 5, now: clock.now })).items.find((t) => t.subject === "Contract")!.id);
    expect(all).toEqual([]);
  });

  it("the code review: an Undo with no room under the bound says so and can be tried again", async () => {
    const { backend } = await setup();
    const restore = backend.store.followups.restore;
    backend.store.followups.restore = async () => 0;
    const get = backend.store.followups.get;
    // a promise of theirs Done, still at the revision the Undo expects
    backend.store.followups.get = async () => ({ id: 1, revision: 2, state: "done" }) as never;
    const undoId = (backend.followups as unknown as { remember: (e: unknown[]) => string }).remember([{ snapshot: { id: 1, revision: 1, state: "open", dueAt: 0, deferredUntil: null, inboxState: "none", closedReason: null, closedAt: null }, expectRevision: 2 }]);
    await expect(backend.followups.undoAct(undoId)).rejects.toThrow(/too many follow-ups/);
    backend.store.followups.restore = restore;
    backend.store.followups.get = get;
  });

  it("the Astra review: a file alone, to someone who owes one, is read and can be the delivery", async () => {
    const { model, got, drained, owed, asked, clock } = await setup();
    model.their = () => theirs({ promises: [promise] });
    await got({ subject: "Contract" });
    await drained();
    model.their = () => theirs({ kept: [{ label: "t1", evidence: "Contract_signed.pdf" }] });
    clock.now += 3600_000;
    await got({ subject: "Signed", bodyText: "", hasAttachments: true, attachments: [{ filename: "Contract_signed.pdf", mime: "application/pdf", size: 3, bytes: new Uint8Array([1, 2, 3]) }] });
    await drained();
    expect(asked()).toHaveLength(2);
    expect(await owed()).toEqual([]);
  });

  it("the Astra review: reading what you send never carries a promise from a conversation with anything in Spam", async () => {
    const { model, got, send, drained, owed, backend, account, clock } = await setup();
    model.their = () => theirs({ promises: [promise] });
    const a = await got({ subject: "Deal", rfcMessageId: "deal@x", providerThreadId: "deal" });
    await drained();
    expect(await owed()).toHaveLength(1);
    // another of the conversation's messages moved to Spam
    await backend.store.sync.ingest([msg({ accountId: account.id, from: { name: "Bea", email: "bea@acme.test" }, to: [me], providerMsgId: "spam-1", providerThreadId: "deal", inReplyTo: "deal@x", references: ["deal@x"], subject: "Re: Deal", isSpam: true, inInbox: false, date: clock.now - 30_000 })], { applyFilters: false, now: clock.now, classifier: null });
    clock.now += 60_000;
    const before = model.requests.length;
    await send({ subject: "Re: Deal", providerThreadId: "deal", inReplyTo: "deal@x", references: ["deal@x"], bodyText: "Got it, thanks!" });
    await drained();
    const sentReads = model.requests.slice(before).filter((r) => schemaOf(r) === "sent_mail");
    expect(sentReads.length).toBeGreaterThan(0);
    for (const r of sentReads) expect(JSON.stringify(r.messages)).not.toContain("<owed>");
    expect(a.id).toBeGreaterThan(0);
  });

  it("the Astra review: a conversation held for a body holds its later senders too, so their delivery elsewhere waits for their promise", async () => {
    const { model, got, drained, owed, clock, backend } = await setup();
    // Bob's message, its body not here yet, holds the conversation
    const bob = await got({ from: { name: "Bob", email: "bob@acme.test" }, subject: "Plan", providerThreadId: "plan", rfcMessageId: "plan1@x", bodyState: "none", bodyText: "" });
    clock.now += 60_000;
    // Alex promises in that conversation, then delivers in another, with no cue
    await got({ subject: "Re: Plan", providerThreadId: "plan", rfcMessageId: "plan2@x", inReplyTo: "plan1@x", references: ["plan1@x"] });
    clock.now += 60_000;
    await got({ subject: "Contract", bodyText: "Here it is." });
    model.their = (req) => (JSON.stringify(req.messages).includes("<owed>") ? theirs({ kept: [{ label: "t1", evidence: "Here it is." }] }) : theirs({ promises: [promise] }));
    backend.followups.wake();
    // the delivery waits with the conversation (its marks stay)
    await expect.poll(async () => backend.store.followups.owed.marks.count()).toBe(3);
    await backend.store.sync.setBody(bob.id, "Can someone send the contract?", null, { now: clock.now, classifier: null });
    await drained();
    expect(await owed()).toEqual([]);
  });
});
