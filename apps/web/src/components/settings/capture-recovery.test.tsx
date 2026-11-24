// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import CaptureRecovery from "./capture-recovery";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
let root: Root, container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.clearAllMocks(); });
it("keeps keyboard focus on Next page when the final discovery page has no successor", async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ key: `key${i}`, locator: { kind: "gmail", providerId: `p${i}` }, reason: "mime-parts", state: "blocked", revision: 0 }));
  call.mockResolvedValueOnce({ items, next: "key49" }).mockResolvedValueOnce({ items: [items[0]] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<CaptureRecovery accountId={1} />));
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  await act(async () => button("Messages needing repair").click());
  const next = button("Next page"); next.focus(); expect(document.activeElement).toBe(next);
  await act(async () => next.click());
  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("aria-disabled")).toBe("true");
});
it("keeps collapsed recovery idle with a stable accessible controlled region", async () => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<CaptureRecovery accountId={1} />));
  expect(call).not.toHaveBeenCalled();
  const toggle = container.querySelector("button")!;
  const region = document.getElementById(toggle.getAttribute("aria-controls")!);
  expect(region).not.toBeNull(); expect(region!.hidden).toBe(true);
});

it("plan 267: says which message each repair is and why, in its own words for every reason", async () => {
  const row = (key: string, reason: string, detail?: object) => ({ key, locator: { kind: "gmail", providerId: key }, reason, state: "blocked", revision: 0, ...(detail && { detail }) });
  call.mockResolvedValueOnce({ items: [
    row("a", "mime-parts", { subject: "Quarterly report", from: "Ana Torres", date: Date.UTC(2026, 9, 3) }),
    row("b", "mime-depth"), row("c", "mime-headers", { from: "Bea" }), row("d", "mime-addresses"), row("e", "unknown"),
  ] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<CaptureRecovery accountId={1} />));
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Messages needing repair")!.click());
  const groups = [...container.querySelectorAll('[role="group"]')];
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Quarterly report", "Message 2", "No subject", "Message 4", "Message 5"]);
  const text = groups.map((g) => g.textContent);
  expect(text[0]).toContain("Ana Torres · ");
  expect(text[0]).toContain("too many parts");
  expect(text[1]).toContain("nested too deeply");
  expect(text[2]).toContain("Bea");
  expect(text[2]).toContain("headers are too large");
  expect(text[3]).toContain("address list is too large");
  expect(text[4]).toContain("can't be processed safely");
});
