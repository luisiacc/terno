// @vitest-environment jsdom
/**
 * Plan 161, pass 3: Today's line says one thing, with no second total to read against the Inbox's. Plan 204: no cap, so
 * nothing past it. Plan 210 (iteration 3): its numbers by when and who, "1 missed · 3 today · 5 waiting", each unsaid at zero.
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

async function show(today: number, o: { missed?: number; waiting?: number; comingUp?: number; open?: boolean } = {}) {
  await act(async () => {
    useApp.setState({ counts: { ...getApp().counts, today: 99, inboxWaiting: 165 } });
    useToday.setState({ counts: { missed: o.missed ?? 0, today, waiting: o.waiting ?? 0 }, comingUp: o.comingUp ?? 0, comingUpOpen: o.open ?? false });
    root.render(<TodayLine />);
  });
}

it("plan 210 (iteration 3): missed, today and waiting, each unsaid at zero; no cap, never the Inbox's count nor the badge's sum", async () => {
  await show(3, { missed: 1, waiting: 5 });
  expect(line()).toBe("1 missed · 3 today · 5 waiting");
  expect(line()).not.toMatch(/165|99|this week|newest|See all/);
  expect(toggle()).toBeNull();
  await show(6, { waiting: 8 });
  expect(line()).toBe("6 today · 8 waiting");
  // a part that's nothing isn't said
  await show(0, { waiting: 1 });
  expect(line()).toBe("1 waiting");
  await show(0);
  expect(line()).toBe("");
});

it("in Spanish too", async () => {
  const { setLocale } = await import("@terno/i18n");
  const { default: es } = await import("@terno/i18n/locales/es");
  const { default: en } = await import("@terno/i18n/locales/en");
  setLocale("es", es);
  try {
    await show(3, { missed: 1, waiting: 5 });
    expect(line()).toBe("1 se te pasó · 3 hoy · 5 te esperan");
    await show(0, { waiting: 1 });
    expect(line()).toBe("1 te espera");
  } finally {
    setLocale("en", en);
  }
});

it("plan 210 (iteration 3): Coming up is the catalog's disclosure after the count, named by what it holds, open or shut, and stays as left", async () => {
  await show(2, { comingUp: 4 });
  expect(toggle()!.textContent).toBe("4 coming up");
  expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
  // the catalog's trigger: a button with its chevron
  expect(toggle()!.tagName).toBe("BUTTON");
  expect(toggle()!.querySelector("[data-slot=collapsible-chevron]")).not.toBeNull();
  await act(async () => toggle()!.click());
  expect(useToday.getState().comingUpOpen).toBe(true);
  expect(localStorage.getItem("terno.today.comingUp")).toBe("open");
  expect(toggle()!.textContent).toBe("4 coming up");
  expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle()!.click());
  expect(useToday.getState().comingUpOpen).toBe(false);
  await show(2, { comingUp: 4, open: true });
  expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
  // nothing coming up, nothing to open
  await show(2, { comingUp: 0, open: true });
  expect(toggle()).toBeNull();
});
