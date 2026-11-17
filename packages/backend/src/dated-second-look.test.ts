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
import { cardMonths, holdsMoment, lookAt, secondLook, type LookDeps } from "./dated-second-look";

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
    // (iteration 5's code review, point 3: only when its words name the same thing: the book)
    expect(look(BOOK_CLUB, { first: { ...none, items: [HOST, { kind: "event", text: "Book club: The Lighthouse Keeper's Daughter", quote: "book club at Dolores's", due: "2026-11-17", time: "19:00" }] } })).toEqual([]);
    // a settlement's or a move's evidence, and an open item's day it was shown (a reminder of it)
    expect(look(REGISTRATION, { first: { ...none, settled: [{ label: "o1", evidence: "Your enrollment window closes Wednesday" }] } })).toEqual([]);
    expect(look(REGISTRATION, { first: { ...none, moved: [{ label: "o1", due: "2026-12-09", time: "23:59", evidence: "enrollment window closes", text: null, textEvidence: null }] } })).toEqual([]);
    expect(look(REGISTRATION, { shown: [{ due: "2026-12-09", text: "Register for spring classes (enrollment window)" }] })).toEqual([]);
    // es
    const es = "Hola a todas:\n\nNos reunimos el martes 17 a las 19:00 en mi casa. ¿Me avisas antes del lunes 16 si puedes ser anfitriona en diciembre?\n\nDolores";
    expect(look(es, { first: { ...none, items: [{ ...HOST, quote: "Me avisas antes del lunes 16 si puedes ser anfitriona en diciembre", due: "2026-11-15" }] } })).toEqual(["Nos reunimos el martes 17 a las 19:00 en mi casa."]);
    expect(look(es, { first: { ...none, items: [{ kind: "event", text: "Club de lectura", quote: "Nos reunimos el martes 17 a las 19:00", due: "2026-11-17", time: "19:00" }] } })).toEqual([]);
  });

  it("never what the checks would refuse: a receipt, a charge made by itself, a sale's end, a scam's pressure, en and es", () => {
    expect(look("Payment received on Tuesday, November 17 at 10:15. Thank you!")).toEqual([]);
    expect(look("Se cobró tu suscripción el martes 17 de noviembre a las 10:15.")).toEqual([]);
    expect(look("Your bill of $64.20 is due November 20 at 5 PM.\n\nAutoPay is on: we'll charge your Visa on the due date.")).toEqual([]);
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

  it("the claims ledger's third batch: a proposal the reader hasn't accepted adds no plan or deadline (Diego's workshop, Carla's gift box)", () => {
    const FER = "¡Hola Diego!\n\nTe escribo por lo que platicamos en la cocina 😄 ¿Siempre sí te animas a dar el taller \"Identidad para negocios pequeños\" el jueves 19 a las 18:00 en la sala grande?\n\nNecesito que me confirmes antes del lunes para meterlo al newsletter de la comunidad y abrir el registro. Si te late, mándame también un título final y dos líneas de descripción.\n\nGracias!!\nFer";
    const confirm = { kind: "respond" as const, text: "Confirmarle a Fer si darás el taller", quote: "Necesito que me confirmes antes del lunes para meterlo al newsletter de la comunidad y abrir el registro.", due: "2026-11-15", time: null };
    expect(look(FER, { first: { ...none, items: [confirm] } })).toEqual([]);
    const CARLA = "Hola Diego,\n\nQueremos sacar una caja de regalo para Navidad con el ensamble y el espadín. La imprenta necesita los archivos a más tardar el 4 de diciembre para entregarnos el 15.\n\n¿Me confirmas antes del viernes 20 si te da tiempo de hacerla? Si no, buscamos otra opción.\n\nCarla";
    const answer = { kind: "respond" as const, text: "Responder a Carla sobre la caja navideña", quote: "¿Me confirmas antes del viernes 20 si te da tiempo de hacerla?", due: "2026-11-19", time: null };
    expect(look(CARLA, { first: { ...none, items: [answer] } })).toEqual([]);
    // en, a question or a yes waited on anywhere
    expect(look("Would you be up for leading the onboarding workshop on Thursday, November 19 at 3:00 PM?")).toEqual([]);
    expect(look("The print shop needs the files by December 4 at 5 PM. If you're in, I'll send the brief.")).toEqual([]);
    // the reader's own word for it (a promise of theirs the mail names) is an acceptance: its days are read again
    const promised = { kind: "promise", text: "send Carla the gift box files", due: null };
    expect(look(CARLA, { first: { ...none, items: [answer] }, shown: [promised] })).toEqual(["La imprenta necesita los archivos a más tardar el 4 de diciembre para entregarnos el 15."]);
    // a request with a day is no proposal ("could you … by"), nor a question asking whether they can host (the book club)
    expect(look("Could you send me the deck? The board meets Tuesday, November 17 at 9:00 AM.")).toEqual(["The board meets Tuesday, November 17 at 9:00 AM."]);
    expect(look(BOOK_CLUB, { first: { ...none, items: [HOST] } })).toEqual([MEETING]);
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

describe("iteration 5's code review", () => {
  it("AutoPay said in the mail rejects only the obligation it's about, with the checks' vetoes (point 2)", () => {
    expect(look("AutoPay is on. Your card has expired. Please pay invoice 3318 by November 25 at 5 PM.")).toEqual(["Please pay invoice 3318 by November 25 at 5 PM."]);
    expect(look("AutoPay is on for your electricity account.\n\nThe lease renewal form is due November 25 at 5 PM.")).toEqual(["The lease renewal form is due November 25 at 5 PM."]);
    expect(look("AutoPay is on. A balance of $40.00 remains, due November 25 at 5 PM.")).toEqual(["A balance of $40.00 remains, due November 25 at 5 PM."]);
    expect(look("Your plan renews automatically each year.\n\nYour free trial ends November 25 at 11:59 PM.")).toEqual(["Your free trial ends November 25 at 11:59 PM."]);
    // its own: still never asked
    expect(look("Your plan will renew automatically on November 25 at 9:00.")).toEqual([]);
  });

  it("a day returned or shown covers only a sentence about the same thing (point 3)", () => {
    const report = { kind: "respond" as const, text: "Send Ana the Q3 report", quote: "Please send me the Q3 report by Friday, November 20 at noon.", due: "2026-11-20", time: "12:00" };
    expect(look("Please send me the Q3 report by Friday, November 20 at noon. The lease renewal closes Friday, November 20 at 5 PM.", { first: { ...none, items: [report] } })).toEqual(["The lease renewal closes Friday, November 20 at 5 PM."]);
    expect(look("The lease renewal closes Friday, November 20 at 5 PM.", { shown: [{ kind: "pay", text: "Pay the Brightline bill", due: "2026-11-20" }] })).toEqual(["The lease renewal closes Friday, November 20 at 5 PM."]);
    // a statement's due date beside the balance the reading quoted, and a reminder naming the open item: the same thing
    const balance = { kind: "pay" as const, text: "Pay $215.50 for the Cobaltline card", quote: "Statement balance: $215.50", due: "2026-11-25", time: null };
    expect(look("Statement balance: $215.50\nPayment due date: November 25, 2026", { first: { ...none, items: [balance] } })).toEqual([]);
    expect(look("Reminder: the lease renewal closes Friday, November 20 at 5 PM.", { shown: [{ kind: "respond", text: "Return the lease renewal form", due: "2026-11-20" }] })).toEqual([]);
  });

  it("round 14's faults: a card's figures and its day in words are one card, whichever the first reading took (Priya's Meridian)", () => {
    const CARD = "Priya Natarajan,\n\nYour Meridian Business Platinum card ending in 4417 expires at the end of December (12/26). Your replacement card has shipped and should arrive within 7–10 business days.\n\nTo avoid interruptions, activate the new card when it arrives and update it with merchants that bill you automatically before your current card expires on December 31, 2026.\n\nMeridian Card Services | Log in to manage your account.";
    const o = { automated: true, from: "Meridian Business Card" };
    // the day in words (the panel's first reading)
    const words = { kind: "expire" as const, text: "Activate the Meridian Business Platinum card and update automatic-billing merchants (expires Dec 31)", quote: "update it with merchants that bill you automatically before your current card expires on December 31, 2026.", due: "2026-12-31", time: null };
    expect(look(CARD, { ...o, first: { ...none, items: [words] } })).toEqual([]);
    // the figures alone, the 26th (the reading's card rule)
    const figures = { kind: "expire" as const, text: "Update merchants with the new Meridian Business Platinum card (expires 12/26)", quote: "Your Meridian Business Platinum card ending in 4417 expires at the end of December (12/26).", due: "2026-12-26", time: null };
    expect(look(CARD, { ...o, first: { ...none, items: [figures] } })).toEqual([]);
    // an open item of the card, shown to a reminder of it
    expect(look(CARD, { ...o, shown: [{ kind: "expire", text: "Update merchants for the Meridian Business Platinum card", due: "2026-12-31" }] })).toEqual([]);
    // another card's month, or nothing returned: still asked
    expect(look(CARD, o)).toHaveLength(2);
    expect(cardMonths("Your card expires at the end of December (12/26).")).toEqual(["2026-12"]);
    expect(cardMonths("Tu tarjeta vence 03/27.")).toEqual(["2027-03"]);
    expect(cardMonths("We'll see you 12/26 at the party.")).toEqual([]);
    expect(cardMonths("Your card expires 12/26/2026.")).toEqual([]);
  });

  it("a list's post the reader isn't named on gets no second look; one sent to them through a list still does (finding 9)", () => {
    const post = "Hola a todos:\n\nYo los acentos en versales los dejo siempre.\n\nPor cierto, la reunión mensual de la lista es el jueves 19 a las 20:00 en la cantina de siempre.\n\nHéctor";
    expect(look(post, { automated: true })).toHaveLength(1);
    expect(look(post, { automated: true, listed: true, addressed: "none" })).toEqual([]);
    expect(look(REGISTRATION, { automated: true, listed: true, addressed: "to" })).toEqual([CLOSES]);
  });

  describe("what a look returns that's already there, or already gone, is dropped (finding 10)", () => {
    const run = async (text: string, o: { first?: DatedResult["items"]; shown?: Parameters<typeof lookAt>[0]["shown"]; answer: DatedResult["items"]; arrivedAt?: number; now?: number; automated?: boolean }) => {
      const input: DatedInput = { text, subject: "", from: { name: "Sender", automated: o.automated ?? true }, reader: { name: "Reader", addressed: "to" }, to: [], cc: [], receivedAt: "x", zone: "UTC", open: [], language: "en" };
      const first = { ...none, items: o.first ?? [] };
      const r = await secondLook(first, { text, subject: "", arrivedAt: o.arrivedAt ?? NOW, automated: o.automated ?? true, shown: o.shown ?? [], now: o.now ?? NOW, input, promptChars: Infinity }, { recheck: async () => "go", claim: async () => true, read: async () => ({ ...none, items: o.answer }), aborted: () => false });
      if (typeof r === "string") throw new Error(r);
      expect(r.asked).toBe(1);
      return r.result.items.slice(first.items.length).map((x) => x.text);
    };

    it("a stay's check-out, or another moment of a stay or a flight already there", async () => {
      const HOTEL = "Your stay is confirmed.\n\nCheck-in: Monday, November 16, 2026 (3:00 PM)\nCheck-out: Wednesday, November 18, 2026 (11:00 AM)\n\nTotal: $764.10 (prepaid)";
      const stay = { kind: "event" as const, text: "Stay in Chicago", quote: "Check-in: Monday, November 16, 2026 (3:00 PM)", due: "2026-11-16", time: "15:00" };
      expect(await run(HOTEL, { first: [stay], answer: [{ kind: "event", text: "Hotel Marlowe Fulton Market (check-out Wed)", quote: "Check-out: Wednesday, November 18, 2026 (11:00 AM)", due: "2026-11-18", time: "11:00" }] })).toEqual([]);
      const CASA = "Llegada: miércoles 25 de noviembre, a partir de las 15:00\nSalida: martes 1 de diciembre, antes de las 11:00";
      const estancia = { kind: "event" as const, text: "Estancia en Casa Malasaña (salida el 1 dic)", quote: "Llegada: miércoles 25 de noviembre, a partir de las 15:00", due: "2026-11-25", time: "15:00" };
      expect(await run(CASA, { first: [estancia], answer: [{ kind: "event", text: "Salida de Casa Malasaña (antes de las 11:00)", quote: "Salida: martes 1 de diciembre, antes de las 11:00", due: "2026-12-01", time: null }] })).toEqual([]);
      const TRIP = "DEPART — Saturday, 05 Dec 2026\nPC 7 · SFO 11:55 PM → BLR 6:05 AM (Mon 07 Dec) via SIN\n\nRETURN — Saturday, 12 Dec 2026\nPC 8 · BLR 1:30 AM → SFO 4:40 PM";
      const out = { kind: "event" as const, text: "Flight from San Francisco to Bengaluru (arrives Mon 07 Dec)", quote: "DEPART — Saturday, 05 Dec 2026", due: "2026-12-05", time: "23:55" };
      expect(await run(TRIP, { first: [out], answer: [{ ...out, quote: "PC 7 · SFO 11:55 PM → BLR 6:05 AM (Mon 07 Dec) via SIN" }] })).toEqual([]);
    });

    it("an open item of its conversation or sender named on the same day; something else that day is kept", async () => {
      const LUCIA = "Hola Diego:\n\nRecuerda que vence el 17.\n\nLucía";
      const pay = { kind: "pay", text: "Pagar $3,214.00 de la declaración de octubre", due: "2026-11-17" };
      const declaration = { kind: "respond" as const, text: "Presentar la declaración mensual de octubre", quote: "Recuerda que vence el 17.", due: "2026-11-17", time: null };
      expect(await run(LUCIA, { automated: false, shown: [pay], answer: [declaration] })).toEqual([]);
      expect(await run(LUCIA, { automated: false, shown: [{ ...pay, due: "2026-11-18" }], answer: [declaration] })).toEqual([declaration.text]);
    });

    it("round 14's faults: the same thing in the same family whatever day each reading gave it, never another part of it", async () => {
      const DOMAIN = "Hi Priya,\n\nPlease renew lumora.io by Monday, November 30 to keep your email running.\n\nIf it isn't renewed, your lumora.io domain expires Friday, December 4 at 11:59 PM.\n\nHarborDNS";
      const renew = { kind: "renew" as const, text: "Renew the lumora.io domain", quote: "Please renew lumora.io by Monday, November 30 to keep your email running.", due: "2026-11-30", time: null };
      const expiry = { kind: "expire" as const, text: "lumora.io domain expires (Dec 4)", quote: "If it isn't renewed, your lumora.io domain expires Friday, December 4 at 11:59 PM.", due: "2026-12-04", time: "23:59" };
      expect(await run(DOMAIN, { first: [renew], answer: [expiry] })).toEqual([]);
      // an ask the look gives a day for: the same request
      const HANNAH = "Hi Priya,\n\nWho did your 409A, and would you use them again? We grant options on Friday, November 20 at 9:00.\n\nHannah";
      const ask = { kind: "ask", text: "Answer Hannah about your 409A provider", due: null };
      expect(await run(HANNAH, { automated: false, shown: [ask], answer: [{ kind: "respond", text: "Tell Hannah who did your 409A", quote: "We grant options on Friday, November 20 at 9:00.", due: "2026-11-20", time: null }] })).toEqual([]);
    });

    it("the Codex code review: never another of its kind on another day, by the look's whole words (another card, another amount)", async () => {
      // two cards of one name, told apart only by their quotes' endings
      const CARDS = "Your Meridian Business Platinum card ending in 4417 expires on December 31, 2026.\nYour Meridian Business Platinum card ending in 8822 expires on January 31, 2027.";
      const first = { kind: "expire" as const, text: "Update the Meridian Business Platinum card", quote: "Your Meridian Business Platinum card ending in 4417 expires on December 31, 2026.", due: "2026-12-31", time: null };
      const other = { ...first, quote: "Your Meridian Business Platinum card ending in 8822 expires on January 31, 2027.", due: "2027-01-31" };
      expect(await run(CARDS, { first: [first], answer: [other] })).toEqual([other.text]);
      // another amount of one name
      const DUES = "Your Harbor Club dues of $120.00 are due December 15, 2026.";
      expect(await run(DUES, { shown: [{ kind: "pay", text: "Pay the Harbor Club dues of $95.00", due: "2026-11-15" }], answer: [{ kind: "pay", text: "Pay the Harbor Club dues", quote: DUES, due: "2026-12-15", time: null }] })).toEqual(["Pay the Harbor Club dues"]);
    });

    it("the Codex code review: never another period's bill on another day; a month said as a day isn't a period (the domain's expiry above)", async () => {
      const BILL = "Your December electricity invoice is due December 21, 2026.";
      const december = { kind: "pay" as const, text: "Pay the December electricity invoice", quote: BILL, due: "2026-12-21", time: null };
      expect(await run(BILL, { shown: [{ kind: "pay", text: "Pay the November electricity invoice", due: "2026-11-20" }], answer: [december] })).toEqual([december.text]);
      const FACTURA = "Tu factura de luz de diciembre vence el 21 de diciembre de 2026.";
      const diciembre = { kind: "pay" as const, text: "Pagar la factura de luz de diciembre", quote: FACTURA, due: "2026-12-21", time: null };
      expect(await run(FACTURA, { shown: [{ kind: "pay", text: "Pagar la factura de luz de noviembre", due: "2026-11-20" }], answer: [diciembre] })).toEqual([diciembre.text]);
      // the same bill, its month said only as its day: still one
      expect(await run(BILL, { shown: [{ kind: "pay", text: "Pay the December electricity invoice", due: "2026-12-20" }], answer: [december] })).toEqual([]);
    });

    it("never a day already past its Missed window", async () => {
      const RFP = "Dear Jordan,\n\nKey dates:\nWritten questions due: November 6, 2026\nResponses due: November 20, 2026, 5:00 PM Eastern\n\nAlicia";
      const responses = { kind: "respond" as const, text: "Submit the Meridian RFP response", quote: "Responses due: November 20, 2026, 5:00 PM Eastern", due: "2026-11-20", time: "17:00" };
      const questions = { kind: "respond" as const, text: "Submit written questions for the Meridian RFP", quote: "Written questions due: November 6, 2026", due: "2026-11-06", time: null };
      const o = { automated: false, arrivedAt: at(2026, 10, 28, 9), first: [responses], answer: [questions] };
      expect(await run(RFP, { ...o, now: at(2026, 11, 16, 9) })).toEqual([]);
      expect(await run(RFP, { ...o, now: at(2026, 11, 12, 9) })).toEqual([questions.text]);
    });
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

  it("iteration 5's code review: a list's post the reader isn't named on is read once, never looked at again; the registrar's list mail to them still is", async () => {
    const { backend, model, receive, read } = await setup();
    model.answer = () => reply();
    await receive(backend, { cc: [], listId: "pageturners.lists.people.test" });
    await read(backend);
    expect(model.requests.map(isLook)).toEqual([false]);
    model.requests.length = 0;
    await receive(backend, { from: registrar, to: [me], cc: [], subject: "Spring 2027 registration is open", bodyText: REGISTRATION, providerThreadId: "reg", listId: "students.lists.uni.test" });
    await read(backend);
    expect(model.requests.map(isLook)).toEqual([false, true]);
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
