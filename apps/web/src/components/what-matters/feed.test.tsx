// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
// everything observed is on screen
vi.stubGlobal("IntersectionObserver", class { constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {} observe() { this.cb([{ isIntersecting: true }]); } unobserve() {} disconnect() {} });
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({})), on: () => () => {} } }));

const { WhatMattersFeed } = await import("./feed");
const { useToday } = await import("~/state/today");
const { useList } = await import("~/state/list");

const DAY = 86_400_000;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => host.remove());

async function draw() {
  const root = createRoot(host);
  await act(async () => root.render(<WhatMattersFeed />));
  return root;
}

describe("plan 222: an empty, clear What matters", () => {
  it("draws the horizon on the feed's column in the empty state, with what you're free until and the first clear day", async () => {
    const at = Date.now() + 2 * DAY;
    const d = new Date(at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    useList.setState({ items: [], loading: false });
    useToday.setState({ rows: [], answered: true, counts: { missed: 0, today: 0, waiting: 0, overdue: 0 }, comingUp: 1, moments: [{ at, timed: true, day }] });
    const root = await draw();
    const empty = host.querySelector("[data-testid=list-empty]")!;
    expect(empty.querySelector("[data-testid=wm-horizon]")).not.toBeNull();
    expect(empty.querySelector("[data-testid=wm-clear-words]")!.textContent).toMatch(/^Nothing needs you until \w+day\.$/);
    expect(empty.querySelector("[data-testid=wm-clear-day]")!.textContent).toBe("Clear day No. 1");
    // the feed's column, as the header's; one title, the horizon's words (no second, empty paragraph)
    expect(empty.className).toContain("max-w-[44rem]");
    expect(empty.querySelectorAll("p").length).toBe(2);
    act(() => root.unmount());
  });

  it("before the first answer, the skeleton: never a clear day counted while loading", async () => {
    useList.setState({ items: [], loading: true });
    useToday.setState({ rows: [], answered: false, counts: { missed: 0, today: 0, waiting: 0, overdue: 0 }, comingUp: 0, moments: [] });
    const root = await draw();
    expect(host.querySelector("[data-testid=wm-clear]")).toBeNull();
    expect(localStorage.getItem("terno.whatMatters.clearDays")).toBeNull();
    act(() => root.unmount());
  });
});
