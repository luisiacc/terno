// @vitest-environment jsdom
import type { FollowupRow } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, connectionVersion: 1 } }));
vi.mock("~/lib/open-dwell", () => ({ onExplicitOpen: () => {}, noteExplicitOpen: () => {} }));

const { followupLine, followupWhen } = await import("./followups");
const { setLocale } = await import("@terno/i18n");
const en = (await import("@terno/i18n/locales/en")).default;
const es = (await import("@terno/i18n/locales/es")).default;

/** Plan 161: what the thread's line says, at a fixed instant: Thursday 22 October 2026, 4:00 PM local. */
const NOW = new Date(2026, 9, 22, 16, 0).getTime();
const MIN = 60_000, DAY = 86_400_000;
const row = (o: Partial<FollowupRow> = {}): FollowupRow => ({ id: 1, threadId: 7, messageId: 3, kind: "awaiting", state: "open", personName: "Arjun Ramírez", personEmail: "arjun@x.test", text: "", quote: null, sentAt: NOW - 2 * MIN, dueAt: new Date(2026, 9, 27, 9, 0).getTime(), ...o }) as FollowupRow;

afterEach(() => setLocale("en", en as never));

describe("the follow-up's line (plan 161)", () => {
  it("minutes after sending it's 'yet', never 'in 1 day'; whole days after that", () => {
    expect(followupLine(row(), NOW)).toBe("Waiting for Arjun Ramírez’s reply");
    expect(followupLine(row({ sentAt: NOW - DAY + MIN }), NOW)).toBe("Waiting for Arjun Ramírez’s reply");
    expect(followupLine(row({ sentAt: NOW - DAY }), NOW)).toBe("Arjun Ramírez hasn’t replied in 1 day");
    expect(followupLine(row({ sentAt: NOW - 5 * DAY - 3 * 3_600_000 }), NOW)).toBe("Arjun Ramírez hasn’t replied in 5 days");
  });

  it("under the fact, when it comes back, with its date and why; a due one says it's due (pass 3)", () => {
    // the fact is the title now ("hasn't replied yet"): this line says what happens, and on what condition
    expect(followupWhen(row(), NOW)).toBe("Comes back to your Inbox Tue, Oct 27, 9:00 AM if there’s no reply");
    expect(followupWhen(row({ dueAt: new Date(2026, 9, 23, 9, 0).getTime() }), NOW)).toBe("Comes back to your Inbox Tomorrow 9:00 AM if there’s no reply");
    expect(followupWhen(row({ state: "due", dueAt: NOW - MIN }), NOW)).toMatch(/^Due Today /);
  });

  it("the fourth panel round (revision 10): a promise of yours says its day as Today does, never a time; one with no day, nothing", () => {
    const promise = (o: Partial<FollowupRow>) => row({ kind: "promise", text: "send the contract", dated: true, ...o });
    expect(followupWhen(promise({}), NOW)).toBe("Due Tuesday");
    expect(followupWhen(promise({ dueAt: new Date(2026, 9, 22, 17, 0).getTime() }), NOW)).toBe("Due today");
    expect(followupWhen(promise({ dueAt: new Date(2026, 9, 23, 9, 0).getTime() }), NOW)).toBe("Due tomorrow");
    // its day over: Missed's words, by the day (due earlier today is still today's)
    expect(followupWhen(promise({ state: "due", dueAt: new Date(2026, 9, 22, 9, 0).getTime() }), NOW)).toBe("Due today");
    expect(followupWhen(promise({ state: "due", dueAt: new Date(2026, 9, 21, 9, 0).getTime() }), NOW)).toBe("Was due yesterday");
    expect(followupWhen(promise({ dated: false }), NOW)).toBeNull();
    expect(followupWhen(promise({ dated: false, state: "due", dueAt: NOW - DAY }), NOW)).toBeNull();
  });

  it("in Spanish too", () => {
    setLocale("es", es as never);
    expect(followupLine(row(), NOW)).toBe("Esperando la respuesta de Arjun Ramírez");
    expect(followupWhen(row(), NOW)).toMatch(/^Vuelve a tu Entrada mar, 27 oct, 09:00 si no hay respuesta$/);
    expect(followupWhen(row({ kind: "promise", dated: true }), NOW)).toBe("Vence el martes");
  });
});
