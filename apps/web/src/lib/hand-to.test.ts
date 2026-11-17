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
    expect(handOffLine("Sign the field trip form.", { dueAt: at(18) }, NOW)).toBe("Could you take care of this: sign the field trip form (by Wed)?");
    expect(handOffLine("Pay $12 for the bus", { dueAt: at(13, 17) }, NOW)).toBe("Could you take care of this: pay $12 for the bus (by today)?");
    expect(handOffLine("Pay $12 for the bus", { dueAt: at(14) }, NOW)).toBe("Could you take care of this: pay $12 for the bus (by tomorrow)?");
    expect(handOffLine("Call Marcus (4:00 PM ET)", { dueAt: at(11) }, NOW)).toBe("Could you take care of this: call Marcus?");
    expect(handOffLine("W-9 upload", { dueAt: null }, NOW)).toBe("Could you take care of this: W-9 upload?");
    expect(handOffLine("RSVP to Dana", { dueAt: at(30) }, NOW)).toBe("Could you take care of this: RSVP to Dana (by Nov 30)?");
  });
  it("in Spanish", () => {
    setLocale("es", es);
    expect(handOffLine("Firmar el permiso", { dueAt: at(18) }, NOW)).toBe("¿Puedes encargarte de esto: firmar el permiso (para el mié)?");
    expect(handOffLine("Pagar el autobús", { dueAt: at(13, 17) }, NOW)).toBe("¿Puedes encargarte de esto: pagar el autobús (para hoy)?");
  });
  it("round 14's faults: with its time when it has one, and its part of the day when that's what it has, en and es", () => {
    const wire = "Wire $187,420.55 for Lumora payroll";
    expect(handOffLine(wire, { dueAt: at(13, 13), timed: true }, NOW)).toBe("Could you take care of this: wire $187,420.55 for Lumora payroll (by today 1:00 PM)?");
    expect(handOffLine(wire, { dueAt: at(14, 13), timed: true }, NOW)).toBe("Could you take care of this: wire $187,420.55 for Lumora payroll (by tomorrow 1:00 PM)?");
    expect(handOffLine(wire, { dueAt: at(18, 13), timed: true }, NOW)).toBe("Could you take care of this: wire $187,420.55 for Lumora payroll (by Wed 1:00 PM)?");
    expect(handOffLine("Send Kai the budget", { dueAt: at(14), partOfDay: "morning" }, NOW)).toBe("Could you take care of this: send Kai the budget (by tomorrow morning)?");
    expect(handOffLine("Send Kai the budget", { dueAt: at(13), partOfDay: "afternoon" }, NOW)).toBe("Could you take care of this: send Kai the budget (by this afternoon)?");
    expect(handOffLine("Send Kai the budget", { dueAt: at(18), partOfDay: "morning" }, NOW)).toBe("Could you take care of this: send Kai the budget (by Wed morning)?");
    setLocale("es", es);
    expect(handOffLine("Transferir $187,420.55 para la nómina", { dueAt: at(13, 13), timed: true }, NOW)).toBe("¿Puedes encargarte de esto: transferir $187,420.55 para la nómina (para hoy 13:00)?");
    expect(handOffLine("Mandarle el presupuesto a Kai", { dueAt: at(14), partOfDay: "morning" }, NOW)).toBe("¿Puedes encargarte de esto: mandarle el presupuesto a Kai (para mañana por la mañana)?");
    expect(handOffLine("Mandarle el presupuesto a Kai", { dueAt: at(18), partOfDay: "morning" }, NOW)).toBe("¿Puedes encargarte de esto: mandarle el presupuesto a Kai (para el mié por la mañana)?");
  });
  it("the claims ledger's second batch: the item's \"you\" is the reader's own once it's handed to someone else (en, es)", () => {
    // Priya's deck, María's book fair
    expect(handOffLine("Send Jess your board meeting deck draft", { dueAt: at(17) }, NOW)).toBe("Could you take care of this: send Jess my board meeting deck draft (by Tue)?");
    expect(handOffLine("Tell Jessica which book fair volunteer shift you can take", { dueAt: at(18) }, NOW)).toBe("Could you take care of this: tell Jessica which book fair volunteer shift I can take (by Wed)?");
    expect(handOffLine("Tell Ana whether you're coming and if the slides are yours", { dueAt: null }, NOW)).toBe("Could you take care of this: tell Ana whether I'm coming and if the slides are mine?");
    expect(handOffLine("Ask Dana to send you the signed form", { dueAt: null }, NOW)).toBe("Could you take care of this: ask Dana to send me the signed form?");
    // a word that only starts like one stays ("young", "youth", "tutor", "turno"), nor one inside another ("thank-you")
    expect(handOffLine("Send Ms. Greer a thank-you note", { dueAt: null }, NOW)).toBe("Could you take care of this: send Ms. Greer a thank-you note?");
    expect(handOffLine("Pay the youth league fee", { dueAt: null }, NOW)).toBe("Could you take care of this: pay the youth league fee?");
    // its code review: what's quoted, a name, and "thank you" / "see you" stay as they are
    expect(handOffLine(`Reply "Thank you" to Alex`, { dueAt: null }, NOW)).toBe(`Could you take care of this: reply "Thank you" to Alex?`);
    expect(handOffLine("Tell Dana you'll see you there", { dueAt: null }, NOW)).toBe("Could you take care of this: tell Dana I'll see you there?");
    expect(handOffLine("Send Ana a thank you card for your gift", { dueAt: null }, NOW)).toBe("Could you take care of this: send Ana a thank you card for my gift?");
    setLocale("es", es);
    expect(handOffLine("Send Tu Nguyen the signed contract", { dueAt: null }, NOW)).toBe("¿Puedes encargarte de esto: send Tu Nguyen the signed contract?");
    expect(handOffLine("Responder «tu pedido llegó» a Ana con tu número", { dueAt: null }, NOW)).toBe("¿Puedes encargarte de esto: responder «tu pedido llegó» a Ana con mi número?");
    expect(handOffLine("Mandarle a Jess tu borrador de la presentación", { dueAt: at(17) }, NOW)).toBe("¿Puedes encargarte de esto: mandarle a Jess mi borrador de la presentación (para el mar)?");
    expect(handOffLine("Confirmar tus turnos con el tutor y si el libro es tuyo", { dueAt: null }, NOW)).toBe("¿Puedes encargarte de esto: confirmar mis turnos con el tutor y si el libro es mío?");
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

  it("a second item handed into the same forward joins it, its line and its items both; past the bound it says so and changes nothing (Codex's code review, iteration 4)", () => {
    const key = createDraft(replyFields("forward", detail, source));
    expect(handOffInto(key, { handoff, line: LINE })).toBe(true);
    const BUS = "Could you take care of this: pay $12 for the bus (by Fri)?";
    expect(handOffInto(key, { handoff: { items: [{ source: "dated", id: 43, revision: 1, named: true }] }, line: BUS })).toBe(true);
    expect(materialize(key)).toMatchObject({ bodyText: `${BUS}\n\n${LINE}`, handoff: { items: [...handoff.items, { source: "dated", id: 43, revision: 1, named: true, row: 1 }] } });
    const before = useDrafts.getState().drafts[key];
    const many = { items: Array.from({ length: 31 }, (_, i) => ({ source: "dated" as const, id: 200 + i, revision: 0, ...(i === 0 && { named: true }) })) };
    expect(handOffInto(key, { handoff: many, line: "Could you take care of all this?" })).toBe(false);
    expect(useDrafts.getState().drafts[key]).toBe(before);
    expect(useSnack.getState().current?.message).toMatch(/Send it first/);
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
