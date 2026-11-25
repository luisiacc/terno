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

/** A person with something open, their items most pressing first (What matters' order, then the replies owed to you). */
export interface PersonOpen {
  /** `personKey` of the address: who they are, however their address is spelled */
  key: string;
  email: string;
  name: string;
  items: PersonItem[];
}

/** The recipient index People's Everyone and search read: answering, still being made ready, or not coming this session. */
export type PeopleIndexState = "ready" | "warming" | "off";

/** The list: who has something open, then everyone you've written to (less those), best first. */
export interface PeopleList {
  open: PersonOpen[];
  everyone: readonly PersonEntry[];
  index: PeopleIndexState;
}

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
  /** the newest conversation's stored summary, its first sentence (never a new AI request) */
  lastSummary?: string;
}

/** Everyone is capped (past it, search finds them). */
export const PEOPLE_EVERYONE_MAX = 5000;
/** A page's recent conversations. */
export const PERSON_CONVERSATIONS_MAX = 20;
/** A search's hits. */
export const PEOPLE_SEARCH_MAX = 50;

/** The key a person item is given to: its own id in its list (an item can be open with one person only). */
export const personItemId = (i: PersonItem): string => (i.kind === "today" ? i.item.id : `awaiting:${i.row.id}`);

/** The conversation a person item opens. */
export const personItemThread = (i: PersonItem): ThreadSummary => (i.kind === "today" ? i.item.thread : i.thread);
