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

const { backToInbox, notCategory, placedItems, senderOf, dayLabel, putAwaySections, refreshNotice, rowLine, sectionOf, seeNotice } = await import("./put-away");
const { usePutAway } = await import("~/state/put-away");
const { useApp } = await import("~/state/app");
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
    const names = { categories: [{ id: 7, name: "Facturas" }], folders: [{ key: "INBOX/News", path: ["News"] }] };
    expect(rowLine(rule(), names)).toBe("Archived · your rule “Xataka”");
    expect(rowLine(rule({}, { action: "moveToFolder", folder: "INBOX/News" }), names)).toBe("In News · your rule “Xataka”");
    expect(rowLine(rule({}, { auto: true, action: "trash" }), names)).toBe("In the Trash · Terno’s rule");
    expect(rowLine(rule({}, { action: "addCategory", categoryId: 7 }), names)).toBe("Facturas · your rule “Xataka”");
    expect(rowLine(terno([{ k: "reason.mentions", p: { count: 1, a: "factura", b: "", c: "" } }, { k: "reason.sameSender", p: { count: 12, category: "Facturas" } }]), names)).toBe("Facturas · filed by Terno");
    expect(rowLine(terno([{ k: "reason.intent.invoice" }]), names)).toBe("Facturas · filed by Terno");
    expect(rowLine(terno([{ k: "reason.newSender" }]), names)).toBe("Facturas · filed by Terno");
    expect(rowLine(rule({ needsLook: true }), names)).toBe("Archived · your rule “Xataka”");
    // the sender the decision read names "Don't file … automatically", not the newest mail's (a reply from someone else)
    expect(senderOf({ by: "terno", categoryId: 7, reasons: [], sender: "a@x.test", senderName: "Alice", fromName: "Bob" })).toBe("Alice");
    setLocale("es", es);
    expect(rowLine(rule(), names)).toBe("Archivado · tu regla “Xataka”");
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
    // no counts: what's loaded isn't the whole of a busy day
    expect(s.headings).toEqual([
      { kind: "needsLook", at: 0, label: "Needs a look", hint: "from people you’ve written to", count: null },
      { kind: "day", at: 1, label: "Today", count: null },
      { kind: "day", at: 3, label: "Yesterday", count: null },
      { kind: "day", at: 4, label: dayLabel(NOW - 3 * DAY, NOW), count: null },
    ]);
    expect(dayLabel(NOW - 3 * DAY, NOW)).toBe("Sunday");
    expect(sectionOf(byThread.get(1)!, NOW)).toBe("Needs a look");
  });

  it("the Inbox line: seen marks what it counted, and an answer counted before that shows nothing", async () => {
    let release!: (v: unknown) => void;
    fake.handlers["putAway.needsLook"] = () => new Promise((r) => (release = r));
    const slow = refreshNotice();
    fake.handlers["putAway.needsLook"] = async () => ({ count: 1, first: { threadId: 5, name: "Ana" }, through: NOW });
    await seeNotice();
    expect(fake.calls.find((c) => c.method === "putAway.seen")?.params).toEqual({ through: NOW });
    // the question asked before the acknowledgment answers late: it's dropped
    release({ count: 1, first: { threadId: 5, name: "Ana" }, through: NOW });
    await slow;
    expect(usePutAway.getState().notice?.count).toBe(0);
    // a later one, counted before the mark, shows nothing either
    await refreshNotice();
    expect(usePutAway.getState().notice?.count).toBe(0);
  });

  it("Not {category} says what it did, and where it is now; its Undo takes back that correction exactly (Codex review #1, #9)", async () => {
    fake.calls.length = 0;
    fake.handlers["putAway.not"] = async () => ({ batchId: 12, inInbox: true });
    fake.handlers["categorize.undo"] = async () => ({ removed: 0, restored: 1 });
    await notCategory(8, NOW, "Recibos");
    expect(fake.calls.find((c) => c.method === "putAway.not")?.params).toEqual({ threadId: 8, at: NOW });
    expect(useSnack.getState().current?.message).toBe("Out of Recibos and back in the Inbox. Terno will learn from this");
    await runUndo(useSnack.getState().undo!);
    expect(fake.calls.find((c) => c.method === "categorize.undo")?.params).toEqual({ batchId: 12 });
    // still kept out by another hidden category: it doesn't claim the Inbox
    fake.handlers["putAway.not"] = async () => ({ batchId: 13, inInbox: false });
    await notCategory(8, NOW, "Recibos");
    expect(useSnack.getState().current?.message).toBe("Out of Recibos. Terno will learn from this");
  });

  it("Back to Inbox of more than one call holds goes in turns, under one Undo (Codex review #8)", async () => {
    fake.calls.length = 0;
    let next = 50;
    fake.handlers["putAway.back"] = async (p) => { const items = (p as { items: { threadId: number }[] }).items; return { undoId: next++, affected: items.length, threadIds: items.map((i) => i.threadId) }; };
    fake.handlers["threads.undo"] = async () => ({ restored: 1 });
    await backToInbox(Array.from({ length: 501 }, (_, i) => ({ threadId: 1000 + i, at: NOW })));
    expect(fake.calls.filter((c) => c.method === "putAway.back").map((c) => (c.params as { items: unknown[] }).items.length)).toEqual([500, 1]);
    expect(useSnack.getState().current?.message).toBe("501 back in the Inbox");
    await runUndo(useSnack.getState().undo!);
    expect(fake.calls.filter((c) => c.method === "threads.undo").map((c) => c.params)).toEqual([{ undoId: 51 }, { undoId: 50 }]);
  });

  it("a row brought back is said as brought back only when it was, and offers nothing more to act on (Codex review 3 #3, #5)", async () => {
    usePutAway.setState({ byThread: new Map([[21, { threadId: 21, at: NOW } as never], [22, { threadId: 22, at: NOW } as never]]), returned: new Map() });
    useApp.setState({ putAway: true } as never);
    // 22 was moved meanwhile by another window: the backend brought back 21 alone
    fake.handlers["putAway.back"] = async () => ({ undoId: 60, affected: 1, threadIds: [21] });
    await backToInbox([{ threadId: 21, at: NOW }, { threadId: 22, at: NOW }]);
    expect([...usePutAway.getState().returned.keys()]).toEqual([21]);
    expect(placedItems([21, 22])).toEqual([{ threadId: 22, at: NOW }]);
    useApp.setState({ putAway: false } as never);
    usePutAway.setState({ byThread: new Map(), returned: new Map() });
  });

  it("a Back to Inbox that fails partway keeps what went back, said on its rows, and offers its Undo (Codex review 4 #1)", async () => {
    useApp.setState({ putAway: true } as never);
    usePutAway.setState({ returned: new Map() });
    let call = 0;
    fake.handlers["putAway.back"] = async (p) => {
      if (call++ > 0) throw new Error("gone");
      const items = (p as { items: { threadId: number }[] }).items;
      return { undoId: 70, affected: items.length, threadIds: items.map((i) => i.threadId) };
    };
    await backToInbox(Array.from({ length: 501 }, (_, i) => ({ threadId: 2000 + i, at: NOW })));
    expect(usePutAway.getState().returned.size).toBe(500);
    expect(useSnack.getState().current?.tone).toBe("error");
    expect(useSnack.getState().current?.action?.name).toBe("Undo: put 500 away again");
    useApp.setState({ putAway: false } as never);
    usePutAway.setState({ byThread: new Map(), returned: new Map() });
  });

  it("Back to Inbox that moved nothing says nothing", async () => {
    fake.handlers["putAway.back"] = async () => ({ undoId: null, affected: 0, threadIds: [] });
    useSnack.setState({ current: null } as never);
    await backToInbox([{ threadId: 3, at: NOW }]);
    expect(useSnack.getState().current).toBeNull();
  });

  it("Back to Inbox takes the conversation back with one Undo that asks the backend for exactly that undo", async () => {
    fake.handlers["putAway.back"] = async () => ({ undoId: 41, affected: 1, threadIds: [9] });
    fake.handlers["threads.undo"] = async () => ({ restored: 1 });
    await backToInbox([{ threadId: 9, at: NOW }]);
    expect(fake.calls.find((c) => c.method === "putAway.back")?.params).toEqual({ items: [{ threadId: 9, at: NOW }] });
    expect(useSnack.getState().current?.message).toBe("Back in the Inbox");
    // the Undo is named for what it does, not for the move it takes back (the QA panel's screen reader heard "Back to Inbox")
    expect(useSnack.getState().current?.action?.name).toBe("Undo: put it away again");
    await runUndo(useSnack.getState().undo!);
    expect(fake.calls.find((c) => c.method === "threads.undo")?.params).toEqual({ undoId: 41 });
  });
});
