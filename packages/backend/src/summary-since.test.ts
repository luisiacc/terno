import type { SummarySourceMessage } from "@terno/store";
import { describe, expect, it } from "vitest";
import { sinceBoundary, storedSince } from "./summary-since";

const FLOOR = 1_000;
let next = 1;
/** one message as summaries see it: someone else's, read, unmarked, unless told */
const m = (over: Partial<SummarySourceMessage> = {}): SummarySourceMessage => ({
  id: next++,
  fromName: "Ana",
  fromEmail: "ana@books.test",
  date: next,
  snippet: "",
  subject: "s",
  own: false,
  read: true,
  to: [],
  cc: [],
  list: false,
  person: null,
  trash: false,
  spam: false,
  bodyState: "full",
  bodyUnavailable: false,
  code: null,
  markedAt: null,
  ...over,
});
const at = (o: { snapshot?: number | null; stored?: { from: number; through: number } | null } = {}) => ({ floor: FLOOR, snapshot: o.snapshot ?? null, stored: o.stored ?? null });

describe("plan 279: where what's new starts", () => {
  it("the last run of unread mail after what was read, its first message included", () => {
    const list = [m(), m(), m({ read: false }), m({ read: false })];
    expect(sinceBoundary(list, at())).toBe(list[2]!.id);
    // one new message is enough
    const one = [m(), m({ read: false })];
    expect(sinceBoundary(one, at())).toBe(one[1]!.id);
  });

  it("nothing read before it, or nothing new: no since", () => {
    expect(sinceBoundary([m({ read: false }), m({ read: false })], at())).toBeNull();
    expect(sinceBoundary([m(), m()], at())).toBeNull();
    expect(sinceBoundary([], at())).toBeNull();
  });

  it("a stray old unread message, or a read message after it, doesn't make the whole conversation new", () => {
    const hole = [m(), m({ read: false }), m(), m({ read: false })];
    expect(sinceBoundary(hole, at())).toBe(hole[3]!.id);
  });

  it("a reply of the reader's ends what was read: the new part never starts before it, and it's never the start", () => {
    const list = [m(), m({ read: false }), m({ own: true, read: true }), m({ read: false })];
    expect(sinceBoundary(list, at())).toBe(list[3]!.id);
    // the reader's own message last: nothing new to them
    expect(sinceBoundary([m(), m({ read: false }), m({ own: true, read: false })], at())).toBeNull();
  });

  it("a fresh mark counts though the dwell has read it; an expired one, or a code's, doesn't", () => {
    const fresh = [m(), m({ markedAt: FLOOR })];
    expect(sinceBoundary(fresh, at())).toBe(fresh[1]!.id);
    expect(sinceBoundary([m(), m({ markedAt: FLOOR - 1 })], at())).toBeNull();
    expect(sinceBoundary([m(), m({ markedAt: FLOOR, code: "123456" })], at())).toBeNull();
  });

  it("by hand, what the reader saw unread in this showing; one not in the conversation is ignored", () => {
    const list = [m(), m(), m()];
    expect(sinceBoundary(list, at({ snapshot: list[1]!.id }))).toBe(list[1]!.id);
    expect(sinceBoundary(list, at({ snapshot: 999_999 }))).toBeNull();
    expect(sinceBoundary(list, at({ snapshot: list[0]!.id }))).toBeNull();
  });

  it("trash and spam are not in the conversation", () => {
    const list = [m(), m({ read: false }), m({ trash: true, read: true })];
    expect(sinceBoundary(list, at())).toBe(list[1]!.id);
    expect(sinceBoundary([m({ spam: true }), m({ read: false })], at())).toBeNull();
  });

  it("nothing newer: a since already stored stays, unless the reader wrote after it or it's gone", () => {
    const list = [m(), m(), m()];
    const kept = { from: list[1]!.id, through: list[2]!.id };
    expect(sinceBoundary(list, at({ stored: kept }))).toBe(list[1]!.id);
    expect(sinceBoundary(list, at({ stored: { from: list[0]!.id, through: list[2]!.id } }))).toBeNull();
    expect(sinceBoundary([...list, m({ own: true })], at({ stored: kept }))).toBeNull();
    expect(sinceBoundary(list, at({ stored: { from: 999_999, through: 999_999 } }))).toBeNull();
    // newer mail replaces it
    const newer = [...list, m({ read: false })];
    expect(sinceBoundary(newer, at({ stored: kept }))).toBe(newer[3]!.id);
  });

  it("mail after what it read, read elsewhere and unmarked, isn't folded into an old since (Codex code review 1)", () => {
    const list = [m(), m(), m()];
    expect(sinceBoundary([...list, m()], at({ stored: { from: list[1]!.id, through: list[2]!.id } }))).toBeNull();
  });

  it("reads a stored result's since, and nothing from one without", () => {
    expect(storedSince(JSON.stringify({ summary: "s", items: [], since: { from: 7, through: 9, text: "" } }))).toEqual({ from: 7, through: 9 });
    expect(storedSince(JSON.stringify({ summary: "s", items: [], since: { from: 7, text: "t" } }))).toBeNull();
    expect(storedSince(JSON.stringify({ summary: "s", items: [] }))).toBeNull();
    expect(storedSince("{")).toBeNull();
    expect(storedSince(null)).toBeNull();
  });
});
