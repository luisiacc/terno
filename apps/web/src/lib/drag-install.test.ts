/**
 * Plan 24: drop targets are measured clipped to their own scrolling
 * container. Before, every target was clipped to the sidebar's nav, so a
 * List tab (above the nav, in the list's header) measured as nothing and
 * couldn't take a drop. Node with a fake document.
 */
import { describe, expect, it, vi } from "vitest";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const fake = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const state = { targets: [] as unknown[] };
  g.document = { documentElement: { dataset: {}, classList: { contains: () => false }, setAttribute() {}, removeAttribute() {} }, querySelector: () => null, querySelectorAll: (sel: string) => (sel === "[data-drop-target]" ? state.targets : []) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { setItem() {}, getItem: () => null };
  g.requestAnimationFrame = () => 0;
  return state;
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));

const { measureTargets } = await import("./drag-install");

const el = (id: number, r: Box, container: Box | null, inert = false) => ({
  dataset: { dropTarget: String(id) },
  getBoundingClientRect: () => r,
  closest: (sel: string) => (sel === "[inert]" ? (inert ? {} : null) : container ? { getBoundingClientRect: () => container } : null),
});

describe("measuring drop targets", () => {
  const nav: Box = { left: 0, right: 240, top: 300, bottom: 900 };
  const strip: Box = { left: 260, right: 1200, top: 120, bottom: 160 };

  it("each target is clipped to its own container: a tab above the sidebar's nav is a target", () => {
    fake.targets = [el(3, { left: 8, right: 232, top: 400, bottom: 428 }, nav), el(3, { left: 400, right: 480, top: 124, bottom: 156 }, strip)];
    expect(measureTargets()).toEqual([
      { id: 3, at: 0, left: 8, right: 232, top: 400, bottom: 428 },
      { id: 3, at: 1, left: 400, right: 480, top: 124, bottom: 156 },
    ]);
  });

  it("scrolled out of its container (either way), or under an inert page cover: not a target", () => {
    fake.targets = [
      el(1, { left: 8, right: 232, top: 200, bottom: 228 }, nav),
      el(2, { left: 1300, right: 1380, top: 124, bottom: 156 }, strip),
      el(4, { left: 400, right: 480, top: 124, bottom: 156 }, strip, true),
    ];
    expect(measureTargets()).toEqual([]);
  });
});
