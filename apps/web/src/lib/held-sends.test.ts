// @vitest-environment jsdom
/** Plan 182: Send's Undo window as a card where the copy will be, the dock only where no card shows it. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, onAttach: () => () => {} } }));

const { heldBodyId, heldWent, holdSend, copyShown, heldById, resetHeldSends, settleOverdue, setHeldThreadOpener, undoHeld, useHeldCard, useHeldSends } = await import("./held-sends");
const { resetSnacks, runUndo, snack, useSnack } = await import("./snack");
const { frameHeight, rememberHeight } = await import("./frame-heights");
const { getApp, setApp, useApp } = await import("~/state/app");
const { useDrafts } = await import("./drafts");

const HOLD = 5000;
const flushFrames = () => vi.advanceTimersByTime(40);

/** a hold of draft `draftId` in conversation `threadId` (null: a new message), its cancel answering `answer` */
function hold(draftId: number, threadId: number | null, answer: (cancelled: () => void) => Promise<boolean> = async (c) => (c(), true)) {
  const cancel = vi.fn(answer);
  holdSend({ draftId, accountId: 1, threadId, mode: threadId === null ? "new" : "reply", subject: "Lunch", to: [{ name: "Bea", email: "bea@example.com" }], cc: [], bodyHtml: null, bodyText: "Thursday works.", attachments: [], goesAt: Date.now() + HOLD, windowMs: HOLD, sentHere: true, cancel });
  return cancel;
}

/** a card on screen for `draftId` while the returned unmount isn't called */
function card(draftId: number, visible = true): () => void {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const Card = ({ v }: { v: boolean }) => (useHeldCard(draftId, v), null);
  act(() => root.render(createElement(Card, { v: visible })));
  return () => act(() => root.unmount());
}

const dockOffers = (draftId: number) => useSnack.getState().current?.id === `held-send-${draftId}` && useSnack.getState().current?.action !== undefined;

afterEach(() => {
  resetHeldSends();
  resetSnacks();
  setApp({ heldView: null, compose: null });
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the window", () => {
  it("counts down to its end, then sends: the card's Undo and z go with it", () => {
    vi.useFakeTimers();
    const unmount = card(1);
    hold(1, 10);
    flushFrames();
    expect(heldById(1)?.phase).toBe("holding");
    expect(useSnack.getState().undo).toBe(heldById(1)?.undo);
    // the card shows it: the dock says nothing
    expect(useSnack.getState().current).toBeNull();
    vi.advanceTimersByTime(HOLD);
    expect(heldById(1)?.phase).toBe("sending");
    expect(useSnack.getState().undo).toBeNull();
    unmount();
  });

  it("no card shows it (the pinned card, another conversation): the dock offers Undo for the time left; a card coming back takes it", () => {
    vi.useFakeTimers();
    hold(2, 10);
    flushFrames();
    expect(dockOffers(2)).toBe(true);
    expect(useSnack.getState().current?.duration).toBeLessThanOrEqual(HOLD);
    vi.advanceTimersByTime(2000);
    const unmount = card(2);
    expect(useSnack.getState().current).toBeNull();
    // left again: the dock again, with what's left of the window
    unmount();
    flushFrames();
    expect(dockOffers(2)).toBe(true);
    expect(useSnack.getState().current!.duration).toBeLessThanOrEqual(HOLD - 2000);
    // its end in the dock: the spinner goes on, Undo's gone (plan 158)
    vi.advanceTimersByTime(HOLD);
    expect(useSnack.getState().current).toMatchObject({ tone: "loading" });
    expect(useSnack.getState().current?.action).toBeUndefined();
  });

  it("a card covered by the full-message view counts as not shown (Codex critique #9)", () => {
    vi.useFakeTimers();
    const unmount = card(3, false);
    hold(3, 10);
    flushFrames();
    expect(dockOffers(3)).toBe(true);
    unmount();
  });

  it("the dock's result already waiting at the window's end takes the dock (plan 158)", () => {
    vi.useFakeTimers();
    hold(4, 10);
    flushFrames();
    snack.success("Message sent", { background: true });
    vi.advanceTimersByTime(HOLD);
    expect(useSnack.getState().current?.message).toBe("Message sent");
  });

  it("is bounded: settled a send's deadline after its window, even if nothing ever came", () => {
    vi.useFakeTimers();
    const unmount = card(5);
    hold(5, 10);
    vi.advanceTimersByTime(HOLD + 30_000);
    expect(heldById(5)).toBeUndefined();
    unmount();
  });

  it("a connection again settles what's past its window (its event may have been missed)", () => {
    vi.useFakeTimers();
    const unmount = card(6);
    hold(6, 10);
    hold(7, 10);
    settleOverdue();
    expect(heldById(6)).toBeDefined();
    vi.advanceTimersByTime(HOLD);
    settleOverdue();
    expect(useHeldSends.getState().holds).toHaveLength(0);
    unmount();
  });
});

describe("Undo", () => {
  it("won: the card stays, busy, until its draft shows, and gives way in that same change; nothing can take it back again (plan 271; plan 182's critique #7)", async () => {
    let reopened!: () => void;
    const unmount = card(11);
    const cancel = hold(11, 10, async (cancelled) => {
      cancelled();
      await new Promise<void>((r) => (reopened = r));
      return true;
    });
    undoHeld(11);
    await vi.waitFor(() => expect(reopened).toBeTypeOf("function"));
    // taken back: still shown (no frame of neither), busy
    expect(heldById(11)?.phase).toBe("undoing");
    // a second press, or z, runs nothing more
    undoHeld(11);
    expect(cancel).toHaveBeenCalledTimes(1);
    // past its window: a reconnect's catch-up doesn't take the card mid-reopen (Codex code review #8)
    const now = Date.now;
    Date.now = () => now() + 60_000;
    try {
      settleOverdue();
    } finally {
      Date.now = now;
    }
    expect(heldById(11)).toBeDefined();
    // another draft shown: not its own
    useDrafts.setState({ drafts: { k11: { id: 11 }, other: { id: 99 } } as never });
    setApp({ draftShown: { threadId: 10, key: "other" } });
    expect(heldById(11)).toBeDefined();
    // its draft shown in its conversation's slot: the card goes in the same store change
    const seen: (boolean | undefined)[] = [];
    const off = useApp.subscribe((s) => seen.push(s.draftShown?.key === "k11" ? heldById(11) === undefined : undefined));
    setApp({ draftShown: { threadId: 10, key: "k11" } });
    off();
    expect(heldById(11)).toBeUndefined();
    expect(seen.filter((x) => x !== undefined)).toEqual([true]);
    reopened();
    unmount();
    setApp({ draftShown: null });
  });

  it("won, its draft slow to show: its send's own deadlines are retired, so the card waits for it (plan 271, Codex code review #8)", async () => {
    vi.useFakeTimers();
    let reopened!: () => void;
    hold(16, 10, async (cancelled) => {
      cancelled();
      await new Promise<void>((r) => (reopened = r));
      return true;
    });
    const unmount = card(16);
    undoHeld(16);
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened).toBeTypeOf("function");
    // past the window and the send's own deadline
    await vi.advanceTimersByTimeAsync(HOLD + 31_000);
    expect(heldById(16)?.phase).toBe("undoing");
    reopened();
    await vi.advanceTimersByTimeAsync(0);
    expect(heldById(16)).toBeUndefined();
    unmount();
  });

  it("won, its draft never shown (kept in Drafts, the reopen failed): the Undo's end settles it (plan 271)", async () => {
    const unmount = card(14);
    hold(14, 10, async (cancelled) => (cancelled(), true));
    await runUndo(heldById(14)!.undo);
    expect(heldById(14)).toBeUndefined();
    unmount();
  });

  it("won, a new message: the composer opened on its draft takes the card's place in the same change (plan 271)", async () => {
    let reopened!: () => void;
    hold(15, null, async (cancelled) => {
      cancelled();
      await new Promise<void>((r) => (reopened = r));
      return true;
    });
    setApp({ heldView: 15 });
    undoHeld(15);
    await vi.waitFor(() => expect(reopened).toBeTypeOf("function"));
    expect(heldById(15)).toBeDefined();
    useDrafts.setState({ drafts: { k15: { id: 15 } } as never });
    setApp({ compose: { key: "k15", seq: 1 } });
    expect(heldById(15)).toBeUndefined();
    reopened();
    setApp({ compose: null, heldView: null });
  });

  it("too late: the card goes on to Sending… and its copy", async () => {
    const unmount = card(12);
    hold(12, 10, async () => false);
    await runUndo(heldById(12)!.undo);
    expect(heldById(12)?.phase).toBe("sending");
    unmount();
  });

  it("failed: held again, and it can be tried again", async () => {
    const unmount = card(13);
    hold(13, 10, async () => { throw new Error("offline"); });
    await expect(runUndo(heldById(13)!.undo)).rejects.toThrow("offline");
    expect(heldById(13)?.phase).toBe("holding");
    expect(heldById(13)?.undo.state).toBe("ready");
    unmount();
  });

  it("not offered once the window is over here", () => {
    vi.useFakeTimers();
    const cancel = hold(14, 10);
    vi.advanceTimersByTime(HOLD);
    undoHeld(14);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("its copy", () => {
  it("a reply looked at: the card stays until the conversation shows the copy, then gives way", () => {
    const unmount = card(21);
    hold(21, 10);
    heldWent({ draftId: 21, threadId: 10, messageId: 500 });
    expect(heldById(21)).toMatchObject({ phase: "sending", copy: { threadId: 10, messageId: 500 } });
    copyShown(21);
    expect(heldById(21)).toBeUndefined();
    unmount();
  });

  it("its copy's body opens at the card's height, as measured when the copy opens (Codex code review: a copy in the same commit, a card measured again)", () => {
    hold(24, 10);
    rememberHeight(heldBodyId(24), 234);
    heldWent({ draftId: 24, threadId: 10, messageId: 503 });
    rememberHeight(heldBodyId(24), 158);
    expect(frameHeight(503)).toBe(158);
  });

  it("a reply nobody looks at settles when it goes", () => {
    hold(22, 10);
    heldWent({ draftId: 22, threadId: 10, messageId: 501 });
    expect(heldById(22)).toBeUndefined();
  });

  it("a copy in another conversation (a forward, a changed subject) settles here, and is offered there", () => {
    const open = vi.fn();
    setHeldThreadOpener({ open });
    const unmount = card(23);
    hold(23, 10);
    heldWent({ draftId: 23, threadId: 77, messageId: 502 });
    expect(heldById(23)).toBeUndefined();
    const offer = useSnack.getState().current!;
    expect(offer.action?.label).toBe("View");
    offer.action!.onClick!();
    expect(open).toHaveBeenCalledWith(77);
    unmount();
  });

  it("a new message still in its pane opens the conversation it started; moved on, it doesn't", async () => {
    const open = vi.fn();
    setHeldThreadOpener({ open });
    hold(24, null);
    setApp({ heldView: 24 });
    heldWent({ draftId: 24, threadId: 88, messageId: 503 });
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(88));
    expect(getApp().heldView).toBeNull();
    open.mockClear();
    hold(25, null);
    heldWent({ draftId: 25, threadId: 89, messageId: 504 });
    expect(open).not.toHaveBeenCalled();
  });

  it("plan 271: a new message's pane waits for its conversation to hold the copy, then opens it as one morphing change", async () => {
    const open = vi.fn();
    let ready!: (ok: boolean) => void;
    const changes: { update: () => void; pairs: readonly { name: string; find: () => HTMLElement | null }[] }[] = [];
    setHeldThreadOpener({ open, ready: () => new Promise<boolean>((r) => (ready = r)), morph: (update, pairs) => void changes.push({ update, pairs }) });
    // (its pane shows it: the held view is its card)
    const unmount = card(31);
    hold(31, null);
    setApp({ heldView: 31 });
    heldWent({ draftId: 31, threadId: 91, messageId: 601 });
    // not yet: the held view stays (never an empty pane)
    await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
    expect(open).not.toHaveBeenCalled();
    expect(getApp().heldView).toBe(31);
    ready(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]!.pairs.map((p) => p.name)).toEqual(["sent-message"]);
    // the change opens it and settles the hold, together
    changes[0]!.update();
    expect(open).toHaveBeenCalledWith(91);
    expect(heldById(31)).toBeUndefined();
    expect(getApp().heldView).toBeNull();
    unmount();
  });

  it("plan 271: a reconnect's catch-up while the pane reads its conversation leaves it be: it opens when the read comes (Codex code review #1)", async () => {
    const open = vi.fn();
    let ready!: (ok: boolean) => void;
    setHeldThreadOpener({ open, ready: () => new Promise<boolean>((r) => (ready = r)) });
    const unmount = card(35);
    hold(35, null);
    setApp({ heldView: 35 });
    heldWent({ draftId: 35, threadId: 95, messageId: 605 });
    await vi.waitFor(() => expect(ready).toBeTypeOf("function"));
    const now = Date.now;
    Date.now = () => now() + 60_000;
    try {
      settleOverdue();
    } finally {
      Date.now = now;
    }
    expect(heldById(35)).toBeDefined();
    // (the old connection's read answers nothing: it opens the conversation it knows)
    ready(false);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(95));
    unmount();
  });

  it("plan 271: not ready (the read failed, or it's slow), it opens as before; moved on meanwhile, or by the change's frame, it only settles", async () => {
    vi.useFakeTimers();
    try {
      const open = vi.fn();
      const changes: (() => void)[] = [];
      setHeldThreadOpener({ open, ready: () => new Promise<boolean>(() => {}), morph: (update) => void changes.push(update) });
      const cards = [card(32), card(33), card(34)];
      hold(32, null);
      setApp({ heldView: 32 });
      heldWent({ draftId: 32, threadId: 92, messageId: 602 });
      await vi.advanceTimersByTimeAsync(1500);
      expect(open).toHaveBeenCalledWith(92);
      expect(changes).toHaveLength(0);
      // moved on while it waited
      open.mockClear();
      setHeldThreadOpener({ open, ready: async () => true, morph: (update) => void changes.push(update) });
      hold(33, null);
      setApp({ heldView: 33 });
      heldWent({ draftId: 33, threadId: 93, messageId: 603 });
      setApp({ heldView: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(open).not.toHaveBeenCalled();
      expect(heldById(33)).toBeUndefined();
      // moved on by the change's own frame
      hold(34, null);
      setApp({ heldView: 34 });
      heldWent({ draftId: 34, threadId: 94, messageId: 604 });
      await vi.advanceTimersByTimeAsync(0);
      expect(changes).toHaveLength(1);
      setApp({ heldView: null });
      changes[0]!();
      expect(open).not.toHaveBeenCalled();
      expect(heldById(34)).toBeUndefined();
      for (const unmount of cards) unmount();
    } finally {
      vi.useRealTimers();
      setHeldThreadOpener({ open: () => {} });
    }
  });

  it("an event before the hold is recorded (a late answer to compose.hold) still applies (Codex critique #1)", () => {
    heldWent({ draftId: 26, threadId: 10, messageId: 505 });
    hold(26, 10);
    expect(heldById(26)).toBeUndefined();
  });

  it("an event for a draft that isn't held here is only kept briefly", () => {
    for (let i = 0; i < 40; i++) heldWent({ draftId: 1000 + i, threadId: 1, messageId: i });
    const unmount = card(1000);
    hold(1000, 1);
    // pushed out by newer ones: this hold waits for its own event
    expect(heldById(1000)?.phase).toBe("holding");
    unmount();
  });

  it("the sent view gives way to a composer opened or a selection made", () => {
    hold(27, null);
    setApp({ heldView: 27 });
    setApp({ compose: { key: "other", seq: 1 } });
    expect(getApp().heldView).toBeNull();
  });
});

describe("focus (Codex critique #12)", () => {
  it("on Undo as the window ends: kept on the card; the card giving way to its copy: on the copy's header", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<article data-held-send="41" tabindex="-1"><button data-testid="held-undo">Undo</button></article><article data-message-id="900"><button aria-controls="msg-body-900">Copy</button></article>`;
    const unmount = card(41);
    hold(41, 10);
    document.querySelector<HTMLElement>("[data-testid=held-undo]")!.focus();
    vi.advanceTimersByTime(HOLD);
    expect(document.activeElement).toBe(document.querySelector("[data-held-send]"));
    heldWent({ draftId: 41, threadId: 10, messageId: 900 });
    copyShown(41);
    vi.advanceTimersByTime(40);
    expect(document.activeElement).toBe(document.querySelector("[aria-controls=msg-body-900]"));
    unmount();
  });
});

describe("what the Codex code review found", () => {
  it("#2: its copy known while the dock offers Undo (held there by a hover): the offer goes, a spinner stays", () => {
    vi.useFakeTimers();
    hold(51, 10);
    flushFrames();
    expect(dockOffers(51)).toBe(true);
    useSnack.setState({ paused: ["hover"] });
    heldWent({ draftId: 51, threadId: 10, messageId: 600 });
    expect(heldById(51)).toBeUndefined();
    expect(useSnack.getState().current?.action).toBeUndefined();
    expect(useSnack.getState().undo).toBeNull();
  });

  it("#4: Undo out across the window's end, then too late or failed: focus stays on the card", async () => {
    vi.useFakeTimers();
    for (const outcome of ["late", "failed"] as const) {
      document.body.innerHTML = `<article data-held-send="52" tabindex="-1"><button data-testid="held-undo">Undo</button></article>`;
      const unmount = card(52);
      let answer!: () => void;
      hold(52, 10, () => new Promise<boolean>((done, fail) => (answer = () => (outcome === "late" ? done(false) : fail(new Error("offline"))))));
      document.querySelector<HTMLElement>("[data-testid=held-undo]")!.focus();
      const undoing = runUndo(heldById(52)!.undo).catch(() => {});
      vi.advanceTimersByTime(HOLD);
      expect(heldById(52)?.phase).toBe("undoing");
      answer();
      await undoing;
      expect(heldById(52)?.phase).toBe("sending");
      expect(document.activeElement).toBe(document.querySelector("[data-held-send]"));
      unmount();
      resetHeldSends();
    }
  });

  it("#6: a card left after its window, before it's queued: the dock says it's going (no Undo), for a bounded time", () => {
    vi.useFakeTimers();
    const unmount = card(53);
    hold(53, 10);
    vi.advanceTimersByTime(HOLD);
    unmount();
    flushFrames();
    const current = useSnack.getState().current;
    expect(current).toMatchObject({ id: "held-send-53", tone: "loading" });
    expect(current?.action).toBeUndefined();
    expect(current!.duration).toBeLessThanOrEqual(30_000);
  });
});
