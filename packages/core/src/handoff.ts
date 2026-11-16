import type { ItemSeen } from "./today-items";

/**
 * Plan 210 (iteration 4, the owner's "Hand to someone"): an item of What matters handed to a person by an inline forward of
 * its conversation. The hand-off is saved with the forward's draft (`drafts.handoff_json`), copied onto its send op when
 * the send is queued, and the items close as handed only in the commit that records the provider's confirmation of that
 * send (`ops.complete`): never when it's queued or held for Undo, never when it fails or its delivery is uncertain.
 */
export interface HandoffItem extends ItemSeen {
  /** the row's own item: nothing is claimed unless it's still open at this revision (a change since wins) */
  named?: boolean;
  /** a request a handed promise of yours answers: settled with it, as Done on that promise does */
  answered?: boolean;
}

export interface Handoff {
  /** every item the row is (a merged row's members), each at the revision it was resolved at */
  items: HandoffItem[];
}

/** What a row can be: a merged row's members and what its promises answer. A hand-off past it is refused, never cut. */
export const HANDOFF_ITEMS_MAX = 32;

/** `closed_reason` of an item closed by its hand-off (state `done`; a request it answers is `settled` as Done leaves it). */
export const HANDED = "handed";

/** Whom it was handed to: the forward's first recipient as it was actually sent. Bounded, never more than this. */
export interface HandedTo {
  name: string;
  email: string;
}
export const HANDED_NAME_MAX = 120;
const EMAIL_MAX = 320;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A hand-off as stored (a draft's column, an op's target), checked; anything else is none. */
export function parseHandoff(value: unknown): Handoff | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const items = (v as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || !items.length || items.length > HANDOFF_ITEMS_MAX) return null;
  const out: HandoffItem[] = [];
  for (const i of items as Record<string, unknown>[]) {
    if (!i || (i.source !== "dated" && i.source !== "promise") || !isInt(i.id) || !isInt(i.revision)) return null;
    out.push({ source: i.source, id: i.id, revision: i.revision, ...(i.named === true && { named: true }), ...(i.answered === true && { answered: true }) });
  }
  // a hand-off names its row's item: without one it could claim nothing as the user saw it
  return out.some((i) => i.named) ? { items: out } : null;
}

/** The recipient a confirmed forward was sent to (its first To), as stored: name cut to its bound. */
export function handedRecipient(to: readonly { name?: string | null; email?: string | null }[] | null | undefined): HandedTo | null {
  const first = to?.find((a) => typeof a?.email === "string" && a.email.trim() !== "");
  if (!first) return null;
  const email = first.email!.trim().slice(0, EMAIL_MAX);
  return { name: (first.name ?? "").trim().slice(0, HANDED_NAME_MAX), email };
}

/** A stored `handed_to` (JSON), read back; anything else is none. */
export function parseHandedTo(json: string | null | undefined): HandedTo | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { name?: unknown; email?: unknown };
    return typeof v?.email === "string" && v.email ? { name: typeof v.name === "string" ? v.name : "", email: v.email } : null;
  } catch {
    return null;
  }
}
