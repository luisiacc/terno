// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { itemLabel } = await import("./thread-summary");

describe("plan 162 (after ai162-r03): a summary item says what it is", () => {
  const arjun = { from: { name: "Arjun Mehta", email: "arjun@acme.studio" } };
  it("a question is the asker's, from the message it cites; never 'Question' beside an instruction", () => {
    expect(itemLabel({ kind: "question" }, arjun as never, ["me@x.com"])).toBe("Arjun asks");
    expect(itemLabel({ kind: "question" }, undefined, ["me@x.com"])).toBe("Question");
    expect(itemLabel({ kind: "action" }, arjun as never, ["me@x.com"])).toBe("To do");
  });
});
