import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FOCUS_SETTLE_MS, FocusReporter } from "./window-focus";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function rig() {
  let focused = false, backend = true;
  const told: boolean[] = [];
  const r = new FocusReporter({ focused: () => focused, tell: (f) => backend && (told.push(f), true) });
  return { r, told, focus: (f: boolean) => { focused = f; r.changed(); }, setBackend: (b: boolean) => void (backend = b) };
}

it("tells the backend each change once it settles; a switch between Terno windows isn't a blur", () => {
  const t = rig();
  expect(t.r.current()).toBe(false);
  t.focus(true);
  expect(t.told).toEqual([]);
  vi.advanceTimersByTime(FOCUS_SETTLE_MS);
  expect(t.told).toEqual([true]);
  // window a blurs, window b gains focus
  t.focus(false);
  t.focus(true);
  vi.advanceTimersByTime(FOCUS_SETTLE_MS);
  expect(t.told).toEqual([true]);
  t.focus(false);
  vi.advanceTimersByTime(FOCUS_SETTLE_MS);
  expect(t.told).toEqual([true, false]);
});

it("a change with no backend to tell is told to the next one by its init, and not lost after", () => {
  const t = rig();
  t.r.current();
  t.setBackend(false);
  t.focus(true);
  vi.advanceTimersByTime(FOCUS_SETTLE_MS);
  expect(t.told).toEqual([]);
  // the restarted backend's init carries it
  t.setBackend(true);
  expect(t.r.current()).toBe(true);
  t.focus(false);
  vi.advanceTimersByTime(FOCUS_SETTLE_MS);
  expect(t.told).toEqual([false]);
});
