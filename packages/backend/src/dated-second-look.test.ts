/**
 * Plan 210 (iteration 5, revision 3): the second look. Its trigger and bounds are pure (`lookAt`, `secondLook` with fakes); the
 * worker's part runs through the real backend (RPC, settings, limiter, SQLite) with a scripted model and clock, as
 * dated.test.ts does: one claim per mark, across a failure and a restart, Spam and a mute read again, "nothing asked".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, DATED_AGAIN_CHARS, promptText, type AiOptions, type Completion, type CompletionRequest, type DatedInput, type DatedResult, type ProviderConfig } from "@terno/ai";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { msg, threadOf } from "@terno/store/conformance";
import type { IncomingMessage } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { holdsMoment, lookAt, secondLook, type LookDeps } from "./dated-second-look";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Tuesday, November 10, 2026
const NOW = at(2026, 11, 10, 12);
const none = { items: [], settled: [], moved: [], replaced: [] } satisfies DatedResult;
const look = (text: string, o: Partial<Parameters<typeof lookAt>[0]> = {}) => lookAt({ text, subject: "", arrivedAt: NOW, automated: false, shown: [], first: none, ...o });

const BOOK_CLUB = "Hello ladies,\n\nWe're meeting Tuesday the 17th at 7:00 at my house for The Lighthouse Keeper's Daughter. I'll make the lemon bars, someone please bring decaf because I'm out.\n\nMargaret, you said you'd do the discussion questions this time, thank you! And could you let me know by Monday the 16th whether you can host in December?\n\nJoan, could you confirm the library meeting room for January by Friday?\n\nSee you soon,\nDolores";
const MEETING = "We're meeting Tuesday the 17th at 7:00 at my house for The Lighthouse Keeper's Daughter.";
const HOST = { kind: "respond" as const, text: "Tell Dolores whether you can host in December", quote: "let me know by Monday the 16th whether you can host in December", due: "2026-11-16", time: null };
const REGISTRATION = "Dear Student,\n\nSpring 2027 registration is now open for graduate students. Your enrollment window closes Wednesday, December 9 at 11:59 PM. Doctoral students must register for at least 9 credits to keep full-time status and funding.\n\nRegister in HalvorsenOne > Student Center.\n\nOffice of the Registrar";
const CLOSES = "Your enrollment window closes Wednesday, December 9 at 11:59 PM.";

describe("which sentences get a second look", () => {
  it("a day with a time or a closing, from the mail's own day on, en and es; never an amount, a street, a schedule or a day gone", () => {
    expect(holdsMoment(MEETING, NOW)).toBe(true);
    expect(holdsMoment(CLOSES, NOW)).toBe(true);
    expect(holdsMoment("Nos reunimos el martes 17 a las 19:00 en mi casa.", NOW)).toBe(true);
    expect(holdsMoment("La inscripción cierra el miércoles 9 de diciembre.", NOW)).toBe(true);
    // a day alone, a time alone
    expect(holdsMoment("See you Tuesday!", NOW)).toBe(false);
    expect(holdsMoment("The doors open at 7:00.", NOW)).toBe(false);
    // what reads as a day and isn't
    expect(holdsMoment("Amount due: $12.10", NOW)).toBe(false);
    expect(holdsMoment("Pickup: Valencia St & 20th St, 9:21 PM", NOW)).toBe(false);
    expect(holdsMoment("The report runs every Monday at 6:00 AM.", NOW)).toBe(false);
    expect(holdsMoment("Delivered: Thursday, October 29 at 3:38 PM", NOW)).toBe(false);
    expect(holdsMoment("Entregado el jueves 29 de octubre a las 15:38", NOW)).toBe(false);
    // a December mail's "January 5" is next year's
    expect(holdsMoment("The office reopens January 5 at 9:00.", at(2026, 12, 20))).toBe(true);
  });

  it("only what nothing returned covers: Margaret's book club and Sam's registration, not the request the reading kept", () => {
    expect(look(BOOK_CLUB, { first: { ...none, items: [HOST] } })).toEqual([MEETING]);
    expect(look(REGISTRATION, { automated: true })).toEqual([CLOSES]);
    // the meeting quoted, or its day returned with a quote the mail doesn't hold word for word: covered
    expect(look(BOOK_CLUB, { first: { ...none, items: [HOST, { kind: "event", text: "Book club", quote: "We're meeting Tuesday the 17th at 7:00", due: "2026-11-17", time: "19:00" }] } })).toEqual([]);
    expect(look(BOOK_CLUB, { first: { ...none, items: [HOST, { kind: "event", text: "Book club", quote: "book club at Dolores's", due: "2026-11-17", time: "19:00" }] } })).toEqual([]);
    // a settlement's or a move's evidence, and an open item's day it was shown (a reminder of it)
    expect(look(REGISTRATION, { first: { ...none, settled: [{ label: "o1", evidence: "Your enrollment window closes Wednesday" }] } })).toEqual([]);
    expect(look(REGISTRATION, { first: { ...none, moved: [{ label: "o1", due: "2026-12-09", time: "23:59", evidence: "enrollment window closes", text: null, textEvidence: null }] } })).toEqual([]);
    expect(look(REGISTRATION, { shown: [{ due: "2026-12-09" }] })).toEqual([]);
    // es
    const es = "Hola a todas:\n\nNos reunimos el martes 17 a las 19:00 en mi casa. ¿Me avisas antes del lunes 16 si puedes ser anfitriona en diciembre?\n\nDolores";
    expect(look(es, { first: { ...none, items: [{ ...HOST, quote: "Me avisas antes del lunes 16 si puedes ser anfitriona en diciembre", due: "2026-11-15" }] } })).toEqual(["Nos reunimos el martes 17 a las 19:00 en mi casa."]);
    expect(look(es, { first: { ...none, items: [{ kind: "event", text: "Club de lectura", quote: "Nos reunimos el martes 17 a las 19:00", due: "2026-11-17", time: "19:00" }] } })).toEqual([]);
  });

  it("never what the checks would refuse: a receipt, a charge made by itself, a sale's end, a scam's pressure, en and es", () => {
    expect(look("Payment received on Tuesday, November 17 at 10:15. Thank you!")).toEqual([]);
    expect(look("Se cobró tu suscripción el martes 17 de noviembre a las 10:15.")).toEqual([]);
    expect(look("Your bill of $64.20 is due November 20 at 5 PM.\n\nAutoPay is on: we'll charge your Visa.")).toEqual([]);
    expect(look("Tu plan se renueva automáticamente el 20 de noviembre a las 9:00.")).toEqual([]);
    expect(look("50% off everything: the sale ends Sunday, November 15 at midnight!")).toEqual([]);
    expect(look("Your account will be suspended within 24 hours. Verify your account by November 11 at 5 PM.")).toEqual([]);
    // a charge said off, or failed, is still asked about
    expect(look("Auto-renew is off. Your domain expires on December 7 at 11:59 PM.")).toEqual(["Your domain expires on December 7 at 11:59 PM."]);
  });

  it("an automated mail's listing is never asked about: more moments than the bound, or one on a list's line", () => {
    const newsletter = "Upcoming events:\n\nThe holiday market opens Saturday, November 21 at 10:00 AM.\nThe book swap is Tuesday, November 24 at 7 PM at the library.\nThe town meeting is Thursday, December 3 at 7:00 PM.";
    expect(look(newsletter, { automated: true })).toEqual([]);
    expect(look("This month:\n\n- RevOps Live (virtual) — Thursday, Dec 3, 1 PM ET", { automated: true })).toEqual([]);
    // a person's three are asked about two at a time, in the mail's order
    expect(look(newsletter)).toEqual(["The holiday market opens Saturday, November 21 at 10:00 AM.", "The book swap is Tuesday, November 24 at 7 PM at the library."]);
  });

  it("at most two sentences and 1,000 characters, each whole", () => {
    const long = `We meet Tuesday, November 17 at 7:00 to go over ${"the long list of things ".repeat(36)}.`;
    expect(long.length).toBeGreaterThan(DATED_AGAIN_CHARS - 200);
    expect(long.length).toBeLessThan(DATED_AGAIN_CHARS);
    const text = `${long}\nThen Wednesday, November 18 at 9:00 we ${"walk the whole site again ".repeat(10)}.\nThursday, November 19 at 8:00 is the dinner.`;
    const asked = look(text);
    expect(asked).toEqual([long, "Thursday, November 19 at 8:00 is the dinner."]);
    expect(asked.join("").length).toBeLessThanOrEqual(DATED_AGAIN_CHARS);
  });
});

describe("the second look's one call (pure, with fakes)", () => {
  const input: DatedInput = { text: BOOK_CLUB, subject: "Book club the 17th", from: { name: "Dolores Haney", automated: false }, reader: { name: "Margaret", addressed: "cc" }, to: [], cc: [], receivedAt: "x", zone: "UTC", open: [], language: "en" };
  const o = { text: BOOK_CLUB, subject: input.subject, arrivedAt: NOW, automated: false, shown: [], input, promptChars: Infinity };
  const deps = (over: Partial<LookDeps> = {}) => {
    const calls: string[] = [];
    const d: LookDeps = {
      recheck: async () => (calls.push("recheck"), "go"),
      claim: async () => (calls.push("claim"), true),
      read: async (i) => {
        calls.push(`read ${i.again?.length ?? 0}`);
        return { ...none, items: [{ kind: "event", text: "Book club at Dolores's", quote: "We're meeting Tuesday the 17th at 7:00", due: "2026-11-17", time: "19:00" }] };
      },
      aborted: () => false,
      ...over,
    };
    return { calls, d };
  };
  const first: DatedResult = { ...none, items: [HOST] };

  it("asks once about the uncovered sentence, the text already read around it, and keeps only items quoting it", async () => {
    const seen: DatedInput[] = [];
    const { calls, d } = deps();
    const read = d.read;
    d.read = async (i) => (seen.push(i), read(i));
    const r = await secondLook(first, o, d);
    expect(calls).toEqual(["recheck", "claim", "read 1"]);
    expect(seen[0]).toEqual({ ...input, again: [MEETING] });
    expect(r).toMatchObject({ asked: 1, complete: true, result: { items: [HOST, { kind: "event", due: "2026-11-17" }] } });
    // an item quoting elsewhere, a settlement or a move from the look: never kept (the first reading had all of the mail)
    const { d: elsewhere } = deps({ read: async () => ({ items: [{ ...HOST, quote: "could you confirm the library meeting room for January by Friday" }], settled: [{ label: "o1", evidence: "x" }], moved: [{ label: "o1", due: "2026-11-20", time: null, evidence: "x", text: null, textEvidence: null }], replaced: [] }) });
    expect(await secondLook(first, o, elsewhere)).toEqual({ result: first, asked: 1, complete: true });
  });

  it("no call for what's covered; Spam, a mute or the settings read again first; one claim; a failure keeps the reading, incomplete", async () => {
    const covered = deps();
    expect(await secondLook({ ...first, items: [HOST, { kind: "event", text: "Book club", quote: MEETING, due: "2026-11-17", time: "19:00" }] }, o, covered.d)).toMatchObject({ asked: 0, complete: true });
    expect(covered.calls).toEqual([]);
    for (const go of ["drop", "stop"] as const) {
      const r = deps({ recheck: async () => go });
      expect(await secondLook(first, o, r.d)).toBe(go);
      expect(r.calls).toEqual([]);
    }
    const claimed = deps({ claim: async () => false });
    expect(await secondLook(first, o, claimed.d)).toEqual({ result: first, asked: 0, complete: false });
    expect(claimed.calls).toEqual(["recheck"]);
    const error = new Error("503");
    expect(await secondLook(first, o, deps({ read: async () => Promise.reject(error) }).d)).toEqual({ result: first, asked: 1, complete: false, error });
    // the first reading's own signal ended it: that's the worker's to handle, never the look's
    await expect(secondLook(first, o, deps({ read: async () => Promise.reject(error), aborted: () => true }).d)).rejects.toBe(error);
  });
});

// ─── the worker ─────────────────────────────────────────────────────────────

type Item = { kind: string; text: string; quote: string; due: string | null; time: string | null };
const reply = (items: Item[] = []): Completion => ({ text: JSON.stringify({ items, settled: [], moved: [], replaced: [] }), stop: "end" });
const me = { name: "Margaret Kowalczyk", email: "me@terno.test" };
const dolores = { name: "Dolores Haney", email: "dolores@people.test" };
const registrar = { name: "Office of the Registrar", email: "registrar@uni.test" };
const EVENT: Item = { kind: "event", text: "Book club at Dolores's", quote: "We're meeting Tuesday the 17th at 7:00", due: "2026-11-17", time: "19:00" };
const isLook = (req: CompletionRequest) => promptText(req.messages[0]!.content).includes("<look_again>");
// the dated reader's requests, not another task's (follow-ups, replies)
const dated = (requests: readonly CompletionRequest[]) => requests.filter((r) => promptText(r.system).startsWith("You read one email a person received"));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-look-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const model = { requests: [] as CompletionRequest[], gate: null as Promise<void> | null, answer: (_r: CompletionRequest): Completion | Promise<Completion> => reply() };
  const clock = { now: NOW };
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async (req) => {
          if (dated([req]).length) model.requests.push(req);
          if (model.gate && isLook(req)) await Promise.race([model.gate, new Promise((_, reject) => (req.signal.aborted ? reject(req.signal.reason) : req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })))]);
          return model.answer(req);
        },
      },
    });
  const open = async () => {
    const backend = new Backend({ dbPath: join(dir, "d.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => clock.now });
    await backend.store.ready;
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await backend.stop();
    };
    cleanups.push(stop);
    return { backend, client: new RpcClient(c), stop };
  };
  const first = await open();
  const { account } = await first.backend.store.accounts.create({ kind: "gmail", email: me.email, displayName: me.name, color: "brown", now: 0 });
  await first.client.call("settings.update", { ai: { provider: "fake", model: "demo" } });
  await first.client.call("settings.update", { dated: { enabled: true } });
  clock.now += 120_000;
  let seq = 0;
  const receive = async (backend: Backend, over: Partial<IncomingMessage> = {}) => {
    const id = `l-${seq++}`;
    const m = msg({ accountId: account.id, from: dolores, to: [{ name: "Pageturners", email: "club@people.test" }], cc: [me], isSent: false, inInbox: true, isRead: false, date: clock.now - 60_000 + seq, subject: "Book club the 17th - and December?", bodyText: BOOK_CLUB, providerMsgId: id, ...over });
    await backend.ingestSliced([m], true, undefined, undefined, undefined, undefined, undefined, true);
    return { thread: await threadOf(backend.store, id), id: (await backend.store.dated.marks.page(null, 100)).at(-1)?.messageId ?? -1 };
  };
  const raw = (backend: Backend) => (backend.store as unknown as { db: { run(sql: string, ...a: unknown[]): unknown; all<T>(sql: string, ...a: unknown[]): T[] } }).db;
  const read = async (backend: Backend) => {
    backend.dated.wake();
    await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
  };
  return { ...first, open, model, clock, receive, raw, read };
}

describe("the second look in the worker", () => {
  it("Margaret's book club: the reading's request, then one look at the meeting, both kept; a covered sentence is never asked again", async () => {
    const { backend, model, receive, read } = await setup();
    model.answer = (req) => (isLook(req) ? reply([EVENT]) : reply([HOST]));
    const { thread } = await receive(backend);
    await read(backend);
    expect(model.requests.map(isLook)).toEqual([false, true]);
    // the same system prompt, the mail already read as context, the sentence asked about
    const [plain, again] = model.requests.map((r) => promptText(r.messages[0]!.content));
    expect(again!.startsWith(plain!)).toBe(true);
    expect(again).toContain(`<look_again>\n- ${MEETING}\n</look_again>`);
    expect(promptText(model.requests[1]!.system)).toBe(promptText(model.requests[0]!.system));
    expect((await backend.store.dated.ofThread(thread)).map((r) => [r.kind, r.dueDay])).toEqual([["respond", "2026-11-16"], ["event", "2026-11-17"]]);
    // the meeting quoted the first time: one request
    model.requests.length = 0;
    model.answer = () => reply([HOST, EVENT]);
    await receive(backend, { providerThreadId: "again", subject: "Book club, again" });
    await read(backend);
    expect(model.requests.map(isLook)).toEqual([false]);
  });

  it("Sam's registration: 'nothing asked' only once the look is answered; a failed look keeps the reading, never 'nothing asked', and holds the provider", async () => {
    const { backend, model, receive, read, raw, clock } = await setup();
    const asked = (id: number) => raw(backend).all<{ message_id: number }>("SELECT message_id FROM dated_nothing_asked WHERE message_id = ?", id).length;
    model.answer = () => reply();
    const answered = await receive(backend, { from: registrar, to: [me], cc: [], subject: "Spring 2027 registration is open", bodyText: REGISTRATION, providerThreadId: "reg" });
    await read(backend);
    expect(model.requests.map(isLook)).toEqual([false, true]);
    expect(asked(answered.id)).toBe(1);
    model.requests.length = 0;
    model.answer = (req) => (isLook(req) ? Promise.reject(Object.assign(new Error("Service Unavailable"), { status: 503 })) : reply());
    const failed = await receive(backend, { from: registrar, to: [me], cc: [], subject: "Spring 2027 registration is open", bodyText: REGISTRATION, providerThreadId: "reg2" });
    await read(backend);
    expect(model.requests.filter(isLook).length).toBeGreaterThanOrEqual(1);
    expect(asked(failed.id)).toBe(0);
    // the reading was written (its mark consumed) and isn't read again: a minute's hold, then nothing more to ask
    const requests = model.requests.length;
    clock.now += 61_000;
    backend.dated.wake({ network: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(model.requests.length).toBe(requests);
  });

  it("one claim across a restart: a look cut off by a stop is never asked again, and the reading is still written", async () => {
    const { backend, model, receive, open, stop } = await setup();
    model.gate = new Promise(() => {});
    model.answer = (req) => (isLook(req) ? reply([EVENT]) : reply([HOST]));
    const { thread } = await receive(backend);
    backend.dated.wake();
    await expect.poll(() => model.requests.filter(isLook).length).toBe(1);
    await stop();
    model.requests.length = 0;
    model.gate = null;
    const again = await open();
    // what a start does with what a quit left marked
    await again.backend.dated.start();
    await expect.poll(() => again.backend.store.dated.marks.count()).toBe(0);
    expect(model.requests.map(isLook)).toEqual([false]);
    expect((await again.backend.store.dated.ofThread(thread)).map((r) => r.kind)).toEqual(["respond"]);
  });

  it("Spam or a mute between the reading and its look: nothing more leaves, and nothing is written", async () => {
    for (const between of ["spam", "mute"] as const) {
      const { backend, model, receive, raw } = await setup();
      let release!: () => void;
      const first = new Promise<void>((r) => (release = r));
      model.answer = async (req) => {
        if (!isLook(req)) await first;
        return isLook(req) ? reply([EVENT]) : reply([HOST]);
      };
      const { thread } = await receive(backend);
      backend.dated.wake();
      await expect.poll(() => model.requests.length).toBe(1);
      if (between === "spam") raw(backend).run("UPDATE messages SET is_spam = 1 WHERE thread_id = ?", thread);
      else await backend.store.dated.mutes.add({ on: "sender", key: dolores.email, name: "", at: 0 });
      release();
      await expect.poll(() => backend.store.dated.marks.count()).toBe(0);
      expect(model.requests.map(isLook)).toEqual([false]);
      expect(await backend.store.dated.ofThread(thread)).toEqual([]);
    }
  });
});
