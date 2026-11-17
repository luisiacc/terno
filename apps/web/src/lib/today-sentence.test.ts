/**
 * Plan 204, the UI experiment: a Today item in one plain sentence, and its "when" in the briefing's right column, in
 * English and Spanish, from its own facts only.
 */
import type { ThreadSummary, TodayItem, TodayWhy } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { historySentence, historyWhen, todaySentence, todayWhen } from "./today-sentence";
import { dayHeading, weekHeading } from "./when";

// Friday 13 November 2026, 9:30 in the machine's own time (the panel's morning)
const NOW = new Date(2026, 10, 13, 9, 30).getTime();
const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).getTime();
const thread = { id: 1, subject: "Your statement is ready", fromName: "Hill Country Power & Water", fromEmail: "ebill@example.com", snippet: "", lastDate: at(1, 5, 30) } as ThreadSummary;
const item = (why: TodayWhy, more: Partial<TodayItem> = {}): TodayItem => ({ id: "dated:1", thread, why, ...more });
const dated = (kind: NonNullable<TodayWhy["item"]>["kind"], text: string, day: number, o: { missed?: boolean; timed?: { h: number; m: number }; dated?: boolean } = {}): TodayItem =>
  item({ kind: "dated", text, dueAt: o.timed ? at(day, o.timed.h, o.timed.m) : at(day, 9), missed: o.missed, item: { id: 1, revision: 0, kind, dueDay: `2026-11-${String(day).padStart(2, "0")}`, timed: !!o.timed, dated: o.dated ?? true } });
const promise = (text: string, day?: number, missed = false): TodayItem => item({ kind: "promise", text, dueAt: day === undefined ? undefined : at(day, 9), missed, personName: "Marcus Feld", promise: { id: 2, revision: 0, dated: day !== undefined } });

afterEach(() => setLocale("en", en));

describe("todaySentence (en)", () => {
  it("an item is its own words, the day left to the column", () => {
    expect(todaySentence(dated("pay", "Pay $187.42 for the electricity bill", 11, { missed: true }))).toBe("Pay $187.42 for the electricity bill.");
    expect(todaySentence(dated("renew", "Renew pingwire.dev for €14.90.", 19))).toBe("Renew pingwire.dev for €14.90.");
    expect(todaySentence(dated("ask", "Can you pick up Saturday nights?", 13, { dated: false }))).toBe("Can you pick up Saturday nights?");
  });

  it("an alert is the email's word", () => {
    expect(todaySentence(dated("alert", "Payment declined for $142.67", 10, { dated: false }))).toBe("Payment declined for $142.67, the email says.");
  });

  it("a promise of yours, in your words", () => {
    expect(todaySentence(promise("call Marcus at 4:00 PM PT", 13))).toBe("You said you'd call Marcus at 4:00 PM PT.");
    expect(todaySentence(promise("Send Elena the October update", 16))).toBe("You said you'd send Elena the October update.");
    expect(todaySentence(promise("RSVP to Lena"))).toBe("You said you'd RSVP to Lena.");
  });

  it("waiting and reminders: who and what, never more than the list knows", () => {
    expect(todaySentence(item({ kind: "waiting", wrote: true }))).toBe("Hill Country Power & Water wrote back about “Your statement is ready”.");
    expect(todaySentence(item({ kind: "waiting" }, { summary: "Tanya asks whether you can cover Saturday" }))).toBe("Tanya asks whether you can cover Saturday.");
    expect(todaySentence(item({ kind: "reminder", dueAt: at(13, 9) }))).toBe("Your reminder for “Your statement is ready”.");
  });

  it("no words: the subject, never an empty line", () => {
    expect(todaySentence(dated("pay", "  ", 16))).toBe("Your statement is ready.");
  });

  it("plan 210's groups by day set the weight: Missed and Today's dated tasks strong; what's undated in Today, its plans, a day ahead and Coming up quiet", () => {
    expect(todayWhen(dated("pay", "Pay", 13), NOW, "today")).toEqual({ text: "Today", tone: "today" });
    // a Plan still on from last night is Today's, drawn quietly under the day's tasks (plan 210, iteration 1), as a delivery is
    expect(todayWhen(dated("event", "Party", 12, { timed: { h: 23, m: 0 } }), NOW, "today").tone).toBe("later");
    expect(todayWhen(dated("delivery", "Parcel", 13), NOW, "today").tone).toBe("later");
    // what has no date sits in Today, its column saying when it came, quietly (the owner: so it isn't read as due today)
    expect(todayWhen(dated("alert", "Card frozen", 10, { dated: false }), NOW, "today")).toEqual({ text: "since Nov 1", tone: "none" });
    expect(todayWhen(dated("ask", "Answer Owen", 13, { dated: false }), NOW, "today")).toEqual({ text: "since Nov 1", tone: "none" });
    expect(todayWhen(item({ kind: "reminder", dueAt: at(13, 9) }), NOW, "today")).toEqual({ text: expect.stringMatching(/^9:00\sAM$/), tone: "none" });
    expect(todayWhen(dated("pay", "Pay", 14), NOW, "day:2026-11-14")).toEqual({ text: "Tomorrow", tone: "later" });
    expect(todayWhen(dated("pay", "Pay", 13), NOW, "today", true).tone).toBe("later");
    expect(todayWhen(dated("pay", "Pay", 11, { missed: true }), NOW, "missed").tone).toBe("missed");
  });
});

describe("todayWhen: the briefing's column, in the list's words, and how pressing it is", () => {
  it("due today, later, and Missed", () => {
    expect(todayWhen(dated("pay", "Pay", 13), NOW)).toEqual({ text: "Today", tone: "today" });
    expect(todayWhen(dated("pay", "Pay", 16), NOW)).toEqual({ text: "Mon", tone: "later" });
    expect(todayWhen(dated("renew", "Renew", 30), NOW)).toEqual({ text: "Nov 30", tone: "later" });
    expect(todayWhen(dated("pay", "Pay", 11, { missed: true }), NOW)).toEqual({ text: "Was due Wed", tone: "missed" });
    expect(todayWhen(dated("respond", "Submit", 12, { missed: true, timed: { h: 23, m: 59 } }), NOW)).toEqual({ text: "Was due yesterday", tone: "missed" });
  });

  it("a timed item says its time, today alone, another day after the day", () => {
    expect(todayWhen(dated("event", "1:1", 13, { timed: { h: 14, m: 0 } }), NOW).text).toMatch(/^2:00\sPM$/);
    expect(todayWhen(dated("event", "Flight", 16, { timed: { h: 7, m: 40 } }), NOW)).toEqual({ text: expect.stringMatching(/^Mon 7:40\sAM$/), tone: "later" });
    expect(todayWhen(dated("event", "Game", 14, { timed: { h: 10, m: 0 } }), NOW).text).toMatch(/^Tomorrow 10:00\sAM$/);
  });

  it("what has no date (an alert that named none, an ask, a waiting reply) says since when, quietly (plan 210)", () => {
    expect(todayWhen(dated("alert", "Card frozen", 10, { dated: false }), NOW)).toEqual({ text: "since Nov 1", tone: "none" });
    expect(todayWhen(dated("ask", "Answer Owen", 13, { dated: false }), NOW)).toEqual({ text: "since Nov 1", tone: "none" });
    expect(todayWhen(item({ kind: "waiting" }), NOW)).toEqual({ text: "since Nov 1", tone: "none" });
    // after the screenshots: mid-phrase, yesterday in lower case
    const yesterday = { ...item({ kind: "waiting" }), thread: { ...thread, lastDate: at(12, 15) } };
    expect(todayWhen(yesterday, NOW).text).toBe("since yesterday");
  });

  it("round 15's second morning: an ask says since its own mail, never since the conversation's last message (your own holding reply, their thanks); a promise since you said it", () => {
    // Theo's Marcus: asked Nov 8, Theo's holding reply yesterday at 4:30 PM
    const replied = { ...thread, lastDate: at(12, 16, 30) };
    const marcus = dated("ask", "Answer Marcus Lee about a call", 8, { dated: false });
    expect(todayWhen({ ...marcus, why: { ...marcus.why, came: at(8, 9) }, thread: replied }, NOW)).toEqual({ text: "since Nov 8", tone: "none" });
    const alert = dated("alert", "Card frozen", 10, { dated: false });
    expect(todayWhen({ ...alert, why: { ...alert.why, came: at(10, 7) }, thread: replied }, NOW).text).toBe("since Nov 10");
    const draft = promise("send the draft");
    expect(todayWhen({ ...draft, why: { ...draft.why, sentAt: at(9, 18) }, thread: replied }, NOW).text).toBe("since Nov 9");
    // a conversation waiting on you: since its last message, as before
    expect(todayWhen({ ...item({ kind: "waiting" }), thread: replied }, NOW).text).toBe("since yesterday");
  });

  it("a promise: its day, Missed, or none when it named none", () => {
    expect(todayWhen(promise("call Marcus", 13), NOW)).toEqual({ text: "Today", tone: "today" });
    expect(todayWhen(promise("send the slip", 11, true), NOW)).toEqual({ text: "Was due Wed", tone: "missed" });
    expect(todayWhen(promise("send the draft"), NOW)).toEqual({ text: "since Nov 1", tone: "none" });
  });
});

describe("a day's heading (plan 210: by day)", () => {
  it("Tomorrow, the weekday this week, the day with its date beyond; capitalised, en and es", () => {
    expect(dayHeading(at(14, 9), NOW)).toBe("Tomorrow");
    expect(dayHeading(at(17, 9), NOW)).toBe("Tuesday");
    expect(dayHeading(at(30, 9), NOW)).toBe("Mon, Nov 30");
    setLocale("es", es);
    expect(dayHeading(at(14, 9), NOW)).toBe("Mañana");
    expect(dayHeading(at(17, 9), NOW)).toBe("Martes");
    expect(dayHeading(at(30, 9), NOW)).toMatch(/^Lun, 30 nov$/);
  });
  it("plan 210 (iteration 3): past two weeks, a week's heading by its Monday, the year only when it isn't this one's", () => {
    expect(weekHeading(new Date(2026, 11, 7).getTime(), NOW)).toBe("Week of Dec 7");
    expect(weekHeading(new Date(2027, 0, 4).getTime(), NOW)).toBe("Week of Jan 4, 2027");
    setLocale("es", es);
    expect(weekHeading(new Date(2026, 11, 7).getTime(), NOW)).toBe("Semana del 7 dic");
  });
});

describe("Spanish", () => {
  it("the same facts in Spanish", () => {
    setLocale("es", es);
    expect(todaySentence(dated("alert", "Tarjeta bloqueada", 16))).toBe("Tarjeta bloqueada, según el correo.");
    expect(todaySentence(promise("enviar a Valeria los ajustes", 11, true))).toBe("Dijiste que ibas a enviar a Valeria los ajustes.");
    expect(todaySentence(item({ kind: "waiting" }))).toBe("Hill Country Power & Water te escribió sobre «Your statement is ready».");
    expect(todayWhen(dated("pay", "Pagar", 11, { missed: true }), NOW).text).toBe("Venció el mié");
    expect(todayWhen(dated("pay", "Pagar", 13), NOW).text).toBe("Hoy");
    expect(todayWhen(item({ kind: "waiting" }), NOW).text).toBe("desde 1 nov");
  });
});

describe("the history's lines (plan 210)", () => {
  const line = (kind: "pay" | "alert" | "respond" | "promise", outcome: "done" | "dismissed" | "settled" | "over" | "replaced" | "changed", at: number, text = "Pay $187.42 for the electricity bill", more: { on?: number; reason?: string } = {}) => ({ thread, kind, outcome, text, key: { at, src: kind === "promise" ? (1 as const) : (0 as const), id: 1 }, ...more });

  it("says the item as the open part did, and in the column what happened and when", () => {
    expect(historySentence(line("pay", "done", at(13, 8)))).toBe("Pay $187.42 for the electricity bill.");
    expect(historySentence(line("alert", "settled", at(12), "Payment declined"))).toBe("Payment declined, the email says.");
    // plan 210 (iteration 3): words the app cut never gain ", the email says" after their ellipsis
    expect(historySentence(line("alert", "settled", at(12), "$1,186.40 Pingwire team payment failed on Visa ending in 4242…"))).toBe("The email says: $1,186.40 Pingwire team payment failed on Visa ending in 4242…");
    expect(historySentence(line("promise", "dismissed", at(10), "Send Jess the deck"))).toBe("You said you'd send Jess the deck.");
    expect(historySentence(line("pay", "done", at(10), " "))).toBe("Your statement is ready.");
    expect(historyWhen(line("pay", "done", at(13, 8)), NOW)).toBe("Done today");
    expect(historyWhen(line("pay", "dismissed", at(12, 9)), NOW)).toBe("Removed yesterday");
    expect(historyWhen(line("promise", "dismissed", at(11)), NOW)).toBe("Removed Wed");
    // plan 210 (iteration 4, revision 7): settled by mail, how and the day that mail came, not the day it was read
    expect(historyWhen(line("pay", "settled", at(2)), NOW)).toBe("Paid Nov 2");
    expect(historyWhen(line("pay", "settled", at(13, 8), undefined, { on: at(9, 18), reason: "settled" }), NOW)).toBe("Paid Mon");
    expect(historyWhen(line("respond", "settled", at(13, 8), undefined, { on: at(12, 7), reason: "answered" }), NOW)).toBe("Answered yesterday");
    expect(historyWhen(line("alert", "settled", at(13, 8), undefined, { on: at(11), reason: "settled" }), NOW)).toBe("Settled Wed");
    expect(historyWhen(line("promise", "done", at(13, 8), undefined, { on: at(10), reason: "kept" }), NOW)).toBe("Done Tue");
    expect(historyWhen(line("pay", "over", at(9)), NOW)).toBe("Over Mon");
    // plan 210 (iteration 3): a promise its person replaced with another request
    expect(historyWhen(line("promise", "replaced", at(12, 9)), NOW)).toBe("Replaced yesterday");
    // plan 210 (iteration 4): handed on by a confirmed forward, to whom, by first name (an address's local part with none)
    expect(historyWhen({ ...line("pay", "done", at(10)), outcome: "handed", handedTo: { name: "Jess Okafor", email: "jess@home.test" } }, NOW)).toBe("Handed to Jess Tue");
    expect(historyWhen({ ...line("promise", "done", at(13, 8)), outcome: "handed", handedTo: { name: "", email: "sam.lee@home.test" } }, NOW)).toBe("Handed to sam.lee today");
    // round 15's second morning: an open item the user changed is still open, never read as finished among Earlier's lines
    expect(historyWhen(line("respond", "changed", at(12, 16, 50)), NOW)).toBe("Still open · changed yesterday");
  });

  it("in Spanish", () => {
    setLocale("es", es);
    expect(historyWhen(line("pay", "done", at(13, 8)), NOW)).toBe("Hecho hoy");
    expect(historyWhen(line("pay", "over", at(11)), NOW)).toBe("Pasó el mié");
    expect(historyWhen(line("promise", "dismissed", at(11)), NOW)).toBe("Quitado el mié");
    expect(historyWhen(line("promise", "replaced", at(11)), NOW)).toBe("Reemplazado el mié");
    expect(historyWhen(line("pay", "changed", at(11)), NOW)).toBe("Sigue pendiente · cambiado el mié");
    expect(historyWhen({ ...line("pay", "done", at(10)), outcome: "handed", handedTo: { name: "Jess Okafor", email: "jess@home.test" } }, NOW)).toBe("Delegado a Jess el mar");
    expect(historyWhen(line("pay", "settled", at(13, 8), undefined, { on: at(11), reason: "settled" }), NOW)).toBe("Pagado el mié");
    expect(historyWhen(line("respond", "settled", at(13, 8), undefined, { on: at(12), reason: "answered" }), NOW)).toBe("Respondido ayer");
    expect(historySentence(line("alert", "settled", at(12), "Pago rechazado de $1,186.40 en la Visa…"))).toBe("Según el correo: Pago rechazado de $1,186.40 en la Visa…");
    expect(historySentence(line("promise", "done", at(11), "enviar a Valeria los ajustes"))).toBe("Dijiste que ibas a enviar a Valeria los ajustes.");
  });
});


describe("plan 210 (iteration 2): one time per row, a request shown early, a broken promise", () => {
  const dueAt = (day: number, h: number, m = 0) => at(day, h, m);
  it("the reader's time, and the mail's own in brackets only when its zone isn't the reader's", () => {
    const rfp = item({ kind: "dated", text: "Submit the RFP response", dueAt: dueAt(16, 16), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-16", timed: true, dated: true, note: "5:00 PM ET" } });
    expect(todayWhen(rfp, NOW)).toEqual({ text: "Mon 4:00 PM (5:00 PM ET)", tone: "later" });
    expect(todaySentence(rfp)).toBe("Submit the RFP response.");
    const local = item({ kind: "dated", text: "Standup", dueAt: dueAt(16, 16), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-16", timed: true, dated: true } });
    expect(todayWhen(local, NOW).text).toBe("Mon 4:00 PM");
    // a promise whose words state its time: the column says it, the sentence doesn't
    const call = item({ kind: "promise", text: "call Marcus", dueAt: dueAt(16, 19), promise: { id: 2, revision: 0, dated: true, timed: true, note: "4:00 PM PT" } });
    expect(todayWhen(call, NOW).text).toBe("Mon 7:00 PM (4:00 PM PT)");
    expect(todaySentence(call)).toBe("You said you'd call Marcus.");
  });

  it("a person's request shown before its day says what it's by, quietly", () => {
    const renewal = item({ kind: "dated", text: "Set up the renewal call", dueAt: at(30, 9), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-30", timed: false, dated: true, early: true } });
    expect(todayWhen(renewal, NOW, "today")).toEqual({ text: "by Nov 30", tone: "none" });
    // plan 210 (iteration 3): Today's Waiting on you, quiet; a timed one keeps its time and the mail's zone when it differs
    expect(todayWhen(renewal, NOW, "waiting")).toEqual({ text: "by Nov 30", tone: "none" });
    const rfp = item({ kind: "dated", text: "Submit the RFP", dueAt: dueAt(20, 16), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-20", timed: true, dated: true, early: true, note: "5:00 PM ET" } });
    expect(todayWhen(rfp, NOW, "waiting")).toEqual({ text: "by Nov 20 4:00 PM (5:00 PM ET)", tone: "none" });
    const soon = item({ kind: "dated", text: "Send the bio", dueAt: dueAt(14, 12), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-14", timed: true, dated: true, early: true } });
    expect(todayWhen(soon, NOW, "waiting").text).toMatch(/^by tomorrow 12:00\sPM$/);
    expect(todayWhen(dated("ask", "Answer Owen", 13, { dated: false }), NOW, "waiting")).toEqual({ text: "since Nov 1", tone: "none" });
  });

  it("a promise said and missed, under its live day, says both in Missed's weight; one ahead says the day it's needed by", () => {
    // Owen moved it to Monday after Tuesday the 10th passed (iteration 3: replaces iteration 2's "Mon · promised Tue")
    const owen = item({ kind: "promise", text: "send the pen test summary", dueAt: at(16, 9), promise: { id: 2, revision: 0, dated: true, said: at(10, 9), needed: at(16, 9) } });
    expect(todayWhen(owen, NOW, "day:2026-11-16")).toEqual({ text: "You said Tue 10 (missed) ·\u00a0needed Mon", tone: "missed" });
    // María said yesterday; the school needs it today
    const slip = item({ kind: "promise", text: "send the slip", dueAt: at(13, 9), promise: { id: 3, revision: 0, dated: true, said: at(12, 9), needed: at(13, 9) } });
    expect(todayWhen(slip, NOW, "today")).toEqual({ text: "You said yesterday (missed) ·\u00a0needed today", tone: "missed" });
    // a week and more ago: its date
    const old = item({ kind: "promise", text: "x", dueAt: at(16, 9), promise: { id: 4, revision: 0, dated: true, said: at(2, 9), needed: at(16, 9) } });
    expect(todayWhen(old, NOW, "day:2026-11-16").text).toBe("You said Nov 2 (missed) ·\u00a0needed Mon");
    // ahead of the request's day
    const deck = item({ kind: "promise", text: "x", dueAt: at(17, 9), promise: { id: 5, revision: 0, dated: true, needed: at(19, 9) } });
    expect(todayWhen(deck, NOW, "day:2026-11-17")).toEqual({ text: "Tue ·\u00a0needed Thu", tone: "later" });
    const tomorrow = item({ kind: "promise", text: "x", dueAt: at(13, 15), promise: { id: 6, revision: 0, dated: true, timed: true, needed: at(14, 9) } });
    expect(todayWhen(tomorrow, NOW, "today").text).toBe("3:00 PM ·\u00a0needed tomorrow");
  });

  it("plan 210 (iteration 4, revision 11): a day the mail asked for it before is said as the mail said it, never the day it sorts under", () => {
    // Jordan's SOC 2 report: Owen moved it "before then", the Monday, after Tuesday the 10th passed
    const owen = item({ kind: "promise", text: "x", dueAt: at(15, 9), promise: { id: 2, revision: 0, dated: true, said: at(10, 9), needed: at(15, 9), neededBefore: "2026-11-16" } });
    expect(todayWhen(owen, NOW, "day:2026-11-15")).toEqual({ text: "You said Tue 10 (missed) ·\u00a0needed before Mon", tone: "missed" });
    // a request it answers, asked before Saturday: tomorrow's words
    const deck = item({ kind: "promise", text: "x", dueAt: at(13, 15), promise: { id: 5, revision: 0, dated: true, timed: true, needed: at(14, 9), neededBefore: "2026-11-15" } });
    expect(todayWhen(deck, NOW, "today").text).toBe("3:00 PM ·\u00a0needed before Sun");
    // Priya's Marcus: a request "before then" (Monday), early among the people and under its day
    const marcus = item({ kind: "dated", text: "x", dueAt: at(15, 9), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-15", timed: false, dated: true, early: true, before: "2026-11-16" } });
    expect(todayWhen(marcus, NOW, "waiting")).toEqual({ text: "before Mon", tone: "none" });
    expect(todayWhen({ ...marcus, why: { ...marcus.why, item: { ...marcus.why.item!, early: false } } }, NOW, "day:2026-11-15").text).toBe("before Mon");
    // tomorrow's, and on the day itself plainly today
    const sat = item({ kind: "dated", text: "x", dueAt: at(13, 9), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-13", timed: false, dated: true, before: "2026-11-14" } });
    expect(todayWhen(sat, NOW, "today").text).toBe("Today");
    // a promise its person moved "before Mon", not broken
    const moved = item({ kind: "promise", text: "x", dueAt: at(15, 9), promise: { id: 7, revision: 0, dated: true, before: "2026-11-16" } });
    expect(todayWhen(moved, NOW, "day:2026-11-15").text).toBe("before Mon");
    setLocale("es", es);
    expect(todayWhen(owen, NOW, "day:2026-11-15").text).toBe("Dijiste el mar 10 (se pasó) ·\u00a0lo necesitan antes del lun");
    expect(todayWhen(marcus, NOW, "waiting").text).toBe("antes del lun");
  });

  it("plan 210 (iteration 5, revision 4): a part of the day is said as a part, never a clock; missed after its noon", () => {
    // NOW is Friday the 13th, 9:30: María's cupcakes this morning, Margaret's key tomorrow morning, Kai's notes by Sat morning
    const cupcakes = item({ kind: "promise", text: "bring Jessica the cupcakes", dueAt: at(13, 9), promise: { id: 2, revision: 0, dated: true, part: "morning" } });
    expect(todayWhen(cupcakes, NOW, "today")).toEqual({ text: "This morning", tone: "today" });
    const key = item({ kind: "promise", text: "drop Phil the spare key", dueAt: at(14, 9), promise: { id: 3, revision: 0, dated: true, part: "morning" } });
    expect(todayWhen(key, NOW, "day:2026-11-14").text).toBe("Tomorrow morning");
    const library = item({ kind: "promise", text: "scan both papers at the library", dueAt: at(17, 9), promise: { id: 4, revision: 0, dated: true, part: "morning" } });
    expect(todayWhen(library, NOW, "day:2026-11-17").text).toBe("Tue morning");
    const kai = item({ kind: "dated", text: "Send Kai notes on cut v2", dueAt: at(14, 9), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-14", timed: false, dated: true, early: true, part: "morning" } });
    expect(todayWhen(kai, NOW, "waiting")).toEqual({ text: "by tomorrow morning", tone: "none" });
    expect(todayWhen({ ...kai, why: { ...kai.why, dueAt: at(16, 9), item: { ...kai.why.item!, dueDay: "2026-11-16" } } }, NOW, "waiting").text).toBe("by Mon morning");
    // missed at noon the same day: "Was due this morning", never "by 12:00 PM"
    expect(todayWhen({ ...cupcakes, why: { ...cupcakes.why, missed: true } }, at(13, 12), "missed")).toEqual({ text: "Was due this morning", tone: "missed" });
    // a request it answers, needed tomorrow morning
    const notes = item({ kind: "promise", text: "send Kai notes", dueAt: at(13, 9), promise: { id: 5, revision: 0, dated: true, needed: at(14, 9), neededPart: "morning" } });
    expect(todayWhen(notes, NOW, "today").text).toBe("Today · needed tomorrow morning");
    setLocale("es", es);
    expect(todayWhen(cupcakes, NOW, "today").text).toBe("Esta mañana");
    expect(todayWhen(key, NOW, "day:2026-11-14").text).toBe("Mañana por la mañana");
    expect(todayWhen(library, NOW, "day:2026-11-17").text).toBe("mar por la mañana");
    expect(todayWhen(kai, NOW, "waiting").text).toBe("para mañana por la mañana");
    expect(todayWhen({ ...cupcakes, why: { ...cupcakes.why, missed: true } }, at(13, 12), "missed").text).toBe("Venció esta mañana");
    expect(todayWhen(notes, NOW, "today").text).toBe("Hoy · lo necesitan mañana por la mañana");
  });

  it("plan 210 (iteration 4, revision 10): travel says the mail's clock with the place, never the reader's", () => {
    // Theo's tech check, 4:00 PM in Austin (2:00 PM where he reads it)
    const check = item({ kind: "dated", text: "Tech check", dueAt: at(16, 14), item: { id: 1, revision: 0, kind: "event", dueDay: "2026-11-16", timed: true, dated: true, travel: { day: "2026-11-16", time: "16:00", place: "Austin" } } });
    expect(todayWhen(check, NOW, "day:2026-11-16").text).toMatch(/^Mon 4:00\sPM Austin$/);
    const today = item({ kind: "dated", text: "Flight to Denver", dueAt: at(13, 17), item: { id: 1, revision: 0, kind: "event", dueDay: "2026-11-13", timed: true, dated: true, travel: { day: "2026-11-13", time: "18:05", place: "Austin" } } });
    expect(todayWhen(today, NOW, "today").text).toMatch(/^6:05\sPM Austin$/);
    setLocale("es", es);
    expect(todayWhen(check, NOW, "day:2026-11-16").text).toBe("lun 16:00 en Austin");
  });

  it("in Spanish", () => {
    setLocale("es", es);
    const renewal = item({ kind: "dated", text: "x", dueAt: at(30, 9), item: { id: 1, revision: 0, kind: "respond", dueDay: "2026-11-30", timed: false, dated: true, early: true } });
    expect(todayWhen(renewal, NOW, "today").text).toBe("para el 30 nov");
    const owen = item({ kind: "promise", text: "x", dueAt: at(16, 9), promise: { id: 2, revision: 0, dated: true, said: at(10, 9), needed: at(16, 9) } });
    expect(todayWhen(owen, NOW, "day:2026-11-16").text).toBe("Dijiste el mar 10 (se pasó) ·\u00a0lo necesitan el lun");
    const slip = item({ kind: "promise", text: "x", dueAt: at(13, 9), promise: { id: 3, revision: 0, dated: true, said: at(12, 9), needed: at(13, 9) } });
    expect(todayWhen(slip, NOW, "today").text).toBe("Dijiste ayer (se pasó) ·\u00a0lo necesitan hoy");
    const deck = item({ kind: "promise", text: "x", dueAt: at(17, 9), promise: { id: 5, revision: 0, dated: true, needed: at(19, 9) } });
    expect(todayWhen(deck, NOW, "day:2026-11-17").text).toBe("mar ·\u00a0lo necesitan el jue");
  });
});
