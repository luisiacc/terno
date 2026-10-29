// @vitest-environment jsdom
import type { MessageDetail } from "@terno/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const NOW = Date.UTC(2026, 9, 29, 12);
const message = (o: Partial<MessageDetail> = {}): MessageDetail => ({
  id: 1, threadId: 1, accountId: 1, from: { name: "Bank", email: "no-reply@bank.test" }, replyTo: [], to: [], cc: [],
  subject: "Your verification code", date: NOW - 60_000, snippet: "", bodyText: "Your code is 048291.", bodyHtml: null, bodyState: "full",
  isRead: false, isStarred: false, isSent: false, hasAttachments: false, rfcMessageId: null, references: [], listId: null, attachments: [], ...o,
} as MessageDetail);

let host: HTMLDivElement, root: Root, writeText: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  (await import("./message-code")).resetCopiedCodes();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="message-code"]');
async function show(m: MessageDetail) {
  const { MessageCode } = await import("./message-code");
  await act(async () => root.render(<MessageCode m={m} />));
}
const click = () => act(async () => chip()!.click());

it("shows the code of a fresh message and copies it, check for five seconds, then outlined", async () => {
  await show(message());
  expect(chip()!.textContent).toContain("048291");
  expect(chip()!.getAttribute("aria-label")).toBe("Copy verification code 048291");
  expect(chip()!.hasAttribute("data-used")).toBe(false);
  await click();
  expect(writeText).toHaveBeenCalledWith("048291");
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  expect(chip()!.hasAttribute("data-used")).toBe(false);
  expect(host.querySelector("[aria-live]")!.textContent).toBe("Copied");
  await act(async () => vi.advanceTimersByTime(4999));
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
  expect(chip()!.hasAttribute("data-used")).toBe(true);
  expect(host.querySelector("[aria-live]")!.textContent).toBe("");
  // copying again shows the check and stays outlined
  await click();
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  expect(chip()!.hasAttribute("data-used")).toBe(true);
});

it("restarts the five seconds on a second click", async () => {
  await show(message());
  await click();
  await act(async () => vi.advanceTimersByTime(3000));
  await click();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
});

it("says so when the clipboard refuses, and stays as it was", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const { useSnack } = await import("~/lib/snack");
  await show(message());
  await click();
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
  expect(useSnack.getState().current?.message).toBe("Couldn’t copy");
});

it("remembers a copied code when the message is shown again", async () => {
  await show(message());
  await click();
  act(() => root.unmount());
  root = createRoot(host);
  await show(message());
  expect(chip()!.hasAttribute("data-used")).toBe(true);
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
});

it("is only offered on received mail at most two hours old", async () => {
  await show(message({ date: NOW - 2 * 3_600_000 - 1 }));
  expect(chip()).toBeNull();
  await show(message({ isSent: true }));
  expect(chip()).toBeNull();
  await show(message({ bodyText: "Your order 048291 has shipped.", subject: "Shipped" }));
  expect(chip()).toBeNull();
});

it("goes away when the two hours run out, but not from under the keyboard", async () => {
  await show(message({ date: NOW - 2 * 3_600_000 + 1000 }));
  chip()!.focus();
  await act(async () => vi.advanceTimersByTime(1001));
  expect(chip()).not.toBeNull();
  await act(async () => chip()!.blur());
  expect(chip()).toBeNull();
});

it("goes away at expiry when not focused", async () => {
  await show(message({ date: NOW - 2 * 3_600_000 + 1000 }));
  await act(async () => vi.advanceTimersByTime(1001));
  expect(chip()).toBeNull();
});

// Codex review (plan 69): the clipboard answers after the chip is gone
it("a copy that settles after the chip is gone leaves no timer and no snack", async () => {
  let settle!: { ok: () => void; fail: () => void };
  writeText.mockImplementation(() => new Promise<void>((ok, fail) => (settle = { ok, fail: () => fail(new Error("denied")) })));
  const { useSnack } = await import("~/lib/snack");
  const before = useSnack.getState().current;
  await show(message());
  await click();
  act(() => root.unmount());
  await act(async () => settle.fail());
  expect(useSnack.getState().current).toBe(before);
  root = createRoot(host);
  await show(message({ id: 2 }));
  await click();
  act(() => root.unmount());
  await act(async () => settle.ok());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});
