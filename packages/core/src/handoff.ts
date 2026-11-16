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
  /** which of the forward's rows it's of: a second Hand to… into the same forward is a row of its own (absent, the first) */
  row?: number;
}

export interface Handoff {
  /** every item each row is (a merged row's members), each at the revision it was resolved at */
  items: HandoffItem[];
}

/** What a forward hands on: its rows' members and what their promises answer. A hand-off past it is refused, never cut. */
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
    if (i.row !== undefined && !(isInt(i.row) && i.row < HANDOFF_ITEMS_MAX)) return null;
    out.push({ source: i.source, id: i.id, revision: i.revision, ...(i.named === true && { named: true }), ...(i.answered === true && { answered: true }), ...(isInt(i.row) && i.row > 0 && { row: i.row }) });
  }
  // each row names its item: without one it could claim nothing as the user saw it
  const rows = new Set(out.map((i) => i.row ?? 0));
  return [...rows].every((row) => out.some((i) => (i.row ?? 0) === row && i.named)) ? { items: out } : null;
}

/**
 * Codex's code review of iteration 4: a second Hand to… into a forward that already hands something on joins it as a row of
 * its own, so the forward's confirmation closes both (each row by its own item, `handoffCloses`). Handing the same row again
 * takes its new resolution in place of the old; an item already there is kept once, as now resolved. Null past the bound.
 */
export function mergeHandoffs(was: Handoff | null | undefined, next: Handoff): Handoff | null {
  const key = (i: HandoffItem) => `${i.source}:${i.id}`;
  const nextKeys = new Set(next.items.map(key));
  // a row whose own item is handed again is that row, resolved again
  const again = new Set((was?.items ?? []).filter((i) => i.named && nextKeys.has(key(i))).map((i) => i.row ?? 0));
  const kept = (was?.items ?? []).filter((i) => !again.has(i.row ?? 0) && !nextKeys.has(key(i)));
  // rows numbered from 0 in the order they came
  const order = [...new Set(kept.map((i) => i.row ?? 0))];
  const renumber = (i: HandoffItem, row: number): HandoffItem => {
    const { source, id, revision, named, answered } = i;
    return { source, id, revision, ...(named && { named }), ...(answered && { answered }), ...(row > 0 && { row }) };
  };
  const items = [...kept.map((i) => renumber(i, order.indexOf(i.row ?? 0))), ...next.items.map((i) => renumber(i, order.length))];
  return items.length > HANDOFF_ITEMS_MAX ? null : { items };
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
