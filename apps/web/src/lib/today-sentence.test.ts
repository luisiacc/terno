/**
 * Plan 204, the UI experiment: a Today item in one plain sentence, and its "when" in the briefing's right column, in
 * English and Spanish, from its own facts only.
 */
import type { ThreadSummary, TodayItem, TodayWhy } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { groupLine, historySentence, historyWhen, todaySentence, todayWhen } from "./today-sentence";

// Friday 13 November 2026, 9:30 in the machine's own time (the panel's morning)
const NOW = new Date(2026, 10, 13, 9, 30).getTime();
const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).getTime();
const thread = { id: 1, subject: "Your statement is ready", fromName: "Hill Country Power & Water", fromEmail: "ebill@example.com", snippet: "", lastDate: at(1, 5, 30) } as ThreadSummary;
const item = (why: TodayWhy, more: Partial<TodayItem> = {}): TodayItem => ({ thread, why, ...more });
const dated = (kind: NonNullable<TodayWhy["item"]>["kind"], text: string, day: number, o: { missed?: boolean; timed?: { h: number; m: number }; dated?: boolean } = {}): TodayItem =>
  item({ kind: "dated", text, dueAt: o.timed ? at(day, o.timed.h, o.timed.m) : at(day, 9), missed: o.missed, item: { id: 1, revision: 0, kind, dueDay: `2026-11-${String(day).padStart(2, "0")}`, timed: !!o.timed, dated: o.dated ?? true } });
const promise = (text: string, day?: number, missed = false): TodayItem => item({ kind: "promise", text, dueAt: day === undefined ? undefined : at(day, 9), missed, personName: "Marcus Feld", promise: { id: 2, revision: 0, dated: day !== undefined } });

afterEach(() => setLocale("en", en));

describe("todaySentence (en)", () => {
  it("an item is its own words, the day left to the column", () => {
    expect(todaySentence(dated("pay", "Pay $187.42 for the electricity bill", 11, { missed: true }), NOW)).toBe("Pay $187.42 for the electricity bill.");
    expect(todaySentence(dated("renew", "Renew pingwire.dev for €14.90.", 19), NOW)).toBe("Renew pingwire.dev for €14.90.");
    expect(todaySentence(dated("ask", "Can you pick up Saturday nights?", 13, { dated: false }), NOW)).toBe("Can you pick up Saturday nights?");
  });

  it("an alert is the email's word", () => {
    expect(todaySentence(dated("alert", "Payment declined for $142.67", 10, { dated: false }), NOW)).toBe("Payment declined for $142.67, the email says.");
  });

  it("a promise of yours, in your words", () => {
    expect(todaySentence(promise("call Marcus at 4:00 PM PT", 13), NOW)).toBe("You said you'd call Marcus at 4:00 PM PT.");
    expect(todaySentence(promise("Send Elena the October update", 16), NOW)).toBe("You said you'd send Elena the October update.");
    expect(todaySentence(promise("RSVP to Lena"), NOW)).toBe("You said you'd RSVP to Lena.");
  });

  it("waiting, nudges and reminders: who and what, never more than the list knows", () => {
    expect(todaySentence(item({ kind: "waiting", wrote: true }), NOW)).toBe("Hill Country Power & Water wrote back about “Your statement is ready”.");
    expect(todaySentence(item({ kind: "waiting" }, { summary: "Tanya asks whether you can cover Saturday" }), NOW)).toBe("Tanya asks whether you can cover Saturday.");
    expect(todaySentence(item({ kind: "nudge", personName: "Megan Cole", sentAt: at(7) }), NOW)).toBe("No reply from Megan Cole in 6 days.");
    expect(todaySentence(item({ kind: "reminder", dueAt: at(13, 9) }), NOW)).toBe("Your reminder for “Your statement is ready”.");
  });

  it("no words: the subject, never an empty line", () => {
    expect(todaySentence(dated("pay", "  ", 16), NOW)).toBe("Your statement is ready.");
  });

  it("the chat's group lines count", () => {
    expect(groupLine("missed", 3)).toBe("3 things you missed");
    expect(groupLine("plans", 1)).toBe("1 plan ahead");
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

  it("an alert with no day says none and is pressing; an ask and a waiting reply show the day they came, quietly", () => {
    expect(todayWhen(dated("alert", "Card frozen", 10, { dated: false }), NOW)).toEqual({ text: null, tone: "today" });
    expect(todayWhen(dated("ask", "Answer Owen", 13, { dated: false }), NOW)).toEqual({ text: "Nov 1", tone: "none" });
    expect(todayWhen(item({ kind: "waiting" }), NOW)).toEqual({ text: "Nov 1", tone: "none" });
  });

  it("a promise: its day, Missed, or none when it named none", () => {
    expect(todayWhen(promise("call Marcus", 13), NOW)).toEqual({ text: "Today", tone: "today" });
    expect(todayWhen(promise("send the slip", 11, true), NOW)).toEqual({ text: "Was due Wed", tone: "missed" });
    expect(todayWhen(promise("send the draft"), NOW)).toEqual({ text: null, tone: "none" });
  });
});

describe("Spanish", () => {
  it("the same facts in Spanish", () => {
    setLocale("es", es);
    expect(todaySentence(dated("alert", "Tarjeta bloqueada", 16), NOW)).toBe("Tarjeta bloqueada, según el correo.");
    expect(todaySentence(promise("enviar a Valeria los ajustes", 11, true), NOW)).toBe("Dijiste que ibas a enviar a Valeria los ajustes.");
    expect(todaySentence(item({ kind: "waiting" }), NOW)).toBe("Hill Country Power & Water te escribió sobre «Your statement is ready».");
    expect(todayWhen(dated("pay", "Pagar", 11, { missed: true }), NOW).text).toBe("Venció el mié");
    expect(todayWhen(dated("pay", "Pagar", 13), NOW).text).toBe("Hoy");
    expect(groupLine("missed", 2)).toBe("2 cosas que se te pasaron");
  });
});

describe("the history's lines (plan 210)", () => {
  const line = (kind: "pay" | "alert" | "promise", outcome: "done" | "dismissed" | "settled" | "over", at: number, text = "Pay $187.42 for the electricity bill") => ({ thread, kind, outcome, text, key: { at, src: kind === "promise" ? (1 as const) : (0 as const), id: 1 } });

  it("says the item as the open part did, and in the column what happened and when", () => {
    expect(historySentence(line("pay", "done", at(13, 8)))).toBe("Pay $187.42 for the electricity bill.");
    expect(historySentence(line("alert", "settled", at(12), "Payment declined"))).toBe("Payment declined, the email says.");
    expect(historySentence(line("promise", "dismissed", at(10), "Send Jess the deck"))).toBe("You said you'd send Jess the deck.");
    expect(historySentence(line("pay", "done", at(10), " "))).toBe("Your statement is ready.");
    expect(historyWhen(line("pay", "done", at(13, 8)), NOW)).toBe("Done today");
    expect(historyWhen(line("pay", "dismissed", at(12, 9)), NOW)).toBe("Not a task yesterday");
    expect(historyWhen(line("promise", "dismissed", at(11)), NOW)).toBe("Not a promise Wed");
    expect(historyWhen(line("pay", "settled", at(2)), NOW)).toBe("Settled Nov 2");
    expect(historyWhen(line("pay", "over", at(9)), NOW)).toBe("Over Mon");
    expect(groupLine("history", 40)).toBe("Earlier");
  });

  it("in Spanish", () => {
    setLocale("es", es);
    expect(historyWhen(line("pay", "done", at(13, 8)), NOW)).toBe("Hecho hoy");
    expect(historyWhen(line("pay", "over", at(11)), NOW)).toBe("Pasó el mié");
    expect(historySentence(line("promise", "done", at(11), "enviar a Valeria los ajustes"))).toBe("Dijiste que ibas a enviar a Valeria los ajustes.");
    expect(groupLine("history", 3)).toBe("Antes");
  });
});

