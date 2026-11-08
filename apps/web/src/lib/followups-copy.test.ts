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
    expect(followupLine(row(), NOW)).toBe("Arjun Ramírez hasn’t replied yet");
    expect(followupLine(row({ sentAt: NOW - DAY + MIN }), NOW)).toBe("Arjun Ramírez hasn’t replied yet");
    expect(followupLine(row({ sentAt: NOW - DAY }), NOW)).toBe("Arjun Ramírez hasn’t replied in 1 day");
    expect(followupLine(row({ sentAt: NOW - 5 * DAY - 3 * 3_600_000 }), NOW)).toBe("Arjun Ramírez hasn’t replied in 5 days");
  });

  it("the header says when it was sent and what comes back when, and a due one says it's due", () => {
    expect(followupWhen(row(), NOW)).toBe("Sent today · back on top of your Inbox Tue 9:00 AM if Arjun doesn’t reply");
    expect(followupWhen(row({ sentAt: NOW - DAY }), NOW)).toMatch(/^Sent Yesterday · back on top of your Inbox/);
    expect(followupWhen(row({ kind: "promise", text: "send the contract" }), NOW)).toBe("Back on top of your Inbox Tue 9:00 AM");
    expect(followupWhen(row({ state: "due", dueAt: NOW - MIN }), NOW)).toMatch(/^Due /);
  });

  it("in Spanish too", () => {
    setLocale("es", es as never);
    expect(followupLine(row(), NOW)).toBe("Arjun Ramírez aún no ha respondido");
    expect(followupWhen(row(), NOW)).toMatch(/^Enviado hoy · vuelve arriba de Entrada .* si Arjun no responde$/);
  });
});
