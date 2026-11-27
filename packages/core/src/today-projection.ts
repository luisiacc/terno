import { ANSWERED_KINDS, datedGroup, datedGroupAt, dayKeyOf, displayBucket, promiseActFrom, promiseBroken, promiseDay, promiseDeferred, promiseGroupAt, shownEarly, showsFrom, todayCounted, type BrokenPromise, type DatedRow, type TaskPlace, type TodayGroupKind } from "./dated";
import type { FollowupRow } from "./followups";
import type { PartOfDay } from "./part-of-day";
import { addressKey } from "./people";
import { mailDay } from "./schedule";
import { normalizeText } from "./text";
import { sortInDay, sortToday, waitsOnYou, type TodayAlso, type TodayCounts, type TodayPart, type TodayWhy } from "./today";
import { clockHolds, refKey, reminderRowId, splitZoneNote, statedClock, waitingRowId, type FeedRowId, type ItemRef, type ItemSeen } from "./today-items";

/**
 * Plan 210 (iteration 2, the owner: "a row per item"; Codex's design): What matters is one projection, the list's, the
 * sidebar's count's and the morning notice's alike. Bounded facts (the open dated items and promises with their duplicate
 * membership and related details, the conversations waiting on you, your reminders, which threads are in Spam or Trash) →
 * canonical items (one per set of true duplicates) → placement and order (`datedGroupAt`, `promiseGroupAt`, `sortToday`, `sortInDay`) →
 * rows and the counts' buckets. Pure: both stores give the facts, nothing here reads a store, and nothing is subtracted from
 * a thread count any more.
 */

export interface ProjectionFacts {
  now: number;
  /** the open dated items the open part may show (the dated setting on, untrusted senders left out), at their bound */
  dated: readonly DatedRow[];
  /** your open promises (follow-ups on), with the day of the request each answers (`withNeeds`); a nudge isn't one */
  promises: readonly NeedingPromise[];
  /**
   * conversations waiting on your answer (`waitingPage`), newest first: in the Inbox, so never Spam or Trash. Plan 215: with
   * their waiting date, the message the facts judge waiting and its record's revision (the list's: what Done and Later
   * name), and Later's moment while it's ahead (`deferredUntil`: under Coming up meanwhile, never Waiting on you nor counted)
   */
  waiting: readonly WaitingFact[];
  /** your reminders due by the end of today (the list's only: never counted) */
  reminders: readonly { threadId: number; dueAt: number }[];
  /** whether an item's conversation may show: not in Spam or Trash (it comes back with it) */
  live: (threadId: number) => boolean;
  /** the reader's zone: a promise's stated time in another is said in brackets */
  zone: string;
  /** plan 249: the user's words (absent: none, the empty box, and nothing here runs) */
  visibility?: RowVisibility;
}

/**
 * Plan 249 (the Codex review's revision 4): what the user's words say of a row, applied after the facts are resolved (links,
 * answered requests, a reply's promises): a hidden item's conversation still counts as represented, so it never comes back
 * as a waiting row; a first row sorts first within its own section.
 */
export interface RowVisibility {
  /** hidden when the words hide every entry of it; first when they put any first */
  item(item: Logical): { hide: boolean; first: boolean };
  waiting(w: WaitingFact): { hide: boolean; first: boolean };
}

/** Plan 215: a conversation waiting on you as the projection reads it (`ProjectionFacts.waiting`). */
export interface WaitingFact {
  id: number;
  lastDate: number;
  hasSent: boolean;
  waitingSince?: number;
  /** the message the facts judge waiting (null: not resolved, the count's) */
  message?: number | null;
  rev?: number;
  /** put off with Later until then */
  deferredUntil?: number | null;
  /** plan 216: taken off What matters (Remove): no waiting row anywhere, its items and your reminder as they'd be without one */
  removed?: boolean;
}

export interface ProjectedRow {
  id: FeedRowId;
  threadId: number;
  group: TodayGroupKind;
  /** a day of its own's, or Coming up's */
  day: string | null;
  why: TodayWhy;
  /** plan 210 (iteration 4): the other promises of its reply (`replyKey`), a line each */
  also?: TodayAlso[];
  /** a conversation waiting on you, whose line is its summary's */
  waiting?: boolean;
  /** plan 210 (iteration 3, revision 8): Today's "Waiting on you" part (`waitsOnYou`); its id stays as its tier changes */
  part?: TodayPart;
  /**
   * plan 210 (iteration 3, revision 9): a day ahead's or Coming up's heading (`displayBucket`), apart from its own `day`: the
   * day for the first two weeks, then its week ("week:YYYY-MM-DD")
   */
  bucket?: string;
  /** plan 210 (iteration 3, revision 10): a dated item's own message and its sender's `addressKey`, whom the row names */
  source?: { messageId: number; senderKey: string };
  /** plan 249: the user's words put it first within its section */
  first?: boolean;
}

/** One item, or the true duplicates of one: its id the canonical's key, shown as `lead`. */
export interface Logical {
  id: FeedRowId;
  lead: { source: "dated"; row: DatedRow } | { source: "promise"; row: NeedingPromise };
  members: ItemRef[];
  /** every open member, the lead first: another shows it when the lead's conversation is in Spam or Trash */
  entries: Logical["lead"][];
}

const own = (source: "dated" | "promise", id: number): string => refKey({ source, id });

/** Plan 210 (iteration 3): a promise of yours with the moment of the open dated request it answers (`promiseDay`'s `needed`). */
export type NeedingPromise = FollowupRow & { needed?: number | null; neededBefore?: string | null; neededPart?: PartOfDay | null };

/**
 * Plan 210 (iteration 3, the Codex review's revision 2): each promise with the day of the request it answers
 * (`FollowupRow.answers`), from the requests read with it in one batch: only an open request's, and only one with a day
 * (an undated ask carries none). The others as they are.
 */
export function withNeeds(promises: readonly FollowupRow[], requests: ReadonlyMap<number, Pick<DatedRow, "kind" | "state" | "dated" | "dueAt" | "before" | "partOfDay">>): NeedingPromise[] {
  return promises.map((p) => {
    const r = p.answers == null ? undefined : requests.get(p.answers);
    // plan 210 (iteration 4, revision 11): with the day it was asked before, when it was ("needed before Mon"); iteration 5,
    // the part of that day it asked for ("by Saturday morning")
    return r && r.state === "open" && r.dated && ANSWERED_KINDS.includes(r.kind) ? { ...p, needed: r.dueAt, ...(r.before ? { neededBefore: r.before } : {}), ...(r.partOfDay ? { neededPart: r.partOfDay } : {}) } : p;
  });
}

/**
 * The requests an open promise of yours answers are its row's, not rows of their own (their day is the promise's, said
 * beside it), and so is the request asked again they're one item with; unless the matcher made the promise that item too
 * (the same canonical), when that item is the row. Plan 210 (iteration 4): the reader's "Also in this conversation" reads
 * the same rule (`readerItems`).
 */
export function withoutAnswered(dated: readonly DatedRow[], promises: readonly FollowupRow[]): readonly DatedRow[] {
  if (!promises.some((p) => p.answers != null)) return dated;
  const answered = new Map<number, string>();
  for (const p of promises) if (p.answers != null && (p.state === "open" || p.state === "due")) answered.set(p.answers, p.sameAs ?? own("promise", p.id));
  const keyOf = (r: DatedRow) => r.sameAs ?? own("dated", r.id);
  // by the request's item: its own key, or its canonical's
  const hidden = new Map<string, string>();
  for (const r of dated) {
    const by = answered.get(r.id);
    if (by !== undefined) hidden.set(keyOf(r), by);
  }
  return dated.filter((r) => {
    const by = hidden.get(keyOf(r));
    return by === undefined || by === keyOf(r);
  });
}

/**
 * True duplicates as one item each: grouped by their canonical (`sameAs`, or their own key). The row is the canonical's id
 * whatever happens to its members, so the feed's selection and an act's target never move; it shows the canonical while
 * that's open, else its first open member (a merged dinner whose restaurant mail was settled shows the friend's).
 */
function logicalItems(dated: readonly DatedRow[], promises: readonly NeedingPromise[]): Logical[] {
  const groups = new Map<string, Logical>();
  const add = (key: string, entry: Logical["lead"], ref: ItemRef) => {
    const g = groups.get(key);
    const isCanonical = own(entry.source, entry.row.id) === key;
    if (!g) return void groups.set(key, { id: key, lead: entry, members: [ref], entries: [entry] });
    // the canonical leads; else the first open member, a dated item before a promise, the lower id first
    if (isCanonical) {
      g.lead = entry;
      g.members.unshift(ref);
      g.entries.unshift(entry);
    } else {
      g.members.push(ref);
      g.entries.push(entry);
    }
  };
  for (const row of dated) add(row.sameAs ?? own("dated", row.id), { source: "dated", row }, { source: "dated", id: row.id });
  for (const row of promises) add(row.sameAs ?? own("promise", row.id), { source: "promise", row }, { source: "promise", id: row.id });
  return [...groups.values()];
}

/** An item's words without the mail's own time, when the column says it (one time per row, A7). */
const wordsOf = (row: DatedRow) => (row.timed ? splitZoneNote(row.text) : { text: row.text, note: null });

/** Letters and digits only, lower case: what a detail is compared by. */
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Plan 210 (iteration 3, the panel): what a merged row's other dated members say that its own words don't, as the readers
 * write details, in brackets: Priya's dinner from the restaurant keeps "car pickup 7:05" from Jess's note. Joined into the
 * lead's own bracket, or a new one.
 */
export function withMembersDetails(text: string, others: readonly DatedRow[]): string {
  const have = plain(text);
  const details: string[] = [];
  for (const o of others) {
    for (const m of wordsOf(o).text.matchAll(/\(([^()]+)\)/gu)) {
      const d = m[1]!.trim();
      const p = plain(d);
      if (p && !have.includes(p) && !details.some((x) => plain(x) === p)) details.push(d);
    }
  }
  if (!details.length) return text;
  const more = details.join("; ");
  return /\)\s*$/u.test(text) ? text.replace(/\)\s*$/u, `; ${more})`) : `${text} (${more})`;
}

function datedWhy(row: DatedRow, missed: boolean, early: boolean, members: ItemRef[], others: readonly DatedRow[] = []): TodayWhy {
  const split = wordsOf(row);
  const mail = mailDay(row);
  return {
    kind: "dated",
    text: others.length ? withMembersDetails(split.text, others) : split.text,
    dueAt: row.dueAt,
    came: row.arrivedAt,
    ...(missed ? { missed } : {}),
    item: { id: row.id, revision: row.revision, kind: row.kind, dueDay: row.dueDay, timed: row.timed, dated: row.dated, ...(row.wanted ? { wanted: true } : {}), ...(early ? { early } : {}), ...(split.note ? { note: split.note } : {}), ...(row.before ? { before: row.before } : {}), ...(row.timed && row.wall?.place ? { travel: { day: row.wall.day, time: row.wall.time, place: row.wall.place } } : {}), ...(!row.timed && row.partOfDay ? { part: row.partOfDay } : {}), ...(mail ? { mailDay: mail } : {}) },
    ...(members.length > 1 ? { members } : {}),
  };
}

function promiseWhy(r: NeedingPromise, missed: boolean, members: ItemRef[], zone: string, now: number): TodayWhy {
  // a time its words state is the column's (its zone's words in brackets when that isn't the reader's); never in the sentence
  const clock = r.timed ? statedClock(r.text) : null;
  const note = clock?.zone && clock.zone !== zone && clockHolds(r.dueAt, clock) ? clock.note : null;
  // plan 210 (iteration 3): the day it sits under, and the days said beside it (a missed one, the one it's needed by)
  const day = promiseDay(r, now);
  const sitsOnOwn = day.dueAt === r.dueAt;
  return {
    kind: "promise",
    text: clock ? clock.rest : r.text,
    dueAt: day.dueAt,
    personName: r.personName,
    personEmail: r.personEmail,
    sentAt: r.sentAt,
    ...(missed ? { missed } : {}),
    promise: { id: r.id, revision: r.revision, dated: day.dated, ...(r.timed && sitsOnOwn ? { timed: true } : {}), ...(note && sitsOnOwn ? { note } : {}), ...(!missed && day.said != null ? { said: day.said } : {}), ...(!missed && day.needed != null ? { needed: day.needed } : {}), ...(!missed && day.neededBefore ? { neededBefore: day.neededBefore } : {}), ...(!missed && day.before ? { before: day.before } : {}), ...(day.part && !(r.timed && sitsOnOwn) ? { part: day.part } : {}), ...(!missed && day.needed != null && day.neededPart ? { neededPart: day.neededPart } : {}) },
    ...(members.length > 1 ? { members } : {}),
  };
}

/** Another item of a reply's row as its line says it (plan 210, iteration 4). */
const alsoOf = (r: DatedRow): TodayAlso => ({ kind: r.kind, text: r.timed ? splitZoneNote(r.text).text : r.text, dueDay: r.dueDay, dueAt: r.dueAt, timed: r.timed, dated: r.dated });

/** Plan 210 (iteration 4): another promise of the row's reply as its line says it, a time its words state in the when. */
function alsoOfPromise(r: NeedingPromise): TodayAlso {
  const clock = r.timed ? statedClock(r.text) : null;
  return { kind: "promise", text: clock ? clock.rest : r.text, dueDay: dayKeyOf(r.dueAt), dueAt: r.dueAt, timed: clock !== null, dated: r.dated };
}

/** What a reply's row names besides its lead for Done, Remove and Later: each other item's lead, at the revision shown. */
const seenOf = (l: Logical): ItemSeen => ({ source: l.lead.source, id: l.lead.row.id, revision: l.lead.row.revision });

interface Placed extends ProjectedRow {
  /** the moment it's ordered by in Missed (the most recently due first) */
  dueAt: number;
  /** when it came: Today's people go newest first */
  came: number;
  /**
   * plan 210 (iteration 4, revision 8): a promise broken and still needed (`promiseBroken`); iteration 5 (revision 6): needed
   * today, Today's own first; needed ahead, first in Waiting on you and overdue
   */
  broken?: BrokenPromise;
  /** plan 273 (asked with `counted`): the messages its dated items were read from */
  messages?: number[];
}

/**
 * Plan 273: what the counted rows (`todayCounted`, the badge's) stand for: the messages their dated items were read from,
 * and the conversations waiting on you. A notice for new mail, with What matters first, is for these.
 */
export interface CountedMail {
  messages: Set<number>;
  waiting: Set<number>;
}

/** A canonical item in its group, before anything of its conversation is known (`placeItems`). */
export interface PlacedItem {
  item: Logical;
  at: TaskPlace;
  /** plan 210 (iteration 4): the other promises of its reply to its person (`replyKey`), dated first by day, then in the reply's order: its Also lines */
  with?: Logical[];
}

/**
 * Plan 210 (iteration 4, the owner's "one reply, one row"; Codex revision 4): your promises from one sent message to one
 * person are one row. Presentation only, never identity: each stays its own item (its duplicates, the request it answers),
 * so the reader and the history keep them apart and `samePromise` stays what it was. The key: the message and the person
 * (their address, else their name); none with neither, as a reply to several people can't say whose a promise is.
 */
export function replyKey(p: Pick<FollowupRow, "messageId" | "personEmail" | "personName">): string | null {
  const who = p.personEmail ? addressKey(p.personEmail) : p.personName ? normalizeText(p.personName).replace(/\s+/gu, " ").trim() : "";
  return who ? `${p.messageId} ${who}` : null;
}

/** Whether any two promises came from one message: only then can a reply's group form (most mailboxes: none). */
function sharesMessage(promises: readonly FollowupRow[]): boolean {
  const seen = new Set<number>();
  for (const p of promises) {
    if (seen.has(p.messageId)) return true;
    seen.add(p.messageId);
  }
  return false;
}

/**
 * The placed items with a reply's promises as one: the group's lead is its first dated promise that shows (in the order the
 * reply said them), else its first that shows, and it keeps its own place, id and members; every other is its `with`, one
 * not showing yet too (an undated promise before its day comes: Done on the row finishes it, it never comes back alone).
 * Only items a promise of yours leads: one an event or a request leads (your promise to attend, an errand read twice) is
 * that item's row, apart. Grouped where they're placed, before the count leaves Coming up out, so the list and the count
 * agree on what's one row. `hidden`: the items a promise leads that show nowhere now.
 */
function byReply(placed: readonly PlacedItem[], hidden: readonly Logical[]): PlacedItem[] {
  const groups = new Map<string, { placed: PlacedItem[]; all: Logical[] }>();
  const add = (item: Logical, at?: PlacedItem) => {
    const key = item.lead.source === "promise" ? replyKey(item.lead.row) : null;
    if (key === null) return;
    const g = groups.get(key) ?? { placed: [], all: [] };
    groups.set(key, g);
    g.all.push(item);
    if (at) g.placed.push(at);
  };
  for (const p of placed) add(p.item, p);
  for (const item of hidden) add(item);
  const leads = new Map<PlacedItem, Logical[]>();
  const folded = new Set<Logical>();
  const said = (a: Logical, b: Logical) => a.lead.row.item - b.lead.row.item || a.lead.row.id - b.lead.row.id;
  // round 17's faults (Priya's Karin, Saturday): the Also line is one line, cut at the row's width, so what has a day comes
  // first, soonest first, and an undated promise (the credit) never pushes a dated one (Tuesday's written root cause) out of it
  const byDay = (a: Logical, b: Logical) => {
    const [x, y] = [a.lead.row as FollowupRow, b.lead.row as FollowupRow];
    return Number(y.dated) - Number(x.dated) || (x.dated && y.dated ? x.dueAt - y.dueAt : 0);
  };
  for (const g of groups.values()) {
    if (g.all.length < 2 || !g.placed.length) continue;
    const shows = [...g.placed].sort((a, b) => said(a.item, b.item));
    const lead = shows.find((p) => (p.item.lead.row as FollowupRow).dated) ?? shows[0]!;
    const others = g.all.filter((l) => l !== lead.item).sort((a, b) => byDay(a, b) || said(a, b));
    leads.set(lead, others);
    for (const l of others) folded.add(l);
  }
  if (!leads.size) return [...placed];
  return placed.flatMap((p) => (folded.has(p.item) ? [] : leads.has(p) ? [{ ...p, with: leads.get(p)! }] : [p]));
}

/**
 * The projection's first step: the canonical items (`logicalItems`) and where each sits (`datedGroupAt`, `promiseGroupAt`).
 * A related detail (a trip's return leg) is a row of its own under its own day, never also its item's Also line (plan
 * 210, iteration 5: the panel saw one leg twice, on two clocks). Needs no store: the caller then reads which of their
 * conversations may show (`placedThreads`). `count`: Coming up is never counted nor says a conversation, so it's left out.
 */
export function placeItems(dated: readonly DatedRow[], promises: readonly NeedingPromise[], now: number, o: { count?: boolean; away?: ReadonlySet<number>; /** plan 281 */ keepDeferred?: boolean } = {}): PlacedItem[] {
  const today = dayKeyOf(now);
  // plan 281: People keeps a promise put off with Later under Coming up, by its day back (What matters shows none until
  // then: an undated one has no day of its own to show it on); the count and What matters never ask for it
  const promiseAt = (row: NeedingPromise): TaskPlace | null =>
    promiseGroupAt(row, now, today) ?? (o.keepDeferred && !o.count && (row.state === "open" || row.state === "due") && promiseDeferred(row, now) ? { group: "comingUp", day: dayKeyOf(row.deferredUntil!) } : null);
  // (iteration 4, the Codex review's revision 4) a promise that only holds a request is never a row: the request is
  if (promises.some((p) => p.holds != null)) promises = promises.filter((p) => p.holds == null);
  dated = withoutAnswered(dated, promises);
  // plans 218, 277: a promise whose conversation is in Trash or Spam (`away`; archived, it stays) is no row nor member of
  // one, nor counted; the request it answers stays answered by it (the conversation went whole), and both come back with it
  const away = o.away;
  if (away?.size && promises.some((p) => away.has(p.threadId))) promises = promises.filter((p) => !away.has(p.threadId));
  // (iteration 4) a reply's promises are grouped where they're placed, then the count leaves Coming up out
  const grouping = sharesMessage(promises);
  const hidden: Logical[] = [];
  const finish = (out: PlacedItem[]) => (grouping ? byReply(out, hidden) : out).filter((p) => !(o.count && p.at.group === "comingUp"));
  // most mailboxes link nothing: each item is its own, placed where it is, and nothing is grouped (every count runs this
  // over the 1,000-item bound)
  if (!dated.some((r) => r.sameAs != null) && !promises.some((r) => r.sameAs != null)) {
    const out: PlacedItem[] = [];
    for (const row of dated) {
      const at = datedGroupAt(row, now, today);
      const lead = { source: "dated" as const, row };
      if (at !== null) out.push({ item: { id: own("dated", row.id), lead, members: [{ source: "dated", id: row.id }], entries: [lead] }, at });
    }
    for (const row of promises) {
      const at = promiseAt(row);
      const lead = { source: "promise" as const, row };
      const item: Logical = { id: own("promise", row.id), lead, members: [{ source: "promise", id: row.id }], entries: [lead] };
      if (at !== null) out.push({ item, at });
      else if (grouping) hidden.push(item);
    }
    return finish(out);
  }
  const out: PlacedItem[] = [];
  for (const item of logicalItems(dated, promises)) {
    const { lead } = item;
    const at = lead.source === "dated" ? datedGroupAt(lead.row, now, today) : promiseAt(lead.row);
    if (at !== null) out.push({ item, at });
    else if (grouping && lead.source === "promise") hidden.push(item);
  }
  return finish(out);
}

/**
 * The conversations placed items are in, every member's (one shows a merged row when the canonical's is in Spam or Trash:
 * Codex code review): what the caller asks the store about, one read.
 */
export const placedThreads = (items: readonly PlacedItem[]): number[] => [...new Set(items.flatMap((p) => p.item.entries.map((e) => e.row.threadId)))];

/**
 * Plan 210 (iteration 2): every row, in `TODAY_GROUP_ORDER` (Missed by the most recently due; Today by `sortToday`; each
 * day ahead and Coming up by their day, then the same order), and the counts. `count`: only the counts are wanted (nothing
 * ordered, no words made, no reminders).
 */
export function projectToday(f: ProjectionFacts, o: { count?: boolean; counted?: boolean } = {}): { rows: ProjectedRow[]; counts: TodayCounts; counted?: CountedMail } {
  return projectRows(placeItems(f.dated, f.promises, f.now, { count: o.count }), f, o);
}

/**
 * The projection's second step: placed items, what's waiting and your reminders as rows, and the counts' buckets; with
 * `counted` (plan 273), what the counted rows stand for, from the same pass.
 */
export function projectRows(items: readonly PlacedItem[], f: Pick<ProjectionFacts, "now" | "waiting" | "reminders" | "live" | "zone" | "visibility">, o: { count?: boolean; counted?: boolean } = {}): { rows: ProjectedRow[]; counts: TodayCounts; counted?: CountedMail } {
  const today = dayKeyOf(f.now);
  const placed: Placed[] = [];
  // each day's heading once (most rows share a few days)
  const buckets = new Map<string, string>();
  const bucketOf = (day: string): string => buckets.get(day) ?? (buckets.set(day, displayBucket(day, today)), buckets.get(day)!);
  // conversations an item of theirs shown now stands for: their ask, request or bill, or your promise to them (a Plan isn't
  // what they asked), so a waiting row there would say the same thing twice. One behind Coming up (put off with Later, or
  // not shown yet) says nothing yet: the conversation waiting on you is a row of its own meanwhile (their nudge on a promise
  // due next week, their new question beside an ask put off to Thursday)
  const represented = new Set<number>();
  // plan 215: and those a non-plan item of theirs is placed in anywhere, Coming up included
  const anywhere = new Set<number>();
  for (const placedItem of items) {
    const { item, with: others } = placedItem;
    let { at } = placedItem;
    let { lead } = item;
    // (Codex code review of iteration 2) the canonical's conversation in Spam or Trash: a live member shows the same row
    if (!f.live(lead.row.threadId)) {
      const alt = item.entries.find((e) => e !== lead && f.live(e.row.threadId));
      const altAt = !alt ? null : alt.source === "dated" ? datedGroupAt(alt.row, f.now, today) : promiseGroupAt(alt.row, f.now, today);
      if (!alt || !altAt || (o.count && altAt.group === "comingUp")) continue;
      lead = alt;
      at = altAt;
    }
    const plan = lead.source === "dated" && datedGroup(lead.row.kind) === "plans";
    if (!plan && at.group !== "comingUp") represented.add(lead.row.threadId);
    // (every member's conversation: a merged row stands for each of them, Codex code review 2, #6)
    if (!plan) for (const e of item.entries) anywhere.add(e.row.threadId);
    // plan 249: hidden by the user's words, after its conversation is counted as represented (no waiting row says it instead)
    const seen = f.visibility?.item(item);
    if (seen?.hide) continue;
    const early = lead.source === "dated" && at.group === "today" && shownEarly(lead.row, today);
    // the count needs only what `todayCounted` and `waitsOnYou` read: no words made
    const why: TodayWhy = o.count
      ? lead.source === "dated" ? { kind: "dated", item: { id: lead.row.id, revision: 0, kind: lead.row.kind, dueDay: "", timed: false, dated: true, ...(early ? { early } : {}) } } : { kind: "promise" }
      : lead.source === "dated"
        ? datedWhy(lead.row, at.group === "missed", early, item.members, item.entries.length > 1 ? item.entries.flatMap((e) => (e !== lead && e.source === "dated" ? [e.row] : [])) : undefined)
        : promiseWhy(lead.row, at.group === "missed", item.members, f.zone, f.now);
    if (others && !o.count) why.with = others.map(seenOf);
    // round 15's second morning: put off with Later, it says when it's back, never "since …" or its own day
    if (!o.count && at.group === "comingUp" && lead.row.deferredUntil != null && lead.row.deferredUntil > f.now) why.back = lead.row.deferredUntil;
    const came = lead.source === "dated" ? lead.row.arrivedAt : lead.row.sentAt;
    if (!o.count) {
      // plan 281 (owner, 2026-11-26): what People reads of this placement, one source for both views. Behind Coming up: until
      // it shows (its time to act, or Later's back if that's later; Codex's critique: never its heading's day, which is its
      // deadline). Shown now: when its time to act came, if after it came, so it's open since then, never since the mail
      // (never ahead either: a broken promise shows at once though its new day's lead is weeks off)
      const from = lead.source === "dated" ? showsFrom(lead.row) : promiseActFrom(lead.row, f.now);
      if (at.group === "comingUp") why.ahead = Math.max(why.back ?? 0, from);
      else if (from > came && from <= f.now) why.from = from;
    }
    // (fields set as they apply, not spread: this runs over the 1,000-item bound on every read)
    const row: Placed = { id: item.id, threadId: lead.row.threadId, group: at.group, day: at.day, why, dueAt: why.dueAt ?? lead.row.dueAt, came };
    if (seen?.first) row.first = true;
    if (o.counted) row.messages = item.entries.flatMap((e) => (e.source === "dated" ? [e.row.messageId] : []));
    // (plan 210, iteration 4, revision 8: someone waits on a promise broken with a live day, in the list and the count alike;
    // iteration 5, revision 6: needed today, it's Today's own, a thing to do now; needed ahead, Waiting on you's, overdue)
    const broken = at.group === "today" && lead.source === "promise" ? promiseBroken(lead.row, f.now) : null;
    if (broken) row.broken = broken;
    if (broken === "ahead" || (broken === null && at.group === "today" && waitsOnYou(why))) row.part = "waiting";
    if (!o.count) {
      if (at.day !== null && at.group !== "ahead") row.bucket = bucketOf(at.day);
      if (lead.source === "dated") row.source = { messageId: lead.row.messageId, senderKey: lead.row.senderKey };
      if (others) row.also = others.map((l) => (l.lead.source === "promise" ? alsoOfPromise(l.lead.row) : alsoOf(l.lead.row)));
      // (iteration 5, R9) your promise to come to an event, or bring someone or something to it, is the event's member
      // (`attendsEvent`): its words are the event's line, else they'd show nowhere
      else if (lead.source === "dated" && lead.row.kind === "event" && item.entries.length > 1) {
        const attends = item.entries.flatMap((e) => (e.source === "promise" ? [{ ...alsoOfPromise(e.row), attends: true }] : []));
        if (attends.length) row.also = attends;
      }
    }
    placed.push(row);
  }
  // what's waiting on you (the owner's round 10: only when something is asked; the stores' `stillWaiting` says so), unless
  // an item of the conversation already says it
  const waiting: Placed[] = [];
  // plan 215: put off with Later, a conversation waits under Coming up on its moment's day, saying when it's back, out of
  // the counts (the count leaves Coming up out); at its moment it's back in Waiting on you. Any item of the conversation
  // placed, Coming up's too (the reader's request put off with it), says it already
  for (const w of f.waiting) {
    if (w.removed || represented.has(w.id)) continue;
    // plan 249: the user's words
    const seen = f.visibility?.waiting(w);
    if (seen?.hide) continue;
    const deferred = w.deferredUntil != null && w.deferredUntil > f.now;
    if (deferred && (o.count || anywhere.has(w.id))) continue;
    const why: TodayWhy = { kind: "waiting", wrote: w.hasSent };
    if (!o.count && w.waitingSince !== undefined && w.message != null) why.reply = { since: w.waitingSince, rev: w.rev ?? 0, message: w.message };
    const row: Placed = deferred
      ? (() => {
          const day = dayKeyOf(w.deferredUntil!);
          why.back = why.ahead = w.deferredUntil!;
          return { id: waitingRowId(w.id), threadId: w.id, group: "comingUp" as const, day, bucket: bucketOf(day), why, waiting: true, dueAt: w.deferredUntil!, came: w.lastDate };
        })()
      : { id: waitingRowId(w.id), threadId: w.id, group: "today", day: null, why, waiting: true, part: "waiting", dueAt: w.lastDate, came: w.lastDate };
    if (seen?.first) row.first = true;
    waiting.push(row);
  }
  const all = placed.concat(waiting);
  // your reminder on a conversation with no row of its own (one that has one already brings it to you); plan 210
  // (iteration 4, revision 8): drawn under Today and counted there, the list and the count alike
  const shown = new Set<number>();
  for (const p of all) shown.add(p.threadId);
  const reminders: Placed[] = [...f.reminders]
    .sort((a, b) => a.dueAt - b.dueAt)
    .filter((r) => !shown.has(r.threadId) && f.live(r.threadId))
    .map((r) => ({ id: reminderRowId(r.threadId), threadId: r.threadId, group: "today", day: null, why: { kind: "reminder", dueAt: r.dueAt }, dueAt: r.dueAt, came: r.dueAt }));
  const rows = all.concat(reminders);
  const counts = countsOf(rows);
  const counted = o.counted ? countedMail(rows) : undefined;
  if (o.count) return { rows: [], counts, ...(counted && { counted }) };
  return { rows: ordered(rows), counts, ...(counted && { counted }) };
}

/** Plan 249: the rows the user's words put first, then the rest, each in the order it had. */
function firstUp<T extends { first?: boolean }>(list: T[]): T[] {
  if (!list.some((r) => r.first)) return list;
  return list.filter((r) => r.first).concat(list.filter((r) => !r.first));
}

/** Plan 273: what the rows `countsOf` counts stand for (`CountedMail`). */
function countedMail(rows: readonly Placed[]): CountedMail {
  const counted: CountedMail = { messages: new Set(), waiting: new Set() };
  for (const r of rows) {
    if (!todayCounted(r.group, r.why)) continue;
    if (r.waiting) counted.waiting.add(r.threadId);
    for (const m of r.messages ?? []) counted.messages.add(m);
  }
  return counted;
}

/**
 * The header's and the badge's buckets (`TodayCounts`), disjoint: what `todayCounted` counts, by its group and Today's part;
 * `overdue` (iteration 5, revision 6) a part of `waiting`: the broken promises needed on a day ahead.
 */
function countsOf(rows: readonly Placed[]): TodayCounts {
  const counts: TodayCounts = { missed: 0, today: 0, waiting: 0, overdue: 0 };
  for (const r of rows) {
    if (!todayCounted(r.group, r.why)) continue;
    if (r.group === "missed") counts.missed++;
    else if (r.part === "waiting") {
      counts.waiting++;
      if (r.broken === "ahead") counts.overdue++;
    } else counts.today++;
  }
  return counts;
}

/**
 * The feed's order: Missed, the most recently due first; Today's own by one key (iteration 5, revision 7: `sortToday`, a
 * broken promise needed today first, then what you do before what happens to you, each by its time and then the
 * untimed), then its "Waiting on you" part (iteration 4, the Codex review's revision 8: a promise broken and needed on a
 * day ahead first, by that day; then requests shown early, all within the seven days since iteration 5, soonest first;
 * then what has none, asks and waiting conversations as they came, newest first); each day of the seven ahead, then
 * Ahead (iteration 5, revision 5), then Coming up, by its day and then the same order, a timed row by its time of day (two
 * put off to one day). The quiet rows (a plan happening today, your reminder) stay Today's own, above the part: a
 * sub-heading holds only its own rows.
 */
function ordered(rows: readonly Placed[]): ProjectedRow[] {
  const groups = new Map<TodayGroupKind, Placed[]>();
  for (const r of rows) {
    const list = groups.get(r.group);
    if (list) list.push(r);
    else groups.set(r.group, [r]);
  }
  const of = (g: TodayGroupKind) => groups.get(g) ?? [];
  const missed = of("missed").sort((a, b) => b.dueAt - a.dueAt);
  const todays = of("today");
  const own = todays.filter((r) => r.part !== "waiting");
  const soonest = (a: Placed, b: Placed) => a.dueAt - b.dueAt;
  const broken = todays.filter((r) => r.broken === "ahead").sort(soonest);
  const dated = todays.filter((r) => r.part === "waiting" && !r.broken && r.why.item?.early).sort(soonest);
  const undated = todays.filter((r) => r.part === "waiting" && !r.broken && !r.why.item?.early).sort((a, b) => b.came - a.came);
  const byItsDay = (list: Placed[]) => sortInDay(list, (r) => r.why, (r) => r.day!);
  // plan 249: what the user's words put first leads its own section (Today's own, its waiting part, a day), each keeping its order
  if (rows.some((r) => r.first)) {
    const today = firstUp(sortToday(own, (r) => r.why, (r) => r.broken === "today")).concat(firstUp(broken.concat(dated, undated)));
    const perDay = (list: Placed[]) => {
      const sorted = byItsDay(list);
      const out: Placed[] = [];
      for (let i = 0; i < sorted.length; ) {
        let j = i;
        while (j < sorted.length && sorted[j]!.bucket === sorted[i]!.bucket && sorted[j]!.day === sorted[i]!.day) j++;
        out.push(...firstUp(sorted.slice(i, j)));
        i = j;
      }
      return out;
    };
    return firstUp(missed).concat(today, perDay(of("day")), perDay(of("ahead")), perDay(of("comingUp")));
  }
  const today = sortToday(own, (r) => r.why, (r) => r.broken === "today").concat(broken, dated, undated);
  // (the ordering's own fields ride along, unread: no copy of every row at the 1,000-item bound)
  return missed.concat(today, byItsDay(of("day")), byItsDay(of("ahead")), byItsDay(of("comingUp")));
}
