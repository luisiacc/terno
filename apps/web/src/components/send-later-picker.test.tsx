// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { SendLaterPicker } = await import("./send-later-picker");

afterEach(() => vi.useRealTimers());

it("a custom moment that passed while the picker stayed open isn't scheduled (it would send at once): it says so", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 22, 10, 14));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPick = vi.fn();
  await act(async () => root.render(<SendLaterPicker onPick={onPick} done={() => {}} />));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=send-later-custom]")!.click());
  // tomorrow 8:00 by default; the clock jumps past it with the picker still open
  vi.setSystemTime(new Date(2026, 9, 23, 8, 1));
  const set = host.querySelector<HTMLButtonElement>("[data-testid=send-later-set]")!;
  expect(set.disabled).toBe(false);
  await act(async () => set.click());
  expect(onPick).not.toHaveBeenCalled();
  expect(host.querySelector("[data-testid=send-later-past]")).not.toBeNull();
  expect(set.disabled).toBe(true);
  await act(async () => root.unmount());
  host.remove();
});
