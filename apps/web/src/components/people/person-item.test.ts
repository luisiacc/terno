// @vitest-environment jsdom
/** Plan 281 (owner, 2026-11-26): an item What matters keeps under Coming up reads as not yet on a person's page and row. */
import type { PersonItem, ThreadSummary, TodayWhy } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { itemWhen } = await import("./person-item");
setLocale("en", en);

const NOW = new Date(2026, 10, 26, 19).getTime();
const thread = { id: 1, subject: "Renueva el agente residente", fromName: "Gonzalo", fromEmail: "gonzalo@x.test", lastDate: NOW - 13 * 86_400_000 } as ThreadSummary;
const renewal = (why: Partial<TodayWhy>): PersonItem => ({
  kind: "today",
  item: { id: "dated:31", thread, why: { kind: "dated", text: "Renew the registered agent", dueAt: new Date(2027, 0, 12, 23, 59).getTime(), came: thread.lastDate, item: { id: 31, revision: 0, kind: "renew", dueDay: "2027-01-12", timed: false, dated: true }, ...why } },
});

describe("itemWhen", () => {
  it("not yet without a Later: What matters' own when, under Later; put off: when it's back; shown now: open", () => {
    const ahead = itemWhen(renewal({ ahead: new Date(2027, 0, 5, 9).getTime() }), NOW);
    expect(ahead.later).toBe(true);
    expect(ahead.text).toBe("Jan 12, 2027");
    const back = new Date(2026, 11, 30, 9).getTime();
    expect(itemWhen(renewal({ ahead: back, back }), NOW)).toMatchObject({ later: true, text: expect.stringMatching(/^Back/) });
    expect(itemWhen(renewal({}), NOW).later).toBe(false);
  });
});
