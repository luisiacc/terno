// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { itemLabel, newFirst, offersReply, overdue } = await import("./thread-summary");

describe("plan 279's panel: a row says when it's late, who you wait on, and offers Reply only where replying does it", () => {
  const now = new Date(2026, 10, 25, 9).getTime();
  it("a to-do whose day has passed is Overdue; today's or a later one isn't, nor a question", () => {
    expect(itemLabel({ kind: "action", due: "2026-11-13" }, undefined, [], now)).toBe("Overdue");
    expect(itemLabel({ kind: "action", due: "2026-11-25" }, undefined, [], now)).toBe("To do");
    expect(itemLabel({ kind: "action" }, undefined, [], now)).toBe("To do");
    expect(overdue("2026-11-24", now)).toBe(true);
    expect(itemLabel({ kind: "question", due: "2026-11-13" }, undefined, [], now)).toBe("Question");
    expect(itemLabel({ kind: "waiting" }, undefined, [], now)).toBe("Waiting on");
  });
  it("Reply on questions and on to-dos done by replying; never on a call, a payment or what you wait on", () => {
    expect(offersReply({ kind: "question" })).toBe(true);
    expect(offersReply({ kind: "action" })).toBe(true);
    expect(offersReply({ kind: "action", byReply: false })).toBe(false);
    expect(offersReply({ kind: "waiting" })).toBe(false);
    expect(offersReply({ kind: "date" })).toBe(false);
  });
});

describe("plan 279: with a since, rows from where it starts come first", () => {
  it("each group keeps its order; no since, or one not drawn, keeps them as they were", () => {
    const messages = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const items = [{ messageId: 1, n: "a" }, { messageId: 3, n: "b" }, { messageId: 2, n: "c" }, { messageId: 1, n: "d" }];
    expect(newFirst(items, messages, 2).map((i) => i.n)).toEqual(["b", "c", "a", "d"]);
    expect(newFirst(items, messages, null).map((i) => i.n)).toEqual(["a", "b", "c", "d"]);
    expect(newFirst(items, messages, 99).map((i) => i.n)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("plan 162 (after ai162-r03): a summary item says what it is", () => {
  const arjun = { from: { name: "Arjun Mehta", email: "arjun@acme.studio" } };
  it("a question is the asker's, from the message it cites; never 'Question' beside an instruction", () => {
    expect(itemLabel({ kind: "question" }, arjun as never, ["me@x.com"])).toBe("Arjun asks");
    expect(itemLabel({ kind: "question" }, undefined, ["me@x.com"])).toBe("Question");
    expect(itemLabel({ kind: "action" }, arjun as never, ["me@x.com"])).toBe("To do");
  });
});
