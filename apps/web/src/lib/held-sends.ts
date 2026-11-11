import type { Address, AttachmentRef } from "@terno/core";
import type { DraftMode, ScheduledSent } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { useEffect } from "react";
import { create } from "zustand";
import { dismissSnack, newsWaiting, registerUndo, snack, undoNow, useSnack, withdrawSnack, type Undo } from "~/lib/snack";
import { revealSent } from "~/lib/sent-reveal";
import { getApp, setApp, useApp } from "~/state/app";

/**
 * Plan 182: Send's Undo window, as this window shows it. The backend holds the message (plan 158's `compose.hold`, a
 * scheduled row it sends at its moment whatever happens here); this keeps what was sent, so the conversation can show it
 * at once, where its copy will be, with the time left and Undo on it (`HeldMessage`). The copy takes its place when the
 * backend says which one it became (`scheduledSent`). A hold with no card on screen (the user moved on, the pinned card,
 * a closed conversation) has the dock's snack instead, for the time that's left: the window is never out of reach.
 */

export interface HeldSend {
  draftId: number;
  accountId: number;
  /** the conversation it shows in; null: a new message, shown in the pane (`heldView`) */
  threadId: number | null;
  mode: DraftMode;
  subject: string;
  to: Address[];
  cc: Address[];
  /** the message as it goes (signature and quote included), so it reads as its copy will */
  bodyHtml: string | null;
  bodyText: string;
  attachments: AttachmentRef[];
  /** when the window ends, on Date.now()'s clock (the backend's own decides; this is only what's shown) */
  goesAt: number;
  /** holding: Undo can take it back; sending: its window is over; undoing: the cancel is out */
  phase: "holding" | "sending" | "undoing";
  undo: Undo;
  /** the copy it became, once the backend says */
  copy: { threadId: number; messageId: number } | null;
}

interface HeldState {
  holds: readonly HeldSend[];
}

export const useHeldSends = create<HeldState>(() => ({ holds: [] }));

const EMPTY: readonly HeldSend[] = [];
/** a conversation's holds, in the order sent (a stable empty list when there are none: renders nothing new) */
export const heldIn = (s: HeldState, threadId: number): readonly HeldSend[] => {
  const mine = s.holds.filter((h) => h.threadId === threadId);
  return mine.length ? mine : EMPTY;
};
export const heldById = (draftId: number): HeldSend | undefined => useHeldSends.getState().holds.find((h) => h.draftId === draftId);

function patch(draftId: number, change: Partial<HeldSend>): void {
  useHeldSends.setState((s) => ({ holds: s.holds.map((h) => (h.draftId === draftId ? { ...h, ...change } : h)) }));
}

/** holds the reader has gone to once: coming back to the conversation later keeps its place (it isn't taken there again) */
const revealed = new Set<number>();
export const firstReveal = (draftId: number): boolean => !revealed.has(draftId) && revealed.add(draftId) !== undefined;

/** a copy shown here but never arriving (a forward started another conversation) gives way after this long */
const COPY_WAIT_MS = 10_000;
/** how long "Sending…" may stand for a copy that isn't coming soon: a send's own deadline (plan 158) */
const SENDING_MS = 30_000;
const timers = new Map<number, ReturnType<typeof setTimeout>[]>();
function later(draftId: number, ms: number, run: () => void): void {
  const handle = setTimeout(run, Math.max(0, ms));
  timers.set(draftId, [...(timers.get(draftId) ?? []), handle]);
}

/** It's over (Undo won, its copy is here, or it can't be shown any more): its timers, snack and view go with it. */
export function settleHeld(draftId: number, keepView = false): void {
  const held = heldById(draftId);
  if (!held) return;
  for (const handle of timers.get(draftId) ?? []) clearTimeout(handle);
  timers.delete(draftId);
  revealed.delete(draftId);
  keepFocus(draftId, held.copy?.messageId ?? null);
  cards.delete(draftId);
  if (useSnack.getState().undo === held.undo) useSnack.setState({ undo: null });
  // an offer of Undo goes with it, whatever the phase (Codex review #2); a spinner stays for the op's own result
  const offered = useSnack.getState().current;
  if (held.phase !== "sending" || (offered?.id === snackId(draftId) && offered.action)) withdrawSnack(snackId(draftId));
  if (!keepView && getApp().heldView === draftId) setApp({ heldView: null });
  useHeldSends.setState((s) => ({ holds: s.holds.filter((h) => h.draftId !== draftId) }));
}

// ── the cards on screen, and the dock's snack for a hold that has none

const cards = new Map<number, number>();
const snackId = (draftId: number) => `held-send-${draftId}`;
const shownAnywhere = (draftId: number) => (cards.get(draftId) ?? 0) > 0;

/**
 * A held message's card is on screen while this is mounted and `visible` (the full-message view covers the conversation,
 * mounted but out of reach: Codex critique #9): the dock's snack stands down for it.
 */
export function useHeldCard(draftId: number, visible: boolean): void {
  useEffect(() => {
    if (!visible) return;
    cards.set(draftId, (cards.get(draftId) ?? 0) + 1);
    withdrawSnack(snackId(draftId));
    return () => {
      const left = (cards.get(draftId) ?? 1) - 1;
      if (left > 0) cards.set(draftId, left);
      else cards.delete(draftId);
      // a frame later: a card that unmounts only to mount again (a re-key, a layout switch) never flashes the dock
      soon(() => offerSnack(draftId));
    };
  }, [draftId, visible]);
}

const soon = (run: () => void) => (typeof requestAnimationFrame === "undefined" ? run() : void requestAnimationFrame(run));

/** No card shows this hold: its window, in the dock, for the time that's left (as plan 158 had it). */
function offerSnack(draftId: number): void {
  const held = heldById(draftId);
  if (!held || shownAnywhere(draftId)) return;
  const left = held.goesAt - Date.now();
  if (held.phase === "holding" && left > 0) {
    // the token z already holds (or not): the dock's button runs it, it never takes z over (Codex critique #8)
    snack.loading(t("compose.sending"), { id: snackId(draftId), duration: left, action: { label: t("common.undo"), name: t("compose.undoSend"), undo: held.undo } });
    return;
  }
  if (held.phase !== "sending") return;
  // its window is over, its copy known, and nothing shows it: nothing left to show; the op's own result says the rest
  if (held.copy) return settleHeld(draftId);
  // not queued yet: the dock says it's going, for as long as this hold may last (Codex review #6)
  const rest = held.goesAt + SENDING_MS - Date.now();
  if (rest > 0) snack.loading(t("compose.sending"), { id: snackId(draftId), duration: rest });
}

/** Undo leaves the card as its window ends: focus on it stays on the card (focusable, named), not on nothing. */
function parkFocus(draftId: number): void {
  if (typeof document === "undefined") return;
  const undo = document.activeElement?.closest(`[data-held-send="${draftId}"] [data-testid=held-undo]`);
  undo?.closest<HTMLElement>("[data-held-send]")?.focus({ preventScroll: true });
}

/** The card is about to leave the page (its copy shown in its place): focus in it goes on to the copy (Codex review #3). */
export function cardLeaving(draftId: number): void {
  keepFocus(draftId, heldById(draftId)?.copy?.messageId ?? null);
}

/** Focus on a card that goes: to its copy's header if it's there, else the conversation (never left on nothing). */
function keepFocus(draftId: number, copy: number | null): void {
  if (typeof document === "undefined" || !document.activeElement?.closest(`[data-held-send="${draftId}"]`)) return;
  const reader = document.activeElement.closest<HTMLElement>("[data-testid=reader], [data-testid=held-view]");
  soon(() => {
    // the user has put it elsewhere meanwhile: theirs
    const now = document.activeElement;
    if (now && now !== document.body && now.isConnected && !now.closest(`[data-held-send="${draftId}"]`)) return;
    const to = (copy !== null && document.querySelector<HTMLElement>(`[aria-controls="msg-body-${copy}"], article[data-message-id="${copy}"] [data-testid=message-header]`)) || reader;
    to?.focus({ preventScroll: true });
  });
}

// ── the window's lifetime

export interface HoldInput extends Omit<HeldSend, "phase" | "undo" | "copy"> {
  /** Undo: cancels it on the backend (`cancelled` as soon as that won); true if it won, false if it had already gone */
  cancel: (cancelled: () => void) => Promise<boolean>;
}

/** `scheduledSent`s for holds not recorded yet (the answer to `compose.hold` can come after its end: Codex critique #1) */
const early = new Map<number, ScheduledSent>();
const EARLY_MAX = 20;

/**
 * It's held: shown where it was written (the conversation; a new message's pane is the sender's to set, `heldView`), and z
 * on its Undo. `goesAt` is taken before the backend was asked, so this window never outlasts the backend's.
 */
export function holdSend(input: HoldInput): void {
  const { cancel, ...shown } = input;
  const draftId = shown.draftId;
  // a stale entry for it goes; the pane the sender just gave it stays
  settleHeld(draftId, true);
  const undo = registerUndo(async () => {
    if (heldById(draftId)) patch(draftId, { phase: "undoing" });
    let won: boolean;
    try {
      won = await cancel(() => settleHeld(draftId));
    } catch (error) {
      // still held for all anyone knows: it can be tried again (the snack's Retry, or the card's Undo)
      const now = heldById(draftId);
      if (now?.phase === "undoing") {
        const still = Date.now() < now.goesAt;
        if (!still) parkFocus(draftId);
        patch(draftId, { phase: still ? "holding" : "sending" });
      }
      throw error;
    }
    if (!won && heldById(draftId)?.phase === "undoing") {
      parkFocus(draftId);
      patch(draftId, { phase: "sending" });
    }
  });
  const held: HeldSend = { ...shown, phase: "holding", undo, copy: null };
  useHeldSends.setState((s) => ({ holds: [...s.holds, held] }));
  const left = shown.goesAt - Date.now();
  later(draftId, left, () => windowEnded(draftId));
  // bounded: a send's own deadline after its window, whatever did or didn't come (a lost event, a dropped connection)
  later(draftId, left + SENDING_MS, () => settleHeld(draftId));
  const went = early.get(draftId);
  early.delete(draftId);
  if (went) heldWent(went);
  // nothing shows it (the pinned card's send while another conversation is read): the dock does, from the start
  else soon(() => soon(() => offerSnack(draftId)));
}

/** The window is over here: Undo goes from the card and from z; in the dock, a spinner until its result (plan 158). */
function windowEnded(draftId: number): void {
  const held = heldById(draftId);
  if (!held) return;
  if (held.phase === "holding") {
    parkFocus(draftId);
    patch(draftId, { phase: "sending" });
  }
  if (useSnack.getState().undo === held.undo && held.undo.state === "ready") useSnack.setState({ undo: null });
  undoLeavesDock(draftId);
  if (held.copy && !shownAnywhere(draftId)) settleHeld(draftId);
}

/** The dock's Undo for this hold, if it shows, becomes the spinner (plan 158), or gives way to a result already waiting. */
function undoLeavesDock(draftId: number): void {
  const id = snackId(draftId);
  const current = useSnack.getState().current;
  if (current?.id !== id || !current.action) return;
  // the backend's clock started first: its "Message sent" can already be waiting behind the Undo
  if (newsWaiting()) dismissSnack(id);
  else snack.loading(t("compose.sending"), { id, duration: SENDING_MS });
}

/** Undo from the card: the same token z and the snack run. */
export function undoHeld(draftId: number): void {
  const held = heldById(draftId);
  if (held?.phase === "holding") undoNow(held.undo);
}

/**
 * The backend sent one (`scheduledSent`): if it's one of these, its copy is known. A new message whose pane still shows
 * it opens the conversation it started, on the copy; a reply's card stays until its copy shows in the conversation
 * (`copyShown`), so nothing jumps; one nobody sees settles now. A copy that went to another conversation (a forward, a
 * reply whose subject was changed) is offered there, once, if its card was being looked at.
 */
export function heldWent(sent: ScheduledSent): void {
  const held = heldById(sent.draftId);
  if (!held) {
    early.set(sent.draftId, sent);
    for (const id of early.keys()) if (early.size > EARLY_MAX) early.delete(id);
    return;
  }
  const copy = { threadId: sent.threadId, messageId: sent.messageId };
  parkFocus(sent.draftId);
  patch(sent.draftId, { copy, phase: "sending" });
  if (useSnack.getState().undo === held.undo && held.undo.state === "ready") useSnack.setState({ undo: null });
  undoLeavesDock(sent.draftId);
  if (held.threadId === null) {
    if (getApp().heldView === sent.draftId) {
      revealSent(sent.messageId);
      openSentThread(sent.threadId);
    }
    settleHeld(sent.draftId);
    return;
  }
  const watched = shownAnywhere(sent.draftId);
  if (held.threadId !== sent.threadId) {
    settleHeld(sent.draftId);
    if (watched) snack(t("compose.held.elsewhere"), { action: { label: t("common.view"), name: t("compose.held.view"), onClick: () => { revealSent(sent.messageId); openSentThread(sent.threadId); } } });
    return;
  }
  if (!watched) return settleHeld(sent.draftId);
  revealSent(sent.messageId);
  later(sent.draftId, COPY_WAIT_MS, () => settleHeld(sent.draftId));
}

/** The conversation shows the copy now: the card has given way to it. */
export function copyShown(draftId: number): void {
  if (heldById(draftId)?.copy) settleHeld(draftId);
}

/** A connection again (a restart of the backend, a takeover): what may have been missed meanwhile is over here. */
export function settleOverdue(): void {
  for (const h of useHeldSends.getState().holds) if (Date.now() >= h.goesAt) settleHeld(h.draftId);
}

/** how the pane opens a conversation, set by the page module (kept out of the send path's imports) */
const pane = { open: null as ((threadId: number) => void) | null };
export function setHeldThreadOpener(open: (threadId: number) => void): void {
  pane.open = open;
}
function openSentThread(threadId: number): void {
  pane.open?.(threadId);
}

/** for tests */
export function resetHeldSends(): void {
  for (const h of useHeldSends.getState().holds) settleHeld(h.draftId);
  cards.clear();
  early.clear();
  revealed.clear();
}

// the sent view is the pane's while nothing else takes it: a composer opened, rows checked (a click on a row is openThread)
useApp.subscribe((s, p) => {
  if (s.heldView === null || s.heldView !== p.heldView) return;
  if (s.compose || (s.checked.size >= 2 && p.checked.size < 2) || (s.scope !== null && p.scope === null) || s.selectedId !== p.selectedId) setApp({ heldView: null });
});
