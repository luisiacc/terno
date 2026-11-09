// @vitest-environment jsdom
import type { DigestRow } from "@terno/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
Element.prototype.scrollIntoView = function () {};
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

// the page reads its row from the backend: whatever the test says it is now
let served: DigestRow | null = null;
// the archive's answer, when the page asks for one
let archived = { undoId: 5 as number | null, archived: 0, archivedIds: [] as number[], changed: 0, spared: 0 };
let undoFails = false;
// plan 166: what the list's cap dropped, when the page says a sender isn't a newsletter
let evicted: { id: string; email: string; name: string; at: number }[] = [];
const calls: { method: string; params: unknown }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "today.digestArchive") return archived;
      if (method === "today.notNewsletter") return { added: { ...(params as object), id: "e7", at: 7 }, evicted: evicted };
      if (method === "today.notNewslettersUndo") return { restored: 1 };
      if (method === "today.newsletterAgain") return { removed: { email: (params as { email: string }).email, name: "x", at: 7 } };
      if (method === "threads.undo") {
        if (undoFails) throw new Error("That can no longer be undone.");
        return { restored: 1 };
      }
      return served;
    }),
    on: () => () => {},
    connectionVersion: 1,
  },
}));

const { default: DigestPage } = await import("./digest-page");
const { useToday } = await import("~/state/today");
const { dismissSnack: dismissSnackNow, undoNow, useSnack } = await import("~/lib/snack");
const { getApp } = await import("~/state/app");

/** plan 162: the page's own Undo shows once the snack carrying the same one is gone: the snack goes, then it's pressed */
async function undoInline() {
  await act(async () => dismissSnackNow());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-undo]")!.click());
}

const item = (id: number) => ({ threadId: id, messageId: id, lastDate: 1, messageCount: 1, from: `Sender ${id}`, fromEmail: `news@sender${id}.test`, subject: `Issue ${id}`, line: `Line ${id}` });
const digestOf = (day: string, automated = false): DigestRow => ({ day, state: "ready", automated, items: [1, 2, 3].map(item), liveIds: [1, 2, 3], model: "m" });

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const ticks = () => [...host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")].map((b) => b.getAttribute("aria-checked") === "true" || b.hasAttribute("data-checked"));
const page = () => host.querySelector<HTMLElement>("[data-testid=digest-page]")!;
/** ai-r03: the pane scrolls, not the page in it (the page had no height to scroll in) */
const scroller = () => host.querySelector<HTMLElement>("[data-testid=digest-scroller]")!;
async function show(row: DigestRow) {
  served = row;
  await act(async () => useToday.setState({ digest: row }));
  await act(async () => root.render(<DigestPage key={Math.random()} />));
}
const unmount = () => act(() => root.render(<></>));

beforeEach(() => useToday.setState({ pick: null, digest: null, notNewsletters: new Set() }));

it("plan 161: what was unticked, and where it was scrolled, survive opening a source (the page unmounting)", async () => {
  await show(digestOf("2026-10-22"));
  expect(ticks()).toEqual([true, true, true]);
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[1]!.click());
  expect(ticks()).toEqual([true, false, true]);
  await act(async () => {
    scroller().scrollTop = 140;
    scroller().dispatchEvent(new Event("scroll"));
  });
  await unmount();
  await show(digestOf("2026-10-22"));
  expect(ticks()).toEqual([true, false, true]);
  expect(scroller().scrollTop).toBe(140);
  // pass 2: the button says what goes, the line what stays
  expect(host.querySelector("[data-testid=digest-archive]")!.textContent).toBe("Archive 2");
  expect(host.querySelector("[data-testid=digest-count]")!.textContent).toContain("2 to archive · 1 stays in Inbox");
});

it("plan 161 (Codex review): a new day starts afresh, its scroll too; automated mail's picks don't turn into the digest's", async () => {
  await show(digestOf("2026-10-22"));
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[0]!.click());
  await act(async () => {
    scroller().scrollTop = 200;
    scroller().dispatchEvent(new Event("scroll"));
  });
  // the next day's arrives while the page is open
  served = digestOf("2026-10-23");
  await act(async () => useToday.setState({ digest: served }));
  expect(ticks()).toEqual([true, true, true]);
  expect(scroller().scrollTop).toBe(0);
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

const states = () => [...host.querySelectorAll<HTMLElement>("[data-testid=digest-item]")].map((li) => `${li.dataset.state}:${li.querySelector("[data-testid=digest-state]")?.textContent ?? ""}`);

it("pass 2: each row says what it is; what was opened isn't counted, and the button's count is what goes", async () => {
  await show({ ...digestOf("2026-10-22"), liveIds: [1, 3], readIds: [2] });
  expect(states()).toEqual(["archive:", "opened:Opened · stays in Inbox", "archive:"]);
  expect(host.querySelector("[data-testid=digest-archive]")!.textContent).toBe("Archive 2");
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[2]!.click());
  expect(states()).toEqual(["archive:", "opened:Opened · stays in Inbox", "keep:Stays in Inbox"]);
  expect(host.querySelector("[data-testid=digest-count]")!.textContent).toContain("1 to archive · 2 stay in Inbox");
  expect(host.querySelector("[data-testid=digest-archive]")!.textContent).toBe("Archive 1");
  // the tick is a 24 px control itself, not a pseudo-element around a 16 px box
  expect(host.querySelector("[data-testid=digest-tick]")!.className).toContain("size-6");
});

it("plan 162 (after ai162-r02): opening one keeps it at once, before the backend's read mark, and the keys on the page are the list's", async () => {
  // the backend still calls all three unread and live: the read mark lands after the reader's dwell
  await show(digestOf("2026-10-22"));
  // opened afresh, the page has the keys: its first row is the cursor
  expect(document.activeElement?.getAttribute("data-digest-open")).toBe("1");
  const { digestKeys } = await import("~/state/today");
  expect(digestKeys.current!.has()).toBe(true);
  await act(async () => digestKeys.current!.step(1));
  expect(document.activeElement?.getAttribute("data-digest-open")).toBe("2");
  // x unticks the cursor's row, and ticks it again
  await act(async () => digestKeys.current!.toggle());
  expect(ticks()).toEqual([true, false, true]);
  await act(async () => digestKeys.current!.toggle());
  expect(ticks()).toEqual([true, true, true]);
  // Enter opens it: read at once (not after the reader's dwell), and kept whichever way the page is come back to
  calls.length = 0;
  await act(async () => digestKeys.current!.open());
  expect(calls.filter((c) => c.method === "threads.act").map((c) => c.params)).toEqual([{ threadIds: [2], action: "markRead" }]);
  await unmount();
  await show(digestOf("2026-10-22"));
  expect(states()).toEqual(["archive:", "opened:Opened · stays in Inbox", "archive:"]);
  expect(host.querySelector("[data-testid=digest-archive]")!.textContent).toBe("Archive 2");
  expect(host.querySelector("[data-testid=digest-count]")!.textContent).toContain("2 to archive · 1 stays in Inbox");
  // back on the row it was opened from; its box can't be ticked again (opened is read and stays, plan 145)
  expect(document.activeElement?.getAttribute("data-digest-open")).toBe("2");
  expect(host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[1]!.hasAttribute("data-disabled")).toBe(true);
  await act(async () => digestKeys.current!.toggle());
  expect(ticks()).toEqual([true, false, true]);
  // Tick all and Untick all leave it out too
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-tick-all]")!.click());
  expect(ticks()).toEqual([false, false, false]);
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-tick-all]")!.click());
  expect(ticks()).toEqual([true, false, true]);
});

it("plan 162 (after ai162-r02, Codex review): opened here, then archived elsewhere, it says archived, not that it stays", async () => {
  await show(digestOf("2026-10-22"));
  const { digestKeys } = await import("~/state/today");
  await act(async () => digestKeys.current!.step(1));
  await act(async () => digestKeys.current!.open());
  await unmount();
  // archived in another window meanwhile: out of the Inbox, and not among the read ones still there
  await show({ ...digestOf("2026-10-22"), liveIds: [1, 3], readIds: [] });
  expect(states()).toEqual(["archive:", "archived:Archived", "archive:"]);
  expect(host.querySelector("[data-testid=digest-count]")!.textContent).toContain("2 to archive");
  expect(host.querySelector("[data-testid=digest-count]")!.textContent).not.toContain("stay");
});

it("pass 2: after Archive, what it archived leaves the page, the rest stays under its own heading, and Undo ends it", async () => {
  calls.length = 0;
  archived = { undoId: 5, archived: 2, archivedIds: [1, 3], changed: 0, spared: 0 };
  await show(digestOf("2026-10-22"));
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[1]!.click());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  expect((calls.find((c) => c.method === "today.digestArchive")!.params as { items: { threadId: number }[] }).items.map((i) => i.threadId)).toEqual([1, 3]);
  // the backend's answer: two gone, one kept
  served = { ...digestOf("2026-10-22"), liveIds: [2], readIds: [] };
  await act(async () => useToday.setState({ digest: served }));
  expect(host.querySelector("[data-testid=digest-done]")!.textContent).toBe("Archived 2 newsletters.");
  expect(host.querySelector("[data-testid=digest-still-here]")).not.toBeNull();
  expect(states()).toEqual(["keep:Stays in Inbox"]);
  expect(host.querySelector("[data-testid=digest-archive]")).toBeNull();
  // it outlives the page, as the rest of the pick does
  await unmount();
  await show(served);
  expect(states()).toEqual(["keep:Stays in Inbox"]);
  await undoInline();
  await vi.waitFor(() => expect(host.querySelector("[data-testid=digest-done]")).toBeNull());
  served = digestOf("2026-10-22");
  await act(async () => useToday.setState({ digest: served }));
  expect(states()).toEqual(["archive:", "keep:Stays in Inbox", "archive:"]);
});

it("plan 162: one Undo at a time: the page's waits for the snack carrying the same one to go", async () => {
  archived = { undoId: 11, archived: 1, archivedIds: [1], changed: 0, spared: 0 };
  await show(digestOf("2026-10-22"));
  for (const i of [1, 2]) await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[i]!.click());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  expect(host.querySelector("[data-testid=digest-done]")).not.toBeNull();
  expect(host.querySelector("[data-testid=digest-undo]")).toBeNull();
  await act(async () => dismissSnackNow());
  expect(host.querySelector("[data-testid=digest-undo]")).not.toBeNull();
});

it("plan 162: Tick all and Untick all reset the ticks at once, both ways", async () => {
  await show(digestOf("2026-10-22"));
  expect(host.querySelector("[data-testid=digest-tick-all]")!.textContent).toBe("Untick all");
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-tick-all]")!.click());
  expect(ticks()).toEqual([false, false, false]);
  expect(host.querySelector("[data-testid=digest-archive]")!.hasAttribute("disabled")).toBe(true);
  expect(host.querySelector("[data-testid=digest-tick-all]")!.textContent).toBe("Tick all");
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-tick-all]")!.click());
  expect(ticks()).toEqual([true, true, true]);
});

it("plan 162: the header says what the batch was, the day it reaches back to", async () => {
  await show(digestOf("2026-10-22"));
  expect(host.querySelector("[data-testid=digest-coverage]")!.textContent).toMatch(/^Prepared today from 3 newsletters since \w{3}, \w{3} \d+(, \d{4})?$/);
});

it("pass 2: everything archived says it's all done", async () => {
  archived = { undoId: 6, archived: 3, archivedIds: [1, 2, 3], changed: 0, spared: 0 };
  await show(digestOf("2026-10-22"));
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  served = { ...digestOf("2026-10-22"), liveIds: [], readIds: [] };
  await act(async () => useToday.setState({ digest: served }));
  expect(host.querySelector("[data-testid=digest-all-done]")!.textContent).toBe("All done for today.");
  expect(host.querySelectorAll("[data-testid=digest-item]")).toHaveLength(0);
});

it("Codex review: one archived elsewhere meanwhile stays listed, said so; a second Archive's Undo leaves the first done", async () => {
  // 2 was archived in another window after the page drew: the backend skips it
  archived = { undoId: 7, archived: 1, archivedIds: [1], changed: 1, spared: 0 };
  await show({ ...digestOf("2026-10-22"), liveIds: [1, 2, 3] });
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[2]!.click());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  served = { ...digestOf("2026-10-22"), liveIds: [3], readIds: [] };
  await act(async () => useToday.setState({ digest: served }));
  expect(states()).toEqual(["archived:Archived", "keep:Stays in Inbox"]);
  expect(host.querySelector("[data-testid=digest-done]")!.textContent).toBe("Archived 1 newsletter.");
  // then the kept one too, and that one's Undo: the first Archive stays done
  archived = { undoId: 8, archived: 1, archivedIds: [3], changed: 0, spared: 0 };
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[1]!.click());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  served = { ...digestOf("2026-10-22"), liveIds: [], readIds: [] };
  await act(async () => useToday.setState({ digest: served }));
  expect(host.querySelector("[data-testid=digest-done]")!.textContent).toContain("Archived 2 newsletters.");
  await undoInline();
  served = { ...digestOf("2026-10-22"), liveIds: [3], readIds: [] };
  await act(async () => useToday.setState({ digest: served }));
  await vi.waitFor(() => expect(host.querySelector("[data-testid=digest-done]")!.textContent).toBe("Archived 1 newsletter."));
  expect(states()).toEqual(["archived:Archived", "archive:"]);
});

it("Codex review: an inline Undo that fails says so, with a retry", async () => {
  const { useSnack } = await import("~/lib/snack");
  archived = { undoId: 9, archived: 1, archivedIds: [1], changed: 0, spared: 0 };
  await show(digestOf("2026-10-22"));
  for (const i of [1, 2]) await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[i]!.click());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  undoFails = true;
  await undoInline();
  await vi.waitFor(() => expect(JSON.stringify(useSnack.getState())).toContain("can no longer be undone"));
  undoFails = false;
  expect(host.querySelector("[data-testid=digest-done]")).not.toBeNull();
});

it("Codex review, round 2: an older day's Undo leaves today's page as it was left", async () => {
  const { useSnack, runUndo } = await import("~/lib/snack");
  archived = { undoId: 10, archived: 1, archivedIds: [1], changed: 0, spared: 0 };
  await show(digestOf("2026-10-22"));
  for (const i of [1, 2]) await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[i]!.click());
  await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
  const old = useSnack.getState().undo!;
  // the next day's digest, and a choice made on it
  served = digestOf("2026-10-23");
  await act(async () => useToday.setState({ digest: served }));
  await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[0]!.click());
  expect(ticks()).toEqual([false, true, true]);
  await act(async () => runUndo(old));
  expect(useToday.getState().pick?.day).toBe("2026-10-23|digest");
  expect([...useToday.getState().pick!.toggled]).toEqual([1]);
  expect(ticks()).toEqual([false, true, true]);
});

it("pass 3: who wrote the lines is said in the header, before the list, and not at its foot; the ticks are the quiet ones", async () => {
  await show(digestOf("2026-10-22"));
  const said = host.querySelector<HTMLElement>("[data-testid=digest-provenance]")!;
  expect(said.textContent).toBe("Written with AI");
  expect(said.closest("header")).not.toBeNull();
  expect(said.compareDocumentPosition(host.querySelector("[data-testid=digest-item]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(page().textContent).not.toContain("It can make mistakes");
  expect([...host.querySelectorAll("[data-testid=digest-tick]")].every((b) => b.hasAttribute("data-quiet"))).toBe(true);
  // automated mail wasn't written by a model: nothing to attribute
  await show(digestOf("2026-10-22", true));
  expect(host.querySelector("[data-testid=digest-provenance]")).toBeNull();
});

it("plan 162 (Codex review): a digest that failed for a reason Settings fixes offers AI settings beside Try again; one that timed out doesn't", async () => {
  await show({ ...digestOf("2026-10-22"), state: "failed", errorKind: "auth" } as DigestRow);
  expect(host.querySelector("[data-testid=digest-retry]")).not.toBeNull();
  expect(host.querySelector("[data-testid=digest-error-settings]")!.textContent).toBe("AI settings");
  await unmount();
  await show({ ...digestOf("2026-10-22"), state: "failed", errorKind: "rate_limited" } as DigestRow);
  expect(host.querySelector("[data-testid=digest-retry]")).not.toBeNull();
  expect(host.querySelector("[data-testid=digest-error-settings]")).toBeNull();
});

it("plan 162 (Codex review): a digest whose provider answered with an error says so, not that it couldn't be reached", async () => {
  await show({ ...digestOf("2026-10-22"), state: "failed", errorKind: "provider_error" } as DigestRow);
  expect(host.querySelector("[data-testid=digest-failed-text]")!.textContent).toMatch(/answered with an error/);
  expect(host.querySelector("[data-testid=digest-failed-text]")!.textContent).not.toMatch(/reach/i);
  await unmount();
  await show({ ...digestOf("2026-10-22"), state: "failed", errorKind: "provider_not_found" } as DigestRow);
  expect(host.querySelector("[data-testid=digest-failed-text]")!.textContent).toMatch(/doesn’t have that model/);
  await unmount();
  // a key without permission isn't a rejected key, and Settings fix it
  await show({ ...digestOf("2026-10-22"), state: "failed", errorKind: "provider_no_permission" } as DigestRow);
  expect(host.querySelector("[data-testid=digest-failed-text]")!.textContent).toMatch(/refused this request for your key: it doesn’t have permission/);
  expect(host.querySelector("[data-testid=digest-error-settings]")).not.toBeNull();
});

describe("plan 166: Not a newsletter", () => {
  const senders = () => [...host.querySelectorAll("[data-testid=digest-from]")].map((e) => e.textContent);
  const undoSnack = () => act(async () => undoNow(useSnack.getState().current!.action!.undo!));

  it("the row's control: its sender leaves the page and Archive at once, no model, no opening; Undo brings it back as it was", async () => {
    await show(digestOf("2026-10-22"));
    useToday.setState({ fromDigest: null });
    // unticked first: Undo must bring it back unticked, after an Untick all / Tick all in between (Codex critique)
    await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-tick]")[1]!.click());
    calls.length = 0;
    const control = host.querySelectorAll<HTMLElement>("[data-testid=digest-not-newsletter]")[1]!;
    expect(control.getAttribute("aria-label")).toBe("Not a newsletter");
    // beside Open, never inside it
    expect(control.closest("[data-testid=digest-open]")).toBeNull();
    await act(async () => control.click());
    expect(senders()).toEqual(["Sender 1", "Sender 3"]);
    expect(host.querySelector("[data-testid=digest-archive]")!.textContent).toBe("Archive 2");
    expect(calls.map((c) => c.method).filter((m) => m !== "today.digest" && m !== "threads.list" && m !== "today.list")).toEqual(["today.notNewsletter"]);
    expect(calls[0]!.params).toEqual({ email: "news@sender2.test", name: "Sender 2" });
    expect(useToday.getState().fromDigest).toBeNull();
    // Today's header counts without it at once
    expect(useToday.getState().digest!.liveIds).toEqual([1, 3]);
    // whatever a read brings meanwhile (the backend's answer from before), it stays out
    await act(async () => useToday.setState({ digest: digestOf("2026-10-22") }));
    expect(senders()).toEqual(["Sender 1", "Sender 3"]);
    await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-tick-all]")!.click());
    expect(ticks()).toEqual([false, false]);
    await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-tick-all]")!.click());
    expect(useSnack.getState().current!.message).toBe("Sender 2 won't be in your digest");
    await undoSnack();
    expect(calls.find((c) => c.method === "today.notNewslettersUndo")!.params).toEqual({ remove: { email: "news@sender2.test", id: "e7" }, restore: [] });
    await act(async () => useToday.setState({ digest: digestOf("2026-10-22") }));
    expect(senders()).toEqual(["Sender 1", "Sender 2", "Sender 3"]);
    expect(ticks()).toEqual([true, false, true]);
  });

  it("the row's menu: Open, and Not a newsletter, which gives the keys back to the page and lands them on the next row", async () => {
    await show(digestOf("2026-10-22"));
    const row = host.querySelectorAll<HTMLElement>("[data-testid=digest-item]")[0]!;
    expect(row.hasAttribute("data-context-menu")).toBe(true);
    host.querySelectorAll<HTMLElement>("[data-testid=digest-open]")[0]!.focus();
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 })));
    const item = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-testid=digest-menu-not-newsletter]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(document.querySelector("[data-testid=digest-menu-open]")!.textContent).toBe("Open");
    expect(getApp().menuOpen).toBe(true);
    await act(async () => item.click());
    expect(senders()).toEqual(["Sender 2", "Sender 3"]);
    expect(getApp().menuOpen).toBe(false);
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(host.querySelector("[data-digest-open='2']"));
  });

  it("Codex review: a sender the cap dropped isn't hidden here any more, Undo hides it again; a long name is kept to 200", async () => {
    await show(digestOf("2026-10-22"));
    useToday.setState({ notNewsletters: new Set(["news@sender3.test"]) });
    evicted = [{ id: "e3", email: "news@sender3.test", name: "Sender 3", at: 1 }];
    try {
      await act(async () => useToday.setState({ digest: { ...digestOf("2026-10-22"), items: [1, 2, 3].map((id) => ({ ...item(id), from: id === 1 ? "N".repeat(300) : `Sender ${id}` })) } }));
      calls.length = 0;
      await act(async () => host.querySelectorAll<HTMLElement>("[data-testid=digest-not-newsletter]")[0]!.click());
      expect((calls.find((c) => c.method === "today.notNewsletter")!.params as { name: string }).name).toHaveLength(200);
      expect([...useToday.getState().notNewsletters]).toEqual(["news@sender1.test"]);
      await undoSnack();
      expect(calls.find((c) => c.method === "today.notNewslettersUndo")!.params).toEqual({ remove: { email: "news@sender1.test", id: "e7" }, restore: evicted });
      expect([...useToday.getState().notNewsletters]).toEqual(["news@sender3.test"]);
    } finally {
      evicted = [];
    }
  });

  it("automated mail has neither: nothing there has said these are newsletters", async () => {
    await show(digestOf("2026-10-22", true));
    expect(host.querySelectorAll("[data-testid=digest-not-newsletter]")).toHaveLength(0);
    expect(host.querySelector("[data-testid=digest-item]")!.hasAttribute("data-context-menu")).toBe(false);
  });

  it("Archive names each row's sender, so one said not to be a newsletter meanwhile is left alone", async () => {
    await show(digestOf("2026-10-22"));
    calls.length = 0;
    await act(async () => host.querySelector<HTMLElement>("[data-testid=digest-archive]")!.click());
    expect((calls.find((c) => c.method === "today.digestArchive")!.params as { items: { fromEmail?: string }[] }).items.map((i) => i.fromEmail)).toEqual(["news@sender1.test", "news@sender2.test", "news@sender3.test"]);
  });
});
