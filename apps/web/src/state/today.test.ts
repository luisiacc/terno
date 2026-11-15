// @vitest-environment jsdom
import { dayKeyOf, DIGEST_ROW_ID, type TodayList } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));

const { digestPick, flattenToday, historyThrough, installToday, keepDigestPick, publishHistory, todayAnswer, useToday } = await import("./today");
installToday();
const { setApp } = await import("./app");
const { laterWindow } = await import("~/lib/dated");

const ai = { provider: "ollama", model: "m", local: true, needsKey: false, keys: {} };

describe("the digest page's pick (plan 161)", () => {
  it("what was unticked, and where it was, outlive the page; a new day starts afresh", () => {
    keepDigestPick({ day: "2026-10-22", toggled: new Set([4, 9]), scroll: 120 });
    expect([...digestPick("2026-10-22").toggled]).toEqual([4, 9]);
    expect(digestPick("2026-10-22").scroll).toBe(120);
    expect(digestPick("2026-10-23")).toEqual({ day: "2026-10-23", toggled: new Set(), scroll: 0 });
  });
});

describe("Back to the digest (plan 161)", () => {
  beforeEach(() => {
    setApp({ devAi: { anthropic: true, openai: false, jev: false }, settings: { ai, devAi: true, today: { show: true } } as never, view: "all", today: true, selectedId: DIGEST_ROW_ID });
    useToday.setState({ fromDigest: null });
  });

  it("stays on the newsletter it was opened for, and back on the digest", () => {
    useToday.setState({ fromDigest: 7 });
    setApp({ selectedId: 7 });
    expect(useToday.getState().fromDigest).toBe(7);
    setApp({ selectedId: DIGEST_ROW_ID });
    expect(useToday.getState().fromDigest).toBe(7);
  });

  it("goes when another conversation opens, or Today is left", () => {
    useToday.setState({ fromDigest: 7 });
    setApp({ selectedId: 7 });
    setApp({ selectedId: 8 });
    expect(useToday.getState().fromDigest).toBe(null);
    useToday.setState({ fromDigest: 7 });
    setApp({ selectedId: 7 });
    setApp({ today: false });
    expect(useToday.getState().fromDigest).toBe(null);
  });
});

describe("plan 166, after the owner's second look; plan 210: what needs you now is Today's", () => {
  const thread = (id: number) => ({ id, snippet: `snippet ${id}`, fromName: "Ana" }) as never;
  const waiting = (id: number, wrote: boolean, summary?: string) => ({ thread: thread(id), why: { kind: "waiting" as const, wrote }, ...(summary ? { summary } : {}) });
  const groups = () => useToday.getState().groups.map((g) => [g.kind, g.at]);

  it("one heading, in the backend's order; the row leads with its own words, a promise's line stays", () => {
    const list: TodayList = {
      now: 0,
      held: [],
      digest: null,
      sections: [
        {
          kind: "today",
          items: [
            { thread: thread(5), why: { kind: "promise", text: "send the contract" } },
            waiting(1, false, "A summary."),
            waiting(2, true),
            { thread: thread(7), why: { kind: "reminder" } },
          ],
        },
      ],
    };
    const rows = flattenToday(list, []);
    expect(rows.map((r) => r.id)).toEqual([5, 1, 2, 7]);
    expect(groups()).toEqual([["today", 0]]);
    expect(rows.map((r) => r.snippet)).toEqual(["You said: send the contract", "A summary.", "snippet 2", "snippet 7"]);
    expect("reasons" in useToday.getState()).toBe(false);
    // your reminder sits in Today, never counted
    expect(useToday.getState().counted).toBe(3);
  });

  it("a held row stays at its place, above the reminder after it", () => {
    const list = (items: ReturnType<typeof waiting>[], held: never[] = []): TodayList => ({ now: 0, held, digest: null, sections: [{ kind: "today", items: [...items, { thread: thread(7), why: { kind: "reminder" } } as never] }] });
    const before = flattenToday(list([waiting(1, true), waiting(2, false)]), []);
    expect(groups()).toEqual([["today", 0]]);
    const rows = flattenToday(list([waiting(1, true)], [thread(2)]), before);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 7]);
    expect(groups()).toEqual([["today", 0]]);
  });
});

describe("plan 161, pass 2: the digest's way in", () => {
  const thread = (id: number) => ({ id, snippet: "s", fromName: "Ana" }) as never;
  const digest = { day: "2026-10-22", state: "ready" as const, automated: false, items: [], liveIds: [1, 2], readIds: [] };
  it("plan 204 (after the panel, revision 10): the list's last option again, after held rows, under no heading; none without a digest", () => {
    const list: TodayList = { now: 0, held: [thread(9)], digest, sections: [{ kind: "today", items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }] };
    // the digest's row stays last however the held row was placed (never before a person)
    const rows = flattenToday(list, [thread(9), thread(1), thread(DIGEST_ROW_ID)]);
    expect(rows.map((r) => r.id)).toEqual([9, 1, DIGEST_ROW_ID]);
    expect(useToday.getState().groups.map((g) => [g.kind, g.at])).toEqual([["today", 0]]);
    expect(useToday.getState().digest).toBe(digest);
    expect(useToday.getState().tasks.has(DIGEST_ROW_ID)).toBe(false);
    expect(flattenToday({ ...list, digest: null }, rows).map((r) => r.id)).toEqual([9, 1]);
  });
  it("plan 162 (after ai162-r02): a newsletter opened from the page is kept in its pick at once, beside what was unticked", async () => {
    const { openFromDigest } = await import("./today");
    keepDigestPick({ day: "k", toggled: new Set([3]), scroll: 0 });
    openFromDigest("k", 5, 120, new Set([3]));
    openFromDigest("k", 6, 80, new Set([3]));
    expect([...(digestPick("k").opened ?? [])]).toEqual([5, 6]);
    expect([...digestPick("k").toggled]).toEqual([3]);
    expect(digestPick("k").from).toBe(6);
    expect(digestPick("k").scroll).toBe(80);
    // the next day's page starts afresh
    expect(digestPick("l").opened ?? null).toBe(null);
  });
  it("Esc's way back: only from the newsletter it opened, while Today shows", async () => {
    const { backToDigest } = await import("./today");
    setApp({ devAi: { anthropic: true, openai: false, jev: false }, settings: { ai, devAi: true, today: { show: true } } as never, view: "all", today: true, selectedId: 7 });
    useToday.setState({ fromDigest: null });
    expect(backToDigest()).toBe(false);
    useToday.setState({ fromDigest: 7 });
    expect(backToDigest()).toBe(true);
    expect(useToday.getState().fromDigest).toBe(null);
    const { getApp } = await import("./app");
    expect(getApp().selectedId).toBe(DIGEST_ROW_ID);
  });
  it("the pick keeps what the page archived when the rest of it moves on", () => {
    keepDigestPick({ day: "d", toggled: new Set(), scroll: 0, done: [{ ids: [1], undo: null }] });
    keepDigestPick({ day: "d", toggled: new Set([2]), scroll: 40 });
    expect(digestPick("d").done?.[0]!.ids).toEqual([1]);
    keepDigestPick({ day: "e", toggled: new Set(), scroll: 0 });
    expect(digestPick("e").done ?? null).toBe(null);
  });
});

describe("plan 161, pass 2 (Codex review): Esc from inside a newsletter's own document", () => {
  it("goes back to the digest that opened it, as Esc in the window does", async () => {
    const { forwardNavKey } = await import("~/lib/page");
    setApp({ devAi: { anthropic: true, openai: false, jev: false }, settings: { ai, devAi: true, today: { show: true } } as never, view: "all", today: true, selectedId: 7 });
    useToday.setState({ fromDigest: 7 });
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    forwardNavKey(e);
    expect(e.defaultPrevented).toBe(true);
    const { getApp } = await import("./app");
    expect(getApp().selectedId).toBe(DIGEST_ROW_ID);
  });
});

describe("plan 162 (after ai162-r02): the digest's way in counts what the page lists", () => {
  it("counts what's still in the Inbox, read or not", async () => {
    const { digestLabel } = await import("./today");
    const digest = { day: "d", state: "ready" as const, automated: false, items: [], liveIds: [1], readIds: [2, 3, 4] };
    expect(digestLabel(digest as never)).toBe("4 newsletters · today's digest");
    expect(digestLabel({ ...digest, liveIds: [], readIds: [] } as never)).not.toMatch(/^\d+ newsletters? · today/);
  });
});

describe("plan 204: Missed, Today, Needs you, Soon, Reminders and Coming up (the seventh panel round: by when, not by kind)", () => {
  const thread = (id: number) => ({ id, snippet: `snippet ${id}`, fromName: "Ana" }) as never;
  const groups = () => useToday.getState().groups.map((g) => [g.kind, g.at]);
  // Thursday 12 November 2026, 10:00, local
  const now = new Date(2026, 10, 12, 10, 0).getTime();
  const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;
  const at = (d: number, h = 9, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const dated = (id: number, kind: "pay" | "renew" | "alert" | "event" | "delivery", text: string, d: number, o: { timed?: boolean; h?: number; m?: number; missed?: boolean; undated?: boolean } = {}) => ({
    thread: thread(id),
    why: { kind: "dated" as const, text, dueAt: at(d, o.h, o.m), ...(o.missed ? { missed: true } : {}), item: { id: id * 10, revision: 1, kind, dueDay: day(d), timed: o.timed === true, dated: o.undated !== true } },
  });
  type Row = ReturnType<typeof dated> | { thread: never; why: never };
  /** a row's day as the backend gives a day's section (its item's, else its promise's) */
  const dayOf = (r: Row): string => (r.why as { item?: { dueDay: string } }).item?.dueDay ?? dayKeyOf((r.why as { dueAt: number }).dueAt);
  /** the backend's sections: a day ahead's and Coming up's split by day, in order */
  const byDay = (kind: "day" | "comingUp", rows: readonly Row[] = []) => [...new Set(rows.map(dayOf))].sort().map((d) => ({ kind, day: d, items: rows.filter((r) => dayOf(r) === d) as never }));
  const list = (over: Partial<Record<"missed" | "today" | "day" | "comingUp", Row[]>>, held: never[] = []): TodayList => ({
    now,
    held,
    digest: null,
    sections: [{ kind: "missed", items: (over.missed ?? []) as never }, { kind: "today", items: (over.today ?? []) as never }, ...byDay("day", over.day), ...byDay("comingUp", over.comingUp)],
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    useToday.setState({ comingUpOpen: false, groups: [] });
  });
  afterEach(() => vi.useRealTimers());

  const full = () =>
    list({
      missed: [dated(1, "renew", "Renew the domain", 10, { missed: true }), { thread: thread(2), why: { kind: "promise", text: "send the contract", dueAt: at(11), missed: true } } as never],
      // what needs you now and your reminder are Today's (plan 210)
      today: [dated(4, "pay", "Pay the rent", 12), dated(5, "alert", "Your card was declined", 12, { undated: true }), dated(7, "delivery", "Your parcel arrives", 12), { thread: thread(8), why: { kind: "waiting", wrote: true } } as never, { thread: thread(9), why: { kind: "reminder" } } as never],
      day: [dated(6, "event", "Flight to Madrid", 13, { timed: true, h: 7, m: 40 }), dated(3, "pay", "Pay the electricity bill", 13)],
      comingUp: [dated(10, "renew", "Renew the passport", 20)],
    });

  it("every group in core's order, a heading each, all their rows (no cap); Coming up closed, but counted for its toggle", () => {
    const many = list({ today: Array.from({ length: 30 }, (_, i) => ({ thread: thread(100 + i), why: { kind: "waiting", wrote: true } })) as never });
    expect(flattenToday(many, []).length).toBe(30);
    expect(useToday.getState().counted).toBe(30);

    const rows = flattenToday(full(), []);
    // plan 210: by day: Missed, Today (what needs you now in it), then tomorrow under its own heading
    expect(rows.map((r) => r.id)).toEqual([1, 2, 4, 5, 7, 8, 9, 6, 3]);
    expect(groups()).toEqual([["missed", 0], ["today", 2], ["day:2026-11-13", 7]]);
    expect(useToday.getState().comingUp).toBe(1);
    // a Plan's kind wherever it sits (today's parcel, tomorrow's flight), your reminder and Coming up aren't counted (the
    // third panel round: a Plan isn't something you owe; the seventh: one rule, `todayCounted`)
    expect(useToday.getState().counted).toBe(6);
    // the menu's Done knows each row's task; a promise with no reference (an older backend) and a waiting row have none
    expect(useToday.getState().tasks.get(3)).toMatchObject({ kind: "dated", item: { id: 30, revision: 1, kind: "pay" } });
    expect(useToday.getState().tasks.has(2)).toBe(false);
    expect(useToday.getState().tasks.has(8)).toBe(false);
    flattenToday(list({ today: [dated(7, "delivery", "Your parcel arrives", 12)], day: [dated(6, "event", "Flight to Madrid", 13, { timed: true, h: 7, m: 40 })] }), []);
    expect(useToday.getState().counted).toBe(0);
  });

  it("each kind's line: the task alone where the date says when, and when in words for a screen reader", () => {
    const rows = flattenToday(full(), []);
    const line = (id: number) => rows.find((r) => r.id === id)!.snippet;
    const due = (id: number) => useToday.getState().tasks.get(id)?.due;
    // after the second panel round: the right column says when, so the line doesn't say it again
    expect([line(1), due(1)]).toEqual(["Renew the domain", "Was due Tuesday"]);
    expect([line(3), due(3)]).toEqual(["Pay the electricity bill", "Due tomorrow"]);
    expect([line(4), due(4)]).toEqual(["Pay the rent", "Due today"]);
    // Codex code review: "Tomorrow" in the right column can't hold the time, so the line does
    expect([line(6), due(6)]).toEqual(["7:40 AM · Flight to Madrid", "Tomorrow 7:40 AM"]);
    expect([line(7), due(7)]).toEqual(["Your parcel arrives", "Today"]);
    // no date in the right column, so the line keeps the whole wording: a missed promise an older backend gave no
    // reference (no task), an alert that named no day
    expect(line(2)).toBe("Was due yesterday · You said: send the contract");
    // the Codex code review of the fourth round: an alert is the mail's word, said by the app
    expect([line(5), due(5)]).toEqual(["Your card was declined, the email says", null]);
  });

  it("Codex code review of the fixes: a timed item keeps its time in Missed", () => {
    const rows = flattenToday(list({ missed: [dated(1, "pay", "Wire payroll", 11, { missed: true, timed: true, h: 13 })] }), []);
    // "Yesterday" in the right column can't hold the time: the line does (Codex code review)
    expect(rows.find((r) => r.id === 1)!.snippet).toBe("1:00 PM · Wire payroll");
    expect(useToday.getState().tasks.get(1)).toMatchObject({ when: "Yesterday", due: "Was due yesterday 1:00 PM" });
  });

  it("after the panel: any timed item says its time; a promise of yours says when it's due; Coming up's promise its day", () => {
    const rows = flattenToday(
      list({
        today: [dated(1, "pay", "Wire payroll", 12, { timed: true, h: 13 }), { thread: thread(3), why: { kind: "promise", text: "send the agenda", dueAt: at(12, 18), promise: { id: 31, revision: 2, dated: true } } } as never, { thread: thread(4), why: { kind: "promise", text: "call back", dueAt: at(12, 18), promise: { id: 41, revision: 0, dated: false } } } as never],
        day: [dated(2, "pay", "Pay the rent", 13, { timed: true, h: 9, m: 30 })],
        // an older backend's promise in Coming up names no `dated`: there it can only be a dated one
        comingUp: [{ thread: thread(5), why: { kind: "promise", text: "send the deck", dueAt: at(17), promise: { id: 51, revision: 0 } } } as never],
      }),
      [],
    );
    const line = (id: number) => rows.find((r) => r.id === id)?.snippet;
    const due = (id: number) => useToday.getState().tasks.get(id)?.due;
    // today, the right column is the time; tomorrow, it's the day and the line keeps the time
    expect([line(1), due(1)]).toEqual(["Wire payroll", "Due today 1:00 PM"]);
    expect([line(2), due(2)]).toEqual(["9:30 AM · Pay the rent", "Due tomorrow 9:30 AM"]);
    expect([line(3), due(3)]).toEqual(["You said: send the agenda", "Due today"]);
    expect([line(4), due(4)]).toEqual(["You said: call back", null]);
    useToday.setState({ comingUpOpen: true });
    expect(flattenToday(list({ comingUp: [{ thread: thread(5), why: { kind: "promise", text: "send the deck", dueAt: at(17), promise: { id: 51, revision: 0 } } } as never] }), [])[0]!.snippet).toBe("You said: send the deck");
    expect(useToday.getState().tasks.get(5)).toMatchObject({ when: "Tue", due: "Due Tuesday" });
  });

  it("after the panel: each row's task, what D, Done, Remove and Later act on, with its due day for the date's place", () => {
    flattenToday(full(), []);
    const tasks = useToday.getState().tasks;
    // Missed says its day; a deadline tomorrow, "Tomorrow"; an alert that named none, no day at all (the fifth panel
    // round: not the day it came either)
    expect(tasks.get(1)).toMatchObject({ kind: "dated", when: "Tue" });
    expect(laterWindow(tasks.get(1)!)).toEqual({ before: null, limit: null });
    expect(tasks.get(3)).toMatchObject({ when: "Tomorrow" });
    expect(tasks.get(5)).toMatchObject({ when: null, noDay: true });
    // a Plan: its time tomorrow, and Later only before it starts (the third panel round), or an untimed one before it ends
    expect(tasks.get(6)).toMatchObject({ when: "Tomorrow" });
    expect(laterWindow(tasks.get(6)!)).toEqual({ before: at(13, 7, 40), limit: "starts" });
    expect(laterWindow(tasks.get(7)!)).toEqual({ before: new Date(2026, 10, 13).getTime(), limit: "ends" });
    flattenToday(list({ today: [dated(1, "pay", "Wire payroll", 12, { timed: true, h: 13 }), { thread: thread(3), why: { kind: "promise", text: "send the agenda", dueAt: at(12, 18), promise: { id: 31, revision: 2, dated: true } } } as never] }), []);
    expect(useToday.getState().tasks.get(1)).toMatchObject({ when: "1:00 PM" });
    // a promise row acts on the promise it shows, exactly
    expect(useToday.getState().tasks.get(3)).toEqual({ kind: "promise", id: 31, revision: 2, when: "Today", due: "Due today", dated: true, text: "send the agenda" });
  });

  it("the fourth panel round: a promise's row is its person's, the one it shows now; one with no day says none", () => {
    const promise = (id: number, revision: number, personName: string | null, personEmail: string | null, dated = true) =>
      ({ thread: thread(3), why: { kind: "promise", text: "send the agenda", dueAt: at(12, 18), personName, personEmail, promise: { id, revision, dated } } }) as never;
    flattenToday(list({ today: [promise(31, 0, "Elena Ruiz", "elena@acme.test")] }), []);
    expect(useToday.getState().tasks.get(3)).toMatchObject({ when: "Today", person: { name: "Elena Ruiz", email: "elena@acme.test" } });
    expect(useToday.getState().tasks.get(3)).not.toHaveProperty("noDay");
    // Done on it, and the conversation's other promise is the row's: its person, not the first one's
    flattenToday(list({ today: [promise(32, 1, null, "tom.lee@people.test", false)] }), []);
    expect(useToday.getState().tasks.get(3)).toMatchObject({ id: 32, when: null, noDay: true, person: { name: "tom.lee", email: "tom.lee@people.test" } });
    // nobody known: the thread's own sender stays
    flattenToday(list({ today: [promise(33, 0, null, null, false)] }), []);
    expect(useToday.getState().tasks.get(3)).not.toHaveProperty("person");
  });

  it("the fifth panel round (change 6): a row's task says its conversation's next item; what it acts on stays its own", () => {
    const board = { kind: "event" as const, text: "Board meeting", dueDay: day(17), dueAt: at(17, 9), timed: true, dated: true };
    flattenToday(list({ today: [dated(4, "pay", "Pay the rent", 12)], day: [{ ...dated(3, "respond" as never, "Send Jess your draft", 13), also: board } as never] }), []);
    const { tasks } = useToday.getState();
    expect(tasks.get(3)).toMatchObject({ kind: "dated", item: { id: 30 }, when: "Tomorrow", also: "Also Tue 9:00 AM · Board meeting" });
    expect(tasks.get(4)).not.toHaveProperty("also");
  });

  it("further days: a weekday within six, else the date", () => {
    flattenToday(list({ day: [dated(2, "event", "Dinner at Lúa", 16), dated(1, "pay", "Pay the water bill", 17)], comingUp: [] }), []);
    const due = (id: number) => useToday.getState().tasks.get(id)?.due;
    expect(due(1)).toBe("Due Tuesday");
    expect(due(2)).toBe("Monday");
    useToday.setState({ comingUpOpen: true });
    flattenToday(full(), []);
    expect(due(10)).toBe("Due Nov 20");
  });

  it("Coming up's rows only while it's open, under their days (plan 210), quiet, never counted", () => {
    useToday.setState({ comingUpOpen: true });
    const rows = flattenToday(full(), []);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 4, 5, 7, 8, 9, 6, 3, 10]);
    expect(groups().at(-1)).toEqual(["day:2026-11-20", 9]);
    expect([...useToday.getState().ahead]).toEqual([10]);
    expect(useToday.getState().counted).toBe(6);
  });

  it("plan 210: Coming up's row on a day that has rows joins its heading in the day's order (iteration 1: tasks, then plans by time); one whose day has come is Today's", () => {
    const parcel = dated(11, "delivery", "Your parcel arrives", 13, { timed: true, h: 8 });
    const late = { ...dated(12, "pay", "Pay the late fee", 10), why: { ...dated(12, "pay", "Pay the late fee", 10).why, dueAt: at(12, 9) } };
    const sections = (): TodayList => ({
      now,
      held: [],
      digest: null,
      sections: [
        { kind: "today", items: [dated(4, "pay", "Pay the rent", 12)] as never },
        { kind: "day", day: day(13), items: [dated(6, "event", "Flight to Madrid", 13, { timed: true, h: 9 }), dated(3, "pay", "Pay the electricity bill", 13)] as never },
        // put off until this morning, the backend's Coming up said its Later's day: now Today's here
        { kind: "comingUp", day: day(12), items: [late] as never },
        { kind: "comingUp", day: day(13), items: [parcel] as never },
      ],
    });
    expect(flattenToday(sections(), []).map((r) => r.id)).toEqual([4, 6, 3]);
    expect(useToday.getState().comingUp).toBe(2);
    useToday.setState({ comingUpOpen: true });
    const rows = flattenToday(sections(), []);
    // the bill first (a task), then the plans by time: the parcel at 8:00 before the flight at 9:00; the late fee with Today's
    expect(rows.map((r) => r.id)).toEqual([4, 12, 3, 11, 6]);
    expect(groups()).toEqual([["today", 0], ["day:2026-11-13", 2]]);
    expect(useToday.getState().kinds.get(11)).toBe("day:2026-11-13");
    expect([...useToday.getState().ahead].sort()).toEqual([11, 12]);
  });

  it("a held row keeps its group's place in any group; a group it was the last of keeps its heading", () => {
    const before = flattenToday(full(), []);
    // Pay the rent left on its own (a later mail settled it) while it was open: held where it was, first in Today
    const next = full();
    next.sections.find((s) => s.kind === "today")!.items.splice(0, 1);
    next.held = [thread(4)];
    expect(flattenToday(next, before).map((r) => r.id)).toEqual([1, 2, 4, 5, 7, 8, 9, 6, 3]);
    expect(groups()).toEqual([["missed", 0], ["today", 2], ["day:2026-11-13", 7]]);
    // tomorrow's both rows gone, one of them held: its day's heading stays above it, at the end
    const after = flattenToday(full(), []);
    const gone = full();
    gone.sections.find((s) => s.kind === "day")!.items = [];
    gone.held = [thread(6)];
    expect(flattenToday(gone, after).map((r) => r.id)).toEqual([1, 2, 4, 5, 7, 8, 9, 6]);
    expect(groups()).toEqual([["missed", 0], ["today", 2], ["day:2026-11-13", 7]]);
  });

  it("Coming up's open or closed is remembered, and storage that refuses changes nothing else", async () => {
    const { setComingUpOpen } = await import("./today");
    setComingUpOpen(true);
    expect(localStorage.getItem("terno.today.comingUp")).toBe("open");
    expect(useToday.getState().comingUpOpen).toBe(true);
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    setComingUpOpen(false);
    expect(useToday.getState().comingUpOpen).toBe(false);
    set.mockRestore();
  });
});

describe("plan 210: the history below the open part and the automated section, and its pages", () => {
  const thread = (id: number) => ({ id, snippet: `snippet ${id}`, fromName: "Ana" }) as never;
  const line = (id: number, at: number) => ({ thread: thread(id), key: { at, src: 0 as const, id: id * 10 }, outcome: "done" as const, kind: "pay" as const, text: "Pay the bill" });
  const groups = () => useToday.getState().groups.map((g) => [g.kind, g.at]);

  it("the history's first page after the digest, under its own heading; a page appended joins it; the deepest line is what a reload asks down to", () => {
    const list: TodayList = {
      now: 0,
      held: [],
      digest: { day: "2026-11-13", state: "ready", items: [], automated: true, liveIds: [], errorKind: null },
      sections: [{ kind: "today", items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }],
      // a line for a conversation already in the open part is never drawn twice
      history: { items: [line(2, 900), line(3, 800), line(1, 700)], next: { at: 800, src: 0, id: 30 } },
    };
    const rows = flattenToday(list, []);
    expect(rows.map((r) => r.id)).toEqual([1, DIGEST_ROW_ID, 2, 3]);
    expect(groups()).toEqual([["today", 0], ["history", 2]]);
    expect(useToday.getState().kinds.get(3)).toBe("history");
    expect(useToday.getState().counted).toBe(1);
    expect(historyThrough(rows)).toEqual({ at: 800, src: 0, id: 30 });
    // the next page's lines the list took join the history
    publishHistory([line(4, 600)]);
    expect(useToday.getState().history.get(4)?.key).toEqual({ at: 600, src: 0, id: 40 });
    expect(useToday.getState().kinds.get(4)).toBe("history");
    expect(historyThrough([...rows, thread(4)])).toEqual({ at: 600, src: 0, id: 40 });
  });

  it("Codex code review: an answer's maps change nothing until the list publishes them with its rows", () => {
    flattenToday({ now: 0, held: [], digest: null, sections: [{ kind: "today", items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }] }, []);
    const answer = todayAnswer({ now: 0, held: [], digest: null, sections: [], history: { items: [line(1, 900)], next: null } }, []);
    expect(answer.items.map((r) => r.id)).toEqual([1]);
    // dropped (a newer answer came): the open row is still the open part's
    expect(useToday.getState().history.has(1)).toBe(false);
    expect(useToday.getState().kinds.get(1)).toBe("today");
    answer.publish();
    expect(useToday.getState().kinds.get(1)).toBe("history");
  });

  it("without a history (the list look), no history group and nothing to page", () => {
    const rows = flattenToday({ now: 0, held: [], digest: null, sections: [{ kind: "today", items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }] }, []);
    expect(groups()).toEqual([["today", 0]]);
    expect(useToday.getState().history.size).toBe(0);
    expect(historyThrough(rows)).toBeNull();
  });
});

