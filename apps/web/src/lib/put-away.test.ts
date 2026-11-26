// @vitest-environment jsdom
/**
 * Plan 282: what Put away says: each row's line (who put it away, and why, from the user's own past actions), its
 * sections (Needs a look, then each day), and Back to Inbox's Undo; the client mocked.
 */
import type { Placement } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.requestAnimationFrame = () => 0;
  return { handlers: {} as Record<string, (params: unknown) => Promise<unknown>>, calls: [] as { method: string; params: unknown }[] };
});

vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, params: unknown) => {
      fake.calls.push({ method, params });
      const h = fake.handlers[method];
      return h ? h(params) : Promise.resolve({});
    },
    on: () => () => {},
    onAttach: () => () => {},
  },
}));

const { backToInbox, dayLabel, putAwaySections, rowLine, sectionOf } = await import("./put-away");
const { setApp } = await import("~/state/app");
const { runUndo, useSnack } = await import("~/lib/snack");

const NOW = new Date(2026, 10, 25, 12).getTime();
const DAY = 86_400_000;
const rule = (over: Partial<Placement> = {}, detail: object = {}): Placement => ({ threadId: 1, at: NOW, needsLook: false, detail: { by: "rule", filterId: 4, name: "Xataka", auto: false, source: "manual", createdAt: Date.UTC(2026, 10, 12, 12), action: "archive", ruleHash: "h", fromName: "Xataka", ...detail } as Placement["detail"], ...over });
const terno = (reasons: unknown[], over: Partial<Placement> = {}): Placement => ({ threadId: 2, at: NOW, needsLook: false, detail: { by: "terno", categoryId: 7, reasons, sender: "recibos@rappi.com", fromName: "Rappi" } as Placement["detail"], ...over });

afterEach(() => {
  setLocale("en", en);
  fake.calls.length = 0;
});

describe("Put away's words (plan 282)", () => {
  it("a row says who did it and why, in the user's terms", () => {
    setApp({ categories: [{ id: 7, name: "Facturas", color: "amber" }] as never, folders: [{ accountId: 1, key: "INBOX/News", path: ["News"], selectable: true }] as never });
    expect(rowLine(rule())).toBe("Archived by your rule “Xataka”");
    expect(rowLine(rule({}, { action: "moveToFolder", folder: "INBOX/News" }))).toBe("Moved to News by your rule “Xataka”");
    expect(rowLine(rule({}, { auto: true, action: "trash" }))).toBe("Deleted by a rule Terno made on Nov 12");
    expect(rowLine(rule({}, { action: "addCategory", categoryId: 7 }))).toBe("Facturas · by your rule “Xataka”");
    expect(rowLine(terno([{ k: "reason.mentions", p: { count: 1, a: "factura", b: "", c: "" } }, { k: "reason.sameSender", p: { count: 12, category: "Facturas" } }]))).toBe("Facturas · you keep 12 from Rappi there");
    expect(rowLine(terno([{ k: "reason.intent.invoice" }]))).toBe("Facturas · looks like an invoice or a receipt");
    expect(rowLine(terno([{ k: "reason.newSender" }]))).toBe("Facturas · like the mail you keep there");
    expect(rowLine(rule({ needsLook: true }))).toBe("Archived by your rule “Xataka” · you’ve written to them");
    setLocale("es", es);
    expect(rowLine(rule())).toBe("Archivado por tu regla “Xataka”");
  });

  it("sections: Needs a look first, then each day with its count", () => {
    const byThread = new Map<number, Placement>([
      [1, rule({ threadId: 1, needsLook: true, at: NOW - 2 * DAY })],
      [2, rule({ threadId: 2, at: NOW })],
      [3, rule({ threadId: 3, at: NOW - 60_000 })],
      [4, rule({ threadId: 4, at: NOW - DAY })],
      [5, rule({ threadId: 5, at: NOW - 3 * DAY })],
    ]);
    const s = putAwaySections([1, 2, 3, 4, 5].map((id) => ({ id })), byThread, NOW);
    expect(s.headings).toEqual([
      { kind: "needsLook", at: 0, label: "Needs a look", count: 1 },
      { kind: "day", at: 1, label: "Today", count: 2 },
      { kind: "day", at: 3, label: "Yesterday", count: 1 },
      { kind: "day", at: 4, label: dayLabel(NOW - 3 * DAY, NOW), count: 1 },
    ]);
    expect(dayLabel(NOW - 3 * DAY, NOW)).toBe("Sunday");
    expect(sectionOf(byThread.get(1)!, NOW)).toBe("Needs a look");
  });

  it("Back to Inbox takes the conversation back with one Undo that asks the backend for exactly that undo", async () => {
    fake.handlers["putAway.back"] = async () => ({ undoId: 41, affected: 1 });
    fake.handlers["threads.undo"] = async () => ({ restored: 1 });
    await backToInbox([9]);
    expect(fake.calls.find((c) => c.method === "putAway.back")?.params).toEqual({ threadIds: [9] });
    expect(useSnack.getState().current?.message).toBe("Back in the Inbox");
    await runUndo(useSnack.getState().undo!);
    expect(fake.calls.find((c) => c.method === "threads.undo")?.params).toEqual({ undoId: 41 });
  });
});
