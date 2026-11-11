// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const error = vi.fn();
vi.mock("~/lib/snack", () => ({ snack: { error, success: vi.fn() } }));

const { AiCopyButton, AiProvenance } = await import("./ai-provenance");

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(() => {
  act(() => root.render(null));
  vi.useRealTimers();
});
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

it("plan 161, pass 3: Copy says Copied in place, to a screen reader too, and goes back; a failure says what to do", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  act(() => root.render(<AiCopyButton text={() => "the words"} failed="Couldn't copy." testId="x-copy" />));
  const button = q("x-copy")!;
  expect(button.tagName.toLowerCase()).toBe("button");
  // the row's 28 px, BoardUI's secondary
  expect(button.className).toContain("h-7");
  expect(button.textContent).toContain("Copy");
  await act(async () => button.click());
  expect(writeText).toHaveBeenCalledWith("the words");
  expect(button.dataset.copied).toBe("true");
  // the word shown (the other holds the width, hidden from everyone)
  expect(button.querySelector(".grid > span:not([aria-hidden])")!.textContent).toBe("Copied");
  expect(q("x-copy-status")!.textContent).toBe("Copied");
  await act(async () => vi.advanceTimersByTime(1500));
  expect(button.dataset.copied).toBeUndefined();
  expect(q("x-copy-status")!.textContent).toBe("");
  writeText.mockRejectedValueOnce(new Error("denied"));
  await act(async () => button.click());
  expect(error).toHaveBeenCalledWith("Couldn't copy.");
  expect(button.dataset.copied).toBeUndefined();
});

it("plan 181: Copy as its glyph alone is named, the row's 28 px square, and says Copied in its name", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  act(() => root.render(<AiCopyButton iconOnly text={() => "the words"} failed="Couldn't copy." testId="x-copy" />));
  const button = q("x-copy")!;
  expect(button.getAttribute("aria-label")).toBe("Copy");
  expect(button.textContent).toBe("");
  expect(button.className).toContain("size-7");
  // its tooltip's trigger: the words it can't show
  expect(button.dataset.slot).toBe("tooltip-trigger");
  await act(async () => button.click());
  expect(writeText).toHaveBeenCalledWith("the words");
  expect(button.getAttribute("aria-label")).toBe("Copied");
  expect(q("x-copy-status")!.textContent).toBe("Copied");
  await act(async () => vi.advanceTimersByTime(1500));
  expect(button.getAttribute("aria-label")).toBe("Copy");
});

it("plan 161, pass 3: who wrote it is a button (it was a span that took focus and did nothing), opening what it used and the model", async () => {
  act(() => root.render(<AiProvenance model="qwen3:8b" at={new Date(2026, 10, 8, 9, 41).getTime()} lines={["In your voice with Liam: it learned from how you write to Liam."]} testId="x-prov" />));
  const trigger = q("x-prov")!;
  expect(trigger.tagName.toLowerCase()).toBe("button");
  expect(q("x-prov-label")!.textContent).toBe("Written with AI");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  const popover = q("x-prov-popover")!;
  expect(popover.textContent).toContain("In your voice with Liam");
  expect(q("x-prov-detail")!.textContent).toMatch(/^Written by qwen3:8b, .+\. It can make mistakes\.$/);
});
