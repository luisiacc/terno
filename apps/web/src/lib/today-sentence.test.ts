/** Plan 204, the UI experiment: a Today item said in one plain sentence, in English and Spanish, from its own facts only. */
import type { ThreadSummary, TodayItem, TodayWhy } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { groupLine, todaySentence } from "./today-sentence";

// Friday 13 November 2026, 9:30 in the machine's own time (the panel's morning)
const NOW = new Date(2026, 10, 13, 9, 30).getTime();
const at = (d: number, h = 0, m = 0) => new Date(2026, 10, d, h, m).getTime();
const thread = { id: 1, subject: "Your statement is ready", fromName: "Hill Country Power & Water", fromEmail: "ebill@example.com", snippet: "", lastDate: at(1) } as ThreadSummary;
const item = (why: TodayWhy, more: Partial<TodayItem> = {}): TodayItem => ({ thread, why, ...more });
const dated = (kind: NonNullable<TodayWhy["item"]>["kind"], text: string, day: number, o: { missed?: boolean; timed?: { h: number; m: number }; dated?: boolean } = {}): TodayItem =>
  item({ kind: "dated", text, dueAt: o.timed ? at(day, o.timed.h, o.timed.m) : at(day, 9), missed: o.missed, item: { id: 1, revision: 0, kind, dueDay: `2026-11-${String(day).padStart(2, "0")}`, timed: !!o.timed, dated: o.dated ?? true } });
const promise = (text: string, day?: number, missed = false): TodayItem => item({ kind: "promise", text, dueAt: day === undefined ? undefined : at(day, 9), missed, personName: "Marcus Feld", promise: { id: 2, revision: 0, dated: day !== undefined } });

afterEach(() => setLocale("en", en));

describe("todaySentence (en)", () => {
  it("a bill: due on its day, or was due when it's Missed", () => {
    expect(todaySentence(dated("pay", "Pay $2,418.33 for the Cirrus Cloud invoice", 16), NOW)).toBe("Pay $2,418.33 for the Cirrus Cloud invoice, due Monday.");
    expect(todaySentence(dated("pay", "Pay $187.42 for the electricity bill", 11, { missed: true }), NOW)).toBe("Pay $187.42 for the electricity bill. It was due Wednesday.");
    expect(todaySentence(dated("respond", "RSVP for Sofia to Ava's party.", 13), NOW)).toBe("RSVP for Sofia to Ava's party, due today.");
    expect(todaySentence(dated("respond", "Submit abstract", 14, { timed: { h: 17, m: 0 } }), NOW)).toBe("Submit abstract, due tomorrow at 5:00 PM.");
  });

  it("renewals and expiries say their day once", () => {
    expect(todaySentence(dated("renew", "Renew pingwire.dev for €14.90", 30), NOW)).toBe("Renew pingwire.dev for €14.90. It renews Nov 30.");
    expect(todaySentence(dated("expire", "BLS certification expires", 19), NOW)).toBe("BLS certification expires Thursday.");
    expect(todaySentence(dated("expire", "Card ending 4421", 19), NOW)).toBe("Card ending 4421. It expires Thursday.");
  });

  it("an alert is the email's word, with its deadline if it named one", () => {
    expect(todaySentence(dated("alert", "Payment declined for $142.67", 10, { dated: false, missed: true }), NOW)).toBe("Payment declined for $142.67, the email says.");
    expect(todaySentence(dated("alert", "Corporate card will be suspended", 16), NOW)).toBe("Corporate card will be suspended, the email says. The deadline is Monday.");
  });

  it("plans lead with when; an ask is its words", () => {
    expect(todaySentence(dated("event", "Flight to Austin", 16, { timed: { h: 7, m: 40 } }), NOW)).toBe("Monday at 7:40 AM: Flight to Austin.");
    expect(todaySentence(dated("delivery", "Package arriving by 9 PM", 13), NOW)).toBe("Today: Package arriving by 9 PM.");
    expect(todaySentence(dated("ask", "Can you pick up Saturday nights?", 13, { dated: false }), NOW)).toBe("Can you pick up Saturday nights?");
  });

  it("a promise of yours, in your words, with its day", () => {
    expect(todaySentence(promise("call Marcus at 4:00 PM PT", 13), NOW)).toBe("You said you'd call Marcus at 4:00 PM PT today.");
    expect(todaySentence(promise("be there at 7:30 AM with snacks", 14), NOW)).toBe("You said you'd be there at 7:30 AM with snacks tomorrow.");
    expect(todaySentence(promise("Send Elena the October update", 16), NOW)).toBe("You said you'd send Elena the October update by Monday.");
    expect(todaySentence(promise("send the slip", 11, true), NOW)).toBe("You said you'd send the slip. It was due Wednesday.");
    expect(todaySentence(promise("send the draft"), NOW)).toBe("You said you'd send the draft.");
    // the day isn't said twice, and a capitalised name stays
    expect(todaySentence(promise("send it today", 13), NOW)).toBe("You said you'd send it today.");
    expect(todaySentence(promise("RSVP to Lena", 16), NOW)).toBe("You said you'd RSVP to Lena by Monday.");
  });

  it("waiting, nudges and reminders: who and what, never more than the list knows", () => {
    expect(todaySentence(item({ kind: "waiting", wrote: true }), NOW)).toBe("Hill Country Power & Water wrote back about “Your statement is ready”.");
    expect(todaySentence(item({ kind: "waiting" }, { summary: "Tanya asks whether you can cover Saturday" }), NOW)).toBe("Tanya asks whether you can cover Saturday.");
    expect(todaySentence(item({ kind: "nudge", personName: "Megan Cole", sentAt: at(7) }), NOW)).toBe("No reply from Megan Cole in 6 days.");
    expect(todaySentence(item({ kind: "reminder", dueAt: at(13, 9) }), NOW)).toBe("Your reminder for “Your statement is ready”.");
  });

  it("no words: the subject, never an empty bubble", () => {
    expect(todaySentence(dated("pay", "  ", 16), NOW)).toBe("Your statement is ready.");
  });

  it("the chat's group lines count", () => {
    expect(groupLine("missed", 3)).toBe("3 things you missed");
    expect(groupLine("plans", 1)).toBe("1 plan ahead");
  });
});

describe("todaySentence (es)", () => {
  it("the same facts in Spanish", () => {
    setLocale("es", es);
    expect(todaySentence(dated("pay", "Pagar $1,247.00 del recibo de luz LuzMex", 16), NOW)).toBe("Pagar $1,247.00 del recibo de luz LuzMex, vence el lunes.");
    expect(todaySentence(dated("pay", "Pagar $589.00 del estado de cuenta de Telnova", 11, { missed: true }), NOW)).toBe("Pagar $589.00 del estado de cuenta de Telnova. Venció el miércoles.");
    expect(todaySentence(dated("event", "Vuelo de Ciudad de México a Madrid", 14, { timed: { h: 18, m: 5 } }), NOW)).toBe("Mañana a las 18:05: Vuelo de Ciudad de México a Madrid.");
    expect(todaySentence(dated("expire", "La licencia vence", 19), NOW)).toBe("La licencia vence el jueves.");
    expect(todaySentence(dated("alert", "Tarjeta bloqueada", 16), NOW)).toBe("Tarjeta bloqueada, según el correo. La fecha límite es el lunes.");
    expect(todaySentence(promise("enviar a Valeria los ajustes", 11, true), NOW)).toBe("Dijiste que ibas a enviar a Valeria los ajustes. Era para el miércoles.");
    expect(todaySentence(promise("enviar a Tomás los archivos", 13), NOW)).toBe("Dijiste que ibas a enviar a Tomás los archivos hoy.");
    expect(todaySentence(promise("enviar a Megan el logotipo", 16), NOW)).toBe("Dijiste que ibas a enviar a Megan el logotipo para el lunes.");
    expect(todaySentence(item({ kind: "waiting" }), NOW)).toBe("Hill Country Power & Water te escribió sobre «Your statement is ready».");
    expect(groupLine("missed", 2)).toBe("2 cosas que se te pasaron");
  });
});
