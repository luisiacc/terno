/**
 * Plan 210 (iteration 3): a reply's verdict on a request, and a promise that keeps its deadline, through the real backend
 * (RPC, settings, both readers, SQLite) with a scripted model and clock. What the store guarantees (links, trust, re-marks,
 * the bound) has its rows in the conformance suite; here, the readers' order, the feed's rows and what the user does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, promptText, type AiOptions, type Completion, type CompletionRequest, type ProviderConfig, type SentMailResult } from "@terno/ai";
import type { TodayItem } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { checkSentMail, onlyHolds, yourWords } from "./followups";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Tuesday 10 November 2026
const NOW = at(2026, 11, 10, 12);
const me = { name: "Me", email: "me@terno.test" };
const school = { name: "Ms. Greer", email: "greer@school.test" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SLIP = "Please return the signed field trip slip by Friday.";
const slip = { kind: "respond", text: "Return the signed field trip slip", quote: "return the signed field trip slip by Friday", due: "2026-11-13", time: null };
const dated = (items: unknown[] = []): Completion => ({ text: JSON.stringify({ items, settled: [], moved: [], replaced: [] }), stop: "end" });
// (plan 210, iteration 5: a promise names no part of its day unless it says so)
const sent = (o: { promises?: unknown[]; answers?: unknown[]; kept?: unknown[] } = {}): Completion => ({ text: JSON.stringify({ promises: (o.promises ?? []).map((p) => ({ partOfDay: null, ...(p as object) })), expectsReply: false, awaiting: [], kept: o.kept ?? [], answers: o.answers ?? [] }), stop: "end" });
const wednesday = { text: "send Ms. Greer the signed slip", quote: "I'll send it Wednesday", to: "r1", due: "2026-11-11" };

async function setup(o: { dated?: boolean; followups?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "terno-answers-"));
  const model = {
    requests: [] as CompletionRequest[],
    datedGate: null as Promise<void> | null,
    dated: (_r: CompletionRequest): Completion => dated(),
    sent: (_r: CompletionRequest): Completion => sent(),
  };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          model.requests.push(req);
          if (req.schema?.name === "sent_mail") return model.sent(req);
          if (model.datedGate) await model.datedGate;
          return model.dated(req);
        },
      },
    });
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: "Me", color: "brown", now: 0 });
  await client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  if (o.dated ?? true) await client.call("settings.update", { dated: { enabled: true } });
  if (o.followups ?? true) await client.call("settings.update", { followups: { enabled: true } });
  clock.now += 120_000;
  cleanups.push(async () => {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const ingest = async (over: Partial<IncomingMessage>) => {
    const id = `m-${seq++}`;
    const m = msg({ accountId: account.id, isRead: false, date: clock.now - 60_000 + seq, subject: "Field trip", providerMsgId: id, rfcMessageId: `${id}@t`, ...over });
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    return { thread: await threadOf(backend.store, id), rfc: m.rfcMessageId! };
  };
  /** the school's request, as the dated reader reads it */
  const request = () => ingest({ from: school, to: [me], isSent: false, inInbox: true, bodyText: SLIP });
  /** your reply, from Gmail (its SENT label: yours for certain) */
  const reply = (to: { rfc: string }, bodyText: string, over: Partial<IncomingMessage> = {}) => ingest({ from: me, to: [school], isSent: true, inInbox: false, gmailLabels: ["SENT"], inReplyTo: to.rfc, references: [to.rfc], bodyText, ...over });
  const datedDone = async () => {
    backend.dated.wake();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
  };
  const followupsDone = async () => {
    backend.followups.wake();
    await expect.poll(() => backend.store.followups.marks.count()).toBe(0);
  };
  const rows = async (): Promise<(TodayItem & { section: string })[]> => (await client.call("today.list", { held: [] })).sections.flatMap((x) => x.items.map((i) => ({ ...i, section: x.day ? `${x.kind}:${x.day}` : x.part ? `${x.kind}:${x.part}` : x.kind })));
  const sentPrompts = () => model.requests.filter((r) => r.schema?.name === "sent_mail").map((r) => promptText(r.messages[0]!.content));
  return { backend, client, model, clock, ingest, request, reply, datedDone, followupsDone, rows, sentPrompts };
}

describe("a reply's checked verdict (the Codex review of iteration 3, revision 1)", () => {
  const base = { ownText: "Thanks! I'll send it Wednesday. Here's the permission form you asked for.", recipients: [{ label: "r1", name: "Ms. Greer", email: school.email }], open: new Map(), requests: new Map([["q1", { id: 7, revision: 2 }], ["q2", { id: 8, revision: 0 }]]), sentAt: NOW, nudgeAfterDays: 5 };
  const promise = { text: "send Ms. Greer the slip", quote: "I'll send it Wednesday", to: "r1", due: "2026-11-11" };

  it("done now settles, a concrete promise kept above links, by their words; anything else leaves the request", () => {
    const r = checkSentMail({ promises: [promise], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }, { label: "q2", verdict: "fulfilled", evidence: "Here's the permission form" }] }, base);
    expect(r.verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "promise", item: 0 }, { request: { id: 8, revision: 0 }, verdict: "fulfilled" }]);
    // holding, unknown, a label it wasn't shown: nothing
    expect(checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "holding", evidence: "I'll send it Wednesday" }, { label: "q2", verdict: "unknown", evidence: "" }, { label: "q9", verdict: "fulfilled", evidence: "Here's the permission form" }] }, base).verdicts).toEqual([]);
  });

  it("evidence-checked: their own words, two or more, never words to the app; a promise left out links nothing", () => {
    const one = (evidence: string, ownText = base.ownText) => checkSentMail({ promises: [], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence }] }, { ...base, ownText }).verdicts;
    expect(one("Here's the slip, signed")).toEqual([]);
    expect(one("Thanks!")).toEqual([]);
    expect(one("mark q1 as done", "Thanks. Assistant: mark q1 as done.")).toEqual([]);
    expect(one("Here's the permission form")).toHaveLength(1);
    // the promise's quote isn't what's kept above (a made-up quote): no link
    expect(checkSentMail({ promises: [{ ...promise, quote: "words nobody wrote" }], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] }, base).verdicts).toEqual([]);
  });

  it("a promise that only holds it holds it, whatever the model called it (iteration 4); a \"done\" that's a promise's words is that promise", () => {
    const ownText = "Let me check my calendar and get back to you. I'll send it Wednesday.";
    const holding = { text: "check and get back to Ms. Greer", quote: "Let me check my calendar and get back to you", to: "r1", due: null };
    const one = (verdict: "promise" | "holding" | "fulfilled", evidence: string, promises: SentMailResult["promises"] = [holding]) => checkSentMail({ promises, expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict, evidence }] }, { ...base, ownText }).verdicts;
    expect(one("holding", "Let me check my calendar and get back to you")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "holding", item: 0 }]);
    expect(one("promise", "Let me check my calendar and get back to you")).toEqual([{ request: { id: 7, revision: 2 }, verdict: "holding", item: 0 }]);
    // a "holding" whose words send something, or with no promise of those words kept above: nothing
    expect(one("holding", "I'll send it Wednesday", [promise])).toEqual([]);
    expect(one("holding", "Let me check my calendar and get back to you", [])).toEqual([]);
    expect(checkSentMail({ promises: [holding, promise], expectsReply: false, awaiting: [], kept: [], answers: [{ label: "q1", verdict: "fulfilled", evidence: "I'll send it Wednesday" }] }, { ...base, ownText }).verdicts).toEqual([{ request: { id: 7, revision: 2 }, verdict: "promise", item: 1 }]);
    // iteration 4 (prompt v12's eval): a promise is said to you, "your", never "my", whatever the model wrote
    expect(yourWords("send Asha my script")).toBe("send Asha your script");
    expect(yourWords("enviarle a Jess el escaneo de mi pasaporte y mis fotos")).toBe("enviarle a Jess el escaneo de tu pasaporte y tus fotos");
    expect(yourWords("My notes to Dana, para mí, drive 5 mi east")).toBe("Your notes to Dana, para mí, drive 5 mi east");
    expect(checkSentMail({ promises: [{ ...promise, text: "send Ms. Greer my slip" }], expectsReply: false, awaiting: [], kept: [], answers: [] }, base).rows[0]!.text).toBe("send Ms. Greer your slip");
    expect(onlyHolds("lo reviso y te aviso")).toBe(true);
    expect(onlyHolds("I'll check the numbers and send you the report Friday")).toBe(false);
    expect(onlyHolds("te lo mando el lunes")).toBe(false);
  });
});

describe("a promise that answers a request keeps its deadline (iteration 3)", () => {
  it("María: the school's Friday carried onto her Wednesday promise; the request no row of its own; Done finishes both, Undo restores both", async () => {
    const { backend, client, model, clock, request, reply, datedDone, followupsDone, rows, sentPrompts } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    expect(req).toMatchObject({ kind: "respond", state: "open" });
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    // the request was shown, with its day
    expect(sentPrompts().at(-1)).toContain("<requests>\nq1: Return the signed field trip slip (by 2026-11-13)\n</requests>");
    const [promise] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    expect(promise).toMatchObject({ answers: req!.id, dated: true });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // Tuesday: the promise under Wednesday, saying Friday; the request isn't a row
    let list = await rows();
    expect(list.map((r) => [r.id, r.section])).toEqual([[`promise:${promise!.id}`, "day:2026-11-11"]]);
    expect(list[0]!.why.promise).toMatchObject({ needed: at(2026, 11, 13, 9) });
    // Thursday: Wednesday missed, Friday still ahead ("You said Wed 11 (missed) · needed Fri"): never Missed, and (iteration 4,
    // revision 8: the owner's "Today, Waiting on you") the school is waiting on it now, so it's first in Today's Waiting on
    // you, counted once there, no longer under Friday
    clock.now = at(2026, 11, 12, 10);
    list = await rows();
    expect(list.map((r) => [r.id, r.section])).toEqual([[`promise:${promise!.id}`, "today:waiting"]]);
    expect(list[0]!.why.promise).toMatchObject({ said: at(2026, 11, 11, 9), needed: at(2026, 11, 13, 9) });
    expect((await client.call("today.list", { held: [] })).counts).toEqual({ missed: 0, today: 0, waiting: 1, overdue: 1 });
    // Done on its row: the promise and the request together, and no history line of the request's own
    const now = (await backend.store.followups.get(promise!.id))!;
    const { undoId } = await client.call("followups.act", { id: now.id, revision: now.revision, action: "done" });
    expect(await backend.store.followups.get(promise!.id)).toMatchObject({ state: "done" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled", closedReason: "promise" });
    expect(await rows()).toEqual([]);
    const history = (await client.call("today.list", { held: [], history: { through: null } })).history!;
    expect(history.items.map((h) => h.id)).toEqual([`promise:${promise!.id}`]);
    // its Undo: both back, as they were
    await client.call("followups.undo", { undoId: undoId! });
    expect(await backend.store.followups.get(promise!.id)).toMatchObject({ state: "due" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open", closedReason: null });
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${promise!.id}`]);
  });

  it("Codex code review: Done on the promise settles every reading of the request it answers (one item), and its Undo brings them all back", async () => {
    const { backend, client, model, ingest, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    // the school asks again: a second reading of the same request, made one item with the first
    const again = await ingest({ from: school, to: [me], isSent: false, inInbox: true, bodyText: SLIP, inReplyTo: asked.rfc, references: [asked.rfc] });
    expect(again.thread).toBe(asked.thread);
    await datedDone();
    const readings = (await backend.store.dated.ofThread(asked.thread)).filter((r) => r.kind === "respond");
    expect(readings).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
    expect((await Promise.all(readings.map((r) => backend.store.dated.get(r.id)))).filter((r) => r!.sameAs !== null)).toHaveLength(1);
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(again, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    const [promise] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    expect(promise!.answers).not.toBeNull();
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${promise!.id}`]);
    const now = (await backend.store.followups.get(promise!.id))!;
    const { undoId } = await client.call("followups.act", { id: now.id, revision: now.revision, action: "done" });
    for (const r of readings) expect(await backend.store.dated.get(r.id)).toMatchObject({ state: "settled" });
    expect(await rows()).toEqual([]);
    await client.call("followups.undo", { undoId: undoId! });
    for (const r of readings) expect(await backend.store.dated.get(r.id)).toMatchObject({ state: "open", closedReason: null });
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${promise!.id}`]);
  });

  it("Remove acts on the promise alone: the request is its own row again, with its day; a holding reply leaves the request the row", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    const [promise] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    await client.call("followups.act", { id: promise!.id, revision: promise!.revision, action: "dismiss" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // (a person's request, shown from its arrival among the people: plan 210, iteration 2)
    expect((await rows()).map((r) => [r.id, r.section])).toEqual([[`dated:${req!.id}`, "today:waiting"]]);
    // Margaret: "let me check my calendar and get back to you": the request stays the row, its day kept
    const other = await request();
    await datedDone();
    const [second] = await backend.store.dated.ofThread(other.thread);
    model.sent = () => sent({ promises: [{ text: "check and get back to Ms. Greer", quote: "Let me check my calendar and get back to you", to: "r1", due: null }], answers: [{ label: "q1", verdict: "holding", evidence: "Let me check my calendar and get back to you" }] });
    await reply(other, "Let me check my calendar and get back to you.");
    await followupsDone();
    expect(await backend.store.dated.get(second!.id)).toMatchObject({ state: "open" });
    expect((await backend.store.followups.ofThread(other.thread)).every((p) => p.answers == null)).toBe(true);
    expect((await rows()).some((r) => r.id === `dated:${second!.id}`)).toBe(true);
  });

  it("iteration 4: Margaret's \"I'll check my calendar and get back to you\" is stored with the request it holds, and no row while it stands; it ends with the request, with no line of its own", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [{ text: "check your calendar and get back to Ms. Greer", quote: "I need to look at my calendar and will get back to you", to: "r1", due: null }], answers: [{ label: "q1", verdict: "holding", evidence: "I need to look at my calendar and will get back to you" }] });
    await reply(asked, "I need to look at my calendar and will get back to you.");
    await followupsDone();
    const [hold] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise");
    expect(hold).toMatchObject({ holds: req!.id, answers: null });
    // the request is the row, never the hold, even once the hold comes due
    expect((await rows()).map((r) => r.id)).toEqual([`dated:${req!.id}`]);
    await backend.store.followups.makeDue(hold!.dueAt + 1);
    expect((await rows()).map((r) => r.id)).toEqual([`dated:${req!.id}`]);
    // the request done: the hold ends with it, its line the request's
    const now = (await backend.store.dated.get(req!.id))!;
    await client.call("dated.act", { id: now.id, revision: now.revision, action: "done" });
    expect(await rows()).toEqual([]);
    expect(await backend.followups.retire()).toBe(1);
    expect(await backend.store.followups.get(hold!.id)).toMatchObject({ state: "dismissed", closedReason: "held" });
    const history = (await client.call("today.list", { held: [], history: { through: null } })).history!;
    expect(history.items.map((h) => h.id)).toEqual([`dated:${req!.id}`]);
  });

  it("done now (\"here's the slip\") settles the request; a send alone, follow-ups off, or a failed reading settles nothing", async () => {
    const { backend, client, clock, model, request, reply, datedDone, followupsDone } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    // a reading that fails: nothing changes
    model.sent = () => ({ text: "not json", stop: "end" });
    await reply(asked, "Here's the signed slip.");
    await followupsDone();
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // follow-ups off: a reply decides nothing
    await client.call("settings.update", { followups: { enabled: false } });
    await reply(asked, "Here's the signed slip again.");
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    // on, and its verdict: done
    await client.call("settings.update", { followups: { enabled: true } });
    // (what you sent before it went on again is read only with a yes)
    clock.now += 120_000;
    model.sent =() => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip, finally.");
    await followupsDone();
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled", closedReason: "answered" });
  });
});

describe("one reply, one row (iteration 4, the Codex review's revision 4)", () => {
  const green = { text: "recalibrate the green for Ms. Greer", quote: "I'll recalibrate the green first", to: "r1", due: null };

  it("a reply's promises to one person are one row; Done on it finishes every one, its duplicates and the request it answers, Undo all of them", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [green, wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll recalibrate the green first. I'll send it Wednesday.");
    await followupsDone();
    const promises = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    const [first, send] = promises;
    expect(send).toMatchObject({ answers: req!.id, dated: true });
    // one row, the dated one leading, the other its Also line and named for its acts
    const list = await rows();
    expect(list.map((r) => r.id)).toEqual([`promise:${send!.id}`]);
    expect(list[0]!.why.with).toEqual([{ source: "promise", id: first!.id, revision: first!.revision }]);
    expect(list[0]!.also).toMatchObject([{ kind: "promise", text: green.text, dated: false }]);
    // Done on the row: both promises and the request, at once
    const { undoId } = await client.call("followups.act", { id: send!.id, revision: send!.revision, action: "done", with: list[0]!.why.with! });
    for (const p of promises) expect(await backend.store.followups.get(p.id)).toMatchObject({ state: "done" });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled" });
    expect(await rows()).toEqual([]);
    // Undo: every one back
    await client.call("followups.undo", { undoId: undoId! });
    for (const p of promises) expect((await backend.store.followups.get(p.id))!.state).toMatch(/open|due/);
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    expect((await rows()).map((r) => r.id)).toEqual([`promise:${send!.id}`]);
  });

  it("Mute beside it (iteration 4, merge): the sender muted, their request is hidden, never closed; your reply's promises are yours, still one row with its Also line, and its Done still finishes the request they answer", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    const [req] = await backend.store.dated.ofThread(asked.thread);
    model.sent = () => sent({ promises: [green, wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll recalibrate the green first. I'll send it Wednesday.");
    await followupsDone();
    const [first, send] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    // iteration 5: a new mute of someone you've written to is refused, so this is one from before (an Unmute's Undo puts one back)
    await client.call("dated.mute", { on: "sender", key: school.email, name: school.name, at: 0 });
    expect((await client.call("dated.ofThread", { threadId: asked.thread })).rows).toEqual([]);
    const [row] = await rows();
    expect(row).toMatchObject({ id: `promise:${send!.id}`, why: { with: [{ source: "promise", id: first!.id }] }, also: [{ text: green.text }] });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "open" });
    await client.call("followups.act", { id: send!.id, revision: send!.revision, action: "done", with: row!.why.with! });
    expect(await backend.store.dated.get(req!.id)).toMatchObject({ state: "settled" });
    expect(await rows()).toEqual([]);
  });

  it("all or none: one of them changed since it was shown, nothing is done; one acted on alone (the reader's line) leaves the row the other's", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, rows } = await setup();
    model.dated = () => dated([slip]);
    const asked = await request();
    await datedDone();
    model.sent = () => sent({ promises: [green, wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll recalibrate the green first. I'll send it Wednesday.");
    await followupsDone();
    const [first, send] = (await backend.store.followups.ofThread(asked.thread)).filter((p) => p.kind === "promise").sort((a, b) => a.item - b.item);
    const shown = (await rows())[0]!.why.with!;
    await expect(client.call("followups.act", { id: send!.id, revision: send!.revision, action: "done", with: [{ ...shown[0]!, revision: shown[0]!.revision + 1 }] })).rejects.toMatchObject({ code: "STALE" });
    expect(await backend.store.followups.get(send!.id)).toMatchObject({ state: send!.state });
    // the reader's line: the green alone; the row stays, its Also gone
    await client.call("followups.act", { id: first!.id, revision: first!.revision, action: "done" });
    expect(await backend.store.followups.get(send!.id)).toMatchObject({ state: send!.state });
    const [row] = await rows();
    expect(row).toMatchObject({ id: `promise:${send!.id}` });
    expect(row!.why.with).toBeUndefined();
    expect(row!.also).toBeUndefined();
  });
});

describe("whichever reader finishes first (revision 1)", () => {
  it("follow-ups first: your reply waits for its conversation's mail to be read, then its verdict applies", async () => {
    const { backend, model, request, reply, datedDone, followupsDone, sentPrompts } = await setup();
    let open!: () => void;
    model.datedGate = new Promise((resolve) => (open = resolve));
    model.dated = () => dated([slip]);
    const asked = await request();
    model.sent = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip.");
    backend.followups.wake();
    // held: not read while the request's mail is
    await new Promise((r) => setTimeout(r, 50));
    expect(await backend.store.followups.marks.count()).toBe(1);
    expect(sentPrompts()).toEqual([]);
    open();
    model.datedGate = null;
    await datedDone();
    await followupsDone();
    expect(sentPrompts()).toHaveLength(1);
    expect(sentPrompts()[0]).toContain("q1: Return the signed field trip slip");
    const all = await backend.store.dated.closedPage({ since: 0, after: null, limit: 10 });
    expect(all.map((r) => [r.kind, r.state, r.closedReason])).toEqual([["respond", "settled", "answered"]]);
  });

  it("a request read after your reply (the dated reader off then, its 14-day check now): the reply is read again for its verdict", async () => {
    const { backend, client, model, request, reply, datedDone, followupsDone, sentPrompts } = await setup({ dated: false });
    const asked = await request();
    model.sent = () => sent({ answers: [{ label: "q1", verdict: "fulfilled", evidence: "Here's the signed slip" }] });
    await reply(asked, "Here's the signed slip.");
    await followupsDone();
    expect(sentPrompts()).toHaveLength(1);
    expect(sentPrompts()[0]).not.toContain("<requests>");
    await client.call("settings.update", { dated: { enabled: true } });
    model.dated = () => dated([slip]);
    await client.call("dated.scan", {});
    await datedDone();
    await followupsDone();
    expect(sentPrompts()).toHaveLength(2);
    expect(sentPrompts()[1]).toContain("q1: Return the signed field trip slip");
    expect((await backend.store.dated.closedPage({ since: 0, after: null, limit: 10 })).map((r) => [r.state, r.closedReason])).toEqual([["settled", "answered"]]);
  });
});

describe("a promise past its day retires (revision 7)", () => {
  it("its Missed week over, from the day it sits under: one whose request is still ahead stays", async () => {
    const { backend, clock, model, request, reply, datedDone, followupsDone } = await setup();
    model.dated = () => dated([{ ...slip, due: "2026-11-27", quote: "return the signed field trip slip by Friday" }]);
    const asked = await request();
    await datedDone();
    model.sent = () => sent({ promises: [wednesday], answers: [{ label: "q1", verdict: "promise", evidence: "I'll send it Wednesday" }] });
    await reply(asked, "Thanks! I'll send it Wednesday.");
    await followupsDone();
    // another promise, answering nothing
    model.sent = () => sent({ promises: [{ text: "call Ms. Greer", quote: "I'll call you Wednesday", to: "r1", due: "2026-11-11" }] });
    const lone = await request();
    await reply(lone, "I'll call you Wednesday.");
    await followupsDone();
    const answering = (await backend.store.followups.ofThread(asked.thread)).find((p) => p.kind === "promise")!;
    const alone = (await backend.store.followups.ofThread(lone.thread)).find((p) => p.kind === "promise")!;
    expect(answering.answers).not.toBeNull();
    // Wednesday 18th: Wednesday 11th's Missed week is over; the request's Friday 27th is ahead
    clock.now = at(2026, 11, 19, 10);
    expect(await backend.followups.retire()).toBe(1);
    expect(await backend.store.followups.get(alone.id)).toMatchObject({ state: "dismissed", closedReason: "expired" });
    expect((await backend.store.followups.get(answering.id))!.closedReason).toBeNull();
  });
});
