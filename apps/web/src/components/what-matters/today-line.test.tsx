// @vitest-environment jsdom
/**
 * Plan 161, pass 3: Today's line says one thing, with no second total to read against the Inbox's. Plan 204: no cap, so
 * nothing past it. Plan 210 (iteration 2, the owner): its numbers by when, "6 today · 8 this week", Missed first when any.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => null), on: () => () => {}, connectionVersion: 1 } }));

const { TodayLine } = await import("./today-line");
const { useApp, getApp } = await import("~/state/app");
const { useToday } = await import("~/state/today");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const line = () => host.querySelector("[data-testid=today-line]")!.textContent;
const toggle = () => host.querySelector<HTMLButtonElement>("[data-testid=today-coming-up]");

async function show(today: number, o: { missed?: number; thisWeek?: number; comingUp?: number; open?: boolean } = {}) {
  await act(async () => {
    useApp.setState({ counts: { ...getApp().counts, today: 99, inboxWaiting: 165 } });
    useToday.setState({ counts: { missed: o.missed ?? 0, today, thisWeek: o.thisWeek ?? 0 }, comingUp: o.comingUp ?? 0, comingUpOpen: o.open ?? false });
    root.render(<TodayLine />);
  });
}

it("today and this week, Missed first when any, and nothing else: no cap, never the Waiting count nor the badge's sum", async () => {
  await show(6, { thisWeek: 8 });
  expect(line()).toBe("6 today · 8 this week");
  expect(line()).not.toMatch(/165|99|waiting|newest|See all/);
  expect(toggle()).toBeNull();
  await show(6, { missed: 2, thisWeek: 8 });
  expect(line()).toBe("2 missed · 6 today · 8 this week");
  // a part that's nothing isn't said
  await show(0, { thisWeek: 1 });
  expect(line()).toBe("1 this week");
  await show(0);
  expect(line()).toBe("");
});

it("in Spanish too", async () => {
  const { setLocale } = await import("@terno/i18n");
  const { default: es } = await import("@terno/i18n/locales/es");
  const { default: en } = await import("@terno/i18n/locales/en");
  setLocale("es", es);
  try {
    await show(6, { thisWeek: 8 });
    expect(line()).toBe("6 hoy · 8 esta semana");
  } finally {
    setLocale("en", en);
  }
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
