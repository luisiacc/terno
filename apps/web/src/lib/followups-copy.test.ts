// @vitest-environment jsdom
import type { FollowupRow } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, connectionVersion: 1 } }));
vi.mock("~/lib/open-dwell", () => ({ onExplicitOpen: () => {}, noteExplicitOpen: () => {} }));

const { followupLine, followupWhen, withoutPerson } = await import("./followups");
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

/** Plan 210 (iteration 3): Jess's promise, as the reader's line and the lists say it. */
const jess = (o: Partial<FollowupRow>) => row({ kind: "promise", personName: "Jess Okafor", personEmail: "jess@board.test", dated: true, ...o });
const script = jess({ text: "send Jess the script" });

describe("a promise never names its person twice (plan 210, iteration 3)", () => {
  it("the person goes from the words when they stand without them", () => {
    expect(withoutPerson("send Jess the script", ["Jess Okafor", "Jess"])).toBe("send the script");
    expect(withoutPerson("send the script to Jess Okafor", ["Jess Okafor", "Jess"])).toBe("send the script");
    expect(withoutPerson("share the deck with Jess", ["Jess Okafor", "Jess"])).toBe("share the deck");
    expect(withoutPerson("enviar a Valeria Ochoa el guion", ["Valeria Ochoa", "Valeria"])).toBe("enviar el guion");
    expect(withoutPerson("send the contract", ["Tom Reed", "Tom"])).toBe("send the contract");
  });

  it("where they can't, the words keep the name and the line doesn't add it", () => {
    expect(withoutPerson("email Jess", ["Jess Okafor", "Jess"])).toBeNull();
    expect(withoutPerson("review Jess's deck", ["Jess Okafor", "Jess"])).toBeNull();
    expect(withoutPerson("enviar a Valeria Ochoa", ["Valeria Ochoa", "Valeria"])).toBeNull();
    // a name inside another word is no mention
    expect(withoutPerson("send the Jessup file", ["Jess"])).toBe("send the Jessup file");
  });

  it("the reader's line, the lists' line, in English and Spanish", () => {
    expect(followupLine(script, NOW, { short: true })).toBe("You told Jess you’d send the script");
    expect(followupLine(script, NOW)).toBe("You told Jess Okafor you’d send the script");
    expect(followupLine(jess({ text: "email Jess" }), NOW, { short: true })).toBe("You said you’d email Jess");
    setLocale("es", es as never);
    const valeria = jess({ personName: "Valeria Ochoa", text: "enviar a Valeria Ochoa" });
    expect(followupLine(valeria, NOW, { short: true })).toBe("Dijiste que ibas a enviar a Valeria Ochoa");
    expect(followupLine(jess({ personName: "Valeria Ochoa", text: "enviar el guion a Valeria" }), NOW, { short: true })).toBe("Le dijiste a Valeria que ibas a enviar el guion");
  });
});
