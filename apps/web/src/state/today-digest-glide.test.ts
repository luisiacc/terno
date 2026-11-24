// @vitest-environment jsdom
/**
 * Plan 251 (Codex review): Esc's way back to the digest glides, so it lands on the transition's frame. A newsletter opened
 * before then (j from the list beside) isn't put away by it.
 */
import { DIGEST_ROW_ID } from "@terno/core";
import { expect, it, vi } from "vitest";

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {}, connectionVersion: 1 } }));
const queued: (() => void)[] = [];
vi.mock("~/lib/morph", () => ({ morph: (update: () => void) => queued.push(update) }));

const { backToDigest, openFromDigest, useToday } = await import("./today");
const { getApp, setApp } = await import("./app");
const { useAppearance } = await import("~/lib/appearance");

it("a queued way back lands only on the newsletter it was asked from", () => {
  useAppearance.setState({ layout: "split" });
  setApp({ view: "all", today: true, selectedId: DIGEST_ROW_ID });
  openFromDigest("d|automated", 7, 0, { toggled: new Set() });
  expect(backToDigest(true)).toBe(true);
  expect(queued).toHaveLength(1);
  // j opens the next before the frame
  openFromDigest("d|automated", 8, 0, { toggled: new Set() });
  queued.shift()!();
  expect(getApp().selectedId).toBe(8);
  expect(useToday.getState().fromDigest).toBe(8);
  // unmoved, it lands
  expect(backToDigest(true)).toBe(true);
  queued.shift()!();
  expect(getApp().selectedId).toBe(DIGEST_ROW_ID);
  expect(useToday.getState().fromDigest).toBeNull();
});
