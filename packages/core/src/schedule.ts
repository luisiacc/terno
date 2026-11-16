import { readWall, type DatedWall } from "./dated";
import { isPartOfDay, type PartOfDay } from "./part-of-day";

/**
 * Plan 210 (iteration 4, the owner's "Change…"): the user may change an item's day and time (a dated item, a promise of
 * yours). From then on its schedule is the user's (`changedAt`): a later mail's move doesn't override it, it's kept as a
 * proposal the user can take ("Elena says Mon now · Use"). One change event an item (the latest, `changedAt` and the
 * schedule before it), so it's bounded with the item; Earlier says "Changed {day}" while the item is open. Not the words,
 * not the kind.
 */

/** An item's schedule: its day (local), its moment, whether that moment is a stated time, and whether it has a day at all. */
export interface ItemSchedule {
  dueDay: string;
  dueAt: number;
  timed: boolean;
  dated: boolean;
}

/**
 * A later mail's move of an item whose schedule is the user's, kept rather than applied: its new day and moment, a dated
 * item's moment it shows from (`actAt`) and its new words when the move gave some, who said it (the mail's sender, as
 * named) and the message, and when it came.
 */
export interface ScheduleProposal {
  dueDay: string;
  dueAt: number;
  timed: boolean;
  actAt?: number;
  text?: string;
  /** plan 210 (iteration 4, merge): the move's day asked before ("before Mon") and the mail's own clock, as a move writes them */
  before?: string;
  wall?: DatedWall;
  /** plan 210 (iteration 5, revision 4): the move's part of its new day ("Saturday morning"), as a move writes it */
  partOfDay?: PartOfDay;
  by: string;
  messageId: number;
  at: number;
}

/** A sender's name as a proposal keeps it, at most (it's the line's "Elena says…"). */
export const PROPOSAL_BY_MAX = 120;

const record = (json: string | null | undefined): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMoment = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export const scheduleJson = (s: ItemSchedule): string => JSON.stringify({ dueDay: s.dueDay, dueAt: s.dueAt, timed: s.timed, dated: s.dated });

/** A stored schedule, or null (none, or not one: what can't be read says nothing). */
export function parseSchedule(json: string | null | undefined): ItemSchedule | null {
  const r = record(json);
  if (!r || !isDay(r.dueDay) || !isMoment(r.dueAt)) return null;
  return { dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed === true, dated: r.dated !== false };
}

export const proposalJson = (p: ScheduleProposal): string =>
  JSON.stringify({ dueDay: p.dueDay, dueAt: p.dueAt, timed: p.timed, ...(p.actAt !== undefined ? { actAt: p.actAt } : {}), ...(p.text ? { text: p.text } : {}), ...(p.before ? { before: p.before } : {}), ...(p.wall ? { wall: p.wall } : {}), ...(p.partOfDay ? { partOfDay: p.partOfDay } : {}), by: p.by.slice(0, PROPOSAL_BY_MAX), messageId: p.messageId, at: p.at });

/** A stored proposal, or null. */
export function parseProposal(json: string | null | undefined): ScheduleProposal | null {
  const r = record(json);
  if (!r || !isDay(r.dueDay) || !isMoment(r.dueAt) || typeof r.by !== "string" || !isMoment(r.messageId) || !isMoment(r.at)) return null;
  const wall = readWall(r.wall);
  return {
    dueDay: r.dueDay,
    dueAt: r.dueAt,
    timed: r.timed === true,
    ...(isMoment(r.actAt) ? { actAt: r.actAt } : {}),
    ...(typeof r.text === "string" && r.text ? { text: r.text } : {}),
    ...(isDay(r.before) ? { before: r.before } : {}),
    ...(wall ? { wall } : {}),
    ...(isPartOfDay(r.partOfDay) ? { partOfDay: r.partOfDay } : {}),
    by: r.by.slice(0, PROPOSAL_BY_MAX),
    messageId: r.messageId,
    at: r.at,
  };
}

/** Who a proposal names: the sender's name, else their address. */
export const proposerOf = (from: { name: string; email: string }): string => (from.name.trim() || from.email.trim()).slice(0, PROPOSAL_BY_MAX);

/** A "Changed" line's row id in Earlier: never the open row's own (`dated:42`), which the item keeps above. */
export const changeLineId = (canonical: string): string => `change:${canonical}`;
