// @vitest-environment jsdom
/** Plan 161, pass 3: Today's line says one thing, with no second total to read against the Inbox's. */
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

async function show(today: number, shown: number, more: number) {
  await act(async () => {
    useApp.setState({ counts: { ...getApp().counts, today, inboxWaiting: 165 } });
    useToday.setState({ needsShown: shown, more });
    root.render(<TodayLine />);
  });
}

it("capped: what the list is, and the way to the rest by the filter's name, never the Waiting count", async () => {
  await show(41, 12, 29);
  expect(host.querySelector("[data-testid=today-needs]")!.textContent).toBe("The newest 12 of 41 that need you");
  expect(host.querySelector("[data-testid=today-more]")!.textContent).toBe("More in To reply to");
  expect(line()).not.toMatch(/165|waiting/);
});

it("not capped: how many need you, and nothing else", async () => {
  await show(9, 9, 0);
  expect(line()).toBe("9 need you");
  expect(host.querySelector("[data-testid=today-more]")).toBeNull();
});
