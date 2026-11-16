// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Handoff, ThreadDetail } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";

const { loadThread, details } = vi.hoisted(() => {
  // the app's state reads the window's preferences as it loads
  (globalThis as Record<string, unknown>).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return { loadThread: vi.fn(), details: new Map<number, ThreadDetail>() };
});
vi.mock("~/state/threads", () => ({ loadThread, invalidateThreads: vi.fn(), useThreads: { getState: () => ({ details }), subscribe: () => () => {} } }));
vi.mock("~/rpc/connection", () => ({ client: { call: async (method: string) => (method === "drafts.sourceContext" ? { threadId: 7, accountId: 1 } : null) } }));
const { composeLanding, handOffInto } = await import("./compose");
const { replyFields } = await import("./compose-fields");
const { createDraft, editDraft, forgetDraft, materialize, useDrafts } = await import("./drafts");
const { handOffLine, othersOfTask, seenOfTask } = await import("./hand-to");
const { setApp } = await import("~/state/app");
const { runUndo, useSnack } = await import("./snack");

/**
 * Plan 210 (iteration 4, Hand to…): the composer's forward option. Its line goes above what's written, once, never over it,
 * and the hand-off is kept with the draft, wherever the forward lands; a pinned reply isn't turned into a forward.
 */

const source = { id: 1, email: "me@test.com" } as Account;
const detail = { thread: { id: 7, accountId: 1, subject: "Field trip" }, messages: [{ id: 3, accountId: 1, attachmentState: "complete", isSent: false, from: { name: "School", email: "office@school.test" }, to: [], cc: [], subject: "Field trip", date: 0, bodyText: "Sign it by Friday.", attachments: [] }] } as unknown as ThreadDetail;
const handoff: Handoff = { items: [{ source: "dated", id: 42, revision: 2, named: true }] };
const LINE = "Could you take care of this: sign the field trip form (by Fri)?";

beforeEach(() => {
  loadThread.mockImplementation(async (id: number) => details.get(id));
  details.set(7, detail);
  setApp({ accounts: [source], accountId: 1, selectedId: 7, checked: new Set(), scope: null, draftShown: null });
});
afterEach(() => {
  for (const key of Object.keys(useDrafts.getState().drafts)) forgetDraft(key);
  details.clear();
  useSnack.setState({ current: null });
  vi.clearAllMocks();
  setLocale("en", en);
});

describe("the line", () => {
  const NOW = new Date(2026, 10, 13, 10).getTime();
  const at = (d: number, h = 9) => new Date(2026, 10, d, h).getTime();
  it("says the item as an ask, with its day when one's ahead, none when it's past or there's none", () => {
    expect(handOffLine("Sign the field trip form.", at(18), NOW)).toBe("Could you take care of this: sign the field trip form (by Wed)?");
    expect(handOffLine("Pay $12 for the bus", at(13, 17), NOW)).toBe("Could you take care of this: pay $12 for the bus (by today)?");
    expect(handOffLine("Pay $12 for the bus", at(14), NOW)).toBe("Could you take care of this: pay $12 for the bus (by tomorrow)?");
    expect(handOffLine("Call Marcus (4:00 PM ET)", at(11), NOW)).toBe("Could you take care of this: call Marcus?");
    expect(handOffLine("W-9 upload", null, NOW)).toBe("Could you take care of this: W-9 upload?");
    expect(handOffLine("RSVP to Dana", at(30), NOW)).toBe("Could you take care of this: RSVP to Dana (by Nov 30)?");
  });
  it("in Spanish", () => {
    setLocale("es", es);
    expect(handOffLine("Firmar el permiso", at(18), NOW)).toBe("¿Puedes encargarte de esto: firmar el permiso (para el mié)?");
    expect(handOffLine("Pagar el autobús", at(13, 17), NOW)).toBe("¿Puedes encargarte de esto: pagar el autobús (para hoy)?");
  });
});

describe("what a row hands (iteration 4, merge)", () => {
  it("a reply's row hands its other promises with it, as its Done takes them; a dated row or a promise alone, only itself", () => {
    const also = [{ source: "promise" as const, id: 8, revision: 1 }];
    const reply = { kind: "promise" as const, id: 7, revision: 3, when: null, due: null, with: also };
    expect([seenOfTask(reply), othersOfTask(reply)]).toEqual([{ source: "promise", id: 7, revision: 3 }, also]);
    expect(othersOfTask({ ...reply, with: undefined })).toEqual([]);
  });
});

describe("the forward option (handOffInto)", () => {
  it("an empty forward takes the line and the hand-off", () => {
    const key = createDraft(replyFields("forward", detail, source));
    expect(handOffInto(key, { handoff, line: LINE })).toBe(true);
    expect(materialize(key)).toMatchObject({ mode: "forward", bodyText: LINE, handoff });
  });

  it("over authored words, the line is a paragraph above them, never over them, and never twice", () => {
    const key = createDraft(replyFields("forward", detail, source));
    editDraft(key, { bodyText: "Hi Jess,\nthanks!", bodyHtml: "<p>Hi Jess,</p><p>thanks!</p>" });
    expect(handOffInto(key, { handoff, line: LINE })).toBe(true);
    const d = materialize(key)!;
    expect(d.bodyText).toBe(`${LINE}\n\nHi Jess,\nthanks!`);
    expect(d.bodyHtml.endsWith("<p>Hi Jess,</p><p>thanks!</p>")).toBe(true);
    expect(d.bodyHtml).toContain("Could you take care of this");
    expect(handOffInto(key, { handoff, line: LINE })).toBe(true);
    expect(materialize(key)!.bodyText).toBe(`${LINE}\n\nHi Jess,\nthanks!`);
  });

  it("a reply (the conversation's pinned draft) isn't made a forward: it says so and keeps its words", () => {
    const key = createDraft(replyFields("reply", detail, source));
    editDraft(key, { bodyText: "Will do" });
    const before = useDrafts.getState().drafts[key];
    expect(handOffInto(key, { handoff, line: LINE })).toBe(false);
    expect(useDrafts.getState().drafts[key]).toBe(before);
    expect(useSnack.getState().current?.message).toMatch(/reply/);
  });

  it("opening Forward with it lands a new forward of the item's message with the line and the hand-off", async () => {
    const landing = await composeLanding("forward", 7, 0, undefined, undefined, { sourceId: 3, handoff: { handoff, line: LINE } });
    expect(landing.kind).toBe("created");
    const d = materialize((landing as { key: string }).key)!;
    expect(d).toMatchObject({ mode: "forward", forwardOfMessageId: 3, bodyText: LINE, handoff });
  });

  it("a written reply turned into the forward keeps its words under the line; its Undo takes the hand-off back with it", async () => {
    const key = createDraft(replyFields("reply", detail, source));
    editDraft(key, { bodyText: "Draft so far" });
    setApp({ draftShown: { threadId: 7, key } });
    const landing = await composeLanding("forward", 7, 0, undefined, undefined, { sourceId: 3, handoff: { handoff, line: LINE } });
    expect(landing).toEqual({ kind: "converted", key });
    expect(materialize(key)).toMatchObject({ mode: "forward", bodyText: `${LINE}\n\nDraft so far`, handoff });
    expect(useSnack.getState().current?.message).toBe("Converted to a forward");
    await runUndo(useSnack.getState().undo!);
    expect(materialize(key)).toMatchObject({ mode: "reply", bodyText: "Draft so far" });
    expect(materialize(key)!.handoff ?? null).toBeNull();
  });
});
