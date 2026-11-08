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
    expect(rows.map((r) => r.snippet)).toEqual(["Your turn · the snippet", "New from a contact · A summary."]);
    expect(useToday.getState().needsShown).toBe(2);
  });
});
