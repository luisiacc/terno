// @vitest-environment jsdom
import type { FollowupRow } from "@terno/core";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: async () => ({ ok: true }), on: () => () => {}, connectionVersion: 1 } }));
vi.mock("~/lib/open-dwell", () => ({ onExplicitOpen: () => {}, noteExplicitOpen: () => {} }));

const { applyFollowups, countsLate } = await import("./followups");
const { useFollowups } = await import("~/state/followups");
const { followupsOfKey } = await import("~/state/list");

const row = (o: Partial<FollowupRow>): FollowupRow => ({ id: 1, threadId: 7, kind: "promise", state: "due", inboxState: "seen", dated: true, dueDay: "2026-11-20", firm: true, arrivedHint: null, ...o }) as FollowupRow;

describe("plan 285: what the sidebar counts is what Follow-ups dots", () => {
  it("a due promise or wait counts; a pending one doesn't", () => {
    expect(countsLate(row({ kind: "promise" }))).toBe(true);
    expect(countsLate(row({ kind: "awaiting" }))).toBe(true);
    expect(countsLate(row({ state: "open" as FollowupRow["state"] }))).toBe(false);
  });

  it("a promise of theirs counts only once it's late for certain (plan 280)", () => {
    expect(countsLate(row({ kind: "theirs" }))).toBe(true);
    expect(countsLate(row({ kind: "theirs", firm: false }))).toBe(false);
    expect(countsLate(row({ kind: "theirs", dated: false, dueDay: null }))).toBe(false);
    expect(countsLate(row({ kind: "theirs", arrivedHint: 1 as never }))).toBe(false);
  });

  it("one thread a dot, whichever of its rows counts, and the number is the dots", () => {
    applyFollowups({
      rows: [
        // its most urgent row is quiet (a notice may have brought it); another one of its rows is late
        row({ id: 1, threadId: 7, kind: "theirs", arrivedHint: 1 as never }),
        row({ id: 2, threadId: 7, kind: "promise" }),
        row({ id: 3, threadId: 8, kind: "promise" }),
        row({ id: 4, threadId: 8, kind: "awaiting" }),
        row({ id: 5, threadId: 9, kind: "theirs", firm: false }),
      ],
    } as never);
    const { late, due } = useFollowups.getState();
    expect([...late].sort()).toEqual([7, 8]);
    expect(due).toBe(2);
  });

  it("the list's own key says it's Follow-ups, never a search for the word", () => {
    expect(followupsOfKey(JSON.stringify(["all", null, null, null, null, "followups", ""]))).toBe(true);
    expect(followupsOfKey(JSON.stringify(["inbox", null, null, null, null, "followups"]))).toBe(false);
    // (the Codex code review: an IMAP folder named so, in the flag's place)
    expect(followupsOfKey(JSON.stringify(["all", 3, null, null, null, "followups", ""]))).toBe(false);
    expect(followupsOfKey(JSON.stringify(["inbox", null, null, null, null, ""]))).toBe(false);
    expect(followupsOfKey("")).toBe(false);
  });
});
