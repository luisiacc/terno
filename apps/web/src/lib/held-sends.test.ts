// @vitest-environment jsdom
/** Plan 182: Send's Undo window as a card where the copy will be, the dock only where no card shows it. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("~/rpc/connection", () => ({ client: { call: vi.fn(), on: () => () => {}, onAttach: () => () => {} } }));

const { heldWent, holdSend, copyShown, heldById, resetHeldSends, settleOverdue, setHeldThreadOpener, undoHeld, useHeldCard, useHeldSends } = await import("./held-sends");
const { resetSnacks, runUndo, snack, useSnack } = await import("./snack");
const { getApp, setApp } = await import("~/state/app");

const HOLD = 5000;
const flushFrames = () => vi.advanceTimersByTime(40);

/** a hold of draft `draftId` in conversation `threadId` (null: a new message), its cancel answering `answer` */
function hold(draftId: number, threadId: number | null, answer: (cancelled: () => void) => Promise<boolean> = async (c) => (c(), true)) {
  const cancel = vi.fn(answer);
  holdSend({ draftId, accountId: 1, threadId, mode: threadId === null ? "new" : "reply", subject: "Lunch", to: [{ name: "Bea", email: "bea@example.com" }], cc: [], bodyHtml: null, bodyText: "Thursday works.", attachments: [], goesAt: Date.now() + HOLD, cancel });
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
  it("won: gone at once, before the draft is reopened (Codex critique #7); the card, z and the dock run one token", async () => {
    let reopened!: () => void;
    let settledFirst = false;
    const unmount = card(11);
    const cancel = hold(11, 10, async (cancelled) => {
      cancelled();
      settledFirst = heldById(11) === undefined;
      await new Promise<void>((r) => (reopened = r));
      return true;
    });
    undoHeld(11);
    expect(heldById(11)?.phase ?? "gone").not.toBe("holding");
    await vi.waitFor(() => expect(reopened).toBeTypeOf("function"));
    expect(settledFirst).toBe(true);
    // a second press, or z, runs nothing more
    undoHeld(11);
    reopened();
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount();
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

  it("a reply nobody looks at settles when it goes", () => {
    hold(22, 10);
    heldWent({ draftId: 22, threadId: 10, messageId: 501 });
    expect(heldById(22)).toBeUndefined();
  });

  it("a copy in another conversation (a forward, a changed subject) settles here, and is offered there", () => {
    const open = vi.fn();
    setHeldThreadOpener(open);
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

  it("a new message still in its pane opens the conversation it started; moved on, it doesn't", () => {
    const open = vi.fn();
    setHeldThreadOpener(open);
    hold(24, null);
    setApp({ heldView: 24 });
    heldWent({ draftId: 24, threadId: 88, messageId: 503 });
    expect(open).toHaveBeenCalledWith(88);
    expect(getApp().heldView).toBeNull();
    open.mockClear();
    hold(25, null);
    heldWent({ draftId: 25, threadId: 89, messageId: 504 });
    expect(open).not.toHaveBeenCalled();
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
