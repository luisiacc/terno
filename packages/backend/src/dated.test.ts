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
import { afterEach, describe, expect, it, vi } from "vitest";
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
const reply = (items: Item[] = [], settled: { label: string; evidence: string }[] = [], moved: { label: string; due: string; time: string | null; evidence: string }[] = []): Completion => ({ text: JSON.stringify({ items, settled, moved }), stop: "end" });
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
  it("the third panel round: two items of one kind on one day are kept when their times differ (revision 8)", () => {
    const text = "Keynote on November 20 at 9:30. Tech check on November 20 at 16:00.";
    const keynote = { kind: "event", text: "Keynote", quote: "Keynote on November 20", due: "2026-11-20", time: "09:30" };
    const check = { ...keynote, text: "Tech check", quote: "Tech check on November 20", time: "16:00" };
    expect(checkDates({ items: [keynote, check, { ...check, text: "Tech check again" }], settled: [] }, { ...base, text }).rows.map((r) => r.text)).toEqual(["Keynote", "Tech check"]);
    // and two with no time on one day are one
    expect(checkDates({ items: [{ ...keynote, time: null }, { ...check, time: null }], settled: [] }, { ...base, text }).rows).toHaveLength(1);
  });
  describe("an ask (the third panel round, revision 1)", () => {
    const text = "Hi Lucía, can you send me a quote for the rebranding?";
    const ask = { kind: "ask", text: "Answer Mariana about a rebranding quote", quote: "can you send me a quote for the rebranding", due: null, time: null };
    const named = { ...ask, quote: "Hi Lucía, can you send me a quote" };
    const from = (person: boolean, addressed: "to" | "cc" | "none", name = "Lucía Romero") => ({ ...base, text, sender: { person }, reader: { name, addressed } });
    it("from a person to the reader in To: kept undated, from its arrival", () => {
      expect(checkDates({ items: [ask], settled: [] }, from(true, "to")).rows).toEqual([{ kind: "ask", item: 0, text: ask.text, quote: ask.quote, dueDay: "2026-11-10", dueAt: NOW, timed: false, dated: false, actAt: NOW }]);
    });
    it("never from an automated sender (a list, bulk, no-reply or a role address you never wrote to), nor unknown", () => {
      expect(checkDates({ items: [ask], settled: [] }, from(false, "to")).rows).toEqual([]);
      expect(checkDates({ items: [named], settled: [] }, from(false, "to")).rows).toEqual([]);
      expect(checkDates({ items: [ask], settled: [] }, { ...base, text }).rows).toEqual([]);
    });
    it("the reader only copied, or not named among the recipients: only when the mail names them where it asks", () => {
      const team = { text: "Hi team, can you send me a quote for the rebranding? Thanks, Lucía and Pedro, for the photos." };
      expect(checkDates({ items: [ask], settled: [] }, { ...from(true, "cc"), ...team }).rows).toEqual([]);
      expect(checkDates({ items: [ask], settled: [] }, { ...from(true, "none"), ...team }).rows).toEqual([]);
      expect(checkDates({ items: [ask], settled: [] }, { ...from(true, "to"), ...team }).rows).toHaveLength(1);
      expect(checkDates({ items: [named], settled: [] }, from(true, "cc")).rows).toHaveLength(1);
      expect(checkDates({ items: [named], settled: [] }, from(true, "none", "lucia")).rows).toHaveLength(1);
      // the eval: a model quotes from "can you", the name just before it in the mail ("Lucía, can you…")
      expect(checkDates({ items: [ask], settled: [] }, from(true, "cc")).rows).toHaveLength(1);
      // a word of the name inside another word isn't the name
      expect(checkDates({ items: [named], settled: [] }, from(true, "cc", "Lu")).rows).toEqual([]);
    });
    it("with a day it's a request with a day (`respond`), whoever it's from; one ask a message, none beside a request with a day", () => {
      const dated = { ...ask, due: "2026-11-13" };
      expect(checkDates({ items: [dated], settled: [] }, from(false, "cc")).rows[0]).toMatchObject({ kind: "respond", dueDay: "2026-11-13", dated: true });
      expect(checkDates({ items: [ask, { ...ask, text: "Answer Mariana about the dates" }], settled: [] }, from(true, "to")).rows).toHaveLength(1);
      // the eval: a model gave the request with a day and the same as an ask beside it
      const respond = { ...ask, kind: "respond", text: "Send Mariana a quote", due: "2026-11-13" };
      expect(checkDates({ items: [respond, ask], settled: [] }, from(true, "to")).rows.map((r) => r.kind)).toEqual(["respond"]);
    });
    it("an open ask isn't given a day by a later message", () => {
      const open = new Map([["o1", { id: 4, revision: 0, kind: "ask", dueDay: "2026-11-09" } as DatedRow]]);
      expect(checkDates({ items: [], settled: [], moved: [{ label: "o1", due: "2026-11-13", time: null, evidence: "can you send me a quote" }] }, { ...from(true, "to"), open }).moved).toEqual([]);
    });
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

describe("the Codex code review", () => {
  it("#1: an open item whose conversation went to Spam under a request stops it, and it's asked again without that item", async () => {
    const { backend, model, receive, read, raw } = await setup();
    model.answer = () => reply([bill]);
    const first = await receive();
    await read();
    let release!: () => void;
    model.gate = new Promise((r) => (release = r));
    model.requests.length = 0;
    model.answer = () => reply();
    await receive({ subject: "Reminder", bodyText: "A reminder: your bill is due on November 20." });
    backend.dated.wake();
    await expect.poll(() => model.requests.length).toBe(1);
    expect(promptText(model.requests[0]!.messages[0]!.content)).toContain("<open_items>");
    raw.run("UPDATE messages SET is_spam = 1 WHERE thread_id = ?", first);
    // the limiter's last look, as a repair would take it
    await backend.dated.holdingUp();
    model.gate = null;
    release();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
    expect(model.requests).toHaveLength(2);
    expect(promptText(model.requests[1]!.messages[0]!.content)).not.toContain("<open_items>");
  });

  it("#2: what's over for good is retired, so the open set holds only what can still show", async () => {
    const { backend, client, model, receive, read, clock } = await setup();
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("Flight") ? reply([{ kind: "event", text: "Flight to Madrid", quote: "Flight IB3170", due: "2026-11-19", time: "07:40" }]) : reply([bill]));
    await receive();
    await receive({ from: { name: "Iberia", email: "no-reply@iberia.test" }, subject: "Your trip", bodyText: "Flight IB3170 departs November 19 at 07:40." });
    await read();
    expect(await backend.store.dated.active()).toHaveLength(2);
    // the day's bounds run at its first wake, the flight not over yet
    clock.now = at(2026, 11, 19, 0, 30);
    await backend.dated.daily();
    expect(await backend.store.dated.active()).toHaveLength(2);
    // round 2: the clock wakes as the flight ends, the same day: it's retired then, not the next day
    clock.now = at(2026, 11, 19, 9, 41);
    await backend.dated.daily();
    expect((await backend.store.dated.active()).map((r) => r.kind)).toEqual(["pay"]);
    // past Missed's days the bill goes too
    clock.now = at(2026, 11, 28, 1);
    expect(await backend.dated.retire()).toBe(1);
    expect(await backend.store.dated.active()).toEqual([]);
    expect((await client.call("today.list", { heldIds: [] })).sections).toEqual([]);
  });

  it("#3: the 14-day check picks what the reader would ask about before its bound", async () => {
    const { client, receive, clock } = await setup();
    await receive({ date: clock.now - 3 * DAY, gmailLabels: ["INBOX", "CATEGORY_PROMOTIONS"] }, false);
    await receive({ date: clock.now - 3 * DAY, listId: "news.power.test", subject: "Photos", bodyText: "Here are the photos from our team offsite." }, false);
    await receive({ date: clock.now - 3 * DAY, isSpam: true }, false);
    await receive({ date: clock.now - 3 * DAY }, false);
    await receive({ date: clock.now - 3 * DAY, from: { name: "Ana", email: "ana@people.test" }, subject: "Lunch", bodyText: "Thanks, that sounds great!" }, false);
    expect((await client.call("dated.scanOffer", {})).count).toBe(2);
    expect((await client.call("dated.scan", {})).queued).toBe(2);
  });

  it("round 2: the check also reads a later message that may settle one it reads, and one whose body isn't here yet", async () => {
    const { client, receive, clock } = await setup();
    await receive({ date: clock.now - 4 * DAY }, false);
    // the biller's receipt, no time cue in it: read, since it may settle the bill
    await receive({ date: clock.now - 2 * DAY, listId: "billing.power.test", subject: "Thanks", bodyText: "Paid in full. Your balance is now zero." }, false);
    // someone else's automated mail with no cue: still left out
    await receive({ date: clock.now - 2 * DAY, from: { name: "Shop", email: "news@shop.test" }, listId: "news.shop.test", subject: "Hello", bodyText: "Here are the photos from our team offsite." }, false);
    // an automated notice whose body hasn't come: can't be judged, so read
    await receive({ date: clock.now - 1 * DAY, from: { name: "Bank", email: "alerts@bank.test" }, listId: "alerts.bank.test", subject: "Account notice", bodyText: null, bodyState: "none" }, false);
    expect((await client.call("dated.scanOffer", {})).count).toBe(3);
  });

  it("#4: a dated promise past Missed's days isn't Needs you's again", async () => {
    const { client, receive, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    const thread = await receive({ from: { name: "Ana", email: "ana@people.test" }, subject: "The report", bodyText: "Thanks!" });
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, created_at) VALUES (?, 999999, 0, 'promise', 'send the report', ?, ?, 1, 'due', ?)", thread, clock.now - DAY, at(2026, 11, 12, 9), clock.now);
    clock.now = at(2026, 11, 13, 10);
    expect((await client.call("today.list", { heldIds: [] })).sections.map((x) => x.kind)).toEqual(["missed"]);
    clock.now = at(2026, 11, 20, 10);
    expect((await client.call("today.list", { heldIds: [] })).sections).toEqual([]);
  });

  it("#5: two re-arms at once leave one timer, and stop leaves none", async () => {
    const { backend, model, receive, read } = await setup();
    model.answer = () => reply([bill]);
    await receive();
    await read();
    const live = new Set<unknown>();
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const spySet = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const id = set(fn, ms);
      if (ms !== undefined && ms > 60_000) live.add(id);
      return id;
    }) as typeof setTimeout);
    const spyClear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((id?: Parameters<typeof clearTimeout>[0]) => {
      live.delete(id);
      clear(id);
    }) as typeof clearTimeout);
    try {
      await Promise.all([backend.today.armClock(), backend.today.armClock(), backend.today.armClock()]);
      expect(live.size).toBe(1);
      await backend.today.stop();
      expect(live.size).toBe(0);
    } finally {
      spySet.mockRestore();
      spyClear.mockRestore();
    }
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

describe("after the panel", () => {
  it("a promise row carries the promise it shows; one due in two weeks is Coming up's, one due today is Deadlines'", async () => {
    const { client, receive, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    const later = await receive({ from: { name: "Ana", email: "ana@people.test" }, subject: "The report", bodyText: "Thanks!" });
    const now = await receive({ from: { name: "Tom", email: "tom@people.test" }, subject: "The agenda", bodyText: "Thanks!" });
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, created_at) VALUES (?, 999998, 0, 'promise', 'send the report', ?, ?, 1, 'open', ?)", later, clock.now - DAY, at(2026, 11, 20, 9), clock.now);
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, dated, state, revision, created_at) VALUES (?, 999999, 0, 'promise', 'send the agenda', ?, ?, 1, 'due', 3, ?)", now, clock.now - DAY, at(2026, 11, 10, 17), clock.now);
    const list = await client.call("today.list", { heldIds: [] });
    const coming = list.sections.find((x) => x.kind === "comingUp")!.items[0]!;
    expect(coming).toMatchObject({ thread: { id: later }, why: { kind: "promise", text: "send the report", promise: { revision: 0 } } });
    const today = list.sections.find((x) => x.kind === "deadlines")!.items[0]!;
    expect(today).toMatchObject({ thread: { id: now }, why: { kind: "promise", promise: { revision: 3, dated: true } } });
    // Coming up isn't counted
    expect((await client.call("counts.get", {})).today).toBe(1);
  });

  it("inside a group: by day, then the timed ones by time, then the untimed", async () => {
    const { client, model, receive, read, clock } = await setup();
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      if (p.includes("payroll")) return reply([{ kind: "pay", text: "Fund payroll", quote: "payroll by 1:00 PM", due: "2026-11-13", time: "13:00" }]);
      if (p.includes("domain")) return reply([{ kind: "renew", text: "Renew the domain", quote: "domain expires", due: "2026-11-13", time: null }]);
      return reply([{ kind: "pay", text: "Pay the bill", quote: "due on November 12", due: "2026-11-12", time: null }]);
    };
    const payroll = await receive({ subject: "Payroll", bodyText: "Fund payroll by 1:00 PM today." });
    const domain = await receive({ from: { name: "Registrar", email: "bot@registrar.test" }, subject: "Domain", bodyText: "Your domain expires today." });
    const bill = await receive({ from: { name: "Gas", email: "bills@gas.test" }, subject: "Gas bill", bodyText: "Your bill is due on November 12." });
    await read();
    clock.now = at(2026, 11, 12, 10);
    const deadlines = (await client.call("today.list", { heldIds: [] })).sections.find((x) => x.kind === "deadlines")!;
    expect(deadlines.items.map((i) => i.thread.id)).toEqual([bill, payroll, domain]);
    // Codex code review of the fixes: Coming up orders the same way (earlier, the untimed 9:00 came first)
    clock.now = at(2026, 11, 8, 10);
    const coming = (await client.call("today.list", { heldIds: [] })).sections.find((x) => x.kind === "comingUp")!;
    expect(coming.items.map((i) => i.thread.id)).toEqual([bill, payroll, domain]);
  });

  it("Codex code review of the fixes: a thread with two items the same day shows the timed one", async () => {
    const { client, model, receive, read, clock } = await setup();
    model.answer = () => reply([
      { kind: "renew", text: "Renew the plan", quote: "renews", due: "2026-11-13", time: null },
      { kind: "pay", text: "Fund payroll", quote: "payroll by 1:00 PM", due: "2026-11-13", time: "13:00" },
    ]);
    await receive({ subject: "Payroll", bodyText: "Your plan renews today, and fund payroll by 1:00 PM." });
    await read();
    clock.now = at(2026, 11, 13, 10);
    const [row] = (await client.call("today.list", { heldIds: [] })).sections.find((x) => x.kind === "deadlines")!.items;
    expect(row!.why).toMatchObject({ text: "Fund payroll", item: { timed: true } });
  });
});

describe("a later message moves a day (after the panel)", () => {
  const row = { id: 9, revision: 2, kind: "respond", dueDay: "2026-11-10" } as DatedRow;
  const base = { text: "Friday at the latest works for us, 2026-11-13.", subject: "Re: script", arrivedAt: NOW, open: new Map([["o1", row]]), fromScan: false, now: NOW };

  it("quoted, a real day from this message, a label it was shown; settled wins; the same kind on the new day isn't added", () => {
    const moved = { label: "o1", due: "2026-11-13", time: null, evidence: "Friday at the latest works for us" };
    expect(checkDates({ items: [], settled: [], moved: [moved] }, base).moved).toMatchObject([{ id: 9, dueDay: "2026-11-13" }]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, evidence: "words nobody wrote" }] }, base).moved).toEqual([]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, label: "o9" }] }, base).moved).toEqual([]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, due: "2026-11-01" }] }, base).moved).toEqual([]);
    expect(checkDates({ items: [], settled: [{ label: "o1", evidence: "works for us" }], moved: [moved] }, base).moved).toEqual([]);
    const both = checkDates({ items: [{ kind: "respond", text: "Send the script", quote: "Friday at the latest", due: "2026-11-13", time: null }], settled: [], moved: [moved] }, base);
    expect(both.rows).toEqual([]);
    expect(both.moved).toHaveLength(1);
  });

  it("Theo's script: Missed by Tuesday's day, then 'Friday at the latest' moves it back to Deadlines, the same item", async () => {
    const { backend, client, model, receive, read, clock } = await setup();
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      if (p.includes("at the latest")) return reply([], [], [{ label: "o1", due: "2026-11-13", time: null, evidence: "Friday at the latest" }]);
      return reply([{ kind: "respond", text: "Send the sponsor script", quote: "send the script by Tuesday", due: "2026-11-10", time: null }]);
    };
    const thread = await receive({ from: { name: "Jess", email: "jess@sponsor.test" }, subject: "Script", bodyText: "Can you send the script by Tuesday?", providerThreadId: "jess" });
    await read();
    clock.now = at(2026, 11, 12, 9);
    expect((await client.call("today.list", { heldIds: [] })).sections.map((x) => x.kind)).toEqual(["missed"]);
    const [before] = await backend.store.dated.active();
    await receive({ from: { name: "Jess", email: "jess@sponsor.test" }, subject: "Re: Script", bodyText: "No stress. Friday at the latest is fine.", providerThreadId: "jess" });
    await read();
    const [after] = await backend.store.dated.active();
    expect(after).toMatchObject({ id: before!.id, dueDay: "2026-11-13" });
    const list = await client.call("today.list", { heldIds: [] });
    expect(list.sections.map((x) => x.kind)).toEqual(["deadlines"]);
    expect(list.sections[0]!.items[0]!.thread.id).toBe(thread);
  });
});

describe("a later message moves a promise you made (the second panel round)", () => {
  it("Theo's script: his promise for Tuesday, then Jess's 'Friday at the latest' gives it Friday; a stranger can't touch it", async () => {
    const { backend, client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      // the promise is offered only to the person it was made to
      if (p.includes("p1 (promise)")) return reply([], [], [{ label: "p1", due: "2026-11-13", time: null, evidence: "Friday at the latest" }]);
      return reply();
    };
    const thread = await receive({ from: { name: "Jess", email: "jess@sponsor.test" }, subject: "Script", bodyText: "Looking forward to it.", providerThreadId: "jess" });
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, created_at) VALUES (?, 999997, 0, 'promise', 'send the script', 'Jess', 'jess@sponsor.test', ?, ?, 1, 'due', ?)", thread, clock.now - DAY, at(2026, 11, 10, 9), clock.now);
    const [before] = await backend.store.followups.ofThread(thread);
    // a stranger on the thread: the promise isn't offered, nothing moves
    model.requests.length = 0;
    await receive({ from: { name: "Mallory", email: "mallory@else.test" }, subject: "Re: Script", bodyText: "Friday at the latest, 2026-11-20.", providerThreadId: "jess" });
    await read();
    expect(promptText(model.requests.at(-1)!.messages[0]!.content)).not.toContain("p1 (promise)");
    expect((await backend.store.followups.get(before!.id))!.dueAt).toBe(at(2026, 11, 10, 9));
    // Jess herself
    await receive({ from: { name: "Jess", email: "jess@sponsor.test" }, subject: "Re: Script", bodyText: "No stress. Friday at the latest is fine.", providerThreadId: "jess" });
    await read();
    const after = (await backend.store.followups.get(before!.id))!;
    expect(after).toMatchObject({ dated: true, revision: before!.revision + 1 });
    expect(new Date(after.dueAt).getDate()).toBe(13);
    // no longer Missed: it's today's
    clock.now = at(2026, 11, 13, 10);
    const sections = (await client.call("today.list", { heldIds: [] })).sections;
    expect(sections.find((x) => x.kind === "missed")).toBeUndefined();
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

  it("the third panel round: a person's ask is Needs you's, its line and counted, over a plain waiting row, until its window ends; one from a list isn't kept", async () => {
    const { backend, client, model, receive, read, clock, raw } = await setup();
    const mariana = { name: "Mariana Paz", email: "mariana@studio.test" };
    const text = "Hi, can you send me a quote for the rebranding?";
    model.answer = () => reply([{ kind: "ask", text: "Answer Mariana about a rebranding quote", quote: "can you send me a quote for the rebranding", due: null, time: null }]);
    const asked = await receive({ from: mariana, subject: "Rebranding", bodyText: text });
    const listed = await receive({ from: mariana, subject: "Rebranding news", bodyText: text, listId: "news.studio.test" });
    await read();
    expect((await backend.store.dated.active()).map((r) => [r.threadId, r.kind])).toEqual([[asked, "ask"]]);
    // waiting on you too (you've written in it): one row, the ask's
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", clock.now - 60_000, asked);
    const list = await client.call("today.list", { heldIds: [] });
    expect(list.sections.map((x) => x.kind)).toEqual(["needsYou"]);
    expect(list.sections[0]!.items).toHaveLength(1);
    expect(list.sections[0]!.items[0]).toMatchObject({ thread: { id: asked }, why: { kind: "dated", text: "Answer Mariana about a rebranding quote", item: { kind: "ask", dated: false, timed: false } } });
    expect((await client.call("counts.get", {})).today).toBe(1);
    expect(listed).not.toBe(asked);
    // a month on, it's over: retired, never Missed
    const row = (await backend.store.dated.active())[0]!;
    clock.now = row.arrivedAt + 30 * DAY - 1;
    expect((await client.call("today.list", { heldIds: [] })).sections.flatMap((x) => x.items.map((i) => i.why.kind))).toContain("dated");
    clock.now = row.arrivedAt + 30 * DAY;
    raw.run("UPDATE threads SET waiting_since = NULL WHERE id = ?", asked);
    expect((await client.call("today.list", { heldIds: [] })).sections).toEqual([]);
    expect(await backend.dated.retire()).toBe(1);
    expect(await backend.store.dated.get(row.id)).toMatchObject({ state: "dismissed", closedReason: "expired" });
  });

  it("the clock re-arms for the next change, and turning it off empties the dated groups", async () => {
    const { backend, client, model, receive, read } = await setup();
    model.answer = () => reply([bill]);
    await receive();
    await read();
    await backend.today.armClock();
    expect(backend.today.clockNextAt).toBe(at(2026, 11, 11));
    await client.call("settings.update", { dated: { enabled: false } });
    expect((await client.call("today.list", { heldIds: [] })).sections).toEqual([]);
    await backend.today.armClock();
    expect(backend.today.clockNextAt).toBeNull();
  });
});

describe("the third panel round", () => {
  const followup = (thread: number, text: string, dueAt: number, o: { kind?: string; state?: string; dated?: number; message?: number; revision?: number } = {}) =>
    [`INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, revision, created_at) VALUES (?, ?, 0, ?, ?, 'Elena', 'elena@acme.test', ?, ?, ?, ?, ?, ?)`, thread, o.message ?? 900_000 + thread, o.kind ?? "promise", text, NOW - 3 * DAY, dueAt, o.dated ?? 1, o.state ?? "open", o.revision ?? 0, NOW] as const;

  it("change 3: a promise due today is a deadline from its day's start, by day with the dated items; a nudge stays in Needs you", async () => {
    const { client, model, receive, read, raw, clock, sections } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("electricity") ? reply([bill]) : reply());
    const billThread = await receive();
    const agenda = await receive({ from: { name: "Tom", email: "tom@people.test" }, subject: "The agenda", bodyText: "Looking forward to it." });
    const nudge = await receive({ from: { name: "Ana", email: "ana@people.test" }, subject: "The quote", bodyText: "Looking forward to it." });
    await read();
    raw.run(...followup(agenda, "send the agenda", at(2026, 11, 19, 9)));
    raw.run(...followup(nudge, "Ana", at(2026, 11, 18, 9), { kind: "awaiting", dated: 0, state: "due" }));
    // 8:00 on the promise's day: before its 9:00, it's already today's
    clock.now = at(2026, 11, 19, 8);
    expect(await sections()).toEqual({ deadlines: [agenda, billThread], needsYou: [nudge] });
    expect((await client.call("counts.get", {})).today).toBe(3);
    // the day before: Coming up
    clock.now = at(2026, 11, 18, 10);
    expect(await sections()).toMatchObject({ deadlines: [billThread], comingUp: [agenda] });
  });

  it("change 2: a waiting conversation with your promise shows the one due soonest, exactly; Later keeps it the conversation's, at its new day", async () => {
    const { client, receive, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    // Elena's "gentle nudge" on the October update, after Priya promised it
    const elena = await receive({ from: { name: "Elena", email: "elena@acme.test" }, subject: "Re: October update", bodyText: "Gentle nudge on the October update, by Monday if you can." });
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", clock.now - 60_000, elena);
    raw.run(...followup(elena, "send the board deck", at(2026, 11, 20, 9), { message: 900_001 }));
    raw.run(...followup(elena, "send the October update", at(2026, 11, 17, 9), { message: 900_002, revision: 2 }));
    clock.now = at(2026, 11, 14, 10);
    const row = async () => {
      const list = await client.call("today.list", { heldIds: [] });
      expect(list.sections.map((x) => x.kind)).toEqual(["needsYou"]);
      return list.sections[0]!.items[0]!;
    };
    const first = await row();
    expect(first).toMatchObject({ thread: { id: elena }, why: { kind: "promise", text: "send the October update", dueAt: at(2026, 11, 17, 9), promise: { revision: 2, dated: true } } });
    // its line is the promise, so no summary is read for it
    expect(first.summary).toBeUndefined();
    expect((await client.call("counts.get", {})).today).toBe(1);
    // Later on exactly it: the deck is now the soonest
    await client.call("followups.act", { id: first.why.promise!.id, revision: 2, action: "later", dueAt: at(2026, 11, 23, 9) });
    const second = await row();
    expect(second.why).toMatchObject({ text: "send the board deck", dueAt: at(2026, 11, 20, 9) });
    // Done on the deck: the October update is the conversation's promise again, at its new day
    await client.call("followups.act", { id: second.why.promise!.id, revision: second.why.promise!.revision, action: "done" });
    expect((await row()).why).toMatchObject({ text: "send the October update", dueAt: at(2026, 11, 23, 9), promise: { id: first.why.promise!.id } });
  });
});
