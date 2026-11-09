// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { editedShares, habitLines } = await import("./writing-style");

it("plan 162 (after ai162-r03): an opener with the name says so in words, never a template's “Hello …,”", () => {
  const habits = { words: { median: 0 }, greetings: [{ text: "Hello {name},", share: 0.6 }], noGreeting: 0, signOffs: [] } as never;
  const lines = habitLines(habits);
  expect(lines).toContain("Often opens with “Hello” and their name");
  expect(lines.join(" ")).not.toContain("…");
});

it("plan 162 (after ai162-r05): an edited profile says the greeting and sign-off a draft will use, the user's own first", () => {
  // "Hi {name}," typed as a new first greeting is saved at the share a draft's prompt carries it from (10%)
  const habits = { words: { median: 0 }, greetings: [{ text: "Hi {name},", share: 0.1 }, { text: "Hello {name},", share: 0.05 }], noGreeting: 0.2, signOffs: [{ text: "Cheers,", share: 0.1 }], noSignOff: 0 } as never;
  expect(habitLines(habits, true)).toEqual(expect.arrayContaining(["Opens with “Hi” and their name", "Signs off with “Cheers,”"]));
  // a profile that was never edited still says only what it counted often enough
  expect(habitLines(habits).join(" ")).not.toMatch(/opens with|signs off/i);
});

it("plan 162 (after ai162-r05): a greeting typed over another keeps its place's share; a new one gets the draft's floor", () => {
  const counted = [{ text: "Hello {name},", share: 0.6 }, { text: "Hi all,", share: 0.2 }];
  expect(editedShares(counted, ["Hi {name},", "Hi all,"])).toEqual([{ text: "Hi {name},", share: 0.6 }, { text: "Hi all,", share: 0.2 }]);
  // reordered, each keeps its own; added, the floor
  expect(editedShares(counted, ["Hi all,", "Hello {name},", "Hey,"])).toEqual([{ text: "Hi all,", share: 0.2 }, { text: "Hello {name},", share: 0.6 }, { text: "Hey,", share: 0.1 }]);
  // an emptied field between doesn't shift the places
  expect(editedShares(counted, ["", "Yo,"])).toEqual([{ text: "Yo,", share: 0.2 }]);
});

it("Codex review: a rare greeting or sign-off typed over is never saved below what a draft uses", () => {
  const rare = [{ text: "Hello {name},", share: 0.05 }];
  expect(editedShares(rare, ["Hi {name},"])).toEqual([{ text: "Hi {name},", share: 0.1 }]);
  expect(editedShares([{ text: "Best,", share: 0.04 }], ["Cheers,"])).toEqual([{ text: "Cheers,", share: 0.1 }]);
});
