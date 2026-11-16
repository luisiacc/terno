import { AWAITING_ITEM } from "./followups";
import { ANSWERED_WITH_PROMISE } from "./today";
import { addressesOf } from "./autocomplete-source";
import { addressKey, followupDue, handedRecipient, HANDED, parseHandoff, type HandedTo, type Handoff, type HandoffItem } from "@terno/core";

/**
 * Plan 210 (iteration 4, Codex review of the design, revision 3): what both stores do with a send's hand-off when the
 * provider confirms the send, in the commit that records it (`ops.complete`, beside `followupSendConfirmed`). Queued, held
 * for Undo, cancelled, failed or of uncertain delivery, a hand-off claims nothing: only this closes its items.
 */

/** A send op's target: the local copy it sends, and the hand-off its draft carried when it was queued. */
export interface SendTarget {
  messageIds?: number[];
  handoff?: Handoff;
}

/** The hand-off a send op carries, read from its target; none when it carries none or it doesn't read. */
export const handoffOfTarget = (targetJson: string): Handoff | null => {
  try {
    return parseHandoff((JSON.parse(targetJson) as SendTarget).handoff ?? null);
  } catch {
    return null;
  }
};

/** An item as it is now: its state and revision (null: gone). */
export type ItemNow = (item: HandoffItem) => { state: string; revision: number } | null;

const isOpen = (item: HandoffItem, state: string): boolean => state === "open" || (item.source === "promise" && state === "due");

/**
 * Which of a hand-off's items close: none unless every item the row named is still open at the revision it was handed at (a
 * Done, Later, Remove or settlement since wins); then those and every other member still open at its revision.
 */
export function handoffCloses(h: Handoff, now: ItemNow): HandoffItem[] {
  const at = (i: HandoffItem) => {
    const r = now(i);
    return !!r && r.revision === i.revision && isOpen(i, r.state);
  };
  if (!h.items.filter((i) => i.named).every(at)) return [];
  return h.items.filter(at);
}

/** The patch a closing item takes: handed (done), or a request a handed promise answered (settled, as Done leaves it). */
export function handedPatch(item: HandoffItem, to: HandedTo, now: number): { state: "done" | "settled"; closedReason: string; closedAt: number; handedTo: string | null } {
  return item.answered && item.source === "dated"
    ? { state: "settled", closedReason: ANSWERED_WITH_PROMISE, closedAt: now, handedTo: null }
    : { state: "done", closedReason: HANDED, closedAt: now, handedTo: JSON.stringify(to) };
}

/** Whom a confirmed forward went to: its first To, as sent (`to_json`). */
export const handedToOf = (toJson: string | null | undefined): HandedTo | null => handedRecipient(addressesOf(toJson));

/**
 * The forward's own wait (plan 142's awaiting row), seeded directly rather than left to the model's `expectsReply`: it shows
 * in Follow-ups until its person replies. Only with follow-ups on and a nudge set, for someone not yourself.
 */
export function handoffWait(o: { followup?: boolean; nudgeAfterDays?: number }, to: HandedTo, sentAt: number, own: ReadonlySet<string>): { item: number; personName: string | null; personEmail: string; dueAt: number; dated: boolean } | null {
  if (o.followup !== true || o.nudgeAfterDays === undefined || own.has(addressKey(to.email))) return null;
  const { dueAt, dated } = followupDue({ kind: "awaiting", sentAt, due: null, nudgeAfterDays: o.nudgeAfterDays });
  return { item: AWAITING_ITEM, personName: to.name || null, personEmail: to.email, dueAt, dated };
}
