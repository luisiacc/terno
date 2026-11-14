// @vitest-environment jsdom
import { DIGEST_ROW_ID, type TodayList } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));

const { digestPick, flattenToday, installToday, keepDigestPick, useToday } = await import("./today");
installToday();
const { setApp } = await import("./app");

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

describe("plan 166, after the owner's second look: Needs you is one group", () => {
  const thread = (id: number) => ({ id, snippet: `snippet ${id}`, fromName: "Ana" }) as never;
  const waiting = (id: number, wrote: boolean, summary?: string) => ({ thread: thread(id), why: { kind: "waiting" as const, wrote }, ...(summary ? { summary } : {}) });
  const groups = () => useToday.getState().groups.map((g) => [g.kind, g.at]);

  it("one heading, in the backend's order; the row leads with its own words, a promise's and a nudge's lines stay", () => {
    const list: TodayList = {
      now: 0,
      held: [],
      digest: null,
      sections: [
        {
          kind: "needsYou",
          items: [
            { thread: thread(5), why: { kind: "promise", text: "send the contract" } },
            waiting(1, false, "A summary."),
            waiting(2, true),
            { thread: thread(6), why: { kind: "nudge", personName: "Tom", sentAt: Date.now() - 5 * 86_400_000 } },
          ],
        },
        { kind: "reminders", items: [{ thread: thread(7), why: { kind: "reminder" } }] },
      ],
    };
    const rows = flattenToday(list, []);
    expect(rows.map((r) => r.id)).toEqual([5, 1, 2, 6, 7]);
    expect(groups()).toEqual([["needsYou", 0], ["reminders", 4]]);
    expect(rows.map((r) => r.snippet)).toEqual(["You said: send the contract", "A summary.", "snippet 2", "No reply from Tom in 5 days", "snippet 7"]);
    expect("reasons" in useToday.getState()).toBe(false);
    expect(useToday.getState().counted).toBe(4);
  });

  it("a held row stays at its place, above Reminders' heading", () => {
    const list = (items: ReturnType<typeof waiting>[], held: never[] = []): TodayList => ({ now: 0, held, digest: null, sections: [{ kind: "needsYou", items }, { kind: "reminders", items: [{ thread: thread(7), why: { kind: "reminder" } }] }] });
    const before = flattenToday(list([waiting(1, true), waiting(2, false)]), []);
    expect(groups()).toEqual([["needsYou", 0], ["reminders", 2]]);
    const rows = flattenToday(list([waiting(1, true)], [thread(2)]), before);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 7]);
    expect(groups()).toEqual([["needsYou", 0], ["reminders", 2]]);
  });
});

describe("plan 161, pass 2: the digest's way in", () => {
  const thread = (id: number) => ({ id, snippet: "s", fromName: "Ana" }) as never;
  const digest = { day: "2026-10-22", state: "ready" as const, automated: false, items: [], liveIds: [1, 2], readIds: [] };
  it("plan 204 (after the panel, revision 10): the list's last option again, after held rows, under no heading; none without a digest", () => {
    const list: TodayList = { now: 0, held: [thread(9)], digest, sections: [{ kind: "needsYou", items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }] };
    // the digest's row stays last however the held row was placed (never before a person)
    const rows = flattenToday(list, [thread(9), thread(1), thread(DIGEST_ROW_ID)]);
    expect(rows.map((r) => r.id)).toEqual([9, 1, DIGEST_ROW_ID]);
    expect(useToday.getState().digestAt).toBe(2);
    expect(useToday.getState().groups.map((g) => [g.kind, g.at])).toEqual([["needsYou", 0]]);
    expect(useToday.getState().digest).toBe(digest);
    expect(useToday.getState().tasks.has(DIGEST_ROW_ID)).toBe(false);
    expect(flattenToday({ ...list, digest: null }, rows).map((r) => r.id)).toEqual([9, 1]);
    expect(useToday.getState().digestAt).toBe(-1);
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

describe("plan 162 (after ai162-r05): the digest's row says who the newsletters are from", () => {
  it("the first three still in the Inbox, each once, then how many more; nothing until it's ready or once all are gone", async () => {
    const { digestFrom } = await import("./today");
    const item = (threadId: number, from: string) => ({ threadId, messageId: threadId, lastDate: 0, messageCount: 1, from, subject: "", line: null });
    const digest = { day: "d", state: "ready" as const, automated: false, items: [item(1, "Xataka"), item(2, "Figma"), item(3, "Xataka"), item(4, "Morning Brew"), item(5, "Substack"), item(6, "Gone")], liveIds: [1, 2, 3, 4], readIds: [5] };
    expect(digestFrom(digest as never, "en")).toBe("Xataka, Figma, Morning Brew, and 1 more");
    expect(digestFrom({ ...digest, liveIds: [2], readIds: [] } as never, "en")).toBe("Figma");
    expect(digestFrom({ ...digest, liveIds: [], readIds: [] } as never, "en")).toBeNull();
    expect(digestFrom({ ...digest, state: "pending" } as never, "en")).toBeNull();
  });
});

describe("plan 204: Missed, Deadlines, Plans, Needs you, Reminders and Coming up", () => {
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
  const list = (over: Partial<Record<"missed" | "deadlines" | "plans" | "needsYou" | "reminders" | "comingUp", ReturnType<typeof dated>[] | { thread: never; why: never }[]>>, held: never[] = []): TodayList => ({
    now,
    held,
    digest: null,
    // the backend's order, given scrambled: the list keeps core's
    sections: (["comingUp", "reminders", "needsYou", "plans", "deadlines", "missed"] as const).map((kind) => ({ kind, items: (over[kind] ?? []) as never })),
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
      deadlines: [dated(3, "pay", "Pay the electricity bill", 13), dated(4, "pay", "Pay the rent", 12), dated(5, "alert", "Your card was declined", 12, { undated: true })],
      plans: [dated(6, "event", "Flight to Madrid", 13, { timed: true, h: 7, m: 40 }), dated(7, "delivery", "Your parcel arrives", 12)],
      needsYou: [{ thread: thread(8), why: { kind: "waiting", wrote: true } } as never],
      reminders: [{ thread: thread(9), why: { kind: "reminder" } } as never],
      comingUp: [dated(10, "renew", "Renew the passport", 20)],
    });

  it("every group in core's order, a heading each, all their rows (no cap); Coming up closed, but counted for its toggle", () => {
    const many = list({ needsYou: Array.from({ length: 30 }, (_, i) => ({ thread: thread(100 + i), why: { kind: "waiting", wrote: true } })) as never });
    expect(flattenToday(many, []).length).toBe(30);
    expect(useToday.getState().counted).toBe(30);

    const rows = flattenToday(full(), []);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(groups()).toEqual([["missed", 0], ["deadlines", 2], ["plans", 5], ["needsYou", 7], ["reminders", 8]]);
    expect(useToday.getState().comingUp).toBe(1);
    // Reminders and Coming up aren't counted
    expect(useToday.getState().counted).toBe(8);
    // the menu's Done knows each row's task; a promise with no reference (an older backend) and a waiting row have none
    expect(useToday.getState().tasks.get(3)).toMatchObject({ kind: "dated", item: { id: 30, revision: 1, kind: "pay" } });
    expect(useToday.getState().tasks.has(2)).toBe(false);
    expect(useToday.getState().tasks.has(8)).toBe(false);
  });

  it("each kind's line: the task alone where the date says when, and when in words for a screen reader", () => {
    const rows = flattenToday(full(), []);
    const line = (id: number) => rows.find((r) => r.id === id)!.snippet;
    const due = (id: number) => useToday.getState().tasks.get(id)?.due;
    // after the second panel round: the right column says when, so the line doesn't say it again
    expect([line(1), due(1)]).toEqual(["Renew the domain", "Was due Tuesday"]);
    expect([line(3), due(3)]).toEqual(["Pay the electricity bill", "Due tomorrow"]);
    expect([line(4), due(4)]).toEqual(["Pay the rent", "Due today"]);
    expect([line(6), due(6)]).toEqual(["Flight to Madrid", "Tomorrow 7:40 AM"]);
    expect([line(7), due(7)]).toEqual(["Your parcel arrives", "Today"]);
    // no date in the right column, so the line keeps the whole wording: a missed promise an older backend gave no
    // reference (no task), an alert that named no day
    expect(line(2)).toBe("Was due yesterday · You said: send the contract");
    expect([line(5), due(5)]).toEqual(["Your card was declined", null]);
  });

  it("Codex code review of the fixes: a timed item keeps its time in Missed; a nudge row has a task (follow-ups' act)", () => {
    const rows = flattenToday(
      list({
        missed: [dated(1, "pay", "Wire payroll", 11, { missed: true, timed: true, h: 13 })],
        needsYou: [{ thread: thread(2), why: { kind: "nudge", text: "", personName: "Ana", sentAt: at(5), dueAt: at(10), promise: { id: 41, revision: 1, dated: false } } } as never],
      }),
      [],
    );
    expect(rows.find((r) => r.id === 1)!.snippet).toBe("Wire payroll");
    expect(useToday.getState().tasks.get(1)).toMatchObject({ when: "Yesterday", due: "Was due yesterday 1:00 PM" });
    expect(useToday.getState().tasks.get(2)).toMatchObject({ kind: "promise", id: 41, revision: 1, when: null, due: null });
  });

  it("after the panel: any timed item says its time; a promise of yours says when it's due; Coming up's promise its day", () => {
    const rows = flattenToday(
      list({
        deadlines: [dated(1, "pay", "Wire payroll", 12, { timed: true, h: 13 }), dated(2, "pay", "Pay the rent", 13, { timed: true, h: 9, m: 30 })],
        needsYou: [
          { thread: thread(3), why: { kind: "promise", text: "send the agenda", dueAt: at(12, 18), promise: { id: 31, revision: 2, dated: true } } } as never,
          { thread: thread(4), why: { kind: "promise", text: "call back", dueAt: at(12, 18), promise: { id: 41, revision: 0, dated: false } } } as never,
        ],
        // an older backend's promise in Coming up names no `dated`: there it can only be a dated one
        comingUp: [{ thread: thread(5), why: { kind: "promise", text: "send the deck", dueAt: at(17), promise: { id: 51, revision: 0 } } } as never],
      }),
      [],
    );
    const line = (id: number) => rows.find((r) => r.id === id)?.snippet;
    const due = (id: number) => useToday.getState().tasks.get(id)?.due;
    expect([line(1), due(1)]).toEqual(["Wire payroll", "Due today 1:00 PM"]);
    expect([line(2), due(2)]).toEqual(["Pay the rent", "Due tomorrow 9:30 AM"]);
    expect([line(3), due(3)]).toEqual(["You said: send the agenda", "Due today"]);
    expect([line(4), due(4)]).toEqual(["You said: call back", null]);
    useToday.setState({ comingUpOpen: true });
    expect(flattenToday(list({ comingUp: [{ thread: thread(5), why: { kind: "promise", text: "send the deck", dueAt: at(17), promise: { id: 51, revision: 0 } } } as never] }), [])[0]!.snippet).toBe("You said: send the deck");
    expect(useToday.getState().tasks.get(5)).toMatchObject({ when: "Tue", due: "Due Tuesday" });
  });

  it("after the panel: each row's task, what D, Done, Not a task and Later act on, with its due day for the date's place", () => {
    flattenToday(full(), []);
    const tasks = useToday.getState().tasks;
    // Missed says its day; a deadline tomorrow, "Tomorrow"; an alert that named none, nothing (the received date stays)
    expect(tasks.get(1)).toMatchObject({ kind: "dated", when: "Tue", end: null });
    expect(tasks.get(3)).toMatchObject({ when: "Tomorrow" });
    expect(tasks.get(5)).toMatchObject({ when: null });
    // a Plan: its time tomorrow, and Later only before it ends
    expect(tasks.get(6)).toMatchObject({ when: "Tomorrow", end: at(13, 7, 40) + 2 * 3_600_000 });
    expect(tasks.get(7)).toMatchObject({ kind: "dated", end: new Date(2026, 10, 13).getTime() });
    flattenToday(list({ deadlines: [dated(1, "pay", "Wire payroll", 12, { timed: true, h: 13 })], needsYou: [{ thread: thread(3), why: { kind: "promise", text: "send the agenda", dueAt: at(12, 18), promise: { id: 31, revision: 2, dated: true } } } as never] }), []);
    expect(useToday.getState().tasks.get(1)).toMatchObject({ when: "1:00 PM" });
    // a promise row acts on the promise it shows, exactly
    expect(useToday.getState().tasks.get(3)).toEqual({ kind: "promise", id: 31, revision: 2, when: "Today", due: "Due today" });
  });

  it("further days: a weekday within six, else the date", () => {
    flattenToday(list({ deadlines: [dated(1, "pay", "Pay the water bill", 17)], plans: [dated(2, "event", "Dinner at Lúa", 16)], comingUp: [] }), []);
    const due = (id: number) => useToday.getState().tasks.get(id)?.due;
    expect(due(1)).toBe("Due Tuesday");
    expect(due(2)).toBe("Monday");
    useToday.setState({ comingUpOpen: true });
    flattenToday(full(), []);
    expect(due(10)).toBe("Due Nov 20");
  });

  it("Coming up's rows only while it's open: last, under its own heading", () => {
    useToday.setState({ comingUpOpen: true });
    const rows = flattenToday(full(), []);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(groups().at(-1)).toEqual(["comingUp", 9]);
    expect(useToday.getState().counted).toBe(8);
  });

  it("a held row keeps its group's place in any group; a group it was the last of keeps its heading", () => {
    const before = flattenToday(full(), []);
    // Pay the rent was done while it was open: held where it was, in Deadlines
    const next = full();
    next.sections.find((s) => s.kind === "deadlines")!.items.splice(1, 1);
    next.held = [thread(4)];
    expect(flattenToday(next, before).map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(groups()).toEqual([["missed", 0], ["deadlines", 2], ["plans", 5], ["needsYou", 7], ["reminders", 8]]);
    // Plans' both rows gone, one of them held: Plans' heading stays above it, before Needs you
    const after = flattenToday(full(), []);
    const gone = full();
    gone.sections.find((s) => s.kind === "plans")!.items = [];
    gone.held = [thread(6)];
    expect(flattenToday(gone, after).map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    expect(groups()).toEqual([["missed", 0], ["deadlines", 2], ["plans", 5], ["needsYou", 6], ["reminders", 7]]);
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
