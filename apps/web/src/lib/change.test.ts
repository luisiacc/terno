// @vitest-environment jsdom
/**
 * Plan 210 (iteration 4, the owner's "Change…"): what Change… acts on, where its form starts, how a proposal reads, and the
 * act with its own Undo (a refused one says why).
 */
import type { DatedRow, FollowupRow } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return { calls: [] as [string, unknown][], handlers: {} as Record<string, (params: unknown) => Promise<unknown>> };
});
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 0,
    call: (method: string, params: unknown) => {
      fake.calls.push([method, params]);
      return fake.handlers[method]?.(params) ?? Promise.resolve({});
    },
    on: () => () => {},
  },
}));

const { changeItem, changeOfItem, changeOfTask, changeSaid, changeStart, changeTo, closeChange, openChange, proposalSaid, useChangePick, whenSaid } = await import("./change");
const { getApp } = await import("~/state/app");
const { resetSnacks, runUndo, useSnack } = await import("~/lib/snack");

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Tuesday 10 November 2026, noon
const NOW = at(2026, 11, 10, 12);
const row = (over: Partial<DatedRow> = {}): DatedRow => ({ id: 4, threadId: 1, messageId: 1, item: 0, kind: "pay", text: "Pay the electricity bill", quote: "", senderKey: "a@b.mx", dueDay: "2026-11-13", dueAt: at(2026, 11, 13, 9), timed: false, dated: true, actAt: 0, deferredUntil: null, arrivedAt: 0, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 2, model: null, provider: null, createdAt: 0, ...over });
const promise = (over: Partial<FollowupRow> = {}): FollowupRow => ({ id: 7, threadId: 1, messageId: 2, rfcMessageId: null, item: 0, kind: "promise", text: "send the script", quote: null, personName: "Jess", personEmail: "j@x.test", sentAt: 0, dueAt: at(2026, 11, 12, 16), dated: true, timed: true, deferredUntil: null, state: "open", inboxState: "none", closedReason: null, closedAt: null, notifiedAt: null, fromScan: false, revision: 5, model: null, provider: null, createdAt: 0, ...over });
const reader = (r: DatedRow | FollowupRow, open = true) => ({ key: "k", ref: { source: "kind" in r && r.kind !== "promise" && r.kind !== "awaiting" ? "dated" : "promise", id: r.id }, open, missed: false, dueAt: r.dueAt, ...("quote" in r && "senderKey" in r ? { source: "dated" as const, row: r as DatedRow } : { source: "promise" as const, row: r as FollowupRow }) }) as Parameters<typeof changeOfItem>[0];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  setLocale("en", en);
  fake.calls.length = 0;
  fake.handlers = {};
  resetSnacks();
});
afterEach(() => vi.useRealTimers());

describe("what Change… acts on", () => {
  it("a row's dated task or promise, at the revision it was seen at, with its schedule; never a person's ask", () => {
    const item = { id: 4, revision: 2, kind: "pay" as const, dueDay: "2026-11-13", timed: false, dated: true };
    expect(changeOfTask({ kind: "dated", item, when: "Fri", due: "Due Friday", dueAt: at(2026, 11, 13, 9), text: "Pay the bill" })).toEqual({ source: "dated", id: 4, revision: 2, text: "Pay the bill", dueDay: "2026-11-13", dueAt: at(2026, 11, 13, 9), timed: false });
    expect(changeOfTask({ kind: "dated", item: { ...item, kind: "ask", dated: false }, when: null, due: null, dueAt: 0 })).toBeNull();
    expect(changeOfTask({ kind: "promise", id: 7, revision: 5, when: "Thu", due: "Due Thursday", dated: true, dueAt: at(2026, 11, 12, 16), timed: true, text: "send the script" })).toEqual({ source: "promise", id: 7, revision: 5, text: "send the script", dueDay: null, dueAt: at(2026, 11, 12, 16), timed: true });
    // the reader's item: open only
    expect(changeOfItem(reader(row()))).toMatchObject({ source: "dated", id: 4, revision: 2, dueDay: "2026-11-13" });
    expect(changeOfItem(reader(row(), false))).toBeNull();
    expect(changeOfItem(reader(row({ kind: "ask" })))).toBeNull();
    expect(changeOfItem(reader(promise({ dated: false })))).toMatchObject({ source: "promise", dueAt: 0 });
  });

  it("the claims ledger's second batch: the form names a promise as its row says it, a dated item by its words (en, es)", () => {
    expect(changeSaid({ source: "promise", text: "send Jess the Railyard x Pingwire script" })).toBe("You said you'd send Jess the Railyard x Pingwire script.");
    expect(changeSaid({ source: "promise", text: "Email the discussion questions to everyone" })).toBe("You said you'd email the discussion questions to everyone.");
    expect(changeSaid({ source: "dated", text: "Pay the Lumen invoice" })).toBe("Pay the Lumen invoice");
    expect(changeSaid({ source: "promise", text: "  " })).toBeNull();
    setLocale("es", es);
    expect(changeSaid({ source: "promise", text: "enviarle a Megan los archivos" })).toBe("Dijiste que ibas a enviarle a Megan los archivos.");
  });

  it("the form starts on the item's day and time; a day over or none, tomorrow", () => {
    expect(changeStart({ dueDay: "2026-11-13", dueAt: at(2026, 11, 13, 9), timed: false }, NOW)).toEqual({ at: at(2026, 11, 13, 9), timed: false });
    expect(changeStart({ dueDay: null, dueAt: at(2026, 11, 12, 16), timed: true }, NOW)).toEqual({ at: at(2026, 11, 12, 16), timed: true });
    // Missed: tomorrow at its time
    expect(changeStart({ dueDay: "2026-11-06", dueAt: at(2026, 11, 6, 15, 30), timed: true }, NOW)).toEqual({ at: at(2026, 11, 11, 15, 30), timed: true });
    // a promise that named no day
    expect(changeStart({ dueDay: null, dueAt: 0, timed: false }, NOW)).toEqual({ at: at(2026, 11, 11, 9), timed: false });
    expect(changeTo(at(2026, 11, 24, 16, 5), true)).toEqual({ day: "2026-11-24", time: "16:05" });
    expect(changeTo(at(2026, 11, 24, 9), false)).toEqual({ day: "2026-11-24", time: null });
  });

  it("a proposal reads as the row's column does, by the sender's first name, in English and Spanish", () => {
    const p = { dueDay: "2026-11-16", dueAt: at(2026, 11, 16, 9), timed: false, by: "Elena Ruiz", messageId: 9, at: NOW };
    expect(proposalSaid(p, NOW)).toBe("Elena says Mon now");
    expect(proposalSaid({ ...p, timed: true, dueAt: at(2026, 11, 16, 16) }, NOW)).toBe("Elena says Mon 4:00 PM now");
    expect(proposalSaid({ ...p, by: "billing@power.test", dueDay: "2026-11-30", dueAt: at(2026, 11, 30, 9) }, NOW)).toBe("billing@power.test says Nov 30 now");
    setLocale("es", es);
    expect(proposalSaid(p, NOW)).toBe("Elena ahora dice lun");
    expect(whenSaid({ dueDay: "2026-11-11", dueAt: at(2026, 11, 11, 9), timed: false }, NOW)).toBe("Mañana");
  });
});

describe("the act", () => {
  const target = { source: "dated" as const, id: 4, revision: 2, text: "Pay the electricity bill", dueDay: "2026-11-13", dueAt: at(2026, 11, 13, 9), timed: false };

  it("asks for the day and time at the revision seen, names it in the snack, and its Undo is its own", async () => {
    fake.handlers["today.schedule"] = async () => ({ undoId: "s1" });
    await changeItem(target, { day: "2026-11-24", time: "16:00" });
    expect(fake.calls).toEqual([["today.schedule", { item: { source: "dated", id: 4, revision: 2 }, to: { day: "2026-11-24", time: "16:00" } }]]);
    expect(useSnack.getState().current).toMatchObject({ message: "Changed to Nov 24 4:00 PM: Pay the electricity bill", tone: "success", action: { label: "Undo" } });
    await runUndo(useSnack.getState().undo!);
    expect(fake.calls.at(-1)).toEqual(["today.scheduleUndo", { undoId: "s1" }]);
  });

  it("taking a proposal asks for it, not a day; a refusal says why, and an Undo refused says why too", async () => {
    fake.handlers["today.schedule"] = async () => ({ undoId: "s2" });
    await changeItem(target, { accept: true, when: "Mon" });
    expect(fake.calls[0]).toEqual(["today.schedule", { item: { source: "dated", id: 4, revision: 2 }, to: { accept: true } }]);
    expect(useSnack.getState().current?.message).toBe("Changed to Mon: Pay the electricity bill");
    fake.handlers["today.scheduleUndo"] = async () => Promise.reject(new Error("This item changed in the meantime. Look at it again."));
    await runUndo(useSnack.getState().undo!);
    expect(useSnack.getState().current).toMatchObject({ tone: "error", message: "This item changed in the meantime. Look at it again." });
    resetSnacks();
    fake.handlers["today.schedule"] = async () => Promise.reject(new Error("That day and time have passed. Choose one ahead."));
    await changeItem(target, { day: "2026-11-09", time: null });
    expect(useSnack.getState().current).toMatchObject({ tone: "error", message: "That day and time have passed. Choose one ahead." });
  });

  it("the menu's and the palette's dialog opens for the item as it is, and closes", () => {
    openChange(target);
    expect(useChangePick.getState().target).toEqual(target);
    expect(getApp().dialog).toBe("todayChange");
    closeChange();
    expect(useChangePick.getState().target).toBeNull();
    expect(getApp().dialog).toBeNull();
  });
});
