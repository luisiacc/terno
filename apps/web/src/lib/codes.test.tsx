// @vitest-environment jsdom
import type { ThreadSummary } from "@terno/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn().mockResolvedValue({}) } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const NOW = Date.UTC(2026, 9, 29, 12);
const HOURS_2 = 2 * 3_600_000;
const thread = (o: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: 7, accountId: 1, subject: "Your Acme sign-in code", snippet: "Use this code to finish signing in: 048291", lastDate: NOW - 60_000,
  fromName: "Acme", fromEmail: "no-reply@acme.test", messageCount: 1, unread: true, starred: false, hasAttachments: false, categoryIds: [], ...o,
});

let host: HTMLDivElement, root: Root, writeText: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  (await import("./codes")).resetCodes();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const chip = () => host.querySelector<HTMLElement>('[data-testid="row-code"]');
const { useThreadCode } = await import("./codes");
const { CodeChip } = await import("~/components/code-chip");
// one component type, so showing a changed thread updates the mounted row (as the list does)
function Row({ th }: { th: ThreadSummary }) {
  const code = useThreadCode(th);
  return code ? <CodeChip threadId={th.id} code={code} /> : null;
}
async function showRow(th: ThreadSummary) {
  await act(async () => root.render(<Row th={th} />));
}
const click = () => act(async () => chip()!.click());

it("a fresh thread's code copies: the check for five seconds, then outlined for good", async () => {
  await showRow(thread());
  expect(chip()!.dataset.code).toBe("048291");
  await click();
  expect(writeText).toHaveBeenCalledWith("048291");
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  expect(chip()!.hasAttribute("data-used")).toBe(false);
  await act(async () => vi.advanceTimersByTime(4999));
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
  expect(chip()!.hasAttribute("data-used")).toBe(true);
  await click();
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  expect(chip()!.hasAttribute("data-used")).toBe(true);
});

it("a second click restarts the five seconds", async () => {
  await showRow(thread());
  await click();
  await act(async () => vi.advanceTimersByTime(3000));
  await click();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
});

it("pressing the chip doesn't reach the row", async () => {
  const press = vi.fn();
  const { CodeChip } = await import("~/components/code-chip");
  await act(async () => root.render(<div onMouseDown={press} onClick={press}><CodeChip threadId={7} code="048291" /></div>));
  await act(async () => {
    chip()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    chip()!.click();
  });
  expect(press).not.toHaveBeenCalled();
});

it("a row scrolled away and back (or the menu's copy) shares the state", async () => {
  const { codeKey, copyCode } = await import("./codes");
  await showRow(thread());
  await act(async () => void (await copyCode(codeKey(7, "048291"), "048291")));
  expect(chip()!.hasAttribute("data-copied")).toBe(true);
  act(() => root.unmount());
  await act(async () => vi.advanceTimersByTime(5000));
  root = createRoot(host);
  await showRow(thread());
  expect(chip()!.hasAttribute("data-used")).toBe(true);
  // a newer code in the same thread is a new one
  await showRow(thread({ snippet: "Your new code is 551234" }));
  expect(chip()!.hasAttribute("data-used")).toBe(false);
});

it("says so when the clipboard refuses, and stays as it was", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const { useSnack } = await import("~/lib/snack");
  await showRow(thread());
  await click();
  expect(chip()!.hasAttribute("data-copied")).toBe(false);
  expect(useSnack.getState().current?.message).toBe("Couldn’t copy");
});

it("only threads whose newest mail is at most two hours old, with a code", async () => {
  await showRow(thread({ lastDate: NOW - HOURS_2 - 1 }));
  expect(chip()).toBeNull();
  await showRow(thread({ subject: "Shipped", snippet: "Your order 048291 has shipped." }));
  expect(chip()).toBeNull();
});

it("goes away when the two hours run out, with one timer", async () => {
  await showRow(thread({ lastDate: NOW - HOURS_2 + 1000 }));
  expect(chip()).not.toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTime(1001));
  expect(chip()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("threadCode: the menu reads the same code", async () => {
  const { threadCode } = await import("./codes");
  expect(threadCode(thread(), NOW)).toBe("048291");
  expect(threadCode(thread(), NOW + HOURS_2)).toBeNull();
});

// Codex review round 4
it("a row on screen for a while still offers the code of mail arriving now", async () => {
  await showRow(thread({ snippet: "Hello", subject: "Hi" }));
  expect(chip()).toBeNull();
  await act(async () => vi.advanceTimersByTime(10 * 60_000));
  await showRow(thread({ snippet: "Your new code is 551234", subject: "Hi", lastDate: Date.now(), messageCount: 2 }));
  expect(chip()!.dataset.code).toBe("551234");
});

it("a reply doesn't bring back the first message's code from the subject", async () => {
  await showRow(thread({ subject: "Your code 111111", snippet: "Thanks, that worked!", messageCount: 2 }));
  expect(chip()).toBeNull();
  await showRow(thread({ subject: "Your code 111111", snippet: "Your new code is 222222", messageCount: 2 }));
  expect(chip()!.dataset.code).toBe("222222");
  const { threadCode } = await import("./codes");
  expect(threadCode(thread({ subject: "Your code 111111", snippet: "Thanks", messageCount: 2 }), NOW)).toBeNull();
});
