/**
 * Plan 204 through the real backend (RPC, settings, limiter, SQLite), with a scripted model and clock: nothing leaves this
 * process. What the store guarantees has its rows in the conformance suite; here, what the reader, its checks and Today do.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig } from "@terno/ai";
import { TODAY_COUNTED, type DatedRow } from "@terno/core";
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
type Moved = { label: string; due: string; time: string | null; evidence: string; text?: string | null; textEvidence?: string | null };
const reply = (items: Item[] = [], settled: { label: string; evidence: string }[] = [], moved: Moved[] = []): Completion => ({ text: JSON.stringify({ items, settled, moved: moved.map((m) => ({ text: null, textEvidence: null, ...m })) }), stop: "end" });
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
    it("with a day it's a request with a day (`respond`) when it's an ask at all; one ask a message, none beside a request with a day", () => {
      const dated = { ...ask, due: "2026-11-13" };
      expect(checkDates({ items: [dated], settled: [] }, from(true, "to")).rows[0]).toMatchObject({ kind: "respond", dueDay: "2026-11-13", dated: true });
      // revision 2 of the fourth round: checked as an ask first, an automated sender's or a third person's is dropped
      expect(checkDates({ items: [dated], settled: [] }, from(false, "to")).rows).toEqual([]);
      expect(checkDates({ items: [dated], settled: [] }, { ...from(true, "cc"), text: "Hi team, can you send me a quote for the rebranding?" }).rows).toEqual([]);
      expect(checkDates({ items: [dated], settled: [] }, { ...base, text }).rows).toEqual([]);
      expect(checkDates({ items: [ask, { ...ask, text: "Answer Mariana about the dates" }], settled: [] }, from(true, "to")).rows).toHaveLength(1);
      // the eval: a model gave the request with a day and the same as an ask beside it
      const respond = { ...ask, kind: "respond", text: "Send Mariana a quote", due: "2026-11-13" };
      expect(checkDates({ items: [respond, ask], settled: [] }, from(true, "to")).rows.map((r) => r.kind)).toEqual(["respond"]);
    });
    it("Codex code review (round 4): a later message's day makes an open ask the request it now is, a `respond` on that day", () => {
      const open = new Map([["o1", { id: 4, revision: 2, kind: "ask", dueDay: "2026-11-09", text: "Answer Mariana about a rebranding quote" } as DatedRow]]);
      const out = checkDates({ items: [], settled: [], moved: [{ label: "o1", due: "2026-11-13", time: null, evidence: "can you send me a quote" }] }, { ...from(true, "to"), open });
      expect(out.moved).toEqual([]);
      expect(out.settled).toEqual([{ id: 4, revision: 2 }]);
      expect(out.rows).toEqual([expect.objectContaining({ kind: "respond", text: "Answer Mariana about a rebranding quote", quote: "can you send me a quote", dueDay: "2026-11-13", dated: true })]);
      // and the words have to be the mail's
      expect(checkDates({ items: [], settled: [], moved: [{ label: "o1", due: "2026-11-13", time: null, evidence: "by Friday please" }] }, { ...from(true, "to"), open }).rows).toEqual([]);
    });
    it("the fourth panel read: a mail that says no answer is needed asks nothing", () => {
      const fyi = { ...from(true, "to"), text: "Drinks when you're back from Chicago? No need to reply now, I know you're slammed." };
      const drinks = { ...ask, text: "Tell Maya about drinks", quote: "Drinks when you're back from Chicago" };
      expect(checkDates({ items: [drinks], settled: [] }, fyi).rows).toEqual([]);
      expect(checkDates({ items: [drinks], settled: [] }, { ...fyi, text: "Drinks when you're back from Chicago?" }).rows).toHaveLength(1);
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

  it("after the fourth panel round: a sender named like a security desk is never asked about, and keeps nothing", async () => {
    const { backend, client, model, receive, read } = await setup();
    model.answer = () => reply([{ kind: "alert", text: "Online banking access suspended", quote: "access temporarily suspended", due: null, time: null }]);
    const thread = await receive({ from: { name: "Tri-River FCU", email: "security@tririver-fcu-alerts.com" }, subject: "Online banking access temporarily suspended", bodyText: "Your online banking access temporarily suspended. Verify by November 12." });
    await read();
    expect(model.requests).toHaveLength(0);
    expect((await client.call("dated.ofThread", { threadId: thread })).rows).toEqual([]);
    // the real bank's own mail is read
    await receive({ from: { name: "Tri-River FCU", email: "alerts@tririverfcu.org" }, subject: "Online banking access temporarily suspended", bodyText: "Your online banking access temporarily suspended. Verify by November 12." });
    await read();
    expect(model.requests).toHaveLength(1);
    expect(await backend.store.dated.active()).toHaveLength(1);
  });

  it("Codex's second pass: someone you've written to is trusted, whatever their domain's words", async () => {
    const { backend, model, receive, read, raw } = await setup();
    model.answer = () => reply([bill]);
    raw.run("INSERT INTO correspondents (email, written) VALUES (?, 1)", "jane@acme-support.com");
    await receive({ from: { name: "Jane", email: "Jane+billing@Acme-Support.com" } });
    await read();
    expect(model.requests).toHaveLength(1);
    expect(await backend.store.dated.active()).toHaveLength(1);
    // her colleague, never written to, isn't
    await receive({ from: { name: "Mo", email: "mo@acme-support.com" } });
    await read();
    expect(model.requests).toHaveLength(1);
  });

  it("Codex's second pass: an item stored from a suspicious sender before the guard isn't shown, counted or in its conversation, unless you've written to them", async () => {
    const { backend, client, model, receive, read, raw, clock } = await setup();
    model.answer = () => reply([bill]);
    const thread = await receive();
    await read();
    // as if read before the guard existed
    raw.run("UPDATE dated_items SET sender_key = ?", "security@tririver-fcu-alerts.com");
    backend.today.touched();
    clock.now = at(2026, 11, 18, 10);
    expect((await client.call("today.list", { heldIds: [] })).sections).toEqual([]);
    expect((await client.call("counts.get", {})).today).toBe(0);
    expect((await client.call("dated.ofThread", { threadId: thread })).rows).toEqual([]);
    raw.run("INSERT INTO correspondents (email, written) VALUES (?, 1)", "security@tririver-fcu-alerts.com");
    backend.today.touched();
    expect((await client.call("today.list", { heldIds: [] })).sections.map((x) => x.kind)).toEqual(["deadlines"]);
    expect((await client.call("counts.get", {})).today).toBe(1);
    expect((await client.call("dated.ofThread", { threadId: thread })).rows).toHaveLength(1);
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

describe("a later message moves an item's time (the fourth panel round, revision 5)", () => {
  const game = { id: 9, revision: 2, kind: "event", dueDay: "2026-11-14", dueAt: at(2026, 11, 14, 10), timed: true } as DatedRow;
  const base = { text: "Heads up: Saturday's game is moved earlier to 8:00 AM, same field.", subject: "Re: Saturday", arrivedAt: NOW, open: new Map([["o1", game]]), fromScan: false, now: NOW };
  const moved = { label: "o1", due: "2026-11-14", time: "08:00", evidence: "moved earlier to 8:00 AM" };

  it("a new moment on the same day moves a timed item; the same moment, or no time, keeps it where it is", () => {
    expect(checkDates({ items: [], settled: [], moved: [moved] }, base).moved).toEqual([{ id: 9, dueDay: "2026-11-14", dueAt: at(2026, 11, 14, 8), timed: true, actAt: at(2026, 11, 13, 9) }]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, time: "10:00" }] }, base).moved).toEqual([]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, time: null }] }, base).moved).toEqual([]);
    // an untimed item given a moment on its day takes it; another day with no time is the day's move it was
    const bill = { ...game, kind: "pay", dueDay: "2026-11-20", dueAt: at(2026, 11, 20, 9), timed: false } as DatedRow;
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, due: "2026-11-20", time: "17:00" }] }, { ...base, open: new Map([["o1", bill]]) }).moved).toMatchObject([{ dueAt: at(2026, 11, 20, 17), timed: true }]);
    // the Codex code review of the fourth round: "at 9:00" is a time, though an untimed item already sorts at 9:00
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, due: "2026-11-20", time: "09:00" }] }, { ...base, open: new Map([["o1", bill]]) }).moved).toMatchObject([{ dueAt: at(2026, 11, 20, 9), timed: true }]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, due: "2026-11-15", time: null }] }, base).moved).toMatchObject([{ dueDay: "2026-11-15", timed: false }]);
    // the item at its new moment isn't added beside the move
    const both = checkDates({ items: [{ kind: "event", text: "Soccer game", quote: "Saturday's game", due: "2026-11-14", time: "08:00" }], settled: [], moved: [moved] }, base);
    expect(both.rows).toEqual([]);
    expect(both.moved).toHaveLength(1);
  });

  it("the same item, its Later kept: Later, then the move, then Undo; the move, then Later, then Undo", async () => {
    const { backend, client, model, receive, read } = await setup();
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      if (p.includes("moved earlier")) return reply([], [], [moved]);
      if (p.includes("still on")) return reply([], [], [{ ...moved, time: null, evidence: "still on" }]);
      return reply([{ kind: "event", text: "Soccer game", quote: "game on Saturday at 10:00", due: "2026-11-14", time: "10:00" }]);
    };
    const coach = { name: "Coach Ray", email: "ray@club.test" };
    const thread = await receive({ from: coach, subject: "Saturday", bodyText: "Reminder: the game on Saturday at 10:00.", providerThreadId: "game" });
    await read();
    const [row] = (await client.call("dated.ofThread", { threadId: thread })).rows;
    const later = await client.call("dated.act", { id: row!.id, revision: row!.revision, action: "later", until: at(2026, 11, 12, 9) });
    await receive({ from: coach, subject: "Re: Saturday", bodyText: base.text, providerThreadId: "game" });
    await read();
    // the Codex code review of the fourth round: the model is shown the item's day and time, so it can say the same day
    expect(promptText(model.requests.at(-1)!.messages[0]!.content)).toContain("o1 (event, 2026-11-14 10:00): Soccer game");
    expect(await backend.store.dated.get(row!.id)).toMatchObject({ dueDay: "2026-11-14", dueAt: at(2026, 11, 14, 8), timed: true, deferredUntil: at(2026, 11, 12, 9), state: "open" });
    await client.call("dated.undo", { undoId: later.undoId! });
    const moved8 = (await backend.store.dated.get(row!.id))!;
    expect(moved8).toMatchObject({ dueAt: at(2026, 11, 14, 8), deferredUntil: null });
    const again = await client.call("dated.act", { id: row!.id, revision: moved8.revision, action: "later", until: at(2026, 11, 13, 9) });
    await client.call("dated.undo", { undoId: again.undoId! });
    expect(await backend.store.dated.get(row!.id)).toMatchObject({ dueAt: at(2026, 11, 14, 8), deferredUntil: null, state: "open" });
    // "still on", the same day and no time: it keeps 8:00
    await receive({ from: coach, subject: "Re: Saturday", bodyText: "The game is still on, rain or shine.", providerThreadId: "game" });
    await read();
    expect((await backend.store.dated.active()).map((r) => [r.id, r.dueAt])).toEqual([[row!.id, at(2026, 11, 14, 8)]]);
  });
});

describe("a move may carry the item's new words (the fifth panel round, change 2)", () => {
  const game = { id: 9, revision: 2, kind: "event", text: "Soccer game (arrive 9:30)", dueDay: "2026-11-14", dueAt: at(2026, 11, 14, 10), timed: true } as DatedRow;
  const text = "Saturday's game vs the Rattlers is moved EARLIER to 8:00 AM. Please arrive by 7:30.";
  const base = { text, subject: "Re: Saturday", arrivedAt: NOW, open: new Map([["o1", game]]), fromScan: false, now: NOW };
  const moved = { label: "o1", due: "2026-11-14", time: "08:00", evidence: "moved EARLIER to 8:00 AM", text: "Soccer game (arrive 7:30)", textEvidence: "Please arrive by 7:30" };

  it("quoted from this mail, with the move; without the mail's own words, or for a promise, the words stay", () => {
    expect(checkDates({ items: [], settled: [], moved: [moved] }, base).moved).toEqual([{ id: 9, dueDay: "2026-11-14", dueAt: at(2026, 11, 14, 8), timed: true, actAt: at(2026, 11, 13, 9), text: "Soccer game (arrive 7:30)" }]);
    // words the mail doesn't have, or none: the move lands, the words stay
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, textEvidence: "arrive whenever you like" }] }, base).moved).toEqual([expect.not.objectContaining({ text: expect.anything() })]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, textEvidence: null }] }, base).moved[0]).not.toHaveProperty("text");
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, text: " " }] }, base).moved[0]).not.toHaveProperty("text");
    // no move (the same moment), no new words
    expect(checkDates({ items: [], settled: [], moved: [{ ...moved, time: "10:00" }] }, base).moved).toEqual([]);
    // a promise of yours keeps its words: another person's can't become "You said"
    const promises = new Map([["p1", { id: 5, revision: 1 }]]);
    const out = checkDates({ items: [], settled: [], moved: [{ ...moved, label: "p1", due: "2026-11-13" }] }, { ...base, promises });
    expect(out.movedPromises).toEqual([{ id: 5, revision: 1, dueAt: expect.any(Number) }]);
    expect(JSON.stringify(out)).not.toContain("arrive 7:30");
  });

  it("an ask a day turns into a request keeps its words, unless the move gives new ones from the mail", () => {
    const ask = { id: 4, revision: 2, kind: "ask", dueDay: "2026-11-09", text: "Answer Mariana about a rebranding quote" } as DatedRow;
    const mail = { ...base, text: "Can you send me the quote by Friday? Two options, please.", open: new Map([["o1", ask]]), sender: { person: true }, reader: { name: "Lucía", addressed: "to" as const } };
    const dated = { label: "o1", due: "2026-11-13", time: null, evidence: "send me the quote by Friday" };
    expect(checkDates({ items: [], settled: [], moved: [dated] }, mail).rows).toEqual([expect.objectContaining({ kind: "respond", text: "Answer Mariana about a rebranding quote" })]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...dated, text: "Send Mariana two quote options", textEvidence: "Two options, please" }] }, mail).rows).toEqual([expect.objectContaining({ kind: "respond", text: "Send Mariana two quote options" })]);
    expect(checkDates({ items: [], settled: [], moved: [{ ...dated, text: "Send Mariana two quote options", textEvidence: "three options" }] }, mail).rows).toEqual([expect.objectContaining({ text: "Answer Mariana about a rebranding quote" })]);
  });

  it("the game's words with its time, through the reader; Later, then the move, then Undo keeps both and gives back the deferral", async () => {
    const { backend, client, model, receive, read } = await setup();
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      if (p.includes("moved EARLIER")) return reply([], [], [moved]);
      return reply([{ kind: "event", text: "Soccer game (arrive 9:30)", quote: "game on Saturday at 10:00", due: "2026-11-14", time: "10:00" }]);
    };
    const coach = { name: "Coach Ray", email: "ray@club.test" };
    const thread = await receive({ from: coach, subject: "Saturday", bodyText: "Reminder: the game on Saturday at 10:00. Arrive by 9:30.", providerThreadId: "game" });
    await read();
    const [row] = (await client.call("dated.ofThread", { threadId: thread })).rows;
    const later = await client.call("dated.act", { id: row!.id, revision: row!.revision, action: "later", until: at(2026, 11, 12, 9) });
    await receive({ from: coach, subject: "Re: Saturday", bodyText: text, providerThreadId: "game" });
    await read();
    await client.call("dated.undo", { undoId: later.undoId! });
    expect(await backend.store.dated.get(row!.id)).toMatchObject({ text: "Soccer game (arrive 7:30)", dueAt: at(2026, 11, 14, 8), deferredUntil: null, state: "open" });
  });
});

describe("a later message moves a promise you made (the second panel round)", () => {
  it("Theo's script: his promise for Tuesday, then Jess's 'Friday at the latest' gives it Friday; a stranger can't touch it", async () => {
    const { backend, client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = (req) => {
      const p = promptText(req.messages[0]!.content);
      // the promise is offered only to the person it was made to
      if (p.includes("p1 (promise, 2026-11-10)")) return reply([], [], [{ label: "p1", due: "2026-11-13", time: null, evidence: "Friday at the latest" }]);
      return reply();
    };
    const thread = await receive({ from: { name: "Jess", email: "jess@sponsor.test" }, subject: "Script", bodyText: "Looking forward to it.", providerThreadId: "jess" });
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, created_at) VALUES (?, 999997, 0, 'promise', 'send the script', 'Jess', 'jess@sponsor.test', ?, ?, 1, 'due', ?)", thread, clock.now - DAY, at(2026, 11, 10, 9), clock.now);
    const [before] = await backend.store.followups.ofThread(thread);
    // a stranger on the thread: the promise isn't offered, nothing moves
    model.requests.length = 0;
    await receive({ from: { name: "Mallory", email: "mallory@else.test" }, subject: "Re: Script", bodyText: "Friday at the latest, 2026-11-20.", providerThreadId: "jess" });
    await read();
    expect(promptText(model.requests.at(-1)!.messages[0]!.content)).not.toContain("p1 (promise");
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
    // the third panel round: a Plan isn't something you owe, so the count is the bill alone, even with the flight's
    // thread waiting on a reply (it shows as the Plan, so the count agrees with the list)
    expect((await client.call("counts.get", {})).today).toBe(1);
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", clock.now - 60_000, flight);
    expect((await client.call("today.list", { heldIds: [] })).sections.map((x) => [x.kind, x.items.map((i) => i.thread.id)])).toEqual([["deadlines", [billThread]], ["plans", [flight]]]);
    expect((await client.call("counts.get", {})).today).toBe(1);
    raw.run("UPDATE threads SET waiting_since = NULL, has_sent = 0 WHERE id = ?", flight);
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

  it("change 3: a promise is a deadline from a week before its day (the fifth panel round), by day with the dated items; a nudge stays in Needs you", async () => {
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
    // the fifth panel round: a week before its day, from 9:00, as a request's (the bill's week starts a day later)
    clock.now = at(2026, 11, 12, 9);
    expect(await sections()).toMatchObject({ deadlines: [agenda], comingUp: [billThread] });
    clock.now = at(2026, 11, 12, 8, 59);
    expect(await sections()).toMatchObject({ comingUp: [agenda, billThread] });
  });

  it("change 2: a waiting conversation with your promise shows the one due soonest, exactly; one put off is none's until it's back (the fifth panel round)", async () => {
    const { client, receive, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    // Elena's "gentle nudge" on the October update, after Priya promised it
    const elena = await receive({ from: { name: "Elena", email: "elena@acme.test" }, subject: "Re: October update", bodyText: "Gentle nudge on the October update, by Monday if you can." });
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", clock.now - 60_000, elena);
    // past their week's lead (Coming up's), so the conversation is Needs you's
    raw.run(...followup(elena, "send the board deck", at(2026, 11, 28, 9), { message: 900_001 }));
    raw.run(...followup(elena, "send the October update", at(2026, 11, 25, 9), { message: 900_002, revision: 2 }));
    clock.now = at(2026, 11, 14, 10);
    const row = async () => {
      const list = await client.call("today.list", { heldIds: [] });
      expect(list.sections.map((x) => x.kind)).toEqual(["needsYou"]);
      return list.sections[0]!.items[0]!;
    };
    const first = await row();
    expect(first).toMatchObject({ thread: { id: elena }, why: { kind: "promise", text: "send the October update", dueAt: at(2026, 11, 25, 9), promise: { revision: 2, dated: true } } });
    // its line is the promise, so no summary is read for it
    expect(first.summary).toBeUndefined();
    expect((await client.call("counts.get", {})).today).toBe(1);
    // Later on exactly it: its day stays, and the deck is the conversation's promise meanwhile
    await client.call("followups.act", { id: first.why.promise!.id, revision: 2, action: "later", dueAt: at(2026, 11, 26, 9) });
    const second = await row();
    expect(second.why).toMatchObject({ text: "send the board deck", dueAt: at(2026, 11, 28, 9) });
    // Done on the deck: the conversation's only open promise is put off, so it waits for it in Coming up, not counted
    await client.call("followups.act", { id: second.why.promise!.id, revision: second.why.promise!.revision, action: "done" });
    const waits = await client.call("today.list", { heldIds: [] });
    expect(waits.sections.map((x) => [x.kind, x.items.map((i) => i.thread.id)])).toEqual([["comingUp", [elena]]]);
    expect(waits.sections[0]!.items[0]!.why).toMatchObject({ text: "send the October update", dueAt: at(2026, 11, 25, 9), promise: { id: first.why.promise!.id } });
    expect((await client.call("counts.get", {})).today).toBe(0);
    // back after its day: Missed, for a week from then
    clock.now = at(2026, 11, 26, 9);
    const back = await client.call("today.list", { heldIds: [] });
    expect(back.sections.map((x) => [x.kind, x.items.map((i) => i.thread.id)])).toEqual([["missed", [elena]]]);
    expect((await client.call("counts.get", {})).today).toBe(1);
  });

  it("Codex code review (round 4): an ask in a conversation where you'd promised them something shows your promise", async () => {
    const { client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = () => reply([{ kind: "ask", text: "Send Elena the report", quote: "could you send that report", due: null, time: null }]);
    const elena = await receive({ from: { name: "Elena", email: "elena@acme.test" }, subject: "Re: the report", bodyText: "Hi, could you send that report?" });
    await read();
    // past its week's lead, so the conversation is the ask's (the fifth panel round)
    raw.run(...followup(elena, "send the report", at(2026, 11, 28, 9), { revision: 3 }));
    clock.now = at(2026, 11, 14, 10);
    const list = await client.call("today.list", { heldIds: [] });
    expect(list.sections.map((x) => x.kind)).toEqual(["needsYou"]);
    expect(list.sections[0]!.items[0]).toMatchObject({ thread: { id: elena }, why: { kind: "promise", text: "send the report", promise: { revision: 3 } } });
  });

  it("change 6: Later before a timed item's own moment while it's ahead, anywhere once Missed; a promise's Later any moment, its day kept (the fifth panel round)", async () => {
    const { client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("payroll") ? reply([{ kind: "pay", text: "Fund payroll", quote: "payroll by 1:00 PM", due: "2026-11-13", time: "13:00" }]) : reply());
    const payroll = await receive({ subject: "Payroll", bodyText: "Fund payroll by 1:00 PM on Friday." });
    await read();
    clock.now = at(2026, 11, 13, 10);
    const [item] = (await client.call("dated.ofThread", { threadId: payroll })).rows;
    await expect(client.call("dated.act", { id: item!.id, revision: item!.revision, action: "later", until: at(2026, 11, 13, 13) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok = await client.call("dated.act", { id: item!.id, revision: item!.revision, action: "later", until: at(2026, 11, 13, 12) });
    await client.call("dated.undo", { undoId: ok.undoId! });
    // Missed: every moment ahead
    clock.now = at(2026, 11, 14, 10);
    const [missed] = (await client.call("dated.ofThread", { threadId: payroll })).rows;
    await client.call("dated.act", { id: missed!.id, revision: missed!.revision, action: "later", until: at(2026, 11, 16, 9) });
    // a promise due today: Later today is its own, so it leaves Deadlines until then
    const thread = await receive({ from: { name: "Tom", email: "tom@people.test" }, subject: "The agenda", bodyText: "Looking forward to it." });
    raw.run(...followup(thread, "send the agenda", at(2026, 11, 14, 9), { state: "due" }));
    raw.run(...followup(thread, "call back", at(2026, 11, 14, 9), { state: "due", dated: 0, message: 900_100 }));
    const [dated, undated] = (await followupRows(client)).sort((a, b) => Number(b.dated) - Number(a.dated));
    const later = await client.call("followups.act", { id: dated!.id, revision: dated!.revision, action: "later", dueAt: at(2026, 11, 14, 15) });
    expect(later.row).toMatchObject({ dueAt: at(2026, 11, 14, 9), deferredUntil: at(2026, 11, 14, 15), state: "open" });
    expect((await client.call("today.list", { heldIds: [] })).sections.find((x) => x.kind === "deadlines")?.items.some((i) => i.thread.id === thread) ?? false).toBe(false);
    await client.call("followups.act", { id: undated!.id, revision: undated!.revision, action: "later", dueAt: at(2026, 11, 14, 15) });
  });
});

describe("the fourth panel round", () => {
  const followup = (thread: number, text: string, dueAt: number, o: { kind?: string; state?: string; dated?: number; message?: number } = {}) =>
    [`INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, revision, created_at) VALUES (?, ?, 0, ?, ?, 'Elena Ruiz', 'elena@acme.test', ?, ?, ?, ?, 0, ?)`, thread, o.message ?? 900_000 + thread, o.kind ?? "promise", text, NOW - 3 * DAY, dueAt, o.dated ?? 1, o.state ?? "open", NOW] as const;

  it("changes 6 and 8: a due promise with no day is Needs you's, after the asks and before the nudges, and Needs you's heading is above Plans'; a Plan that's waiting stays the Plan", async () => {
    const { client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = (req) => {
      const text = promptText(req.messages[0]!.content);
      if (text.includes("Flight")) return reply([{ kind: "event", text: "Flight to Madrid", quote: "Flight IB3170", due: "2026-11-19", time: "07:40" }]);
      if (text.includes("rebranding")) return reply([{ kind: "ask", text: "Answer Mariana about a rebranding quote", quote: "can you send me a quote for the rebranding", due: null, time: null }]);
      return reply();
    };
    const flight = await receive({ from: { name: "Iberia", email: "no-reply@iberia.test" }, subject: "Your trip", bodyText: "Flight IB3170 departs November 19 at 07:40." });
    const asked = await receive({ from: { name: "Mariana Paz", email: "mariana@studio.test" }, subject: "Rebranding", bodyText: "Hi, can you send me a quote for the rebranding?" });
    const promised = await receive({ from: { name: "Elena Ruiz", email: "elena@acme.test" }, subject: "The call", bodyText: "Talk soon." });
    const nudged = await receive({ from: { name: "Ana", email: "ana@people.test" }, subject: "The quote", bodyText: "Talk soon." });
    await read();
    raw.run(...followup(promised, "call Elena back", at(2026, 11, 12, 9), { dated: 0 }));
    raw.run(...followup(nudged, "Ana", at(2026, 11, 12, 9), { kind: "awaiting", dated: 0, state: "due" }));
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id = ?", clock.now - 60_000, flight);
    clock.now = at(2026, 11, 18, 10);
    const list = await client.call("today.list", { heldIds: [] });
    expect(list.sections.map((x) => [x.kind, x.items.map((i) => i.thread.id)])).toEqual([["needsYou", [asked, promised, nudged]], ["plans", [flight]]]);
    // it names no day, and who it's to, for its row's name and picture
    expect(list.sections[0]!.items[1]!.why).toMatchObject({ kind: "promise", text: "call Elena back", personName: "Elena Ruiz", personEmail: "elena@acme.test", promise: { dated: false } });
    expect(list.sections[0]!.items[1]!.why.missed).toBeUndefined();
    // counted with the rest of Needs you; the waiting Plan isn't
    expect((await client.call("counts.get", {})).today).toBe(3);
    // a dated promise of yours due today is still Deadlines'
    raw.run(...followup(promised, "send the slides", at(2026, 11, 18, 17), { message: 900_500 }));
    expect((await client.call("today.list", { heldIds: [] })).sections.map((x) => x.kind)).toEqual(["deadlines", "needsYou", "plans"]);
  });
});

describe("the fifth panel round: a promise's own Later", () => {
  const followup = (thread: number, text: string, dueAt: number, o: { message?: number } = {}) =>
    [`INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, revision, created_at) VALUES (?, ?, 0, 'promise', ?, 'Elena', 'elena@acme.test', ?, ?, 1, 'open', 0, ?)`, thread, o.message ?? 900_000 + thread, text, NOW - 3 * DAY, dueAt, NOW] as const;
  /** the list, its header's count (the counted groups' rows) and the sidebar's, together */
  const today = async (client: RpcClient) => {
    const list = await client.call("today.list", { heldIds: [] });
    const header = list.sections.filter((x) => TODAY_COUNTED.has(x.kind)).reduce((n, x) => n + x.items.length, 0);
    return { groups: list.sections.map((x) => [x.kind, x.items.map((i) => [i.thread.id, i.why.kind])]), header, sidebar: (await client.call("counts.get", {})).today };
  };

  it("put off, a waiting conversation's only promise is none's until it's back, an ask there still Needs you's; Undo brings it back; the counts agree", async () => {
    const { client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    model.answer = (req) => (promptText(req.messages[0]!.content).includes("budget") ? reply([{ kind: "ask", text: "Answer Elena about the budget", quote: "what's the budget", due: null, time: null }]) : reply());
    const elena = await receive({ from: { name: "Elena", email: "elena@acme.test" }, subject: "Re: the deck", bodyText: "Thanks! Separately, what's the budget?", providerThreadId: "elena" });
    const ned = await receive({ from: { name: "Ned", email: "ned@people.test" }, subject: "Re: the plan", bodyText: "Looking forward to it.", providerThreadId: "ned" });
    await read();
    raw.run("UPDATE threads SET waiting_since = ?, has_sent = 1 WHERE id IN (?, ?)", clock.now - 60_000, elena, ned);
    // past their week's lead: the conversations are Needs you's, each showing its promise
    raw.run(...followup(elena, "send the deck", at(2026, 11, 28, 9)));
    raw.run(...followup(ned, "send the plan", at(2026, 11, 27, 9)));
    clock.now = at(2026, 11, 14, 10);
    expect(await today(client)).toEqual({ groups: [["needsYou", [[elena, "promise"], [ned, "promise"]]]], header: 2, sidebar: 2 });
    const [deck, plan] = [(await followupRows(client)).find((r) => r.threadId === elena)!, (await followupRows(client)).find((r) => r.threadId === ned)!];
    // Ned's only promise, put off: his conversation waits for it in Coming up; Elena's, put off: her ask is the row
    const offNed = await client.call("followups.act", { id: plan.id, revision: plan.revision, action: "later", dueAt: at(2026, 11, 20, 9) });
    await client.call("followups.act", { id: deck.id, revision: deck.revision, action: "later", dueAt: at(2026, 11, 20, 9) });
    expect(await today(client)).toEqual({ groups: [["needsYou", [[elena, "dated"]]], ["comingUp", [[ned, "promise"]]]], header: 1, sidebar: 1 });
    // Undo: Ned's conversation as it was, and its promise its row
    await client.call("followups.undo", { undoId: offNed.undoId! });
    expect(await today(client)).toEqual({ groups: [["needsYou", [[elena, "dated"], [ned, "promise"]]]], header: 2, sidebar: 2 });
    // its Later's moment: Elena's promise is her row again; Ned's is a week before its day, Deadlines'
    clock.now = at(2026, 11, 20, 9);
    expect(await today(client)).toEqual({ groups: [["deadlines", [[ned, "promise"]]], ["needsYou", [[elena, "promise"]]]], header: 2, sidebar: 2 });
  });

  it("Later on an overdue promise keeps its day and Undo's revision: it doesn't come due again at once", async () => {
    const { backend, client, receive, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    const thread = await receive({ from: { name: "Elena", email: "elena@acme.test" }, subject: "The deck", bodyText: "Looking forward to it." });
    raw.run(...followup(thread, "send the deck", at(2026, 11, 9, 9)));
    await backend.followups.look();
    const [row] = await followupRows(client);
    expect(row).toMatchObject({ state: "due", inboxState: "onTop" });
    const later = await client.call("followups.act", { id: row!.id, revision: row!.revision, action: "later", dueAt: clock.now + 2 * DAY });
    expect(later.row).toMatchObject({ state: "open", inboxState: "none", dueAt: at(2026, 11, 9, 9), deferredUntil: clock.now + 2 * DAY, revision: row!.revision + 1 });
    expect(backend.followups.nextAt).toBe(clock.now + 2 * DAY);
    expect((await today(client)).groups).toEqual([["comingUp", [[thread, "promise"]]]]);
    await client.call("followups.undo", { undoId: later.undoId! });
    expect((await followupRows(client))[0]).toMatchObject({ state: "due", inboxState: "onTop", deferredUntil: null });
    expect((await today(client)).groups).toEqual([["missed", [[thread, "promise"]]]]);
    // a nudge's Later still moves its moment (sent after her mail, so it's still unanswered)
    raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, revision, created_at) VALUES (?, 900500, 100, 'awaiting', '', 'Elena', 'elena@acme.test', ?, ?, 0, 'due', 0, ?)", thread, clock.now, at(2026, 11, 9, 9), NOW);
    const nudge = (await followupRows(client)).find((r) => r.kind === "awaiting")!;
    const moved = await client.call("followups.act", { id: nudge.id, revision: nudge.revision, action: "later", dueAt: clock.now + DAY });
    expect(moved.row).toMatchObject({ dueAt: clock.now + DAY, deferredUntil: null, state: "open" });
  });
});
describe("the fifth panel round: a row says its conversation's next item (change 6, revision 9)", () => {
  const JESS = "Board meeting is locked: Thursday Nov 19, 9:00–12:00. Could you send me your draft by Friday?";
  const draft: Item = { kind: "respond", text: "Send Jess your draft", quote: "send me your draft by Friday", due: "2026-11-20", time: null };
  const board: Item = { kind: "event", text: "Board meeting", quote: "Board meeting is locked", due: "2026-11-19", time: "09:00" };
  const renewal: Item = { kind: "renew", text: "Renew the board's insurance", quote: "Board meeting is locked", due: "2026-12-20", time: null };

  async function jess() {
    const s = await setup();
    s.model.answer = () => reply([draft, board, renewal]);
    const thread = await s.receive({ from: { name: "Jess Okafor", email: "jess@board.test" }, subject: "Board meeting", bodyText: JESS });
    await s.read();
    const row = async () => {
      const list = await s.client.call("today.list", { heldIds: [] });
      return list.sections.flatMap((x) => x.items.map((i) => ({ group: x.kind, ...i }))).find((i) => i.thread.id === thread)!;
    };
    return { ...s, thread, row };
  }

  it("Jess's draft says the board meeting, which showed nowhere; the count is still of rows", async () => {
    const { client, clock, row } = await jess();
    clock.now = at(2026, 11, 14, 10);
    const first = await row();
    expect(first).toMatchObject({ group: "deadlines", why: { text: "Send Jess your draft" }, also: { kind: "event", text: "Board meeting", dueDay: "2026-11-19", dueAt: at(2026, 11, 19, 9), timed: true, dated: true } });
    expect((await client.call("counts.get", {})).today).toBe(1);
    // Done on the row's own item: the board meeting is the row's, and nothing else would show (the renewal isn't yet)
    await client.call("dated.act", { id: first.why.item!.id, revision: first.why.item!.revision, action: "done" });
    const next = await row();
    expect(next).toMatchObject({ group: "comingUp", why: { text: "Board meeting" } });
    expect(next.also).toBeUndefined();
  });

  it("never one put off, over, or not showing yet; a promise of yours that would show is one", async () => {
    const { client, clock, raw, thread, row } = await jess();
    clock.now = at(2026, 11, 14, 10);
    const [meeting] = (await client.call("dated.ofThread", { threadId: thread })).rows.filter((r) => r.kind === "event");
    const later = await client.call("dated.act", { id: meeting!.id, revision: meeting!.revision, action: "later", until: at(2026, 11, 18, 9) });
    expect((await row()).also).toBeUndefined();
    await client.call("dated.undo", { undoId: later.undoId! });
    expect((await row()).also).toMatchObject({ text: "Board meeting" });
    // your promise in the conversation, due before it: the soonest
    await client.call("settings.update", { followups: { enabled: true } });
    raw.run(`INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, revision, created_at) VALUES (?, 900001, 0, 'promise', 'send Jess the budget', 'Jess Okafor', 'jess@board.test', ?, ?, 1, 'open', 0, ?)`, thread, NOW, at(2026, 11, 16, 9), NOW);
    // with a promise's week (the fifth round's change 1) it's in Deadlines, the row's own: the meeting is what it also has
    const owed = await row();
    expect(owed).toMatchObject({ group: "deadlines", why: { kind: "promise", text: "send Jess the budget" } });
    expect(owed.also).toMatchObject({ kind: "event", text: "Board meeting" });
    raw.run("UPDATE followups SET state = 'done' WHERE thread_id = ?", thread);
    // the meeting's over at noon on its day: the draft has nothing beside it (the renewal's time to act is a month off)
    clock.now = at(2026, 11, 19, 12);
    const after = await row();
    expect(after).toMatchObject({ group: "deadlines", why: { text: "Send Jess your draft" } });
    expect(after.also).toBeUndefined();
  });

  it("never the same words again, nor an ask under the promise that answers it", async () => {
    const { backend, client, model, receive, read, raw, clock } = await setup();
    await client.call("settings.update", { followups: { enabled: true } });
    const jessFrom = { from: { name: "Jess Okafor", email: "jess@board.test" }, providerThreadId: "jess" };
    model.answer = () => reply([draft]);
    const thread = await receive({ ...jessFrom, subject: "Draft", bodyText: "Could you send me your draft by Friday?" });
    await read();
    // the same request noted again from a later message, and Jess's ask in another
    model.answer = () => reply([{ ...draft, quote: "your draft by Saturday", due: "2026-11-21" }]);
    expect(await receive({ ...jessFrom, subject: "Re: Draft", bodyText: "Sorry, your draft by Saturday is fine." })).toBe(thread);
    await read();
    model.answer = () => reply([{ kind: "ask", text: "Answer Jess about the budget", quote: "can you tell me the budget", due: null, time: null }]);
    expect(await receive({ ...jessFrom, subject: "Re: Draft", bodyText: "One more thing: can you tell me the budget?" })).toBe(thread);
    await read();
    expect((await client.call("dated.ofThread", { threadId: thread })).rows).toHaveLength(3);
    clock.now = at(2026, 11, 14, 10);
    const list = async () => (await client.call("today.list", { heldIds: [] })).sections.flatMap((x) => x.items);
    const [first] = await list();
    expect(first).toMatchObject({ thread: { id: thread }, why: { text: "Send Jess your draft" }, also: { kind: "ask", text: "Answer Jess about the budget", dated: false } });
    // a promise of yours there: the ask's row is the promise, and the ask isn't said under it
    raw.run(`INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, dated, state, revision, created_at) VALUES (?, 900001, 0, 'promise', 'send Jess the budget', 'Jess Okafor', 'jess@board.test', ?, ?, 0, 'open', 0, ?)`, thread, NOW, NOW + 3 * DAY, NOW);
    raw.run("UPDATE dated_items SET state = 'done' WHERE kind = 'respond'");
    backend.today.touched();
    const [promised] = await list();
    expect(promised).toMatchObject({ thread: { id: thread }, why: { kind: "promise" } });
    expect(promised!.also).toBeUndefined();
  });
});

describe("What matters' history (plan 210)", () => {
  /** n bills on their own conversations, read and showing (Deadlines) */
  async function bills(n: number) {
    const s = await setup();
    s.model.answer = () => reply([bill]);
    const threads: number[] = [];
    for (let i = 0; i < n; i++) threads.push(await s.receive({ subject: `Bill ${i}` }));
    await s.read();
    s.clock.now = at(2026, 11, 18, 10);
    const rowOf = async (thread: number) => (await s.client.call("dated.ofThread", { threadId: thread })).rows[0]!;
    const act = async (thread: number, action: "done" | "dismiss") => {
      s.clock.now += 1000;
      const row = await rowOf(thread);
      return s.client.call("dated.act", { id: row.id, revision: row.revision, action });
    };
    const list = (through: { at: number; src: 0 | 1; id: number } | null = null, heldIds: number[] = []) => s.client.call("today.list", { heldIds, history: { through } });
    const lines = async (through: { at: number; src: 0 | 1; id: number } | null = null) => (await list(through)).history!.items.map((i) => i.thread.id);
    return { ...s, threads, act, list, lines, rowOf };
  }

  it("Done and Not a task move a conversation from the open part to the top of the history, Undo moves it back; the count is the open part's", async () => {
    const { client, threads, act, list, lines } = await bills(3);
    const [a, b, c] = threads as [number, number, number];
    expect((await client.call("counts.get", {})).today).toBe(3);
    await act(a, "done");
    const dismissed = await act(b, "dismiss");
    const first = await list();
    expect(first.sections.flatMap((x) => x.items.map((i) => i.thread.id))).toEqual([c]);
    expect(first.history!.items.map((i) => [i.thread.id, i.outcome, i.kind, i.text])).toEqual([[b, "dismissed", "pay", "Pay the electricity bill"], [a, "done", "pay", "Pay the electricity bill"]]);
    expect(first.history!.next).toBeNull();
    // never counted
    expect((await client.call("counts.get", {})).today).toBe(1);
    await client.call("dated.undo", { undoId: dismissed.undoId! });
    expect(await lines()).toEqual([a]);
    expect((await list()).sections.flatMap((x) => x.items.map((i) => i.thread.id)).sort()).toEqual([b, c].sort());
    // without asking for it, no history (the list look)
    expect((await client.call("today.list", { heldIds: [] })).history).toBeUndefined();
  });

  it("pages by key: every line once and in order, whatever closes or reopens between pages; a reload keeps its depth", async () => {
    const { client, threads, act, list, lines } = await bills(8);
    const undo: Record<number, string> = {};
    for (const t of threads.slice(0, 7)) undo[t] = (await act(t, "done")).undoId!;
    const all = (await list()).history!.items;
    expect(all.map((i) => i.thread.id)).toEqual(threads.slice(0, 7).reverse());
    const page = (after: (typeof all)[number]["key"], limit: number) => client.call("today.history", { after, limit, heldIds: [] });
    const p1 = await page(all[1]!.key, 2);
    expect(p1.items.map((i) => i.thread.id)).toEqual([all[2]!.thread.id, all[3]!.thread.id]);
    expect(p1.next).toEqual(all[3]!.key);
    // between pages: one closes (newest: above every key, never on a later page), one not yet paged reopens (gone)
    await act(threads[7]!, "done");
    await client.call("dated.undo", { undoId: undo[all[4]!.thread.id]! });
    const p2 = await page(p1.next!, 2);
    expect(p2.items.map((i) => i.thread.id)).toEqual([all[5]!.thread.id, all[6]!.thread.id]);
    const p3 = await page(p2.next!, 2);
    expect(p3).toEqual({ items: [], next: null });
    // a reload down to the last line it had: the same depth, the newest on top
    const reload = await list(p2.next!);
    expect(reload.history!.items.map((i) => i.thread.id)).toEqual([threads[7]!, all[0]!.thread.id, all[1]!.thread.id, all[2]!.thread.id, all[3]!.thread.id, all[5]!.thread.id, all[6]!.thread.id]);
    expect(await lines(all[1]!.key)).toEqual([threads[7]!, all[0]!.thread.id, all[1]!.thread.id]);
  });

  it("one line per conversation at its newest closing; the open part, a held row, Spam and Trash have none", async () => {
    const s = await setup();
    const renew: Item = { kind: "renew", text: "Renew the plan", quote: "electricity bill", due: "2026-11-21", time: null };
    s.model.answer = () => reply([bill, renew]);
    const two = await s.receive({ subject: "Two" });
    await s.read();
    s.model.answer = () => reply([bill]);
    const other = await s.receive({ subject: "Other" });
    const spam = await s.receive({ subject: "Spammed" });
    await s.read();
    s.clock.now = at(2026, 11, 18, 10);
    const close = async (thread: number) => {
      for (const row of (await s.client.call("dated.ofThread", { threadId: thread })).rows) {
        s.clock.now += 1000;
        await s.client.call("dated.act", { id: row.id, revision: row.revision, action: "done" });
      }
    };
    const [first] = (await s.client.call("dated.ofThread", { threadId: two })).rows;
    s.clock.now += 1000;
    await s.client.call("dated.act", { id: first!.id, revision: first!.revision, action: "done" });
    const history = async (heldIds: number[] = []) => (await s.client.call("today.list", { heldIds, history: { through: null } })).history!.items.map((i) => i.thread.id);
    // its other item still open: the conversation is the open part's, not the history's
    expect(await history()).toEqual([]);
    await close(two);
    await close(other);
    await close(spam);
    expect(await history()).toEqual([spam, other, two]);
    expect((await s.client.call("today.list", { heldIds: [], history: { through: null } })).history!.items.find((i) => i.thread.id === two)!.text).toBe("Renew the plan");
    expect(await history([other])).toEqual([spam, two]);
    await s.backend.store.threads.act({ threadIds: [spam], action: "spam", signal: null, now: s.clock.now });
    expect(await history()).toEqual([other, two]);
  });

  it("the owner's inbox-zero setting: finished items hidden, no history is read at all, and Done still takes the line off the top", async () => {
    const { client, threads, act, list, backend } = await bills(2);
    await act(threads[0]!, "done");
    expect((await list()).history!.items.map((i) => i.thread.id)).toEqual([threads[0]!]);
    await client.call("settings.update", { today: { finished: false } });
    const dated = vi.spyOn(backend.store.dated, "closedPage");
    const promises = vi.spyOn(backend.store.followups, "closedPage");
    const hidden = await list();
    expect(hidden.history).toBeUndefined();
    expect(hidden.sections.flatMap((x) => x.items.map((i) => i.thread.id))).toEqual([threads[1]!]);
    expect(await client.call("today.history", { after: { at: 1, src: 0, id: 1 }, limit: 10, heldIds: [] })).toEqual({ items: [], next: null });
    await act(threads[1]!, "done");
    expect((await list()).sections).toEqual([]);
    expect(dated).not.toHaveBeenCalled();
    expect(promises).not.toHaveBeenCalled();
    // shown again: the history comes back, newest first
    await client.call("settings.update", { today: { finished: true } });
    expect((await list()).history!.items.map((i) => i.thread.id)).toEqual([threads[1]!, threads[0]!]);
  });

  it("a promise of yours done or not a promise is a line too; at the same moment a dated item comes first, and pages split them exactly", async () => {
    const { client, threads, act, list, raw, backend, clock, account } = await bills(2);
    await client.call("settings.update", { followups: { enabled: true } });
    await act(threads[0]!, "done");
    const [closed] = await backend.store.dated.closedPage({ since: 0, after: null, limit: 1 });
    const m = msg({ accountId: account.id, from: me, to: [power], isSent: true, inInbox: false, date: clock.now - 5000, subject: "Promise", providerMsgId: "promise-1" });
    await backend.ingestSliced([m], true);
    const third = await threadOf(backend.store, "promise-1");
    // promises written as follow-ups' finish writes them, then closed: on a third conversation at the bill's very moment,
    // and on the second (its bill still open) a little before
    const put = (thread: number, item: number, state: "done" | "dismissed", closedAt: number) =>
      raw.run("INSERT INTO followups (thread_id, message_id, item, kind, text, sent_at, due_at, state, closed_reason, closed_at, created_at) VALUES (?, 1, ?, 'promise', 'send the contract', ?, ?, ?, 'user', ?, ?)", thread, item, closedAt, closedAt, state, closedAt, closedAt);
    put(third, 0, "dismissed", closed!.closedAt!);
    put(threads[1]!, 1, "done", closed!.closedAt! - 10);
    const lines = (await list()).history!.items;
    // the second conversation's bill is open: its closed promise isn't a line
    expect(lines.map((i) => [i.thread.id, i.kind, i.outcome])).toEqual([[threads[0]!, "pay", "done"], [third, "promise", "dismissed"]]);
    const after = await client.call("today.history", { after: lines[0]!.key, limit: 5, heldIds: [] });
    expect(after.items.map((i) => i.thread.id)).toEqual([third]);
  });
});

const followupRows = async (client: RpcClient) => (await client.call("followups.list", {})).rows;
