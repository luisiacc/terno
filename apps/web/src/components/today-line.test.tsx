// @vitest-environment jsdom
/** Plan 161, pass 3: Today's line says one thing, with no second total to read against the Inbox's. Plan 204: no cap, so nothing past it. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { TodayLine } = await import("./thread-list");
const { useApp, getApp } = await import("~/state/app");
const { useToday } = await import("~/state/today");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const line = () => host.querySelector("[data-testid=today-line]")!.textContent;
const toggle = () => host.querySelector<HTMLButtonElement>("[data-testid=today-coming-up]");

async function show(today: number | null, o: { counted?: number; comingUp?: number; open?: boolean } = {}) {
  await act(async () => {
    useApp.setState({ counts: { ...getApp().counts, today: today ?? undefined, inboxWaiting: 165 } });
    useToday.setState({ counted: o.counted ?? 0, comingUp: o.comingUp ?? 0, comingUpOpen: o.open ?? false });
    root.render(<TodayLine />);
  });
}

it("how many need you, and nothing else: no cap, no way to the rest, never the Waiting count", async () => {
  await show(41);
  expect(line()).toBe("41 need you");
  expect(line()).not.toMatch(/165|waiting|newest|See all/);
  expect(toggle()).toBeNull();
});

it("before the sidebar's count arrives, what the list counts", async () => {
  await show(null, { counted: 3 });
  expect(line()).toBe("3 need you");
});

it("plan 204: Coming up's toggle after the count, named by what it holds and whether it's open", async () => {
  await show(2, { comingUp: 4 });
  expect(toggle()!.textContent).toBe("4 coming up");
  expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
  await show(2, { comingUp: 4, open: true });
  expect(toggle()!.textContent).toBe("Hide coming up");
  expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  // nothing coming up, nothing to open
  await show(2, { comingUp: 0, open: true });
  expect(toggle()).toBeNull();
});
