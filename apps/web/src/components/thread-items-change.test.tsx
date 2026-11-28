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
const model = (r: DatedRow, open = r.state === "open") => ({ top: { key: `dated:${r.id}`, ref: { source: "dated" as const, id: r.id }, open, missed: false, dueAt: r.dueAt, source: "dated" as const, row: r }, others: [], targeted: true, chose: false, waiting: null, waitingRow: null, ready: true, choose: () => {}, chooseWaiting: () => {}, shown: true, setShown: () => {} });

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

describe("the reader's line (plan 210, iteration 5, R8)", () => {
  it("the sentence is a line of its own, the card's width; its controls are under it, on its edge, in their order", async () => {
    await render(row());
    const line = q("thread-dated-item")!;
    // a column: the sentence first, the controls after it, nothing beside the sentence
    expect(line.className).toContain("flex-col");
    expect([...line.children].map((c) => (c as HTMLElement).dataset.testid)).toEqual(["thread-dated-text", "thread-dated-controls"]);
    expect(q("thread-dated-text")!.className).toContain("w-full");
    expect([...q("thread-dated-controls")!.querySelectorAll("button")].map((b) => b.dataset.testid)).toEqual(["thread-dated-done", "thread-dated-later", "thread-dated-change", "thread-dated-hand", "thread-dated-dismiss"]);
    // a history line opened: what happened, under the sentence too
    await render(row({ state: "done", closedAt: NOW }), false);
    expect([...q("thread-dated-item")!.children].map((c) => (c as HTMLElement).dataset.testid)).toEqual(["thread-dated-text", "thread-dated-outcome"]);
  });
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

describe("plan 216: the open waiting row's line in the reader", () => {
  const reply = { since: NOW - 2 * DAY, rev: 3, message: 90 };
  const thread = { id: 7, fromName: "Lucas Fajardo", fromEmail: "lucas@iuspro.test", subject: "IusPro - Colombia", lastDate: NOW - 2 * DAY, waitingSince: NOW - 2 * DAY };
  const waitingRow = (held = false) => ({
    id: "waiting:7" as const,
    threadId: 7,
    entry: { id: "waiting:7" as const, thread, why: { kind: "waiting" as const, wrote: true, reply } },
    ...(held ? { held: true } : { task: { kind: "waiting" as const, threadId: 7, since: reply.since, message: 90, rev: 3, name: "Lucas Fajardo", noDay: true as const } }),
  });
  const waitingModel = (o: { held?: boolean; also?: DatedRow } = {}) => ({
    ...model(o.also ?? row()),
    ...(o.also ? {} : { top: null }),
    waiting: o.also ? ("also" as const) : ("top" as const),
    waitingRow: waitingRow(o.held) as never,
    targeted: false,
  });
  const show = async (m: ReturnType<typeof waitingModel>) => {
    if (!root) {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    }
    await act(async () => root!.render(<ThreadItems detail={detail} items={m as never} />));
  };

  it("says who is waiting and since when, with the row's Done, Later and Remove, named for a screen reader; Remove is the row's act", async () => {
    await show(waitingModel());
    expect(q("thread-dated-item")?.dataset.source).toBe("waiting");
    expect(q("thread-dated-text")?.textContent).toMatch(/^Lucas Fajardo is waiting on your reply · since /u);
    expect([...q("thread-dated-controls")!.querySelectorAll("button")].map((b) => [b.dataset.testid, b.getAttribute("aria-label")])).toEqual([
      ["thread-dated-done", "Done: Lucas Fajardo"],
      ["thread-dated-later", "Later: Lucas Fajardo"],
      ["thread-dated-dismiss", "Remove from “What matters”: Lucas Fajardo"],
    ]);
    await act(async () => q("thread-dated-dismiss")!.click());
    expect(vi.mocked(client.call)).toHaveBeenCalledWith("today.waitingAct", { threadId: 7, since: reply.since, message: 90, rev: 3, action: "remove" });
  });

  it("an item chosen leads, the waiting line first on its Also line; a row held after an act elsewhere shows nothing", async () => {
    await show(waitingModel({ also: row() }));
    expect(q("thread-dated-item")?.dataset.source).toBe("dated");
    const also = [...document.querySelectorAll<HTMLElement>("[data-testid=thread-dated-also-item]")];
    expect(also.map((b) => b.dataset.key)).toEqual(["waiting"]);
    expect(also[0]!.textContent).toMatch(/^Lucas Fajardo is waiting on your reply/u);
    await show(waitingModel({ held: true }));
    expect(q("thread-dated")).toBeNull();
  });
});

describe("plan 216 (Codex code review, #4): a line that goes holding the focus", () => {
  it("leaves the keys on the feed's open row, whenever it goes (an item's line replaced by the waiting line once the act's reply comes)", async () => {
    const { setApp } = await import("~/state/app");
    const { useFeedRow } = await import("~/state/today");
    const feedHost = document.createElement("section");
    feedHost.dataset.testid = "wm-feed";
    feedHost.innerHTML = `<div data-row-id="waiting:7"><button data-testid="wm-item-open">row</button></div>`;
    document.body.append(feedHost);
    setApp({ today: true });
    useFeedRow.setState({ opened: "waiting:7" });
    try {
      await render(row());
      q("thread-dated-done")!.focus();
      expect(document.activeElement).toBe(q("thread-dated-done"));
      // later, the reply: the item's line goes, the waiting line leads
      const waiting = { ...model(row()), top: null, waiting: "top" as const, waitingRow: { id: "waiting:7", threadId: 7, entry: { id: "waiting:7", thread: { id: 7, fromName: "Lucas", fromEmail: "l@x.test", subject: "S", lastDate: NOW }, why: { kind: "waiting", wrote: true } }, task: { kind: "waiting", threadId: 7, since: NOW, message: 1, rev: 0, name: "Lucas", noDay: true } } as never };
      await act(async () => root!.render(<ThreadItems detail={detail} items={waiting} />));
      await vi.waitFor(() => expect(document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id")).toBe("waiting:7"));
    } finally {
      setApp({ today: false });
      useFeedRow.setState({ opened: null });
    }
  });
});

describe("plan 216 (Codex code review, round 2): the line going while its Later menu holds the focus", () => {
  it("leaves the keys on the feed's open row, not the page", async () => {
    const { setApp } = await import("~/state/app");
    const { useFeedRow } = await import("~/state/today");
    const feedHost = document.createElement("section");
    feedHost.dataset.testid = "wm-feed";
    feedHost.innerHTML = `<div data-row-id="waiting:7"><button data-testid="wm-item-open">row</button></div>`;
    document.body.append(feedHost);
    setApp({ today: true, view: "all" });
    useFeedRow.setState({ opened: "waiting:7" });
    try {
      await render(row());
      await act(async () => q("thread-dated-later")!.click());
      const preset = await vi.waitFor(() => {
        const item = document.querySelector<HTMLElement>("[data-testid=thread-dated-later-menu] [role=menuitem]");
        expect(item).toBeTruthy();
        return item!;
      });
      preset.focus();
      expect(document.activeElement).toBe(preset);
      // its row acted on: the reader shows nothing for it any more
      await act(async () => root!.render(<ThreadItems detail={detail} items={{ ...model(row()), top: null, ready: true } as never} />));
      await vi.waitFor(() => expect(document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id")).toBe("waiting:7"));
    } finally {
      setApp({ today: false });
      useFeedRow.setState({ opened: null });
    }
  });
});
