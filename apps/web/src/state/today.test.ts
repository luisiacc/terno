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

describe("a waiting row says why it needs you (plan 161)", () => {
  const thread = (id: number) => ({ id, snippet: "the snippet", fromName: "Ana" }) as never;
  it("leads with needsYou's reason, then the summary or the snippet", () => {
    const list: TodayList = {
      now: 0,
      held: [],
      digest: null,
      sections: [{ kind: "needsYou", more: 3, items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }, { thread: thread(2), why: { kind: "waiting", wrote: false }, summary: "A summary." }] }],
    };
    const rows = flattenToday(list, []);
    // pass 2: the reason is a label of its own, ahead of the words, not their first words
    expect(rows.map((r) => r.snippet)).toEqual(["the snippet", "A summary."]);
    expect([...useToday.getState().reasons]).toEqual([[1, "Your turn"], [2, "Unanswered"]]);
    expect(useToday.getState().needsShown).toBe(2);
  });
});

describe("plan 161, pass 2: the digest first", () => {
  const thread = (id: number) => ({ id, snippet: "s", fromName: "Ana" }) as never;
  const digest = { day: "2026-10-22", state: "ready" as const, automated: false, items: [], liveIds: [1, 2], readIds: [] };
  it("its row leads the list, and Needs you's heading is on the first conversation; a held row never goes above it", () => {
    const list: TodayList = { now: 0, held: [thread(9)], digest, sections: [{ kind: "needsYou", more: 0, items: [{ thread: thread(1), why: { kind: "waiting", wrote: true } }] }] };
    const rows = flattenToday(list, [thread(9)]);
    expect(rows.map((r) => r.id)).toEqual([DIGEST_ROW_ID, 9, 1]);
    // plan 162 (after ai162-r01): the digest is a section of its own, Newsletters, over its row; Needs you heads the people
    expect(useToday.getState().groups.map((g) => [g.kind, g.at])).toEqual([["newsletters", 0], ["needsYou", 1]]);
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
