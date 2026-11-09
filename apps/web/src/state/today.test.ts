// @vitest-environment jsdom
import { DIGEST_ROW_ID, type TodayList } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));

const { digestPick, flattenToday, installToday, keepDigestPick, useToday } = await import("./today");
installToday();
const { setApp } = await import("./app");

const ai = { provider: "ollama", model: "m", local: true, needsKey: false, tasks: {}, keys: {} };

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
          more: 3,
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
    expect(useToday.getState().needsShown).toBe(4);
    expect(useToday.getState().more).toBe(3);
  });

  it("a held row stays at its place, above Reminders' heading", () => {
    const list = (items: ReturnType<typeof waiting>[], held: never[] = []): TodayList => ({ now: 0, held, digest: null, sections: [{ kind: "needsYou", more: 0, items }, { kind: "reminders", items: [{ thread: thread(7), why: { kind: "reminder" } }] }] });
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
  it("plan 162 (after ai162-r02): isn't a row: the list starts with Needs you, and the digest is the header's", () => {
    const list: TodayList = { now: 0, held: [thread(9)], digest, sections: [{ kind: "needsYou", more: 0, items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }] };
    const rows = flattenToday(list, [thread(9)]);
    expect(rows.map((r) => r.id)).toEqual([9, 1]);
    expect(rows.some((r) => r.id === DIGEST_ROW_ID)).toBe(false);
    expect(useToday.getState().groups.map((g) => [g.kind, g.at])).toEqual([["needsYou", 0]]);
    expect(useToday.getState().digest).toBe(digest);
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
