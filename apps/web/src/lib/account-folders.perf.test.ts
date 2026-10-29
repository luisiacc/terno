/**
 * Plan 65 (Codex R11, R14): an account's folder rows from a catalog of 10,000 folders a hundred levels deep, a step
 * at a time: never a frame's work between two pauses (the sidebar gives the frame back at each).
 */
import type { Folder } from "@terno/core";
import { expect, it, vi } from "vitest";

vi.mock("~/state/app", () => ({ getApp: () => ({}), navigate: () => {} }));
const { folderRowSteps } = await import("./account-folders");

it("10,000 folders of 100 levels: no step over 8 ms (warmed once; the best of three)", () => {
  const many: Folder[] = Array.from({ length: 10_000 }, (_, i) => ({ accountId: 2, key: `K${i}`, path: Array.from({ length: 100 }, (_, j) => `S${i}-${j}`), selectable: true }));
  const longest = () => {
    const steps = folderRowSteps(many, 2);
    let worst = 0;
    for (let r: IteratorResult<void, unknown> | null = null; !r?.done; ) {
      const t0 = performance.now();
      r = steps.next();
      worst = Math.max(worst, performance.now() - t0);
    }
    return worst;
  };
  longest();
  expect(Math.min(longest(), longest(), longest())).toBeLessThan(8);
});
