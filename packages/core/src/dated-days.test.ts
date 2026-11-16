import { describe, expect, it } from "vitest";
import { namesDayFrom, saysClock, saysDay } from "./dated-days";

// Thursday, November 12, 2026, noon
const ARRIVED = new Date(2026, 10, 12, 12).getTime();

describe("whether words say a day (plan 210, the Codex code review of v11)", () => {
  it("a weekday, a month and day either way round, a numeric date, an ordinal, in English and Spanish", () => {
    expect(saysDay("Friday at the latest works for us", "2026-11-13")).toBe(true);
    expect(saysDay("we've moved your appointment to November 24", "2026-11-24")).toBe(true);
    expect(saysDay("now on 24 November", "2026-11-24")).toBe(true);
    expect(saysDay("la pasamos al 24 de noviembre", "2026-11-24")).toBe(true);
    expect(saysDay("pasa al miércoles", "2026-11-18")).toBe(true);
    expect(saysDay("new date: 11/24", "2026-11-24")).toBe(true);
    expect(saysDay("nueva fecha: 24/11/2026", "2026-11-24")).toBe(true);
    expect(saysDay("moved to the 24th", "2026-11-24")).toBe(true);
    expect(saysDay("lo movemos al día 24", "2026-11-24")).toBe(true);
    expect(saysDay("due 2026-11-24", "2026-11-24")).toBe(true);
  });
  it("never a day it doesn't name: no date, another day, a count of hours", () => {
    expect(saysDay("Your appointment is confirmed", "2026-11-27")).toBe(false);
    expect(saysDay("Friday at the latest works", "2026-11-17")).toBe(false);
    expect(saysDay("we'll know in the next 24 hours", "2026-11-24")).toBe(false);
    expect(saysDay("it's 20% off", "2026-11-20")).toBe(false);
  });
  it("within a slack: 'before Monday the 16th' for the Sunday, a zone's day either side", () => {
    expect(saysDay("meets Monday the 16th. Could you get them to me before then?", "2026-11-15")).toBe(false);
    expect(saysDay("meets Monday the 16th. Could you get them to me before then?", "2026-11-15", { slack: 1 })).toBe(true);
  });
  it("relative words count only with the day the mail came", () => {
    expect(saysDay("Can we do it tomorrow instead?", "2026-11-13")).toBe(false);
    expect(saysDay("Can we do it tomorrow instead?", "2026-11-13", { arrivedAt: ARRIVED })).toBe(true);
    expect(saysDay("¿Lo vemos mañana?", "2026-11-13", { arrivedAt: ARRIVED })).toBe(true);
    // a morning isn't tomorrow
    expect(saysDay("el lunes por la mañana", "2026-11-13", { arrivedAt: ARRIVED })).toBe(false);
    expect(saysDay("before the end of the month", "2026-11-30", { arrivedAt: ARRIVED })).toBe(true);
    expect(saysDay("sometime this week", "2026-11-15", { arrivedAt: ARRIVED })).toBe(true);
  });
  it("a clock time", () => {
    for (const w of ["moved earlier to 8:00", "now at 8 AM", "a las 8", "10 p.m. PT", "at noon"]) expect(saysClock(w), w).toBe(true);
    for (const w of ["same place as planned", "in 24 hours", "Field 4"]) expect(saysClock(w), w).toBe(false);
  });
});

describe("whether words name a day from the mail's own on (plan 210, iteration 5, revision 3)", () => {
  it("a date by itself, this year's or, half a year gone, the next one's; a weekday, an ordinal or 'tomorrow' alone ahead", () => {
    for (const w of ["Tuesday the 17th at 7:00", "closes Wednesday, December 9", "el martes 17 a las 19:00", "on 11/12", "tomorrow at 9", "due 2026-11-20", "this week"]) expect(namesDayFrom(w, ARRIVED), w).toBe(true);
    for (const w of ["Delivered: Thursday, October 29", "entregado el 29 de octubre", "returned 10/31/2026", "due 2025-11-20", "Amount due: 64.20", "13/45", "no day here at 7:00"]) expect(namesDayFrom(w, ARRIVED), w).toBe(false);
    expect(namesDayFrom("reopens January 5", new Date(2026, 11, 20).getTime())).toBe(true);
  });
});
