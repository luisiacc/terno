import { describe, expect, it } from "vitest";
import { ThreadMerges } from "./thread-merges";

describe("ThreadMerges (plan 107, Codex code review round 17 #1)", () => {
  it("sends a walk back only for messages moved behind it, followed through later merges", () => {
    const m = new ThreadMerges();
    const since = m.current;
    expect(m.rewind(since, 10)).toBeNull();
    // both ahead, both behind: nothing missed
    m.record(30, 20);
    m.record(8, 5);
    expect(m.rewind(since, 10)).toBeNull();
    // ahead into behind
    m.record(12, 7);
    expect(m.rewind(since, 10)).toBe(7);
    // that thread then merged lower still: its messages are there now
    m.record(7, 3);
    expect(m.rewind(since, 10)).toBe(3);
    // the walk's own thread (read part of the way) into one behind
    const later = m.current;
    m.record(10, 9);
    expect(m.rewind(later, 10)).toBe(9);
    expect(m.rewind(m.current, 10)).toBeNull();
  });

  it("starts over when more merges came than it keeps", () => {
    const m = new ThreadMerges();
    for (let i = 0; i < 5000; i++) m.record(100_000 + i, 50_000 + i);
    expect(m.rewind(0, 10)).toBe(1);
    expect(m.rewind(m.current - 1, 100_000)).toBe(54_999);
    expect(m.rewind(m.current - 1, 10)).toBeNull();
  });
});
