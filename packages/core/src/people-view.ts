import type { FollowupRow } from "./followups";
import type { TodayItem } from "./today";
import type { ThreadSummary } from "./types";

/**
 * Plan 281: People. What's open between the user and one person, and the lists the view draws. A person is an address,
 * compared by `personKey` (a `+tag` dropped, Gmail's dots ignored); one human's several addresses are several people.
 */

/** Someone in People's lists: who, when you last heard from each other, and whether you've written to them. */
export interface PersonEntry {
  name: string;
  email: string;
  /** the newest message between you (either way), 0 when unknown */
  last: number;
  written: boolean;
}

/**
 * One thing open between you: an item of What matters' open part (a promise of yours to them, their conversation waiting
 * on your answer, something they asked of you) as What matters lists it, or a reply they owe you (a follow-up waiting on
 * them, which What matters leaves out).
 */
export type PersonItem = { kind: "today"; item: TodayItem } | { kind: "awaiting"; row: FollowupRow; thread: ThreadSummary };

/**
 * A person with something open, their items in People's order (`sortPersonItems`: what's open now, longest waiting first,
 * then what's not yet, put off with Later or behind What matters' Coming up, soonest first).
 */
export interface PersonOpen {
  /** `personKey` of the address: who they are, however their address is spelled */
  key: string;
  email: string;
  name: string;
  items: PersonItem[];
  /**
   * since when the longest of what's open now with them has waited (Open's order: longest waiting first); null when none
   * of it is open yet, put off with Later or behind What matters' Coming up (they sit at Open's end, not counted with it)
   */
  since: number | null;
}

/** The recipient index People's Everyone and search read: answering, still being made ready, or not coming this session. */
export type PeopleIndexState = "ready" | "warming" | "off";

/**
 * The list: who has something open, then everyone you've written to, best first (the open ones too: the list leaves them
 * out), each with their key. Everyone is sent only when it changed since the version the renderer holds (`known`): absent,
 * the renderer keeps its own.
 */
export interface PeopleList {
  open: PersonOpen[];
  everyone?: readonly (PersonEntry & { key: string })[];
  /** which Everyone this is (the index's version): asked back as `known` */
  everyoneVersion: number;
  index: PeopleIndexState;
}

/** What makes a dated item a person's own: their request of you (a bill, a renewal, an alert are What matters' alone). */
export const isPersonRequest = (kind: string | undefined): boolean => kind === "ask" || kind === "respond";

/** A search's hits, best first, each with its key and how many things are open with them. */
export interface PeopleSearch {
  hits: (PersonEntry & { key: string; open: number })[];
  index: PeopleIndexState;
}

/** One person's page (and the person card): what's open, and your recent conversations with them. */
export interface PersonPage {
  key: string;
  email: string;
  name: string;
  items: PersonItem[];
  /** newest first, never in Spam or Trash */
  conversations: ThreadSummary[];
  /** there are more conversations than these */
  more: boolean;
  /** the card's "Last time": the newest conversation's other than the one open, its stored summary's first sentence (never a new AI request) */
  lastSummary?: string;
  /** the card's: the newest conversation other than the open one that they wrote in or you wrote last (to them) */
  lastBetween?: number;
  /** which conversation `lastSummary` is of */
  lastSummaryOf?: number;
  /** the card's last conversation was last written by you (one of your addresses) */
  lastFromMe?: boolean;
  /**
   * of `conversations`, the ones they wrote in (the others they were only sent or copied: a group email), which the page
   * marks; absent when no conversation was asked for
   */
  wrote?: number[];
}

/**
 * Plan 287: People's filter. `within`: the last email with them (either way) no older than this, counted back from now;
 * `accounts`: emailed with in one of these (absent or empty: every account). It chooses who is listed and, by account,
 * which of their items and conversations; a person's items aren't filtered by date.
 */
export const PEOPLE_WITHIN = ["week", "month", "quarter", "year"] as const;
export type PeopleWithin = (typeof PEOPLE_WITHIN)[number];
export interface PeopleFilter {
  within?: PeopleWithin;
  accounts?: number[];
}
const DAY_MS = 86_400_000;
const WITHIN_DAYS: Record<PeopleWithin, number> = { week: 7, month: 30, quarter: 91, year: 365 };
/** The oldest last email a filter's `within` lets in (0: any time). */
export const peopleSince = (within: PeopleWithin | undefined, now: number): number => (within ? now - WITHIN_DAYS[within] * DAY_MS : 0);
/** The most accounts a filter names. */
export const PEOPLE_FILTER_ACCOUNTS_MAX = 64;

/** Everyone is capped (past it, search finds them). */
export const PEOPLE_EVERYONE_MAX = 5000;
/** A page's recent conversations. */
export const PERSON_CONVERSATIONS_MAX = 20;
/** The last conversations asked for at once (the rows drawn). */
export const PEOPLE_LAST_MAX = 60;
/** A search's hits. */
export const PEOPLE_SEARCH_MAX = 50;

/** The key a person item is given to: its own id in its list (an item can be open with one person only). */
export const personItemId = (i: PersonItem): string => (i.kind === "today" ? i.item.id : `awaiting:${i.row.id}`);

/**
 * Since when an item has waited: a promise since you made it, a conversation since it began waiting on your answer, a
 * request since it came, a reply owed to you since you asked (each its conversation's last date when that isn't known);
 * never before its time to act came (owner, 2026-11-26: a renewal due in January isn't open since its November mail).
 */
export function personItemSince(i: PersonItem): number {
  if (i.kind === "awaiting") return i.row.sentAt;
  const { why, thread } = i.item;
  const at = (why.kind === "waiting" ? (why.reply?.since ?? thread.waitingSince) : why.kind === "promise" ? why.sentAt : why.came) ?? thread.lastDate;
  return why.from !== undefined && why.from > at ? why.from : at;
}

/** When an item put off with Later is back, while that's ahead: what its line says ("Back Dec 30"); else null. */
export function personItemBack(i: PersonItem, now: number): number | null {
  const at = i.kind === "awaiting" ? i.row.deferredUntil : i.item.why.back;
  return at != null && at > now ? at : null;
}

/**
 * Not open yet: until when. What matters' own word for its items (owner, 2026-11-26: one source of truth), what it keeps
 * behind Coming up, put off with Later or its time to act still ahead (`TodayWhy.ahead`); a reply owed put off, while that
 * is ahead. Null: open now.
 */
export function personItemAhead(i: PersonItem, now: number): number | null {
  if (i.kind === "today") return i.item.why.ahead ?? null;
  return personItemBack(i, now);
}

/** People's order of a person's items: what's open now, longest waiting first; then what's not yet, soonest first. */
export function sortPersonItems(items: readonly PersonItem[], now: number): PersonItem[] {
  const keyed = items.map((i) => ({ i, back: personItemAhead(i, now), since: personItemSince(i) }));
  keyed.sort((a, b) => {
    if ((a.back === null) !== (b.back === null)) return a.back === null ? -1 : 1;
    return (a.back ?? 0) - (b.back ?? 0) || a.since - b.since;
  });
  return keyed.map((k) => k.i);
}

/** Since when the longest of what's open now has waited (`PersonOpen.since`), of items in People's order. */
export function personSince(items: readonly PersonItem[], now: number): number | null {
  const first = items[0];
  return first && personItemAhead(first, now) === null ? personItemSince(first) : null;
}

/** Open's order: who's waited longest first; those with only what's not yet last, soonest first. */
export function sortPeopleOpen(people: PersonOpen[], now: number): PersonOpen[] {
  const back = (p: PersonOpen) => (p.items[0] ? (personItemAhead(p.items[0], now) ?? 0) : 0);
  return people.sort((a, b) => {
    if ((a.since === null) !== (b.since === null)) return a.since === null ? 1 : -1;
    return (a.since ?? back(a)) - (b.since ?? back(b)) || a.key.localeCompare(b.key);
  });
}

/** The conversation a person item opens. */
export const personItemThread = (i: PersonItem): ThreadSummary => (i.kind === "today" ? i.item.thread : i.thread);
