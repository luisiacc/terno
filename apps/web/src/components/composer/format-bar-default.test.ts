// @vitest-environment jsdom
// Plan 158: the composer starts quiet; only someone who opened the bar keeps it open.
import { beforeEach, expect, it, vi } from "vitest";

const load = async () => { vi.resetModules(); return import("./controller"); };
beforeEach(() => localStorage.clear());

it.each([[null, false], ["hidden", false], ["shown", true]] as const)("stored %s: shown %s", async (stored, shown) => {
  if (stored) localStorage.setItem("terno:format-bar", stored);
  expect((await load()).useFormatBar.getState().shown).toBe(shown);
});

it("the choice is remembered both ways", async () => {
  const { toggleFormatBar } = await load();
  toggleFormatBar();
  expect((await load()).useFormatBar.getState().shown).toBe(true);
  (await load()).toggleFormatBar();
  expect((await load()).useFormatBar.getState().shown).toBe(false);
});
