// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { itemLabel, newFirst } = await import("./thread-summary");

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
