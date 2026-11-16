// @vitest-environment jsdom
/**
 * Plan 210 (iteration 4, the owner's "Change…"): the reader's line offers Change… on an open item with a day to change, and
 * a later mail's move of an item the user changed as "Elena says Mon now · Use".
 */
import type { DatedRow, ScheduleProposal, ThreadDetail } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.hoisted(() => Object.assign(globalThis, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }));
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(async () => ({ undoId: "s1" })), on: vi.fn(() => () => {}), connectionVersion: 1 } }));

const { client } = await import("~/rpc/connection");
const { default: ThreadItems } = await import("./thread-items");
const { resetSnacks } = await import("~/lib/snack");

const DAY = 86_400_000;
const NOW = Date.now();
const local = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const row = (over: Partial<DatedRow> = {}): DatedRow =>
  ({ id: 4, threadId: 7, messageId: 1, item: 0, kind: "respond", text: "Send Elena the signed slip", quote: "", senderKey: "s", dueDay: local(NOW + 3 * DAY), dueAt: NOW + 3 * DAY, timed: false, dated: true, actAt: NOW - 1, deferredUntil: null, arrivedAt: NOW - 1, state: "open", closedReason: null, closedAt: null, fromScan: false, revision: 2, model: null, provider: null, createdAt: NOW - 1, ...over }) as DatedRow;
const detail = { thread: { id: 7, inTrash: false, inSpam: false }, messages: [] } as unknown as ThreadDetail;
const model = (r: DatedRow, open = r.state === "open") => ({ top: { key: `dated:${r.id}`, ref: { source: "dated" as const, id: r.id }, open, missed: false, dueAt: r.dueAt, source: "dated" as const, row: r }, others: [], targeted: true, ready: true, choose: () => {} });

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
async function render(r: DatedRow, open?: boolean) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(<ThreadItems detail={detail} items={model(r, open)} />));
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  setLocale("en", en);
  vi.mocked(client.call).mockClear();
  resetSnacks();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("Change… on the reader's line (plan 210, iteration 4)", () => {
  it("an open item with a day has Change…, named for a screen reader; a person's ask and a closed item have none", async () => {
    await render(row());
    expect(q("thread-dated-change")?.textContent).toBe("Change…");
    expect(q("thread-dated-change")?.getAttribute("aria-label")).toBe("Change day and time: Send Elena the signed slip");
    // beside Later, before Remove
    const buttons = [...q("thread-dated-item")!.querySelectorAll("button")].map((b) => b.dataset.testid);
    expect(buttons.indexOf("thread-dated-change")).toBe(buttons.indexOf("thread-dated-later") + 1);
    // Hand to… (iteration 4's other part) sits between Change… and Remove
    expect(buttons.indexOf("thread-dated-hand")).toBe(buttons.indexOf("thread-dated-change") + 1);
    expect(buttons.indexOf("thread-dated-dismiss")).toBe(buttons.indexOf("thread-dated-hand") + 1);
    await render(row({ kind: "ask", dated: false }));
    expect(q("thread-dated-change")).toBeNull();
    await render(row({ state: "done", closedAt: NOW }), false);
    expect(q("thread-dated-change")).toBeNull();
  });

  it("opens the shared form on the item's day; Change asks for that day at the revision seen", async () => {
    await render(row());
    await act(async () => q("thread-dated-change")!.click());
    expect(q("thread-dated-change-form")).not.toBeNull();
    expect(q("thread-dated-change-date")?.textContent).toContain(String(new Date(NOW + 3 * DAY).getDate()));
    // a day alone: no time field until "At a time"
    expect(q("thread-dated-change-time")).toBeNull();
    await act(async () => q("thread-dated-change-set")!.click());
    expect(client.call).toHaveBeenCalledWith("today.schedule", { item: { source: "dated", id: 4, revision: 2 }, to: { day: local(NOW + 3 * DAY), time: null } });
  });

  it("a later mail's move of an item the user changed: who says what now, and Use takes it", async () => {
    const proposal: ScheduleProposal = { dueDay: local(NOW + 5 * DAY), dueAt: NOW + 5 * DAY, timed: false, by: "Elena Ruiz", messageId: 9, at: NOW };
    await render(row({ changedAt: NOW - DAY, proposal }));
    expect(q("thread-dated-proposal-text")?.textContent).toMatch(/^Elena says .+ now$/);
    expect(q("thread-dated-proposal-use")?.getAttribute("aria-label")).toMatch(/^Use .+ for Send Elena the signed slip$/);
    await act(async () => q("thread-dated-proposal-use")!.click());
    expect(client.call).toHaveBeenCalledWith("today.schedule", { item: { source: "dated", id: 4, revision: 2 }, to: { accept: true } });
    // none without one
    await render(row({ changedAt: NOW - DAY }));
    expect(q("thread-dated-proposal")).toBeNull();
  });
});
