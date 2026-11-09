// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { habitLines } = await import("./writing-style");

it("plan 162 (after ai162-r03): an opener with the name says so in words, never a template's “Hello …,”", () => {
  const habits = { words: { median: 0 }, greetings: [{ text: "Hello {name},", share: 0.6 }], noGreeting: 0, signOffs: [] } as never;
  const lines = habitLines(habits);
  expect(lines).toContain("Often opens with “Hello” and their name");
  expect(lines.join(" ")).not.toContain("…");
});
