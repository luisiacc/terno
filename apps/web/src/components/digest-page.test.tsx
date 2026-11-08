// @vitest-environment jsdom
import type { DigestRow } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

// the page reads its row from the backend: whatever the test says it is now
let served: DigestRow | null = null;
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => served), on: () => () => {}, connectionVersion: 1 } }));

const { default: DigestPage } = await import("./digest-page");
const { useToday } = await import("~/state/today");

const item = (id: number) => ({ threadId: id, messageId: id, lastDate: 1, messageCount: 1, from: `Sender ${id}`, subject: `Issue ${id}`, line: `Line ${id}` });
const digestOf = (day: string, automated = false): DigestRow => ({ day, state: "ready", automated, items: [1, 2, 3].map(item), liveIds: [1, 2, 3], model: "m" });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const ticks = () => [...host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")].map((b) => b.getAttribute("aria-checked") === "true" || b.hasAttribute("data-checked"));
const page = () => host.querySelector<HTMLElement>("[data-testid=digest-page]")!;
async function show(row: DigestRow) {
  served = row;
  await act(async () => useToday.setState({ digest: row }));
  await act(async () => root.render(<DigestPage key={Math.random()} />));
}
const unmount = () => act(() => root.render(<></>));

beforeEach(() => useToday.setState({ pick: null, digest: null }));

it("plan 161: what was unticked, and where it was scrolled, survive opening a source (the page unmounting)", async () => {
  await show(digestOf("2026-10-22"));
  expect(ticks()).toEqual([true, true, true]);
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[1]!.click());
  expect(ticks()).toEqual([true, false, true]);
  await act(async () => {
    page().scrollTop = 140;
    page().dispatchEvent(new Event("scroll"));
  });
  await unmount();
  await show(digestOf("2026-10-22"));
  expect(ticks()).toEqual([true, false, true]);
  expect(page().scrollTop).toBe(140);
  expect(host.querySelector("[data-testid=digest-archive]")!.textContent).toBe("Archive selected (2)");
});

it("plan 161 (Codex review): a new day starts afresh, its scroll too; automated mail's picks don't turn into the digest's", async () => {
  await show(digestOf("2026-10-22"));
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[0]!.click());
  await act(async () => {
    page().scrollTop = 200;
    page().dispatchEvent(new Event("scroll"));
  });
  // the next day's arrives while the page is open
  served = digestOf("2026-10-23");
  await act(async () => useToday.setState({ digest: served }));
  expect(ticks()).toEqual([true, true, true]);
  expect(page().scrollTop).toBe(0);
  // automated mail picked (ticked) one; the same day as a digest isn't the inverse of that
  await unmount();
  await show(digestOf("2026-10-24", true));
  expect(ticks()).toEqual([false, false, false]);
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[0]!.click());
  expect(ticks()).toEqual([true, false, false]);
  await unmount();
  await show(digestOf("2026-10-24"));
  expect(ticks()).toEqual([true, true, true]);
});
