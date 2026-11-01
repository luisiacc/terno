import { describe, expect, it } from "vitest";
import { mergedBehind, ThreadMerges } from "./thread-merges";

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

  it("names the threads merged into since a sequence, and whether a count passed one (Codex code review round 19 #2)", () => {
    const m = new ThreadMerges();
    expect(m.into(0)).toEqual([]);
    m.record(5, 2);
    const since = m.current;
    m.record(9, 4);
    m.record(8, 4);
    expect(m.into(since)!.sort()).toEqual([4]);
    expect(m.into(0)!.sort()).toEqual([2, 4]);
    const places = [{ mailbox: "Label_x" }, { mailbox: "Work", uidvalidity: 7 }, { mailbox: "Label_w" }];
    const of = (t: number) => (t === 4 ? ["Label_w"] : t === 2 ? ["Label_x"] : []);
    // in the folder being read: only at or below where it reached
    expect(mergedBehind({ key: 2, places: false, after: [3] }, [4], places, of)).toBe(false);
    expect(mergedBehind({ key: 2, places: false, after: [4, 1, 1] }, [4], places, of)).toBe(true);
    expect(mergedBehind({ key: 2, places: true, after: [] }, [4], places, of)).toBe(false);
    // in an earlier folder: passed
    expect(mergedBehind({ key: 2, places: true, after: [] }, [2], places, of)).toBe(true);
    // a log that overflowed: start over
    expect(mergedBehind({ key: 0, places: true, after: [] }, null, places, of)).toBe(true);
    for (let i = 0; i < 5000; i++) m.record(100_000 + i, 50_000 + i);
    expect(m.into(0)).toBeNull();
  });
});
