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

const { WhatMattersFeed, drawn } = await import("./feed");
const { useToday } = await import("~/state/today");
const { useList } = await import("~/state/list");

const { dayKeyOf } = await import("@terno/core");
const DAY = 86_400_000;
const zero = { missed: 0, today: 0, waiting: 0, overdue: 0 };
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
    useToday.setState({ rows: [], answered: true, answeredDay: dayKeyOf(Date.now()), counts: zero, comingUp: 1, moments: [{ at, timed: true, day }] });
    const root = await draw();
    const empty = host.querySelector("[data-testid=list-empty]")!;
    expect(empty.querySelector("[data-testid=wm-horizon]")).not.toBeNull();
    expect(empty.querySelector("[data-testid=wm-clear-words]")!.textContent).toMatch(/^Nothing needs you until \w+day\.$/);
    expect(empty.querySelector("[data-testid=wm-clear-day]")!.textContent).toBe("Clear day No. 1");
    // the feed's column, as the header's; one title, the horizon's words (no second, empty paragraph)
    expect(empty.className).toContain("max-w-[44rem]");
    expect(empty.querySelectorAll("p").length).toBe(2);
    // plan 274: under the horizon, Coming up stays a quiet line (no section title, no badge)
    const coming = empty.querySelector("[data-testid=wm-coming-up]")!;
    expect(coming.textContent).toBe("Coming up · 1");
    expect(coming.querySelector("[data-testid=wm-heading-count], [data-slot=badge]")).toBeNull();
    act(() => root.unmount());
  });

  it("before the first answer, the skeleton; with none (its request failed, Codex code review), no horizon: never a clear day counted", async () => {
    for (const loading of [true, false]) {
      useList.setState({ items: [], loading });
      useToday.setState({ rows: [], answered: false, answeredDay: null, counts: zero, comingUp: 0, moments: [] });
      const root = await draw();
      expect(host.querySelector("[data-testid=wm-clear]")).toBeNull();
      expect(localStorage.getItem("terno.whatMatters.clearDays")).toBeNull();
      act(() => root.unmount());
    }
  });

  it("Codex code review: an answer for another day (yesterday's, before midnight's reload) counts nothing", async () => {
    useList.setState({ items: [], loading: false });
    useToday.setState({ rows: [], answered: true, answeredDay: dayKeyOf(Date.now() - DAY), counts: zero, comingUp: 0, moments: [] });
    const root = await draw();
    expect(host.querySelector("[data-testid=wm-clear]")).not.toBeNull();
    expect(host.querySelector("[data-testid=wm-clear-day]")).toBeNull();
    expect(localStorage.getItem("terno.whatMatters.clearDays")).toBeNull();
    act(() => root.unmount());
  });
});

describe("the feed's headings", () => {
  const row = (id: number, group: "today" | "waiting") => ({ id: `${group}:${id}`, threadId: id, group }) as never;
  const headings = (rows: never[]) => drawn(rows, 0, false).flatMap((d) => (d.type === "heading" ? [`${d.kind}${d.part ? " (part)" : ""}`] : []));

  it("no empty Today above Waiting on you: with none of Today's own, Waiting on you is a group of its own (the owner)", () => {
    expect(headings([row(1, "waiting"), row(2, "waiting")])).toEqual(["waiting"]);
  });

  it("under Today's own rows, Waiting on you is a part of Today", () => {
    expect(headings([row(1, "today"), row(2, "waiting")])).toEqual(["today", "waiting (part)"]);
  });
});
