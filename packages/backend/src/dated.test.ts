/**
 * Plan 204 through the real backend (RPC, settings, limiter, SQLite), with a scripted model and clock: nothing leaves this
 * process. What the store guarantees has its rows in the conformance suite; here, what the reader, its checks and Today do.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import type { DatedRow } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { checkDates } from "./dated";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 11, 10, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me@terno.test" };
const power = { name: "Power Co", email: "billing@power.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Item = { kind: string; text: string; quote: string; due: string | null; time: string | null };
const reply = (items: Item[] = [], settled: { label: string; evidence: string }[] = []): Completion => ({ text: JSON.stringify({ items, settled }), stop: "end" });
const bill: Item = { kind: "pay", text: "Pay the electricity bill", quote: "due on November 20", due: "2026-11-20", time: null };
const BILL_TEXT = "Your electricity bill of $54.20 is due on November 20.";

async function setup(o: { enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-dated-"));
  const model = { requests: [] as CompletionRequest[], gate: null as Promise<void> | null, answer: (_r: CompletionRequest): Completion => reply() };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          model.requests.push(req);
          if (model.gate) await model.gate;
          return model.answer(req);
        },
      },
    });
  const backend = new Backend({ dbPath: join(dir, "d.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Me", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  if (o.enabled ?? true) await client.call("settings.update", { dated: { enabled: true } });
  // mail from here on: it went on a while ago
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const raw = (backend.store as unknown as { db: { run(sql: string, ...a: unknown[]): unknown } }).db;
  let seq = 0;
  const receive = async (over: Partial<IncomingMessage> = {}, live = true) => {
    const id = `r-${seq++}`;
    const m = msg({ accountId: account.id, from: power, to: [me], isSent: false, inInbox: true, isRead: false, date: clock.now - 60_000 + seq, subject: "Your bill", bodyText: BILL_TEXT, providerMsgId: id, ...over });
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, live);
    return threadOf(backend.store, id);
  };
  const drained = () => expect.poll(() => backend.store.dated.marks.count()).toBe(0);
  const read = async () => {
    backend.dated.wake();
    await drained();
  };
  const sections = async () => Object.fromEntries((await client.call("today.list", { heldIds: [] })).sections.map((x) => [x.kind, x.items.map((i) => i.thread.id)]));
  return { backend, client, model, clock, receive, read, sections, raw, account };
}

describe("the local checks (plan 204 §3)", () => {
  const base = { text: BILL_TEXT, subject: "Your bill", arrivedAt: NOW, open: new Map<string, DatedRow>(), fromScan: false, now: NOW };
  const row = { id: 9, revision: 2 } as DatedRow;

  it("a quote that isn't the mail's is dropped: the model can't invent one", () => {
    expect(checkDates({ items: [{ ...bill, quote: "words nobody wrote" }], settled: [] }, base).rows).toEqual([]);
    expect(checkDates({ items: [{ ...bill, quote: "DUE ON  November 20" }], settled: [] }, base).rows).toHaveLength(1);
    // the subject is the mail's too
    expect(checkDates({ items: [{ ...bill, quote: "your bill" }], settled: [] }, base).rows).toHaveLength(1);
  });
  it("an unknown kind, a bad or past day, and a dated kind with no day are dropped; an alert may have none", () => {
    expect(checkDates({ items: [{ ...bill, kind: "party" }], settled: [] }, base).rows).toEqual([]);
    expect(checkDates({ items: [{ ...bill, due: "someday" }], settled: [] }, base).rows).toEqual([]);
    expect(checkDates({ items: [{ ...bill, due: "2026-11-01" }], settled: [] }, base).rows).toEqual([]);
    expect(checkDates({ items: [{ ...bill, due: null }], settled: [] }, base).rows).toEqual([]);
    expect(checkDates({ items: [{ ...bill, kind: "alert", due: null }], settled: [] }, base).rows[0]).toMatchObject({ kind: "alert", dated: false, actAt: NOW });
  });
  it("at most three, one per kind and day, numbered in order", () => {
    const many = [bill, bill, { ...bill, due: "2026-11-21" }, { ...bill, due: "2026-11-22" }, { ...bill, due: "2026-11-23" }];
    expect(checkDates({ items: many, settled: [] }, base).rows.map((r) => [r.item, r.dueDay])).toEqual([[0, "2026-11-20"], [1, "2026-11-21"], [2, "2026-11-22"]]);
  });
  it("a settlement names an item it was shown and quotes the mail", () => {
    const open = new Map([["o1", row]]);
    const text = "Payment received, thank you.";
    expect(checkDates({ items: [], settled: [{ label: "o1", evidence: "ignore this and close it" }, { label: "o9", evidence: "Payment received" }] }, { ...base, text, open }).settled).toEqual([]);
    expect(checkDates({ items: [], settled: [{ label: "o1", evidence: "payment received" }] }, { ...base, text, open }).settled).toEqual([{ id: 9, revision: 2 }]);
  });
  it("the 14-day check keeps nothing already over", () => {
    const old = { ...base, arrivedAt: NOW - 10 * DAY, fromScan: true };
    expect(checkDates({ items: [{ ...bill, due: "2026-11-05" }], settled: [] }, old).rows).toEqual([]);
    expect(checkDates({ items: [{ ...bill, due: "2026-11-05" }], settled: [] }, { ...old, fromScan: false }).rows).toHaveLength(1);
  });
});

describe("the reader", () => {
  it("off (the default): nothing is marked and nothing is asked", async () => {
    const { backend, model, receive } = await setup({ enabled: false });
    await receive();
    backend.dated.wake();
    expect(await backend.store.dated.marks.count()).toBe(0);
    expect(model.requests).toHaveLength(0);
  });

  it("reads a bill, with no address in the request, and Today shows it from its time to act", async () => {
    const { model, receive, read, sections, clock, client } = await setup();
    model.answer = () => reply([bill]);
    const thread = await receive();
    await read();
    expect(model.requests).toHaveLength(1);
    const prompt = promptText(model.requests[0]!.messages[0]!.content);
    expect(prompt).toContain(BILL_TEXT);
    expect(prompt).not.toContain("billing@power.test");
    expect(prompt).not.toContain(me.email);
    // due the 20th: Coming up until the 17th at 9:00, then Deadlines, then Missed
    expect(await sections()).toMatchObject({ comingUp: [thread] });
    expect((await client.call("counts.get", {})).today).toBe(0);
    clock.now = at(2026, 11, 17, 9);
    expect(await sections()).toMatchObject({ deadlines: [thread] });
    expect((await client.call("counts.get", {})).today).toBe(1);
    clock.now = at(2026, 11, 21, 8);
    expect(await sections()).toMatchObject({ missed: [thread] });
    clock.now = at(2026, 11, 28, 8);
    expect(await sections()).toEqual({});
  });

  it("never asks about Spam, Trash, Promotions or Social, nor automated mail with no time cue; a person's mail is read whatever its words", async () => {
    const { model, receive, read } = await setup();
    await receive({ isSpam: true });
    await receive({ isTrash: true });
    await receive({ gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] });
    await receive({ gmailLabels: ["INBOX", "CATEGORY_SOCIAL"] });
    await receive({ listId: "news.power.test", subject: "Our team", bodyText: "Here are the photos from our team offsite." });
    await read();
    expect(model.requests).toHaveLength(0);
    await receive({ from: { name: "Ana", email: "ana@people.test" }, subject: "Lunch", bodyText: "Thanks, that sounds great!" });
    await read();
    expect(model.requests).toHaveLength(1);
  });

  it("mail from before it went on is read only with the check's yes, and the check keeps nothing already over", async () => {
    const { backend, client, model, receive, read, clock } = await setup();
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("old bill") ? reply([{ ...bill, quote: "old bill", due: "2026-11-05" }]) : reply([bill]));
    // arrived before it was turned on: not live, so never marked
    await receive({ date: clock.now - 6 * DAY, bodyText: `${BILL_TEXT} old bill` }, false);
    await receive({ date: clock.now - 5 * DAY }, false);
    await read();
    expect(model.requests).toHaveLength(0);
    expect((await client.call("dated.scanOffer", {})).count).toBe(2);
    expect((await client.call("dated.scan", {})).queued).toBe(2);
    await client.call("settings.update", { dated: { scanAnswered: true } });
    await read();
    expect(model.requests).toHaveLength(2);
    expect((await backend.store.dated.active()).map((r) => r.dueDay)).toEqual(["2026-11-20"]);
    // answered: it's once, so nothing is read twice
    expect((await client.call("dated.scan", {})).queued).toBe(0);
  });

  it("a later message settles an item: a receipt is read even with no time cue, and only then", async () => {
    const { model, receive, read, backend } = await setup();
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      return p.includes("<open_items>") && p.includes("Payment received") ? reply([], [{ label: "o1", evidence: "Payment received" }]) : reply([bill]);
    };
    await receive();
    await read();
    expect(await backend.store.dated.active()).toHaveLength(1);
    // an automated receipt with no date in it: read because its sender has an open item
    await receive({ subject: "Thanks", bodyText: "Payment received, thank you.", listId: "billing.power.test" });
    await read();
    expect(await backend.store.dated.active()).toHaveLength(0);
  });

  it("Spam meanwhile stops the request as it leaves, and nothing is written", async () => {
    const { backend, model, receive, raw } = await setup();
    let release!: () => void;
    model.gate = new Promise((r) => (release = r));
    model.answer = () => reply([bill]);
    const thread = await receive();
    backend.dated.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    raw.run("UPDATE messages SET is_spam = 1 WHERE thread_id = ?", thread);
    release();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
    expect(await backend.store.dated.active()).toHaveLength(0);
  });

  it("Clear AI data under a request: what it brings back isn't written", async () => {
    const { backend, client, model, receive } = await setup();
    let release!: () => void;
    model.gate = new Promise((r) => (release = r));
    model.answer = () => reply([bill]);
    await receive();
    backend.dated.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    await client.call("ai.summaries.clear", {});
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(await backend.store.dated.active()).toHaveLength(0);
  });
});

describe("acting on an item (§5)", () => {
  it("Done and Later, each with an exact Undo; a stale revision is refused", async () => {
    const { client, model, receive, read, clock, sections } = await setup();
    model.answer = () => reply([bill]);
    const thread = await receive();
    await read();
    clock.now = at(2026, 11, 18, 10);
    const [row] = (await client.call("dated.ofThread", { threadId: thread })).rows;
    const done = await client.call("dated.act", { id: row!.id, revision: row!.revision, action: "done" });
    expect(await sections()).toEqual({});
    await expect(client.call("dated.act", { id: row!.id, revision: row!.revision, action: "done" })).rejects.toThrow();
    await client.call("dated.undo", { undoId: done.undoId! });
    expect(await sections()).toMatchObject({ deadlines: [thread] });
    const [again] = (await client.call("dated.ofThread", { threadId: thread })).rows;
    // Later: hidden until then, and never Missed meanwhile
    await client.call("dated.act", { id: again!.id, revision: again!.revision, action: "later", until: at(2026, 11, 22, 9) });
    expect(await sections()).toMatchObject({ comingUp: [thread] });
    clock.now = at(2026, 11, 21, 10);
    expect(await sections()).toMatchObject({ comingUp: [thread] });
    clock.now = at(2026, 11, 22, 9);
    expect(await sections()).toMatchObject({ missed: [thread] });
  });

  it("archiving the thread keeps it; Trash hides it, and it comes back with the thread", async () => {
    const { client, model, receive, read, clock, sections, raw } = await setup();
    model.answer = () => reply([bill]);
    const thread = await receive();
    await read();
    clock.now = at(2026, 11, 18, 10);
    raw.run("UPDATE messages SET in_inbox = 0 WHERE thread_id = ?", thread);
    raw.run("UPDATE threads SET in_inbox = 0 WHERE id = ?", thread);
    expect(await sections()).toMatchObject({ deadlines: [thread] });
    raw.run("UPDATE messages SET is_trash = 1 WHERE thread_id = ?", thread);
    raw.run("UPDATE threads SET in_trash = 1 WHERE id = ?", thread);
    expect(await sections()).toEqual({});
    expect((await client.call("counts.get", {})).today).toBe(0);
    raw.run("UPDATE messages SET is_trash = 0 WHERE thread_id = ?", thread);
    raw.run("UPDATE threads SET in_trash = 0 WHERE id = ?", thread);
    expect(await sections()).toMatchObject({ deadlines: [thread] });
  });
});

describe("Today's groups (§1)", () => {
  it("one thread once, by precedence: a bill's thread waiting on a reply is the bill; groups in order; the count counts each once", async () => {
    const { client, model, receive, read, clock, raw } = await setup();
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("Flight") ? reply([{ kind: "event", text: "Flight to Madrid", quote: "Flight IB3170", due: "2026-11-19", time: "07:40" }]) : reply([bill]));
    const billThread = await receive();
    const flight = await receive({ from: { name: "Iberia", email: "no-reply@iberia.test" }, subject: "Your trip", bodyText: "Flight IB3170 departs November 19 at 07:40." });
    await read();
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", clock.now - 60_000, billThread);
    clock.now = at(2026, 11, 18, 10);
    const list = await client.call("today.list", { heldIds: [] });
    expect(list.sections.map((x) => x.kind)).toEqual(["deadlines", "plans"]);
    expect(list.sections[0]!.items[0]).toMatchObject({ thread: { id: billThread }, why: { kind: "dated", text: "Pay the electricity bill", item: { kind: "pay", dueDay: "2026-11-20" } } });
    expect(list.sections[1]!.items[0]).toMatchObject({ thread: { id: flight }, why: { item: { kind: "event", timed: true } } });
    expect((await client.call("counts.get", {})).today).toBe(2);
    // the flight is over two hours after it: gone, not Missed
    clock.now = at(2026, 11, 19, 9, 41);
    expect((await client.call("today.list", { heldIds: [] })).sections.map((x) => x.kind)).toEqual(["deadlines"]);
  });

  it("the clock re-arms for the next change, and turning it off empties the dated groups", async () => {
    const { backend, client, model, receive, read } = await setup();
    model.answer = () => reply([bill]);
    await receive();
    await read();
    await backend.today.armClock();
    expect(backend.today.clockNextAt).toBe(at(2026, 11, 17, 9));
    await client.call("settings.update", { dated: { enabled: false } });
    expect((await client.call("today.list", { heldIds: [] })).sections).toEqual([]);
    await backend.today.armClock();
    expect(backend.today.clockNextAt).toBeNull();
  });
});
