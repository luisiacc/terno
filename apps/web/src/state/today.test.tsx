// @vitest-environment jsdom
import { dayKeyOf, DIGEST_ROW_ID, type TodayList } from "@terno/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));

const { digestPick, flattenToday, heldRows, historyThrough, installToday, keepDigestPick, publishHistory, todayAnswer, useFeedRow, useToday } = await import("./today");
installToday();
const { getApp, setApp } = await import("./app");
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

const ids = (rows: readonly { id: number }[]) => rows.map((r) => r.id);
/** the feed's rows: [row id, conversation, heading] */
const feed = () => useToday.getState().rows.map((r) => [r.id, r.threadId, r.group ?? null]);
const NO_COUNTS = { missed: 0, today: 0, waiting: 0, overdue: 0 };

describe("plan 210 (iteration 2): a row per item", () => {
  const thread = (id: number) => ({ id, snippet: `snippet ${id}`, fromName: "Ana" }) as never;
  const waiting = (id: number, wrote: boolean, summary?: string) => ({ id: `waiting:${id}`, thread: thread(id), why: { kind: "waiting" as const, wrote }, ...(summary ? { summary } : {}) });
  beforeEach(() => {
    setApp({ selectedId: null, checked: new Set() });
    useFeedRow.setState({ opened: null, cursor: null });
    useToday.setState({ rows: [] });
  });

  it("two items of one conversation are two rows, by their own ids; the list keeps the conversation once", () => {
    const list: TodayList = {
      now: 0,
      digest: null,
      counts: { missed: 0, today: 0, waiting: 3, overdue: 0 },
      sections: [
        {
          kind: "today",
          items: [
            { id: "promise:31", thread: thread(5), why: { kind: "promise", text: "send the contract", promise: { id: 31, revision: 0 } } },
            { id: "promise:32", thread: thread(5), why: { kind: "promise", text: "send the deck", promise: { id: 32, revision: 0 } } },
            waiting(1, false, "A summary."),
            { id: "reminder:7", thread: thread(7), why: { kind: "reminder" } },
          ],
        },
      ],
    };
    expect(ids(flattenToday(list, []))).toEqual([5, 1, 7]);
    expect(feed()).toEqual([["promise:31", 5, "today"], ["promise:32", 5, "today"], ["waiting:1", 1, "today"], ["reminder:7", 7, "today"]]);
    // each its own task: what its D, Done and Later act on
    expect(useToday.getState().rows.map((r) => (r.task?.kind === "promise" ? r.task.id : null))).toEqual([31, 32, null, null]);
    // the header's numbers are the backend's projection's
    expect(useToday.getState().counts).toEqual({ missed: 0, today: 0, waiting: 3, overdue: 0 });
  });

  it("a held row (the open one, by its id) stays at its place, its sibling of the same conversation leaving as it may; words only", () => {
    const list = (items: TodayList["sections"][number]["items"]): TodayList => ({ now: 0, digest: null, counts: NO_COUNTS, sections: [{ kind: "today", items: [...items, { id: "reminder:7", thread: thread(7), why: { kind: "reminder" } }] }] });
    const a = { id: "dated:10", thread: thread(1), why: { kind: "dated" as const, text: "Pay the rent", item: { id: 10, revision: 0, kind: "pay" as const, dueDay: "2026-11-12", timed: false, dated: true } } };
    const b = { ...a, id: "dated:11", why: { ...a.why, text: "Sign the lease", item: { ...a.why.item, id: 11 } } };
    const before = flattenToday(list([a, b]), []);
    // the second row of conversation 1 is open; both leave the backend's answer (settled by mail)
    useFeedRow.setState({ opened: "dated:11" });
    setApp({ selectedId: 1 });
    expect(heldRows()).toEqual(["dated:11"]);
    flattenToday(list([]), before);
    expect(feed()).toEqual([["dated:11", 1, "today"], ["reminder:7", 7, "today"]]);
    const held = useToday.getState().rows[0]!;
    expect(held).toMatchObject({ held: true, entry: { why: { text: "Sign the lease" } } });
    expect(held.task).toBeUndefined();
    // let go of, it goes
    setApp({ selectedId: null });
    flattenToday(list([]), before);
    expect(feed()).toEqual([["reminder:7", 7, "today"]]);
  });

  it("the open row follows the app's conversation: another opened by other means opens its first row; a sibling stays", () => {
    flattenToday({ now: 0, digest: null, counts: NO_COUNTS, sections: [{ kind: "today", items: [waiting(1, true), { id: "dated:20", thread: thread(2), why: { kind: "dated", text: "A" } }, { id: "dated:21", thread: thread(2), why: { kind: "dated", text: "B" } }] }] }, []);
    useFeedRow.setState({ opened: "dated:21" });
    setApp({ selectedId: 2 });
    expect(useFeedRow.getState().opened).toBe("dated:21");
    setApp({ selectedId: 1 });
    expect(useFeedRow.getState().opened).toBe("waiting:1");
    setApp({ selectedId: null });
    expect(useFeedRow.getState().opened).toBeNull();
  });
});

describe("plan 161, pass 2: the digest's way in", () => {
  const thread = (id: number) => ({ id, snippet: "s", fromName: "Ana" }) as never;
  const digest = { day: "2026-10-22", state: "ready" as const, automated: false, items: [], liveIds: [1, 2], readIds: [] };
  it("plan 204 (after the panel, revision 10): the open part's last row again, under no heading, no task; none without a digest", () => {
    const list: TodayList = { now: 0, counts: NO_COUNTS, digest, sections: [{ kind: "today", items: [{ id: "waiting:1", thread: thread(1), why: { kind: "waiting", wrote: true } }] }] };
    const rows = flattenToday(list, []);
    expect(rows.map((r) => r.id)).toEqual([1, DIGEST_ROW_ID]);
    expect(feed()).toEqual([["waiting:1", 1, "today"], ["digest", DIGEST_ROW_ID, null]]);
    expect(useToday.getState().digest).toBe(digest);
    expect(useToday.getState().rows.at(-1)!.task).toBeUndefined();
    expect(flattenToday({ ...list, digest: null }, rows).map((r) => r.id)).toEqual([1]);
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

describe("plan 204: Missed, Today, a day ahead and Coming up (plan 210: by day, a row per item)", () => {
  const thread = (id: number) => ({ id, snippet: `snippet ${id}`, fromName: "Ana" }) as never;
  // Thursday 12 November 2026, 10:00, local
  const now = new Date(2026, 10, 12, 10, 0).getTime();
  const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;
  const at = (d: number, h = 9, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const dated = (id: number, kind: "pay" | "renew" | "alert" | "event" | "delivery" | "respond", text: string, d: number, o: { timed?: boolean; h?: number; m?: number; missed?: boolean; undated?: boolean; thread?: number } = {}) => ({
    id: `dated:${id * 10}`,
    thread: thread(o.thread ?? id),
    why: { kind: "dated" as const, text, dueAt: at(d, o.h, o.m), ...(o.missed ? { missed: true } : {}), item: { id: id * 10, revision: 1, kind, dueDay: day(d), timed: o.timed === true, dated: o.undated !== true } },
  });
  type Row = ReturnType<typeof dated> | { id: string; thread: never; why: never };
  const dayOf = (r: Row): string => (r.why as { item?: { dueDay: string } }).item?.dueDay ?? dayKeyOf((r.why as { dueAt: number }).dueAt);
  const byDay = (kind: "day" | "comingUp", rows: readonly Row[] = []) => [...new Set(rows.map(dayOf))].sort().map((d) => ({ kind, day: d, items: rows.filter((r) => dayOf(r) === d) as never }));
  const list = (over: Partial<Record<"missed" | "today" | "day" | "comingUp", Row[]>>): TodayList => ({
    now,
    counts: NO_COUNTS,
    digest: null,
    sections: [{ kind: "missed", items: (over.missed ?? []) as never }, { kind: "today", items: (over.today ?? []) as never }, ...byDay("day", over.day), ...byDay("comingUp", over.comingUp)],
  });
  const taskOfThread = (id: number) => useToday.getState().rows.find((r) => r.threadId === id)?.task;
  const groups = () => useToday.getState().rows.map((r) => r.group ?? null);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    setApp({ selectedId: null, checked: new Set() });
    useFeedRow.setState({ opened: null, cursor: null });
    useToday.setState({ comingUpOpen: false, rows: [] });
  });
  afterEach(() => vi.useRealTimers());

  const full = () =>
    list({
      missed: [dated(1, "renew", "Renew the domain", 10, { missed: true }), { id: "promise:2", thread: thread(2), why: { kind: "promise", text: "send the contract", dueAt: at(11), missed: true } } as never],
      today: [dated(4, "pay", "Pay the rent", 12), dated(5, "alert", "Your card was declined", 12, { undated: true }), dated(7, "delivery", "Your parcel arrives", 12), { id: "waiting:8", thread: thread(8), why: { kind: "waiting", wrote: true } } as never, { id: "reminder:9", thread: thread(9), why: { kind: "reminder" } } as never],
      day: [dated(6, "event", "Flight to Madrid", 13, { timed: true, h: 7, m: 40 }), dated(3, "pay", "Pay the electricity bill", 13)],
      comingUp: [dated(10, "renew", "Renew the passport", 20)],
    });

  it("every group in core's order, a heading each, all their rows (no cap); Coming up closed, but counted for its toggle", () => {
    const many = list({ today: Array.from({ length: 30 }, (_, i) => ({ id: `waiting:${100 + i}`, thread: thread(100 + i), why: { kind: "waiting", wrote: true } })) as never });
    expect(flattenToday(many, []).length).toBe(30);
    const rows = flattenToday(full(), []);
    expect(ids(rows)).toEqual([1, 2, 4, 5, 7, 8, 9, 6, 3]);
    expect(groups()).toEqual(["missed", "missed", "today", "today", "today", "today", "today", "day:2026-11-13", "day:2026-11-13"]);
    expect(useToday.getState().comingUp).toBe(1);
    // the menu's Done knows each row's task; a promise with no reference (an older backend) and a waiting row have none
    expect(taskOfThread(3)).toMatchObject({ kind: "dated", item: { id: 30, revision: 1, kind: "pay" } });
    expect(taskOfThread(2)).toBeUndefined();
    expect(taskOfThread(8)).toBeUndefined();
  });

  it("plan 210 (iteration 3): Today's Waiting on you is a heading of its own after Today's, before the days; its rows keep their ids", () => {
    const today = { kind: "today" as const, items: [dated(4, "pay", "Pay the rent", 12)] as never };
    const waiting = { kind: "today" as const, part: "waiting" as const, items: [{ id: "waiting:8", thread: thread(8), why: { kind: "waiting", wrote: true } }] as never };
    flattenToday({ now, counts: { missed: 0, today: 1, waiting: 1, overdue: 0 }, digest: null, sections: [today, waiting, ...byDay("day", [dated(3, "pay", "Pay the electricity bill", 13)])] }, []);
    expect(useToday.getState().rows.map((r) => [r.id, r.group])).toEqual([
      ["dated:40", "today"],
      ["waiting:8", "waiting"],
      ["dated:30", "day:2026-11-13"],
    ]);
    expect(useToday.getState().counts).toEqual({ missed: 0, today: 1, waiting: 1, overdue: 0 });
  });

  it("each kind's day in words for a screen reader; a timed item keeps its time in Missed", () => {
    flattenToday(full(), []);
    const due = (id: number) => taskOfThread(id)?.due;
    expect(due(1)).toBe("Was due Tuesday");
    expect(due(3)).toBe("Due tomorrow");
    expect(due(4)).toBe("Due today");
    expect(due(6)).toBe("Tomorrow 7:40 AM");
    expect(due(7)).toBe("Today");
    expect(due(5)).toBeNull();
    flattenToday(list({ missed: [dated(1, "pay", "Wire payroll", 11, { missed: true, timed: true, h: 13 })] }), []);
    expect(taskOfThread(1)).toMatchObject({ when: "Yesterday", due: "Was due yesterday 1:00 PM" });
  });

  it("each row's task, what D, Done, Remove and Later act on; a promise row acts on the promise it shows, exactly", () => {
    flattenToday(full(), []);
    expect(taskOfThread(1)).toMatchObject({ kind: "dated", when: "Tue" });
    expect(laterWindow(taskOfThread(1)!)).toEqual({ before: null, limit: null });
    expect(taskOfThread(5)).toMatchObject({ when: null, noDay: true });
    expect(laterWindow(taskOfThread(6)!)).toEqual({ before: at(13, 7, 40), limit: "starts" });
    flattenToday(list({ today: [{ id: "promise:31", thread: thread(3), why: { kind: "promise", text: "send the agenda", dueAt: at(12, 18), promise: { id: 31, revision: 2, dated: true } } } as never] }), []);
    expect(taskOfThread(3)).toEqual({ kind: "promise", id: 31, revision: 2, when: "Today", due: "Due today", dated: true, text: "send the agenda", dueAt: at(12, 18), timed: false });
  });

  it("a related detail (a return leg) is said on its row's second line; nothing else is", () => {
    const back = { kind: "event" as const, text: "Return flight to Madrid", dueDay: day(17), dueAt: at(17, 9), timed: true, dated: true };
    flattenToday(list({ today: [dated(4, "pay", "Pay the rent", 12)], day: [{ ...dated(3, "event", "Flight to Austin", 13, { timed: true }), also: [back] } as never] }), []);
    expect(taskOfThread(3)).toMatchObject({ also: "Also Tue 9:00 AM · Return flight to Madrid" });
    expect(taskOfThread(4)).not.toHaveProperty("also");
  });

  it("plan 210 (iteration 4): a reply's row says its other promises, a line each, and its task names them for Done, Remove and Later", () => {
    const green = { kind: "promise" as const, text: "calibrate the green with the printer's profile", dueDay: day(12), dueAt: at(12, 9), timed: false, dated: false };
    const call = { kind: "promise" as const, text: "call Marcus", dueDay: day(13), dueAt: at(13, 16), timed: true, dated: true };
    const why = { kind: "promise", text: "send Valeria the three changes", dueAt: at(12, 18), promise: { id: 31, revision: 2, dated: true }, with: [{ source: "promise", id: 32, revision: 0 }, { source: "promise", id: 33, revision: 1 }] };
    flattenToday(list({ today: [{ id: "promise:31", thread: thread(3), why, also: [green, call] } as never] }), []);
    expect(taskOfThread(3)).toMatchObject({ kind: "promise", id: 31, with: why.with, also: "Also: You said: calibrate the green with the printer's profile · Also tomorrow 4:00 PM · You said: call Marcus" });
  });

  it("plan 210 (iteration 4, revision 9): Coming up's rows only while it's open, quiet, in buckets of their own after every day and the digest, never joining a day above", () => {
    useToday.setState({ comingUpOpen: true });
    flattenToday(full(), []);
    expect(useToday.getState().rows.at(-1)).toMatchObject({ id: "dated:100", group: "coming:2026-11-20", ahead: true });
    const parcel = dated(11, "delivery", "Your parcel arrives", 13, { timed: true, h: 8 });
    const digest = { day: day(12), state: "ready" as const, items: [], automated: true, liveIds: [] };
    const sections: TodayList = {
      now,
      counts: NO_COUNTS,
      digest,
      sections: [
        { kind: "today", items: [dated(4, "pay", "Pay the rent", 12)] as never },
        { kind: "day", day: day(13), items: [dated(6, "event", "Flight to Madrid", 13, { timed: true, h: 9 }), dated(3, "pay", "Pay the electricity bill", 13)] as never },
        // put off to a day that already has rows: its own bucket all the same
        { kind: "comingUp", day: day(13), bucket: day(13), items: [parcel] as never },
      ],
    };
    flattenToday(sections, []);
    expect(useToday.getState().rows.map((r) => [r.id, r.group ?? null])).toEqual([
      ["dated:40", "today"],
      ["dated:60", "day:2026-11-13"],
      ["dated:30", "day:2026-11-13"],
      ["digest", null],
      ["dated:110", "coming:2026-11-13"],
    ]);
    // closed: none of its rows (j/k walk only what's drawn), counted for its disclosure
    useToday.setState({ comingUpOpen: false });
    flattenToday(sections, []);
    expect(useToday.getState().rows.map((r) => r.id)).toEqual(["dated:40", "dated:60", "dated:30", "digest"]);
    expect(useToday.getState().comingUp).toBe(1);
  });

  it("plan 210 (iteration 3, revision 9): past two weeks Coming up's rows go under their week's heading, by their days; ids stay", () => {
    useToday.setState({ comingUpOpen: true });
    // Thursday Nov 12: its days run through Sunday the 29th; Dec 2 and Dec 4 are the week of Nov 30's
    const passport = dated(10, "renew", "Renew the passport", 26);
    // (Nov 32 is Dec 2: Date rolls over; the item's day said as December's)
    const dec = (id: number, kind: "pay" | "renew", text: string, d: number) => {
      const r = dated(id, kind, text, 30 + d);
      return { ...r, why: { ...r.why, item: { ...r.why.item, dueDay: `2026-12-0${d}` } } };
    };
    const sooner = dec(13, "pay", "Pay the gym", 2);
    const expiry = dec(14, "renew", "Renew the domain", 3);
    const insurance = dec(12, "pay", "Pay the insurance", 4);
    const sections: TodayList = {
      now,
      counts: NO_COUNTS,
      digest: null,
      sections: [
        // an expiry's long lead shows it already, a day ahead's, under its week too
        { kind: "day", day: "2026-12-03", bucket: "week:2026-11-30", items: [expiry] as never },
        { kind: "comingUp", day: day(26), bucket: day(26), items: [passport] as never },
        { kind: "comingUp", day: "2026-12-02", bucket: "week:2026-11-30", items: [sooner] as never },
        { kind: "comingUp", day: "2026-12-04", bucket: "week:2026-11-30", items: [insurance] as never },
      ],
    };
    flattenToday(sections, []);
    // (iteration 4) Coming up's buckets are its own, after the feed's own week
    expect(useToday.getState().rows.map((r) => [r.id, r.group, r.ahead === true])).toEqual([
      ["dated:140", "week:2026-11-30", false],
      ["dated:100", "coming:2026-11-26", true],
      ["dated:130", "coming:week:2026-11-30", true],
      ["dated:120", "coming:week:2026-11-30", true],
    ]);
    // closed: only what's shown, the expiry under its week
    useToday.setState({ comingUpOpen: false });
    flattenToday(sections, []);
    expect(useToday.getState().rows.map((r) => [r.id, r.group])).toEqual([["dated:140", "week:2026-11-30"]]);
    expect(useToday.getState().comingUp).toBe(3);
  });

  it("plan 210 (iteration 4): closing Coming up on one of its rows puts the feed on the last row above it, that row's conversation put away", async () => {
    const { setComingUpOpen } = await import("./today");
    useToday.setState({ comingUpOpen: true });
    flattenToday(full(), []);
    // open beside the feed
    useFeedRow.setState({ opened: "dated:100", cursor: null });
    setApp({ selectedId: 10 });
    setComingUpOpen(false);
    expect(useFeedRow.getState()).toMatchObject({ opened: null, cursor: "dated:30" });
    expect(getApp().selectedId).toBeNull();
    // put away there (the cursor on it): the same row above, nothing to close
    useToday.setState({ comingUpOpen: true });
    flattenToday(full(), []);
    setApp({ selectedId: null });
    useFeedRow.setState({ opened: null, cursor: "dated:100" });
    setComingUpOpen(false);
    expect(useFeedRow.getState()).toMatchObject({ opened: null, cursor: "dated:30" });
    // on a row of the open part: nothing moves
    useToday.setState({ comingUpOpen: true });
    flattenToday(full(), []);
    useFeedRow.setState({ opened: "dated:40", cursor: null });
    setApp({ selectedId: 4 });
    setComingUpOpen(false);
    expect(useFeedRow.getState()).toMatchObject({ opened: "dated:40", cursor: null });
    expect(getApp().selectedId).toBe(4);
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
  const line = (id: number, at: number, thread_ = id) => ({ id: `dated:${id * 10}`, item: { source: "dated" as const, id: id * 10 }, thread: thread(thread_), key: { at, src: 0 as const, id: id * 10 }, outcome: "done" as const, kind: "pay" as const, text: "Pay the bill" });
  beforeEach(() => {
    setApp({ selectedId: null, checked: new Set() });
    useToday.setState({ rows: [] });
  });

  it("the history's first page after the digest, under its own heading, a line per item (one of a conversation still open is a line too); a page appended joins it once; the deepest line is what a reload asks down to", () => {
    const list: TodayList = {
      now: 0,
      counts: NO_COUNTS,
      digest: { day: "2026-11-13", state: "ready", items: [], automated: true, liveIds: [], errorKind: null },
      sections: [{ kind: "today", items: [{ id: "waiting:1", thread: thread(1), why: { kind: "waiting", wrote: true } }] }],
      history: { items: [line(2, 900), line(3, 800), line(4, 700, 1)], next: { at: 700, src: 0, id: 40 } },
    };
    const rows = flattenToday(list, []);
    expect(ids(rows)).toEqual([1, DIGEST_ROW_ID, 2, 3]);
    expect(feed()).toEqual([["waiting:1", 1, "today"], ["digest", DIGEST_ROW_ID, null], ["dated:20", 2, "history"], ["dated:30", 3, "history"], ["dated:40", 1, "history"]]);
    expect(historyThrough()).toEqual({ at: 700, src: 0, id: 40 });
    publishHistory([line(5, 600), line(3, 800)]);
    expect(feed().filter(([, , g]) => g === "history").map(([id]) => id)).toEqual(["dated:20", "dated:30", "dated:40", "dated:50"]);
    expect(historyThrough()).toEqual({ at: 600, src: 0, id: 50 });
  });

  it("Codex code review: an answer's rows change nothing until the list publishes them with its conversations", () => {
    flattenToday({ now: 0, counts: NO_COUNTS, digest: null, sections: [{ kind: "today", items: [{ id: "waiting:1", thread: thread(1), why: { kind: "waiting", wrote: true } }] }] }, []);
    const answer = todayAnswer({ now: 0, counts: NO_COUNTS, digest: null, sections: [], history: { items: [line(1, 900)], next: null } }, []);
    expect(ids(answer.items)).toEqual([1]);
    expect(feed()).toEqual([["waiting:1", 1, "today"]]);
    answer.publish();
    expect(feed()).toEqual([["dated:10", 1, "history"]]);
  });

  it("without a history, nothing to page", () => {
    flattenToday({ now: 0, counts: NO_COUNTS, digest: null, sections: [{ kind: "today", items: [{ id: "waiting:1", thread: thread(1), why: { kind: "waiting", wrote: true } }] }] }, []);
    expect(historyThrough()).toBeNull();
  });
});

describe("plan 210 (iteration 2, Codex code review): whose task the menu's and the palette's Done are", () => {
  it("the right-click menu's, the row it was opened on; the palette's, the open row, whatever menu came before", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useTodayTask } = await import("./today");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const task = (id: number) => ({ kind: "dated" as const, item: { id, revision: 0, kind: "pay" as const, dueDay: "2026-11-12", timed: false, dated: true }, when: null, due: null, dueAt: 0 });
    setApp({ today: true, selectedId: 2 });
    useToday.setState({ rows: [{ id: "dated:10", threadId: 2, task: task(10) }, { id: "dated:11", threadId: 2, task: task(11) }], menuRow: "dated:10" });
    useFeedRow.setState({ opened: "dated:11" });
    const seen: Record<string, string | undefined> = {};
    function Probe() {
      seen.menu = useTodayTask(2, "menu")?.rowId;
      seen.palette = useTodayTask(2, "open")?.rowId;
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    expect(seen).toEqual({ menu: "dated:10", palette: "dated:11" });
    await act(async () => useToday.setState({ menuRow: null }));
    expect(seen).toEqual({ menu: "dated:11", palette: "dated:11" });
    await act(async () => root.unmount());
  });
});
