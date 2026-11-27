import type { AppSettings } from "./rpc/contract";
import type { ThreadSummary } from "./types";
import { aiReady } from "./ai-routing";
import { datedGroup, type DatedKind, type TodayGroupKind } from "./dated";
import type { FeedRowId, ItemRef, ItemSeen, WaitingDoneRef } from "./today-items";
import type { PartOfDay } from "./part-of-day";
import { withoutQuotes } from "./text";

/** Plan 145: what needs you today, and newsletters folded into one digest. Local but for the digest, which is its own opt-in. */

export const DIGEST_CANDIDATES_MAX = 40;
export const DIGEST_WINDOW_MS = 3 * 86_400_000;
export const DIGEST_KEEP_DAYS = 14;
export const DIGEST_LINE_CHARS = 140;
/** the list's row for the digest: no thread has it */
export const DIGEST_ROW_ID = 0;
/** what a notice's click opens when it's the brief: no thread has it */
export const BRIEF_NOTICE_THREAD = -1;

export interface TodaySetting {
  show: boolean;
  /** HH:MM, local */
  prepareAt: string;
  notify: boolean;
  digest: boolean;
  /** plan 210 (the owner): the history ("Earlier") under the open part; off, only what's left, an inbox-zero feeling */
  finished: boolean;
}

export const DEFAULT_TODAY: TodaySetting = { show: true, prepareAt: "08:00", notify: false, digest: false, finished: true };

/**
 * Who sees Today: a provider set up, or (once plan 85's Pro exists) an active entitlement. One helper, so Pro joins in one
 * line.
 */
export function aiFeaturesAvailable(settings: Pick<AppSettings, "ai"> | null | undefined, entitlement?: { active: boolean } | null): boolean {
  if (entitlement?.active === true) return true;
  // plan 168: what can run, by the one rule (on keys, either usable one; elsewhere a model, its endpoint, its key)
  return aiReady(settings?.ai);
}

export interface TodayWhy {
  /** the sixth panel round (change 4): no nudge, what you wait on from others: What matters tracks your own promises */
  kind: "promise" | "waiting" | "reminder" | "dated";
  text?: string;
  dueAt?: number;
  personName?: string | null;
  /** the fourth panel round (revision 9): a promise's person, whom its row names and pictures */
  personEmail?: string | null;
  sentAt?: number;
  /**
   * round 15's second morning: a dated item's own arrival (the asker's message), what "since …" says for one with no day,
   * never the conversation's last message (your own holding reply, their thanks)
   */
  came?: number;
  /** round 15's second morning: put off with Later, when it's back (what its row says if it's ever drawn before then) */
  back?: number;
  /**
   * plan 281 (owner, 2026-11-26): the projection's own word that it's behind Coming up (put off, or its time to act still
   * ahead), set on People's read (`forPeople`): when it shows again, the later of its time to act and Later's `back`
   */
  ahead?: number;
  /**
   * plan 281 (owner, 2026-11-26): on People's read, shown now, when its time to act came (its lead before its day; a promise
   * with none, when it came due), only when after it came: open since then
   */
  from?: number;
  /** a waiting row: you've written in this conversation (else it's new, from someone you write to: `needsYou`'s two reasons) */
  wrote?: boolean;
  /**
   * plan 215: a waiting row, what its Done and Later act on: the conversation's waiting date as drawn (`waiting_since`), the
   * message the facts judged waiting, and its record's revision (0: none); the store checks all three in its act
   */
  reply?: { since: number; rev: number; message: number };
  /** plan 204: its day is over and nothing was done (a dated item, or a dated promise of yours) */
  missed?: boolean;
  /**
   * plan 204: a dated item, what the row's Done, Later and Undo act on. Plan 210 (iteration 2): `early`, a person's request
   * shown in Today's people before its day ("by Nov 30"); `note`, the mail's own time in its zone when it isn't the reader's
   * ("5:00 PM ET"), taken out of `text` for the when column (one time per row)
   */
  item?: { id: number; revision: number; kind: DatedKind; dueDay: string; timed: boolean; dated: boolean; /** plan 249: brought by the user's words (no "the email says": it isn't an alert the mail raised) */ wanted?: boolean; early?: boolean; note?: string | null; /** plan 210 (iteration 4): the day the mail asked for it before ("before Mon"), the day after `dueDay` */ before?: string | null; /** plan 210 (iteration 4, revision 10): travel, the mail's own clock at the place it named ("Mon 4:00 PM Austin") */ travel?: { day: string; time: string; place: string }; /** plan 210 (iteration 5, revision 4): the part of its day it's asked for ("Sat morning") */ part?: PartOfDay | null; /** round 17 (`mailDay`): the mail's own day for a deadline the user moved to another with Change… ("Mon · due Tue") */ mailDay?: string };
  /**
   * plan 204 (Codex review): the promise this row shows, what D, Done and Remove act on (never the thread's most urgent).
   * Plan 210 (iteration 2): `timed`, its words state a time (`dueAt` is it); `note`, that time as written when its zone isn't
   * the reader's. Iteration 3 (`promiseDay`): `said`, a day it was given and missed while it sits under a live one ("You said
   * Tue 10 (missed)"); `needed`, the day the other person needs it, when the column says it ("needed Mon")
   */
  promise?: {
    id: number;
    revision: number;
    /** it names a day (`FollowupRow.dated`): only then does its line say "Due …" */
    dated?: boolean;
    timed?: boolean;
    note?: string | null;
    said?: number | null;
    needed?: number | null;
    /** plan 210 (iteration 4, revision 11, `promiseDay`): `needed` is the day before this one ("needed before Mon"); `before`, the day it sits under is ("before Mon") */
    neededBefore?: string | null;
    before?: string | null;
    /** plan 210 (iteration 5, revision 4, `promiseDay`): the part of the day it sits under ("this morning"), and of the day it's needed by ("needed Sat morning") */
    part?: PartOfDay | null;
    neededPart?: PartOfDay | null;
  };
  /**
   * Plan 210 (iteration 2): every item this row is (true duplicates: the same dinner from the restaurant and from a friend,
   * an errand read as a bill and as your promise), the shown one first: what Done, Later and Remove act on, all at once
   */
  members?: ItemRef[];
  /**
   * Plan 210 (iteration 4, "one reply, one row"): the other promises of this reply to its person, each its own item (its own
   * duplicates, its own request), at the revisions shown: the row's Done, Remove and Later name them with its own, all or
   * none. Not `members`: the reader keeps each a line of its own, and an act on one of them alone leaves the row
   */
  with?: ItemSeen[];
}

/**
 * Plan 210 (iteration 1, Codex's critique point 4): what a row is, inside a day, by what it costs to miss: a cutoff or
 * another task due (0), a promise of yours (1), a person waiting on you (2: their ask, a conversation waiting on your
 * answer), your reminder (3), then a plan or a delivery (4), which the feed draws quieter.
 */
export function dayTier(why: Pick<TodayWhy, "kind" | "item">): number {
  // plan 210 (iteration 2): a person's request shown before its day is with the people, as their ask is
  if (why.kind === "dated") return !why.item ? 0 : why.item.kind === "ask" || why.item.early ? 2 : datedGroup(why.item.kind) === "plans" ? 4 : 0;
  return why.kind === "promise" ? 1 : why.kind === "waiting" ? 2 : 3;
}

/** A row whose moment is a time of day: a timed dated item, or (plan 210, iteration 2) a promise whose words state one. */
const timedWhy = (why: Pick<TodayWhy, "kind" | "item" | "promise">): boolean => (why.kind === "dated" ? why.item?.timed === true : why.kind === "promise" && why.promise?.timed === true);

/** A moment's time of day, in minutes. */
const minuteOfDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

type DayWhy = Pick<TodayWhy, "kind" | "item" | "dueAt" | "promise">;

/** A row's place in an order, read once: numbers compared in turn, the first that differs deciding (lexicographic). */
type OrderKey = readonly number[];

const byOrderKey = (x: OrderKey, y: OrderKey): number => {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

/**
 * Plan 210 (iteration 5, the Codex review's revision 7; the owner: "things to do before what happens to you"): Today's own
 * rows by one key, in turn: a broken promise needed today first (`first`); then what you do before what happens to you
 * (a plan or a delivery); among each, what has a time by its instant (your reminder at its time too), then what has none,
 * by tier (a deadline, your promise, your reminder) and when it came due. People waiting (tier 2: Waiting on you's part)
 * come after it all and keep the order they came in (the rest of their key is equal).
 */
export function todayOrderKey(why: DayWhy, first = false): OrderKey {
  const tier = dayTier(why);
  if (tier === 2) return [1, 2, 0, 0, 0];
  const timed = timedWhy(why) || why.kind === "reminder";
  const dueAt = why.dueAt ?? 0;
  return [first ? 0 : 1, tier === 4 ? 1 : 0, timed ? 0 : 1, timed ? dueAt : tier, timed ? tier : dueAt];
}

/**
 * Plan 210 (iteration 1): a day ahead's order (its own day's heading, Ahead's, Coming up's): by `dayTier`, the timed first
 * by their time of day (put off to that day from others, the times are the rows' own), then the rest as they came due.
 * People waiting keep the order they came in.
 */
export function dayOrderKey(why: DayWhy): OrderKey {
  const tier = dayTier(why);
  if (tier === 2) return [2, 0, 0, 0];
  const timed = timedWhy(why);
  const dueAt = why.dueAt ?? 0;
  return [tier, timed ? 0 : 1, timed ? minuteOfDay(dueAt) : dueAt, dueAt];
}

/** Rows in a key's order, each key read once (the backend sorts up to the 1,000-item bound on every list); ties as they came. */
function sortByKey<T>(rows: readonly T[], key: (row: T) => OrderKey): T[] {
  const keyed = rows.map((row, i) => ({ row, i, key: key(row) }));
  keyed.sort((a, b) => byOrderKey(a.key, b.key) || a.i - b.i);
  return keyed.map((k) => k.row);
}

/** Today's own rows (`todayOrderKey`); `first`, the broken promise needed today (`promiseBroken`'s `today`). */
export const sortToday = <T>(rows: readonly T[], why: (row: T) => DayWhy, first: (row: T) => boolean): T[] => sortByKey(rows, (row) => todayOrderKey(why(row), first(row)));

/** Rows ahead (`dayOrderKey`), their own day first ("YYYY-MM-DD", which sorts as text). */
export function sortInDay<T>(rows: readonly T[], why: (row: T) => DayWhy, day: (row: T) => string): T[] {
  const days = [...new Set(rows.map(day))].sort();
  const rank = new Map(days.map((d, i) => [d, i]));
  return sortByKey(rows, (row) => [rank.get(day(row))!, ...dayOrderKey(why(row))]);
}

/**
 * Plan 210 (iteration 4): another item a row stands for, said on its second line: the other promises of its reply ("Also:
 * You said: calibrate the green"). Iteration 5: a related detail (a return leg) is no longer one, being a row of its own on
 * its own day, said once, in its place's clock.
 */
export interface TodayAlso {
  /** a dated item's kind, or a promise of yours */
  kind: DatedKind | "promise";
  text: string;
  dueDay: string;
  dueAt: number;
  timed: boolean;
  /** false: it names no day (an ask, an alert that named none, a promise with no day): its words alone */
  dated: boolean;
  /**
   * plan 210 (iteration 5, R9): your promise to come to the row's event or bring someone to it (`attendsEvent`), said on the
   * event's row in your words ("You said you'd bring Nina and the SE"), no day of its own
   */
  attends?: boolean;
}

export interface TodayItem {
  /** plan 210 (iteration 2): the row's identity (`FeedRowId`), what the feed keys it by: two items of one conversation are two */
  id: FeedRowId;
  thread: ThreadSummary;
  why: TodayWhy;
  /** the stored summary's first sentence, only when it's current */
  summary?: string;
  /**
   * plan 210 (iteration 4): the other promises of its reply (`TodayWhy.with`), a line each, never another obligation;
   * iteration 5: on an event's row, your promise to attend it or bring someone (`TodayAlso.attends`)
   */
  also?: TodayAlso[];
  /**
   * plan 210 (iteration 3, revision 10): a dated item's own sender, from its message (Margaret's premium from Lakeshore
   * Mutual, never "Gary", who wrote last in the conversation); absent for a promise, a waiting row or a reminder
   */
  from?: { name: string; email: string };
}

/**
 * Plan 210 (iteration 3, revision 8, the owner's "'Waiting on you' in Today"): the header's numbers and the sidebar's ("1
 * missed · 3 today · 5 waiting"; the badge Missed + Today), disjoint. What counts is `todayCounted`'s (never a Plan's kind,
 * nor a reminder, nor a day ahead, nor Coming up): `missed`, the rows under Missed; `today`, Today's own (due or happening
 * today, a promise of yours that named no day, an alert that named none); `waiting`, Today's "Waiting on you" part
 * (`waitsOnYou`: a person's ask, a conversation waiting on your answer, a request shown before its day).
 */
export interface TodayCounts {
  missed: number;
  today: number;
  waiting: number;
  /**
   * plan 210 (iteration 5, revision 6; the owner: "… · 5 waiting, 1 overdue"): of `waiting`, your promises broken and needed
   * on a day still ahead (`promiseBroken`'s `ahead`): a subset, said beside it, never added to the badge
   */
  overdue: number;
}

/**
 * Plan 210 (iteration 3, revision 8): a row of Today's "Waiting on you" part, people waiting on you (`dayTier`'s 2): their
 * ask, a conversation waiting on your answer, a request shown before its day. A request due today is a deadline.
 */
export const waitsOnYou = (why: Pick<TodayWhy, "kind" | "item">): boolean => dayTier(why) === 2;

/** Plan 210 (iteration 3): a part of a group: Today's "Waiting on you" */
export type TodayPart = "waiting";

/**
 * The sidebar's badge and the morning notice: what's Missed and what's Today's, as before iteration 3: Today's group,
 * its "Waiting on you" part included (it's inside Today), so the badge is the sum of what the header says. Overdue is a
 * part of waiting, so it adds nothing (iteration 5).
 */
export const todayBadge = (c: TodayCounts): number => c.missed + c.today + c.waiting;

/**
 * Plan 204: every row that's for today, each thread once, in `TODAY_GROUP_ORDER`; Coming up last, and never counted. Plan
 * 210 (by day): a day of its own and Coming up come as a section per day, in order, each with its `day` ("YYYY-MM-DD").
 */
export type TodaySection = {
  kind: TodayGroupKind;
  day?: string;
  /** plan 210 (iteration 3): Today's "Waiting on you" */
  part?: TodayPart;
  /** plan 210 (iteration 3, revision 9): the heading a day ahead's or Coming up's section is drawn under (`displayBucket`) */
  bucket?: string;
  items: TodayItem[];
};

export interface DigestItem {
  threadId: number;
  messageId: number;
  /** a thread that moved since isn't what was listed */
  lastDate: number;
  messageCount: number;
  from: string;
  /** plan 166: the sender's address (what "Not a newsletter" keeps out); absent in a digest stored before it, and filled at read */
  fromEmail?: string;
  subject: string;
  /** null: no line, with the digest off */
  line: string | null;
}

/** Plan 166: a sender the user said isn't a newsletter. Kept on this machine, out of every digest and Automated mail. */
export interface NotNewsletter {
  /** this entry, never another's: what an Undo names (a time can repeat, Codex review) */
  id: string;
  email: string;
  name: string;
  /** when it was said: the list's order */
  at: number;
}

/**
 * Plan 240: a sender the user said to always show in What matters ("Always show in What matters"): each of their unanswered
 * conversations waits on you whatever their mail looks like. `key` is the `addressKey`; `id` this entry, what an Undo names.
 */
export interface ShownSender {
  id: string;
  key: string;
  email: string;
  name: string;
  /** when it was said: the list's order, newest first */
  at: number;
}

/** Plan 240: the most senders shown at once (adding past it is refused in words, as mutes are). */
export const SHOWN_SENDERS_MAX = 500;

/** Plan 166: how much of a sender's name the list keeps. */
export const NOT_NEWSLETTER_NAME_MAX = 200;

/** Plan 166: the list keeps this many; past it, the oldest goes (and its Undo brings it back). */
export const NOT_NEWSLETTERS_MAX = 500;

/** Plan 166 (Codex review): how far Undos putting entries back may take the list past its cap; the next addition trims it. */
export const NOT_NEWSLETTERS_OVER = 10;

export type DigestState = "pending" | "ready" | "failed";

export interface DigestRow {
  day: string;
  state: DigestState;
  items: DigestItem[];
  /** with no digest: what's automated, unsorted: nothing here has said these are newsletters */
  automated: boolean;
  /** of `items`, those still in the Inbox and unread: the rest stay listed, muted */
  liveIds: number[];
  /** of `items`, those still in the Inbox but read (opened): plan 145 archives only unread mail, so they stay, and say so (plan 161) */
  readIds?: number[];
  /** the failure's kind, for its help line */
  errorKind?: string | null;
  model?: string | null;
  provider?: string | null;
}

export interface TodayList {
  sections: TodaySection[];
  digest: DigestRow | null;
  now: number;
  /** plan 210 (iteration 2): the header's numbers, from the same projection as the rows */
  counts: TodayCounts;
  /** plan 210: the history's first page (or down to the line asked for), when asked for (What matters drawn as the feed) */
  history?: TodayHistoryPage;
  /** plan 249: held rows (asked as `held`) the user's words now hide: the feed lets them go */
  hidden?: FeedRowId[];
}

/**
 * Plan 210: a history line's place: when its item closed, then at the same moment a dated item (0) before a promise (1),
 * then the higher id. The history is newest first in this order; a page is taken strictly after a line's key.
 */
export interface HistoryKey {
  at: number;
  src: HistorySource;
  id: number;
}

/**
 * Where a line comes from: a closed dated item (0), a closed promise (1); plan 210 (iteration 4, Change…), an open dated item
 * the user changed (2) and an open promise (3), at the moment of the change; plan 215, a conversation waiting on you marked
 * Done (4), by its message.
 */
export type HistorySource = 0 | 1 | 2 | 3 | 4;

/** Negative: `a` comes first (newer). */
export const historyOrder = (a: HistoryKey, b: HistoryKey): number => b.at - a.at || a.src - b.src || b.id - a.id;

/**
 * A table's own key (`closed_at`, id) strictly after a history line: at the line's moment, lines of a lower source come
 * first, so a table takes none of that moment after a line of a higher source, and all of it after a lower one's.
 */
export function historyAfter(key: HistoryKey, src: HistorySource): { at: number; id: number } {
  if (key.src === src) return { at: key.at, id: key.id };
  return { at: key.at, id: key.src < src ? Number.MAX_SAFE_INTEGER : 0 };
}

/** What happened to the item: done, removed (once "not a task"), settled by later mail, or over (retired when its time passed). */
/** plan 210 (iteration 3): `replaced`, a promise its person replaced with another request; (iteration 4) `handed`, handed to a person */
/** plan 210 (iteration 4): `changed`, an open item whose day or time the user changed (its line while it's open) */
export type HistoryOutcome = "done" | "dismissed" | "settled" | "over" | "replaced" | "changed" | "handed";

export interface TodayHistoryItem {
  /** plan 210 (iteration 2): its row's identity, the closed item's (a merged one's canonical's) */
  id: FeedRowId;
  /** the closed item the line is: what the reader's line shows when it's opened; plan 215, a waiting conversation's message */
  item: ItemRef | WaitingDoneRef;
  thread: ThreadSummary;
  key: HistoryKey;
  outcome: HistoryOutcome;
  /** a dated item's kind, a promise of yours, or (plan 215) a conversation that waited on you */
  kind: DatedKind | "promise" | "waiting";
  /** its words, as the open part said them */
  text: string;
  /** plan 215: a waiting line's words as its row had them at Done (who wrote, about what, and whether you'd written there) */
  waiting?: { who: string; subject: string; wrote: boolean };
  /** plan 210 (iteration 4): `handed`'s person, as the confirmed forward went ("Handed to Jess Tue") */
  handedTo?: import("./handoff").HandedTo;
  /**
   * plan 210 (iteration 4, revision 7): the day the mail that settled it came (`settledAt`), what its column says ("Paid
   * Mon"); absent, the closing's (`key.at`). The history's order stays the closing's
   */
  on?: number;
  /** plan 210 (iteration 4): how mail settled it, its `closedReason` ("answered": your reply did), for the column's verb */
  reason?: string | null;
}

export interface TodayHistoryPage {
  items: TodayHistoryItem[];
  /** the last line's key, to ask for the page after it; null: nothing older */
  next: HistoryKey | null;
}

/** Plan 210: the history's lines a page. */
export const HISTORY_PAGE = 40;

/** A day's key, in the machine's own time. */
export function todayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** When "HH:MM" next comes round after `now`, local, through a DST change as a clock on the wall would. */
export function nextPrepareAt(prepareAt: string, now: number): number {
  const [h, m] = prepareAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  return at.getTime();
}

/** Today's "HH:MM", local. */
export function prepareTimeToday(prepareAt: string, now: number): number {
  const [h, m] = prepareAt.split(":").map(Number);
  const at = new Date(now);
  at.setHours(h ?? 8, m ?? 0, 0, 0);
  return at.getTime();
}

/**
 * Plan 204, the second panel round (plan 145's rule, tighter): a message that only acknowledges ("Thanks.", "Got it,
 * thanks!", "Gracias", "Perfecto 👍") isn't waiting on the reader. Conservative, by what it allows rather than what it
 * catches (Codex code reviews): the visible message (quotes off, inline answers kept, nothing after a sign-off), no
 * question and no request word, acknowledgments, whole phrases that add nothing ("for the update", "talk soon") and at
 * most a name signing it, at its end. "Thanks, review the contract today", "Thanks. Please reply." and "Perfecto.
 * Avísame." are kept. A body too long to read cheaply is kept too: the rule only ever takes conversations out.
 */
const ACK = /\b(thanks|thank you|thx|ty|got it|sounds good|great|perfect|ok|okay|noted|will do|cheers|appreciate it|gracias|muchas gracias|perfecto|listo|de acuerdo|vale|entendido|recibido|genial|excelente)\b|👍|🙏/iu;
const ACK_ONLY =
  /\b(thank you|thanks|thx|ty|many thanks|much appreciated|appreciate it|got it|sounds good|sounds great|great|perfect|ok|okay|noted|will do|cheers|awesome|all good|muchas gracias|mil gracias|gracias|perfecto|perfecta|listo|de acuerdo|vale|entendido|recibido|genial|excelente)\b|[👍🙏🙌😊🙂]/giu;
/** whole phrases that add nothing to a thanks: no task, no date, no thing */
const FILLER =
  /\b(for (the|your) (update|info|information|help|quick reply|reply|response|heads up|note)|so much|a lot|again|as always|talk soon|have a (great|good|nice) (day|weekend|one)|you too|hi|hello|hey|dear|por (la|tu|su) (información|info|ayuda|respuesta)|por el aviso|de nuevo|que tengas (un )?buen (día|fin de semana)|buen (día|fin de semana)|igualmente|nos vemos( pronto)?|un abrazo|saludos|hola)\b/giu;
/** a request, however it's dressed: never an acknowledgment */
const REQUEST = /\b(please|pls|let me know|can you|could you|would you|send|reply|update|review|sign|call|confirm|check|need|por favor|avísame|avisame|me avisas|mándame|mandame|envíame|enviame|revisa|firma|llama|confirma|necesito)\b/iu;
const SIGN_OFF = /^(--\s*$|sent from my|enviado desde|get outlook|best,?$|regards,?$|saludos,?$|un abrazo,?$|abrazo,?$|cheers,?$)/i;
/** past this, a body isn't read for it (the sidebar's count reads it): kept, as anything unsure is */
const ACK_MAX_CHARS = 20_000;

/** A message's own words: quotes off (an answer between them kept), nothing after a sign-off. */
function ownWords(text: string): string {
  const lines: string[] = [];
  for (const raw of withoutQuotes(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (SIGN_OFF.test(line)) break;
    lines.push(line);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export function isAcknowledgment(text: string | null | undefined): boolean {
  if (!text || text.length > ACK_MAX_CHARS) return false;
  const words = ownWords(text);
  // a few words (the cheap test first), no question, an acknowledgment
  if (!words || words.split(" ").length > 14 || /[?¿]/.test(words) || !ACK.test(words)) return false;
  // the phrases that add nothing off ("for the update"), then no request in what's left
  const plain = words.replace(FILLER, " ");
  if (REQUEST.test(plain)) return false;
  const rest = plain.replace(ACK_ONLY, " ").match(/[\p{L}\p{N}'’]+/gu) ?? [];
  // what's left is at most a name signing it: one or two capitalized words, the message's last
  if (rest.length > 2 || !rest.every((w) => /^\p{Lu}\p{Ll}+$/u.test(w))) return false;
  return !rest.length || words.replace(/[^\p{L}\p{N}'’]+$/u, "").endsWith(rest.at(-1)!);
}

/** The cheap screen first: a snippet that starts like an acknowledgment is worth reading the message for. */
export const looksLikeAcknowledgment = (snippet: string | null | undefined): boolean => !!snippet && snippet.length <= 200 && ACK.test(snippet.slice(0, 40));

/** Plan 202: summaries say who has to act from this prompt version on; an older one can't say the reader has nothing to do. */
/**
 * Plan 204, the fourth panel read: a message that says the reader needn't answer or act ("No action needed!", "No need to
 * reply now", "No hace falta que contestes") asks nothing of them: not an ask, and not Needs you's. Whole phrases only.
 */
const NO_REPLY = /\b(no (action|reply|response|answer) (is )?(needed|required|necessary)|no need to (reply|respond|answer|write back|get back to me|do anything)|nothing (is )?(needed|required) from you|you don'?t (need|have) to (reply|respond|answer|do anything)|no hace falta (que )?(respondas|contestes|responder|contestar|hacer nada)|no es necesario (que )?(respondas|contestes|responder|contestar)|no tienes que (responder|contestar|hacer nada)|sin necesidad de (responder|contestar)|no requiere (respuesta|acción))\b/iu;
export const saysNoReplyNeeded = (text: string | null | undefined): boolean => !!text && NO_REPLY.test(text.slice(0, ACK_MAX_CHARS));

export const SUMMARY_WHO_ACTS_SINCE = 7;

/** An acceptance answers an invitation: there's nothing to answer back. Lowercase, as the stores compare them. */
export const CALENDAR_ANSWER_PREFIXES = ["accepted:", "declined:", "tentative:", "aceptado:", "aceptada:", "rechazado:", "rechazada:", "provisional:", "nueva hora propuesta:", "new time proposed:"] as const;
