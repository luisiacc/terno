/** Plan 204: what acting on a task says and sends, and the lines and choices around it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const params: unknown[] = [];
let fail = false;
vi.mock("~/rpc/connection", () => ({
  client: {
    call: (method: string, p: unknown) => {
      calls.push(method);
      params.push(p);
      return fail ? Promise.reject(new Error("The backend is busy.")) : Promise.resolve({ queued: 3, undoId: "u1" });
    },
  },
}));
const errors: string[] = [];
const said: { text: string; undo: boolean }[] = [];
vi.mock("~/lib/snack", () => ({ registerUndo: (f: () => void) => f, snack: { success: (text: string, o: { action?: unknown }) => said.push({ text, undo: !!o.action }), error: (m: string) => errors.push(m) } }));

const { actOnTask, laterChoices, laterNote, laterStart, laterWindow, taskSaid } = await import("./dated");

beforeEach(() => {
  calls.length = 0;
  params.length = 0;
  errors.length = 0;
  said.length = 0;
  fail = false;
});

describe("a Today row's task (plan 204, after the panel)", () => {
  const item = { id: 30, revision: 2, kind: "event" as const, dueDay: "2026-11-12", timed: true, dated: true };
  it("Remove: a date is dismissed by its own act, a promise by follow-ups' (the one the row shows), each with Undo", async () => {
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0 }, "dismiss");
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null, due: null }, "dismiss");
    // plan 210 (iteration 4): a date's Remove asks what its snack may offer to mute (a promise is yours: nothing)
    expect(calls).toEqual(["dated.act", "dated.muteOffer", "followups.act"]);
    expect(params).toEqual([{ id: 30, revision: 2, action: "dismiss" }, { id: 30 }, { id: 7, revision: 3, action: "dismiss" }]);
    expect(said).toEqual([{ text: "Removed from “What matters”", undo: true }, { text: "Removed from “What matters”", undo: true }]);
  });

  it("Done and Later say so; a promise's Later moves its due moment", async () => {
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null, due: null }, "later", 1234);
    await actOnTask({ kind: "dated", item, when: null, due: null, dueAt: 0 }, "done");
    expect(params).toEqual([{ id: 7, revision: 3, action: "later", dueAt: 1234 }, { id: 30, revision: 2, action: "done" }]);
    expect(said.map((s) => s.text)).toEqual(["Moved to later", "Marked done"]);
  });

  it("the fourth panel round (change 9): Undo names what it undoes, by the words the task had when acted on", async () => {
    const bill = { kind: "dated" as const, item, when: null, due: null, dueAt: 0, text: "Pay $187.42 for the utility bill" };
    await actOnTask(bill, "done");
    await actOnTask({ kind: "promise", id: 7, revision: 3, when: null, due: null, text: "send the agenda" }, "dismiss");
    await actOnTask(bill, "later", 1234);
    expect(said).toEqual([
      { text: "Done: Pay $187.42 for the utility bill", undo: true },
      { text: "Removed from “What matters”: send the agenda", undo: true },
      { text: "Later: Pay $187.42 for the utility bill", undo: true },
    ]);
    // a task with no words of its own: the plain ones
    await actOnTask({ kind: "promise", id: 8, revision: 0, when: null, due: null, text: null }, "done");
    expect(said.at(-1)!.text).toBe("Marked done");
  });

  it("a long task is cut at a word, so the snack keeps its Undo in view", () => {
    const long = "Renew the commercial general liability insurance policy for the downtown warehouse before it lapses at midnight";
    const text = taskSaid("done", long);
    expect(text).toBe("Done: Renew the commercial general liability insurance policy for the downtown warehouse…");
    expect(text.length).toBeLessThanOrEqual("Done: ".length + 84);
    // the claims ledger's second batch: Margaret's water bill whole, on the message's two lines
    expect(taskSaid("done", "Pay $58.71 for the City of Millbrook water and sewer service, account 4471-22")).toBe("Done: Pay $58.71 for the City of Millbrook water and sewer service, account 4471-22");
    // one word with no space near the end is cut where it must be
    expect(taskSaid("dismiss", "x".repeat(100))).toBe(`Removed from “What matters”: ${"x".repeat(83)}…`);
    expect(taskSaid("later", "  ")).toBe("Moved to later");
  });

  it("Later's choices: every preset that applies now; on a Plan, only those before it ends", () => {
    // Thursday 12 November 2026, 10:00: later today, tomorrow, this weekend, next week
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    expect(laterChoices({ kind: "promise", id: 7, revision: 3, when: null, due: null }, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    const plan = { kind: "dated" as const, item: { ...item, kind: "delivery" as const, dueDay: "2026-11-14", timed: false }, when: null, due: null, dueAt: new Date(2026, 10, 14, 9).getTime() };
    expect(laterChoices(plan, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend"]);
    expect(laterChoices({ ...plan, item: { ...plan.item, dueDay: "2026-11-12" }, dueAt: new Date(2026, 10, 12, 9).getTime() }, now).map((p) => p.id)).toEqual(["laterToday"]);
  });

  it("the third panel round: a timed item still ahead keeps only what's before its moment; Missed, every preset; a dated promise, every preset (its own Later)", () => {
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    // a 1:00 PM payroll at 10:00: Later today is 1:00 PM, not before it
    const payroll = { kind: "dated" as const, item: { ...item, kind: "pay" as const, dueDay: "2026-11-12", timed: true }, when: null, due: null, dueAt: new Date(2026, 10, 12, 13).getTime() };
    expect(laterChoices(payroll, now)).toEqual([]);
    expect(laterWindow(payroll, now)).toEqual({ before: payroll.dueAt, limit: "due" });
    expect(laterNote(laterWindow(payroll, now)).late).toBe("Pick a time before it’s due.");
    // the same at 2:00 PM (its moment passed) and once Missed: every preset
    expect(laterChoices(payroll, new Date(2026, 10, 12, 14).getTime()).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    expect(laterChoices({ ...payroll, item: { ...payroll.item, dueDay: "2026-11-11" }, dueAt: new Date(2026, 10, 11, 13).getTime() }, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    // a dated promise of yours due today: later today too, since its Later is its own and its day stays (the fifth panel round)
    expect(laterChoices({ kind: "promise", id: 7, revision: 3, when: "Today", due: "Due today", dated: true }, now).map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    // the picker starts an hour before the moment when tomorrow at 9 is past it
    expect(laterStart(laterWindow(payroll, now), now)).toBe(new Date(2026, 10, 12, 12).getTime());
  });
});

describe("plan 215: a conversation waiting on you", () => {
  const thread = { id: 12, fromName: "Tomas Santarcieri", fromEmail: "tomas@acme.test" };
  it("its task is Done and Later at what the row was drawn at, named by who wrote; none without what to act on, nor a reminder", async () => {
    const { taskOf } = await import("./dated");
    const why = { kind: "waiting" as const, wrote: true, reply: { since: 500, rev: 2, message: 90 } };
    expect(taskOf(why, 0, thread)).toEqual({ kind: "waiting", threadId: 12, since: 500, message: 90, rev: 2, name: "Tomas Santarcieri", noDay: true });
    expect(taskOf(why, 0, { ...thread, fromName: "" })).toMatchObject({ name: "tomas@acme.test" });
    expect(taskOf({ kind: "waiting", wrote: true }, 0, thread)).toBeNull();
    expect(taskOf(why, 0)).toBeNull();
    expect(taskOf({ kind: "reminder", dueAt: 5 }, 0, thread)).toBeNull();
  });

  it("Done, Later and (plan 216) Remove go to the waiting act with their Undo, naming who wrote and when it's back (en, es)", async () => {
    const { taskOf, laterWindow } = await import("./dated");
    const { setLocale } = await import("@terno/i18n");
    const { default: en } = await import("@terno/i18n/locales/en");
    const { default: es } = await import("@terno/i18n/locales/es");
    const task = taskOf({ kind: "waiting", wrote: false, reply: { since: 500, rev: 0, message: 90 } }, 0, thread)!;
    expect(laterWindow(task)).toEqual({ before: null, limit: null });
    const friday = new Date(2099, 0, 2, 9).getTime();
    await actOnTask(task, "done");
    await actOnTask(task, "later", friday);
    await actOnTask(task, "dismiss");
    expect(calls).toEqual(["today.waitingAct", "today.waitingAct", "today.waitingAct"]);
    expect(params).toEqual([{ threadId: 12, since: 500, message: 90, rev: 0, action: "done" }, { threadId: 12, since: 500, message: 90, rev: 0, action: "later", until: friday }, { threadId: 12, since: 500, message: 90, rev: 0, action: "remove" }]);
    expect(said).toEqual([{ text: "Done: Tomas Santarcieri", undo: true }, { text: "Later: Tomas Santarcieri, back Jan 2, 2099 9:00 AM", undo: true }, { text: "Removed from “What matters”: Tomas Santarcieri", undo: true }]);
    setLocale("es", es);
    try {
      said.length = 0;
      await actOnTask(task, "done");
      await actOnTask(task, "later", friday);
      await actOnTask(task, "dismiss");
      expect(said.map((x) => x.text)).toEqual(["Hecho: Tomas Santarcieri", expect.stringMatching(/^Más tarde: Tomas Santarcieri, vuelve /u), "Quitado de «Lo importante»: Tomas Santarcieri"]);
    } finally {
      setLocale("en", en);
    }
    // a failure says so, and puts the row back
    fail = true;
    const failed = vi.fn();
    await actOnTask(task, "done", undefined, { undo: async () => {}, failed });
    expect(errors).toEqual(["The backend is busy."]);
    expect(failed).toHaveBeenCalled();
  });
});

describe("the conversation's line keeps the whole wording (plan 204, after the second panel round)", () => {
  it("when, then the task; a promise's in your words; no day, the task alone", async () => {
    const { datedLine, promiseLine } = await import("./dated");
    // Thursday 12 November 2026, 10:00
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const facts = { kind: "pay" as const, dueDay: "2026-11-12", dueAt: new Date(2026, 10, 12, 13, 0).getTime(), timed: true, dated: true, text: "Wire payroll" };
    expect(datedLine(facts, false, now)).toBe("Due today 1:00 PM\u00a0·\u00a0Wire payroll");
    expect(datedLine({ ...facts, dueDay: "2026-11-11", timed: false }, true, now)).toBe("Was due yesterday\u00a0·\u00a0Wire payroll");
    expect(datedLine({ ...facts, dated: false }, false, now)).toBe("Wire payroll");
    expect(promiseLine({ text: "send the agenda", dueAt: facts.dueAt, dated: true }, false, now)).toBe("Due today\u00a0·\u00a0You said: send the agenda");
    expect(promiseLine({ text: "call back", dated: false }, false, now)).toBe("You said: call back");
  });
  it("plan 210 (iteration 5, revision 4): a part of the day in the reader's line, never a clock; missed after its noon (en, es)", async () => {
    const { datedLine, promiseLine } = await import("./dated");
    const { setLocale } = await import("@terno/i18n");
    const { default: en } = await import("@terno/i18n/locales/en");
    const { default: es } = await import("@terno/i18n/locales/es");
    // Thursday 12 November 2026, 10:00
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const kai = { kind: "respond" as const, dueDay: "2026-11-14", dueAt: new Date(2026, 10, 14, 9).getTime(), timed: false, dated: true, text: "Send Kai notes on cut v2", partOfDay: "morning" as const };
    expect(datedLine(kai, false, now)).toBe("Due Saturday morning\u00a0·\u00a0Send Kai notes on cut v2");
    expect(datedLine({ ...kai, dueDay: "2026-11-13" }, false, now)).toBe("Due tomorrow morning\u00a0·\u00a0Send Kai notes on cut v2");
    const cupcakes = { text: "bring Jessica the cupcakes", dueAt: new Date(2026, 10, 12, 9).getTime(), dated: true, partOfDay: "morning" as const };
    expect(promiseLine(cupcakes, false, now)).toBe("Due this morning\u00a0·\u00a0You said: bring Jessica the cupcakes");
    expect(promiseLine(cupcakes, true, new Date(2026, 10, 12, 12).getTime())).toBe("Was due this morning\u00a0·\u00a0You said: bring Jessica the cupcakes");
    // a day later it's yesterday's, as any
    expect(promiseLine(cupcakes, true, new Date(2026, 10, 13, 12).getTime())).toBe("Was due yesterday\u00a0·\u00a0You said: bring Jessica the cupcakes");
    setLocale("es", es);
    try {
      expect(datedLine(kai, false, now)).toBe("Vence el sábado por la mañana\u00a0·\u00a0Send Kai notes on cut v2");
      expect(promiseLine(cupcakes, false, now)).toMatch(/^Vence esta mañana\u00a0·\u00a0/u);
      expect(promiseLine(cupcakes, true, new Date(2026, 10, 12, 12).getTime())).toMatch(/^Venció esta mañana\u00a0·\u00a0/u);
    } finally {
      setLocale("en", en);
    }
  });
  it("plan 210 (iteration 5, R1): a travel item's time is its place's clock wherever it's said, never the reader's zone (en, es)", async () => {
    const { datedLine, taskOf } = await import("./dated");
    const { setLocale } = await import("@terno/i18n");
    const { default: es } = await import("@terno/i18n/locales/es");
    const { default: en } = await import("@terno/i18n/locales/en");
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    // the return flight leaves Austin at 4:00 PM there: stored at the instant, which the reader's zone may call another hour
    const dueAt = new Date(2026, 10, 16, 23, 0).getTime();
    const wall = { day: "2026-11-16", time: "16:00", zone: "America/Chicago", place: "Austin" };
    const back = { kind: "event" as const, dueDay: "2026-11-16", dueAt, timed: true, dated: true, text: "Return flight to Madrid", wall };
    expect(datedLine(back, false, now)).toBe("Monday 4:00 PM Austin\u00a0·\u00a0Return flight to Madrid");
    // a zone the mail named with no place stays the reader's
    expect(datedLine({ ...back, wall: { ...wall, place: null } }, false, now)).toBe("Monday 11:00 PM\u00a0·\u00a0Return flight to Madrid");
    // the row's screen-reader words, from what Today carries
    const why = { kind: "dated" as const, text: back.text, dueAt, item: { id: 1, revision: 0, kind: "event" as const, dueDay: "2026-11-16", timed: true, dated: true, travel: { day: "2026-11-16", time: "16:00", place: "Austin" } } };
    expect(taskOf(why, now)?.due).toBe("Monday 4:00 PM Austin");
    setLocale("es", es);
    try {
      expect(datedLine(back, false, now)).toMatch(/^Lunes 16:00 en Austin\u00a0·\u00a0Return flight to Madrid$/i);
    } finally {
      setLocale("en", en);
    }
  });
  it("the Codex code review of the fourth round: an alert is the mail's word, the app saying so after the model's words (en, es)", async () => {
    const { datedLine, datedText } = await import("./dated");
    const { setLocale } = await import("@terno/i18n");
    const { default: en } = await import("@terno/i18n/locales/en");
    const { default: es } = await import("@terno/i18n/locales/es");
    const now = new Date(2026, 11, 12, 10, 0).getTime();
    const alert = { kind: "alert" as const, dueDay: "2026-12-14", dueAt: now, timed: false, dated: false, text: "Debit card frozen after a $412.18 charge" };
    expect(datedLine(alert, false, now)).toBe("Debit card frozen after a $412.18 charge, the email says");
    expect(datedLine({ ...alert, dated: true }, false, now)).toBe("Due Monday\u00a0·\u00a0Debit card frozen after a $412.18 charge, the email says");
    // only an alert's
    expect(datedText({ kind: "pay", text: "Pay $187.42 for the utility bill" })).toBe("Pay $187.42 for the utility bill");
    // plan 249: news the user's words asked for isn't an alert the mail raised
    expect(datedText({ kind: "alert", text: "Stairwell painting next week", wanted: true })).toBe("Stairwell painting next week");
    setLocale("es", es);
    try {
      expect(datedText({ ...alert, text: "Tarjeta de débito congelada tras un cargo de $412.18" })).toBe("Tarjeta de débito congelada tras un cargo de $412.18, según el correo");
    } finally {
      setLocale("en", en);
    }
  });
  it("the third panel round: an ask is its words alone, in the conversation and in Today, its row's date the day it came", async () => {
    const { datedLine, taskOf } = await import("./dated");
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const arrived = new Date(2026, 10, 10, 9, 0).getTime();
    const ask = { kind: "ask" as const, dueDay: "2026-11-10", dueAt: arrived, timed: false, dated: false, text: "Answer Mariana about a rebranding quote" };
    expect(datedLine(ask, false, now)).toBe("Answer Mariana about a rebranding quote");
    // an older backend's ask said dated: it still names no day
    expect(datedLine({ ...ask, dated: true }, false, now)).toBe("Answer Mariana about a rebranding quote");
    const task = taskOf({ kind: "dated", text: ask.text, dueAt: arrived, item: { id: 1, revision: 0, kind: "ask", dueDay: ask.dueDay, timed: false, dated: false } }, now);
    expect(task).toMatchObject({ kind: "dated", when: null, due: null, dueAt: arrived });
    expect(task!.noDay).toBeUndefined();
  });
  it("the fifth panel round (change 3): an alert that named no day says none on its row, ahead or Missed; one with a day says it", async () => {
    const { taskOf } = await import("./dated");
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const arrived = new Date(2026, 10, 11, 9, 0).getTime();
    const item = { id: 2, revision: 0, kind: "alert" as const, dueDay: "2026-11-13", timed: false, dated: false };
    const why = { kind: "dated" as const, text: "Debit card frozen", dueAt: arrived, item };
    expect(taskOf(why, now)).toMatchObject({ when: null, due: null, noDay: true });
    expect(taskOf({ ...why, missed: true }, now)).toMatchObject({ when: null, due: null, noDay: true });
    expect(taskOf({ ...why, item: { ...item, dated: true } }, now)).toMatchObject({ when: "Tomorrow", due: "Due tomorrow" });
    expect(taskOf({ ...why, item: { ...item, dated: true } }, now)!.noDay).toBeUndefined();
  });
  it("round 17: a deadline moved with Change… is heard with the mail's own day, as the column shows it", async () => {
    const { taskOf } = await import("./dated");
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const item = { id: 3, revision: 0, kind: "pay" as const, dueDay: "2026-11-16", timed: false, dated: true, mailDay: "2026-11-17" };
    expect(taskOf({ kind: "dated", text: "Pay the taxes", dueAt: new Date(2026, 10, 16, 9).getTime(), item }, now)).toMatchObject({ when: "Mon", due: "Due Monday · due Tue" });
  });
  it("iteration 5's code review: a promise's task carries the part of its day, for Remind me's limit", async () => {
    const { taskOf } = await import("./dated");
    const now = new Date(2026, 10, 12, 10, 0).getTime();
    const promise = { id: 4, revision: 1, dated: true, timed: false, part: "morning" as const };
    expect(taskOf({ kind: "promise", text: "send the cupcakes", dueAt: new Date(2026, 10, 13, 9).getTime(), promise }, now)).toMatchObject({ kind: "promise", part: "morning" });
  });
});

describe("a row's second item (plan 204, the fifth panel round, change 6)", () => {
  it("the row's own short day and time, the task in its words; no day, its words alone (en, es)", async () => {
    const { alsoLine } = await import("./dated");
    const { setLocale } = await import("@terno/i18n");
    const { default: en } = await import("@terno/i18n/locales/en");
    const { default: es } = await import("@terno/i18n/locales/es");
    // Saturday 14 November 2026, 10:00
    const now = new Date(2026, 10, 14, 10, 0).getTime();
    const board = { kind: "event" as const, text: "Board meeting", dueDay: "2026-11-19", dueAt: new Date(2026, 10, 19, 9, 0).getTime(), timed: true, dated: true };
    expect(alsoLine(board, now)).toBe("Also Thu 9:00 AM\u00a0·\u00a0Board meeting");
    expect(alsoLine({ ...board, dueDay: "2026-11-15", dueAt: new Date(2026, 10, 15, 9, 0).getTime() }, now)).toBe("Also tomorrow 9:00 AM\u00a0·\u00a0Board meeting");
    expect(alsoLine({ kind: "promise", text: "send the deck", dueDay: "2026-11-14", dueAt: new Date(2026, 10, 14, 9).getTime(), timed: false, dated: true }, now)).toBe("Also today\u00a0·\u00a0You said: send the deck");
    expect(alsoLine({ kind: "pay", text: "Renew the lease", dueDay: "2026-11-30", dueAt: new Date(2026, 10, 30, 9).getTime(), timed: false, dated: true }, now)).toBe("Also Nov 30\u00a0·\u00a0Renew the lease");
    expect(alsoLine({ kind: "ask", text: "Answer Jess about the budget", dueDay: "2026-11-13", dueAt: now, timed: false, dated: false }, now)).toBe("Also: Answer Jess about the budget");
    expect(alsoLine({ kind: "alert", text: "Debit card frozen", dueDay: "2026-11-16", dueAt: now, timed: false, dated: false }, now)).toBe("Also: Debit card frozen, the email says");
    // plan 210 (iteration 5, R9): your promise to attend the row's event or bring someone, in your words, no day
    const bring = { kind: "promise" as const, text: "Bring Nina and the SE.", dueDay: "2026-11-14", dueAt: now, timed: false, dated: false, attends: true };
    expect(alsoLine(bring, now)).toBe("You said you'd bring Nina and the SE");
    setLocale("es", es);
    try {
      expect(alsoLine({ ...bring, text: "llevar a Nina y al ingeniero" }, now)).toBe("Dijiste que ibas a llevar a Nina y al ingeniero");
      expect(alsoLine(board, now)).toBe("También el jue 09:00\u00a0·\u00a0Board meeting");
      expect(alsoLine({ kind: "promise", text: "enviar la presentación", dueDay: "2026-11-15", dueAt: new Date(2026, 10, 15, 9).getTime(), timed: false, dated: true }, now)).toBe("También mañana\u00a0·\u00a0Dijiste: enviar la presentación");
    } finally {
      setLocale("en", en);
    }
  });
});

describe("the conversation's line (plan 204, the sixth panel round, revision 2)", () => {
  it("an alert that named no day: its line for a week from its arrival, never Missed; put off past it, kept", async () => {
    const { conversationItem } = await import("./dated");
    const { datedTiming } = await import("@terno/core");
    const arrived = new Date(2026, 10, 10, 14).getTime();
    const alert = { id: 1, threadId: 1, messageId: 1, item: 0, kind: "alert" as const, text: "Debit card frozen", quote: "frozen", senderKey: "bank", ...datedTiming({ kind: "alert", due: null, arrivedAt: arrived })!, deferredUntil: null, arrivedAt: arrived, state: "open" as const, closedReason: null, closedAt: null, fromScan: false, revision: 0, model: null, provider: null, createdAt: arrived };
    expect(conversationItem(alert, new Date(2026, 10, 13, 10).getTime())).toEqual({ missed: false });
    expect(conversationItem(alert, new Date(2026, 10, 17, 13, 59).getTime())).toEqual({ missed: false });
    expect(conversationItem(alert, new Date(2026, 10, 17, 14).getTime())).toBeNull();
    const later = { ...alert, deferredUntil: new Date(2026, 11, 20, 9).getTime() };
    expect(conversationItem(later, new Date(2026, 10, 18, 10).getTime())).toEqual({ missed: false });
    // a bill is Missed past its day, as Today says
    const bill = { ...alert, kind: "pay" as const, ...datedTiming({ kind: "pay", due: "2026-11-12", arrivedAt: arrived })! };
    expect(conversationItem(bill, new Date(2026, 10, 13, 10).getTime())).toEqual({ missed: true });
  });

  it("the seventh panel round: on a day ahead or in Today an item keeps its own words; its group changes neither the line nor Missed", async () => {
    const { conversationItem, datedWhen } = await import("./dated");
    const { datedGroupAt, datedTiming } = await import("@terno/core");
    const arrived = new Date(2026, 10, 10, 14).getTime();
    const row = (kind: "pay" | "event", due: string, time: string | null) => ({ id: 1, threadId: 1, messageId: 1, item: 0, kind, text: "x", quote: "x", senderKey: "s", ...datedTiming({ kind, due, time, arrivedAt: arrived })!, deferredUntil: null, arrivedAt: arrived, state: "open" as const, closedReason: null, closedAt: null, fromScan: false, revision: 0, model: null, provider: null, createdAt: arrived });
    const bill = row("pay", "2026-11-13", null);
    const visit = row("event", "2026-11-12", "15:00");
    const now = new Date(2026, 10, 12, 10).getTime();
    expect([datedGroupAt(bill, now), datedGroupAt(visit, now)]).toEqual([{ group: "day", day: "2026-11-13" }, { group: "today", day: null }]);
    expect(datedWhen(bill, false, now)).toBe("Due tomorrow");
    expect(datedWhen(visit, false, now)).toBe("Today 3:00 PM");
    expect([conversationItem(bill, now), conversationItem(visit, now)]).toEqual([{ missed: false }, { missed: false }]);
  });
});
