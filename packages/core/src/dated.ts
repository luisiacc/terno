import { REMIND_MORNING } from "./reminders";
import { followupWakeAt, localDay } from "./followups";
import { WAITING_WINDOW_MS } from "./people";

/**
 * Plan 204: dated items, what incoming mail says has a date that matters to the reader (a bill due, a renewal, a flight).
 * The model says what it is and when; when it shows, and where, is decided here, locally.
 */

/** `ask` (after the third panel round): a person's direct, undated ask of the reader, Needs you's, never a dated kind's substitute */
export const DATED_KINDS = ["pay", "renew", "expire", "respond", "alert", "event", "delivery", "ask"] as const;
export type DatedKind = (typeof DATED_KINDS)[number];
export const DATED_STATES = ["open", "done", "dismissed", "settled"] as const;
export type DatedState = (typeof DATED_STATES)[number];

/** Today's groups this plan adds: something to do by a date, and something happening to the reader; an ask is Needs you's. */
export type DatedGroup = "deadlines" | "plans" | "needsYou";
export const datedGroup = (kind: DatedKind): DatedGroup => (kind === "ask" ? "needsYou" : kind === "event" || kind === "delivery" ? "plans" : "deadlines");

/** What a send of yours on the thread answers (plan 204's answered rule): a request, with a day or without. */
export const ANSWERED_KINDS: readonly DatedKind[] = ["respond", "ask"];

/** How many days before its day an item shows (§2); an alert shows at once and a delivery on its day. */
/** After the panel (the owner, 2026-11-14): a week for requests from people and for bills, 30 days for expiring documents. */
/** The sixth panel round (change 3): a Plan three days ahead, so Monday's appointment is Plans' on a Friday. */
export const DATED_LEAD_DAYS: Readonly<Record<DatedKind, number>> = { pay: 7, renew: 7, expire: 30, respond: 7, alert: 0, event: 3, delivery: 0, ask: 0 };
/** Missed keeps an item this long, then it's the Earlier tab's (plan 205; the owner, 2026-11-13). */
export const MISSED_DAYS = 7;
/**
 * Plan 210 (iteration 3, the owner's "7 days whole"): what's due today and in the seven local days after it shows under its
 * day, whatever its kind's lead (a plan and a delivery quietly); a longer lead still brings something further out forward.
 * Everything else not yet shown is Coming up's, at any distance (no horizon: the open set's bound keeps it finite).
 */
export const SHOWN_DAYS = 7;
/** The sixth panel round (change 1): an alert that names no day is Deadlines' this many days from its arrival, never Missed. */
export const ALERT_DAYS = 7;
/** ...and sits among the deadlines as if due its third day (its stored `dueDay`, for order only). */
const ALERT_ORDER_DAYS = 3;
/**
 * The sixth panel round (revisions 3 and 4): what only its own conversation may move or settle, as context and as a write.
 * Each shipment is its own, and a person's ask is about the conversation it's in; other kinds move across the sender's mail.
 */
export const THREAD_SCOPED_KINDS: readonly DatedKind[] = ["delivery", "ask"];
/** A Plan with a time is over this long after it. */
export const PLAN_LENGTH_MS = 2 * 60 * 60 * 1000;
/** Items a message can give, and the open ones a message is shown to settle. */
export const DATED_ITEMS_MAX = 3;
export const DATED_OPEN_SHOWN = 10;
/** The open set's bound, and how long closed rows stay. */
export const DATED_ACTIVE_MAX = 1000;
export const DATED_CLOSED_KEEP_MS = 90 * 86_400_000;
/** The one-time check of mail already here (§6). */
export const DATED_SCAN_DAYS = 14;
export const DATED_SCAN_MAX = 300;

export interface DatedRow {
  id: number;
  threadId: number;
  messageId: number;
  item: number;
  kind: DatedKind;
  /** in the app's language: "Pay the electricity bill" */
  text: string;
  /** the mail's words that say it */
  quote: string;
  /** `addressKey` of who sent it: what can settle it, and plan 206's rules */
  senderKey: string;
  /** YYYY-MM-DD, local: the day it's due or happens */
  dueDay: string;
  /** when, for ordering: the time if the mail gave one, else 9:00 that day */
  dueAt: number;
  timed: boolean;
  /** false: an alert that named no day (its week from its arrival: `alertUntil`), or an ask (the day it arrived) */
  dated: boolean;
  /** when it shows (§2) */
  actAt: number;
  /** Later: hidden until then, and never Missed meanwhile */
  deferredUntil: number | null;
  arrivedAt: number;
  state: DatedState;
  closedReason: string | null;
  closedAt: number | null;
  fromScan: boolean;
  /** ups on each change: what you saw is what your action applies to */
  revision: number;
  model: string | null;
  provider: string | null;
  createdAt: number;
  /**
   * Plan 210 (iteration 2): shown before its kind's lead, decided when it was read (`checkDates`): a person's request to the
   * reader from its arrival (Today's people, "by Nov 30"), a delivery that needs someone there from the day before. Absent:
   * not (stored before it).
   */
  early?: boolean;
  /** Plan 210 (iteration 2): the same thing as another item (`ItemRef` key, "dated:42" or "promise:7"): one row, its canonical's */
  sameAs?: string | null;
  /** Plan 210 (iteration 2): a related detail of this dated item (a return leg under its outbound flight): its `Also` while it shows */
  detailOf?: number | null;
  /**
   * Plan 210 (iteration 3, revision 11): it lapses unless the reader acts (`lapsesUnlessRenewed`, the mail's words), so it
   * takes an expiry's lead whatever kind it was read as. Absent: not (stored before it; no backfill).
   */
  lapses?: boolean;
}

export interface DatedSetting {
  enabled: boolean;
  /** the moment it went on: mail from before it is never read without a yes */
  enabledAt: number | null;
  /** the one-time check was answered (yes or no) */
  scanAnswered: boolean;
  /** Today's header stops offering it */
  offerDismissed: boolean;
}

export const DEFAULT_DATED: DatedSetting = { enabled: false, enabledAt: null, scanAnswered: false, offerDismissed: false };

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A local day plus some days, at an hour, through a DST change as a wall clock would. */
const dayAt = (day: Date, plusDays: number, hour: number, minute = 0): number => {
  const d = new Date(day);
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

export const dayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The moment a day ends, local: the next day's 0:00. */
export const dayEnd = (dueDay: string): number => {
  const day = localDay(dueDay);
  return day ? dayAt(day, 1, 0) : Number.NaN;
};

const parseTime = (time: string | null | undefined): { h: number; m: number } | null => {
  const t = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : null;
  if (!t) return null;
  const h = Number(t[1]);
  const m = Number(t[2]);
  return h < 24 && m < 60 ? { h, m } : null;
};

export interface DatedTiming {
  dueDay: string;
  dueAt: number;
  timed: boolean;
  dated: boolean;
  actAt: number;
}

/**
 * §2 and revision 7: when an item is due and when it shows. `due` is YYYY-MM-DD (null only for an alert or an ask), `time`
 * HH:MM. Null: not to be kept (a day already over, a year out, a dated kind with no day, an ask with one). Pure; local time
 * throughout.
 */
export function datedTiming(o: { kind: DatedKind; due: string | null | undefined; time?: string | null; arrivedAt: number }): DatedTiming | null {
  const arrived = new Date(o.arrivedAt);
  // an ask has no day of its own, not even a made-up one: it shows from its arrival, for Needs you's window (askEnd)
  if (o.kind === "ask") return o.due ? null : { dueDay: dayKeyOf(o.arrivedAt), dueAt: o.arrivedAt, timed: false, dated: false, actAt: o.arrivedAt };
  if (!o.due) {
    if (o.kind !== "alert") return null;
    const day = new Date(startOfDay(o.arrivedAt));
    const dueDay = dayKeyOf(dayAt(day, ALERT_ORDER_DAYS - 1, 12));
    return { dueDay, dueAt: o.arrivedAt, timed: false, dated: false, actAt: o.arrivedAt };
  }
  const day = localDay(o.due);
  if (!day) return null;
  // a day over before the mail came isn't a deadline; one more than a year away isn't for this list
  if (dayAt(day, 1, 0) <= o.arrivedAt) return null;
  const limit = new Date(arrived);
  limit.setFullYear(limit.getFullYear() + 1);
  if (day.getTime() > limit.getTime()) return null;
  const clock = parseTime(o.time);
  const dueAt = clock ? dayAt(day, 0, clock.h, clock.m) : dayAt(day, 0, REMIND_MORNING);
  const act = o.kind === "alert" ? o.arrivedAt : o.kind === "delivery" ? dayAt(day, 0, 0) : leadStart(o.kind, day);
  return { dueDay: o.due, dueAt, timed: clock !== null, dated: true, actAt: Math.max(act, o.arrivedAt) };
}

/** 9:00 its kind's lead before a day, by wall clock across DST (an alert shows at once and a delivery on its day: theirs is stored). */
function leadStart(kind: DatedKind, day: Date, lapses = false): number {
  return dayAt(day, -DATED_LEAD_DAYS[lapses ? "expire" : kind], REMIND_MORNING);
}

/**
 * Plan 210 (iteration 3, revision 6): the one seven-day predicate, a dated item's and a promise's alike: something due on
 * `day` shows from its lead's moment or from the midnight that brings its day within `SHOWN_DAYS`, whichever is first
 * (by wall clock across DST). Expiry and an active Later are applied after it, by the caller.
 */
export const shownBy = (lead: number, day: Date): number => Math.min(lead, dayAt(day, -SHOWN_DAYS, 0));

/**
 * The sixth panel round (revision 6): when an item shows, read here rather than stored, so an item kept under a shorter lead
 * shows by today's without a rescheduling pass: the earlier of its stored `actAt` and its kind's lead before its day, never
 * before its mail came (as `datedTiming`). An alert, a delivery and what has no day keep their stored moment. Plan 210
 * (iteration 3): within its seven days whatever its lead (`shownBy`); one that lapses unless renewed on an expiry's lead.
 */
function showsFrom(r: Pick<DatedRow, "kind" | "dueDay" | "dated" | "actAt" | "arrivedAt" | "early" | "lapses">): number {
  // plan 210 (iteration 2): shown early, read from the item (a move keeps it): a person's request from its arrival (a
  // delivery that needs someone there showed from the day before: the seven days hold that now)
  if (r.early && r.dated && r.kind === "respond") return r.arrivedAt;
  if (!r.dated || r.kind === "ask") return r.actAt;
  const day = localDay(r.dueDay);
  if (!day) return r.actAt;
  // (an alert shows at once and a delivery on its day: theirs is stored)
  const lead = r.kind === "alert" || r.kind === "delivery" ? r.actAt : Math.min(r.actAt, leadStart(r.kind, day, r.lapses === true));
  return Math.max(r.arrivedAt, shownBy(lead, day));
}

/**
 * Plan 210 (iteration 2, the panel's A5): a request shown from its arrival sits in Today's people (its column "by Nov 30")
 * until its day comes, never under a far day's heading, nor behind Coming up.
 */
export const shownEarly = (r: Pick<DatedRow, "kind" | "dated" | "early" | "dueDay">, today: string): boolean => r.early === true && r.dated && r.kind === "respond" && r.dueDay > today;

/**
 * Plan 210 (iteration 2, A6): a delivery that needs someone there (a signature, an adult, an ID), by its words: shown from the
 * day before. Read once, when the item is read (`checkDates`), never on a count.
 */
const PRESENCE = /\b(signature|sign(?:ed)? for|adult|someone (?:must|needs? to|has to|should) be (?:home|there|present|available)|must be present|id (?:required|needed)|in person|firma|firmar|adulto|alguien (?:debe|tiene que|necesita) estar|presente)\b/iu;
/**
 * Plan 210 (iteration 3, revision 11): the mail's own words, never the item's (the reader's paraphrase can drop "signature"
 * or add it): the quote's paragraph, bounded by the caller.
 */
export const needsPresence = (words: string): boolean => PRESENCE.test(words);

/**
 * Plan 210 (iteration 3, revisions 2 and 11): a renewal or an expiry that lapses unless the reader acts, by the mail's own
 * words: auto-renew off, "renew before", a domain or a membership that expires. Such an item takes an expiry's lead
 * (`DATED_LEAD_DAYS.expire`) whichever kind it was read as. Words that say it renews by itself ("will renew automatically",
 * "se renovará automáticamente") are no such fact unless they say it's off. Read once, when the item is read (`checkDates`).
 */
/** within one sentence: a dot inside a word ("pingwire.dev") doesn't end it */
const NEAR = "(?:[^.\\n]|\\.(?=\\S)){0,80}";
const words = (parts: readonly string[]) => new RegExp(parts.join("|"), "iu");
/** it says renewing by itself is off */
const RENEWAL_OFF = words([
  "auto-?renew(?:al)?\\s+(?:is\\s+)?(?:off|disabled|turned off|not (?:on|enabled|active))",
  "(?:will not|won't|does not|doesn't|is not set to)\\s+(?:be\\s+)?(?:auto(?:matically|-)?\\s*)?renew",
  "sin renovaci[oó]n autom[aá]tica",
  "renovaci[oó]n autom[aá]tica\\s+(?:est[aá]\\s+)?(?:desactivada|apagada)",
  "no se renovar[aá]",
]);
/** it says the reader renews, before a day or to keep it; or a thing of theirs expires */
const RENEW_TO_KEEP = words([
  "\\brenew\\w*\\b" + NEAR + "\\bbefore\\b",
  "\\brenew\\w*(?:\\s+[\\w$.,()/-]+){0,4}\\s+by\\b",
  "\\b(?:to keep|to avoid losing|so you don't lose)\\b" + NEAR + "\\brenew",
  "\\bunless (?:you )?renew",
  "\\b(?:domain|membership|registration|certification|certificate|licen[cs]e|passport)\\b" + NEAR + "\\b(?:expir\\w*|lapse\\w*)",
  "\\b(?:renuev|renov)\\w*\\b" + NEAR + "\\b(?:antes|a m[aá]s tardar)\\b",
  "\\bpara no perder\\b",
  "\\b(?:dominio|membres[ií]a|registro|certificaci[oó]n|certificado|licencia|pasaporte)\\b" + NEAR + "\\b(?:vence\\w*|caduc\\w*|expir\\w*|vencimiento)",
]);
/** it says it renews (or is paid) by itself */
const SELF_RENEWS = words(["\\bautomatic(?:ally)?\\b", "\\bauto-?(?:renew|pay)\\w*\\s+(?:is\\s+)?on\\b", "\\bautom[aá]tic(?:a|o|amente)\\b"]);
export const lapsesUnlessRenewed = (text: string): boolean => RENEWAL_OFF.test(text) || (RENEW_TO_KEEP.test(text) && !SELF_RENEWS.test(text));

/** The kinds a lapse can be: a renewal, an expiry, and a bill or a request for one (never a plan, an alert or an ask). */
const LAPSING_KINDS: ReadonlySet<DatedKind> = new Set(["renew", "expire", "pay", "respond"]);
export const canLapse = (kind: DatedKind): boolean => LAPSING_KINDS.has(kind);

/** An alert that named no day: Deadlines' for its week (`alertUntil`), never Missed. */
export const undatedAlert = (r: Pick<DatedRow, "kind" | "dated">): boolean => r.kind === "alert" && !r.dated;

/**
 * The sixth panel round (revision 2): when an undated alert is over: `ALERT_DAYS` from its arrival, or from a Later's end
 * (as `missedUntil` counts a dated item's week from a Later past its day), so one put off is never over meanwhile.
 */
export function alertUntil(r: Pick<DatedRow, "arrivedAt" | "deferredUntil">): number {
  const d = new Date(Math.max(r.arrivedAt, r.deferredUntil ?? 0));
  d.setDate(d.getDate() + ALERT_DAYS);
  return d.getTime();
}

/**
 * Where an item is in its life: Missed, shown in its kind's lane (deadlines, plans, an ask's Needs you), Coming up, or not
 * shown. Not a heading: `datedGroupAt` assigns that from the item's own day (the seventh panel round).
 */
export type DatedPlace = "missed" | "deadlines" | "plans" | "needsYou" | "comingUp" | "hidden";

/** When a Plan is over: two hours after its time, or its day's end. */
export const planEnd = (r: Pick<DatedRow, "dueDay" | "dueAt" | "timed">): number => (r.timed ? r.dueAt + PLAN_LENGTH_MS : dayEnd(r.dueDay));

/** When an ask is over: Needs you's window after it arrived (`WAITING_WINDOW_MS`), as for a conversation waiting on you. */
export const askEnd = (r: Pick<DatedRow, "arrivedAt">): number => r.arrivedAt + WAITING_WINDOW_MS;

/**
 * Revision 8: where an item sits now. One rule for the list, the count and the timer. Later (`deferredUntil`) is honoured in
 * every group: a deferred item is never Missed.
 */
export function datedPlace(r: Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "dated" | "actAt" | "deferredUntil" | "arrivedAt" | "early" | "lapses">, now: number): DatedPlace {
  if (r.state !== "open") return "hidden";
  const group = datedGroup(r.kind);
  const deferred = r.deferredUntil !== null && r.deferredUntil > now;
  const from = showsFrom(r);
  const showsAt = deferred ? Math.max(from, r.deferredUntil!) : from;
  if (group === "plans") {
    if (now >= planEnd(r)) return "hidden";
  } else if (group === "needsYou") {
    // an ask is never Missed: it waits in Needs you until its window ends, a Later past that included
    if (now >= askEnd(r)) return "hidden";
  } else if (undatedAlert(r)) {
    // it has no day to miss: Deadlines' until its week ends, then over
    if (now >= alertUntil(r)) return "hidden";
  } else {
    const missedAt = dayEnd(r.dueDay);
    if (now >= missedAt) {
      if (deferred) return "comingUp";
      return now < missedUntil(r) ? "missed" : "hidden";
    }
  }
  return showsAt <= now ? group : "comingUp";
}

/** A promise of yours, as Today places it (plan 142's row); `deferredUntil` its Later (the fifth panel round). */
type PromiseFacts = { kind: string; state: string; dated: boolean; dueAt: number; deferredUntil?: number | null };

/** Put off with Later until a moment still ahead: no row's promise meanwhile, and never Missed nor over. */
export const promiseDeferred = (r: PromiseFacts, now: number): boolean => r.deferredUntil != null && r.deferredUntil > now;

/** Due by now: the follow-ups worker marks it `due` at `followupWakeAt`, and a promise read before it ran is due all the same. */
const promiseDue = (r: PromiseFacts, now: number): boolean => !promiseDeferred(r, now) && (r.state === "due" || (r.state === "open" && followupWakeAt(r) <= now));

/** When a dated promise leaves Missed: as a dated item does (`missedUntil`), a week after its day, or after a Later past it. */
const promiseMissedUntil = (r: PromiseFacts): number => missedUntil({ dueDay: dayKeyOf(r.dueAt), deferredUntil: r.deferredUntil ?? null });

/**
 * The fifth panel round: a dated promise shows a request's lead before its day (a week, at 9:00), or from its Later. Plan 210
 * (iteration 3): within the seven days as a dated item is (`shownBy`).
 */
const promiseShowsAt = (r: PromiseFacts): number => {
  const day = new Date(startOfDay(r.dueAt));
  const lead = shownBy(dayAt(day, -DATED_LEAD_DAYS.respond, REMIND_MORNING), day);
  return r.deferredUntil != null ? Math.max(lead, r.deferredUntil) : lead;
};

/**
 * Codex code review: past Missed's days a dated promise is the Earlier tab's (plan 205), never Needs you's again. The fifth
 * panel round: while put off it's never over, and back after its day it's Missed for a week from then.
 */
export function promiseOver(r: PromiseFacts, now: number): boolean {
  if (r.kind !== "promise" || (r.state !== "open" && r.state !== "due") || !r.dated || promiseDeferred(r, now)) return false;
  return now >= promiseMissedUntil(r);
}

/** A promise's place in its life, as `DatedPlace`'s: `promiseGroupAt` assigns its heading. */
export type PromisePlace = "missed" | "deadlines" | "needsYou" | "comingUp" | "hidden";

/**
 * The third panel round (revision 5): where a promise of yours sits, by the calendar day of its `dueAt`. One rule for the
 * list, the count and the clock. The fifth panel round: Deadlines from a request's lead before its day (`promiseShowsAt`),
 * unless put off with Later (Coming up; plan 210, iteration 3: at any distance); Missed once its day is over, for
 * `MISSED_DAYS` (from a Later that ran past it: a deferred one is never Missed); Needs you: undated and due, not put off
 * (the fourth panel round: it has no day to sit under). A nudge isn't a promise: it's Needs you's, by `dueAt`.
 */
export function promisePlace(r: PromiseFacts, now: number): PromisePlace {
  if (r.kind !== "promise" || (r.state !== "open" && r.state !== "due")) return "hidden";
  if (!r.dated) return promiseDue(r, now) ? "needsYou" : "hidden";
  const deferred = promiseDeferred(r, now);
  const showsAt = promiseShowsAt(r);
  if (now >= dayEnd(dayKeyOf(r.dueAt))) {
    if (deferred) return "comingUp";
    return promiseOver(r, now) ? "hidden" : "missed";
  }
  return showsAt <= now ? "deadlines" : "comingUp";
}

/**
 * The third panel round (revision 10): the moment Later must come before on a dated item, or null. A timed item still
 * ahead, its own moment (Later today at 1:00 PM isn't for a 1:00 PM payroll); a Plan, its end. A Missed item, or one
 * whose moment has passed, may go anywhere ahead. The menus, the picker and the backend's check all ask this.
 */
export function laterBefore(r: Pick<DatedRow, "kind" | "dueDay" | "dueAt" | "timed">, now: number): number | null {
  if (r.timed && r.dueAt > now) return r.dueAt;
  return datedGroup(r.kind) === "plans" ? planEnd(r) : null;
}

/**
 * Codex code review: an item whose time in Today is over for good: a Plan that's ended, a deadline past Missed's days and
 * not moved on with Later. It's retired (`expired`), so the open set holds only what can still show (its bound of 1,000).
 */
export function datedOver(r: Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "dated" | "deferredUntil" | "arrivedAt">, now: number): boolean {
  if (r.state !== "open") return false;
  if (datedGroup(r.kind) === "plans") return now >= planEnd(r);
  // an ask's window doesn't move with Later: one put off past it is over at its end
  if (r.kind === "ask") return now >= askEnd(r);
  // its week counts from a Later's end, so it's never over while put off
  if (undatedAlert(r)) return now >= alertUntil(r);
  if (r.deferredUntil !== null && r.deferredUntil > now) return false;
  return now >= missedUntil(r);
}

/**
 * When a deadline leaves Missed: `MISSED_DAYS` after its day ends, or (Codex review of the fixes) after a Later that
 * ran past that day ends, so a snoozed Missed item comes back for a visible week rather than straight to over.
 */
export function missedUntil(r: Pick<DatedRow, "dueDay" | "deferredUntil">): number {
  const from = Math.max(dayEnd(r.dueDay), r.deferredUntil ?? 0);
  return dayAt(new Date(startOfDay(from)), MISSED_DAYS + (from === startOfDay(from) ? 0 : 1), 0);
}

/**
 * Revision 11: the next moment, strictly after `now`, at which Today changes by the clock alone: an item showing,
 * entering Coming up, a day ending (Missed), Missed ending, a Plan ending, a deferral ending, a promise's day ending.
 */
export function nextTodayChange(items: readonly Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "dated" | "actAt" | "deferredUntil" | "arrivedAt" | "early" | "lapses">[], promises: readonly PromiseFacts[], now: number): number | null {
  let next = Infinity;
  const consider = (at: number) => {
    if (at > now && at < next) next = at;
  };
  for (const r of items) {
    if (r.state !== "open") continue;
    const from = showsFrom(r);
    const showsAt = r.deferredUntil !== null ? Math.max(from, r.deferredUntil) : from;
    consider(showsAt);
    if (r.deferredUntil !== null) consider(r.deferredUntil);
    if (datedGroup(r.kind) === "plans") consider(planEnd(r));
    else if (r.kind === "ask") consider(askEnd(r));
    else if (undatedAlert(r)) consider(alertUntil(r));
    else {
      consider(dayEnd(r.dueDay));
      consider(missedUntil(r));
    }
  }
  // where `promisePlace` moves a promise: into Coming up, its lead starting (Deadlines), its day ending (Missed), its Later
  // ending, Missed ending; an undated one as it comes due
  for (const p of promises) {
    if (p.kind !== "promise" || (p.state !== "open" && p.state !== "due")) continue;
    if (!p.dated) {
      consider(followupWakeAt(p));
      // Codex code review: put off until before its moment, its conversation waits again when the Later ends (stillWaiting)
      if (p.deferredUntil != null) consider(p.deferredUntil);
      continue;
    }
    const showsAt = promiseShowsAt(p);
    consider(showsAt);
    if (p.deferredUntil != null) consider(p.deferredUntil);
    consider(dayEnd(dayKeyOf(p.dueAt)));
    consider(promiseMissedUntil(p));
  }
  // Codex code review: a row's words are by the day ("Tomorrow 7:40", "Due Friday"): while one shows, midnight changes them.
  // Plan 210 (by day): so do the headings ("Tomorrow" becomes Today's) and what has no date ("since Wed")
  if (items.some((r) => datedPlace(r, now) !== "hidden") || promises.some((p) => promisePlace(p, now) !== "hidden")) consider(dayAt(new Date(startOfDay(now)), 1, 0));
  return Number.isFinite(next) ? next : null;
}

/**
 * What Matters' groups in the order they're shown, by day (plan 210, the owner, replacing plan 204's seventh-round groups):
 * Missed; Today (what's due or happens today, and everything with no date that needs you now: a person's ask, a promise of
 * yours that named no day, an alert that named none, what's waiting on you, your reminders due today); a day of its own
 * for each day ahead whose items' time to act has come (`day`, with its day); Coming up (behind its toggle), by day too.
 * It's also the claim order: a conversation's row is its first task in it, days in their order (`places()`).
 */
export const TODAY_GROUP_ORDER = ["missed", "today", "day", "comingUp"] as const;
export type TodayGroupKind = (typeof TODAY_GROUP_ORDER)[number];

/** Where a task (a dated item, a promise of yours) sits: its group, and for a day of its own or Coming up, its day ("YYYY-MM-DD"). */
export type TaskPlace = { group: "missed" | "today"; day: null } | { group: "day" | "comingUp"; day: string };

const COUNTED_GROUPS: ReadonlySet<TodayGroupKind> = new Set(["missed", "today"]);

/**
 * What "N need you" counts, the header's, the sidebar's and the morning notice's (plan 204's rule, plan 210's groups): a
 * row in Missed or Today, unless it's your reminder or its own item is a Plan's kind (an event or a delivery: something
 * happening to you, wherever it sits). `why` is the row's: its kind, and its own item's (a promise or a waiting row has
 * none). A day ahead and Coming up never count (plan 210, iteration 3: "this week" went with the header's third part).
 */
export const todayCounted = (group: TodayGroupKind, why: { kind: string; item?: { kind: DatedKind } }): boolean => COUNTED_GROUPS.has(group) && why.kind !== "reminder" && (why.item === undefined || datedGroup(why.item.kind) !== "plans");

const TODAY: TaskPlace = { group: "today", day: null };
const MISSED: TaskPlace = { group: "missed", day: null };

/** Plan 210 (iteration 3, revision 9): a day ahead is its own heading for the first two weeks, then its week's. */
export const DAY_HEADINGS_DAYS = 14;

/**
 * Plan 210 (iteration 3, revision 9): where a row ahead is drawn, apart from its own day: the day itself ("YYYY-MM-DD") through
 * the Sunday that ends the week of today's fourteenth day after (so no week is split), then its week, Monday to Sunday,
 * local ("week:YYYY-MM-DD", its Monday). Data, not drawing: the projection gives it, the feed draws its buckets in order.
 */
export function displayBucket(day: string, today: string): string {
  const d = localDay(day);
  const from = localDay(today);
  if (!d || !from) return day;
  const sinceMonday = (x: Date) => (x.getDay() + 6) % 7;
  const last = new Date(from);
  last.setDate(last.getDate() + DAY_HEADINGS_DAYS);
  last.setDate(last.getDate() + 6 - sinceMonday(last));
  if (d.getTime() <= last.getTime()) return day;
  d.setDate(d.getDate() - sinceMonday(d));
  return `week:${dayKeyOf(d.getTime())}`;
}

/**
 * Coming up's day for what isn't shown yet: the day it shows again, the later of its own day and its Later's (put off past
 * its day, Codex code review: the 22nd's for a bill due the 18th put off to the 22nd); with no day of its own (an ask, an
 * alert that named none, a promise that did), its Later's.
 */
function comingUpDay(own: string | null, deferredUntil: number | null | undefined, today: string): string {
  const back = deferredUntil != null ? dayKeyOf(deferredUntil) : null;
  const day = own !== null && back !== null ? (own > back ? own : back) : (own ?? back);
  return day !== null && day > today ? day : (back ?? own ?? today);
}

/**
 * Plan 210 (by day): the group an item shows in, and its day, assigned after `datedPlace` has said whether it shows
 * (eligibility, expiry, Later), from the item's own day: Today on or before it, its own day ahead. What has no date (an
 * ask, an alert that named none) is Today's while it shows; a dated alert is its day's, as anything dated. Null: not
 * shown. `today`, `now`'s day, for a caller placing many.
 */
export function datedGroupAt(r: Parameters<typeof datedPlace>[0], now: number, today = dayKeyOf(now)): TaskPlace | null {
  const place = datedPlace(r, now);
  if (place === "hidden") return null;
  if (place === "missed") return MISSED;
  const undated = r.kind === "ask" || undatedAlert(r);
  if (place === "comingUp") return { group: "comingUp", day: comingUpDay(undated ? null : r.dueDay, r.deferredUntil, today) };
  // plan 210 (iteration 2): a request shown from its arrival is Today's (its people) until its day
  if (undated || r.dueDay <= today || shownEarly(r, today)) return TODAY;
  return { group: "day", day: r.dueDay };
}

/** The same for a promise of yours: an undated one due is Today's, a dated one Today's on its day and its day's before. */
export function promiseGroupAt(r: PromiseFacts, now: number, today = dayKeyOf(now)): TaskPlace | null {
  const place = promisePlace(r, now);
  if (place === "hidden") return null;
  if (place === "missed") return MISSED;
  if (place === "needsYou") return TODAY;
  const day = dayKeyOf(r.dueAt);
  if (place === "comingUp") return { group: "comingUp", day: comingUpDay(r.dated ? day : null, r.deferredUntil, today) };
  return day <= today ? TODAY : { group: "day", day };
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ene(?:ro)?|febrero|marzo|abr(?:il)?|mayo|junio|julio|ago(?:sto)?|sept?(?:iembre)?|setiembre|octubre|noviembre|dic(?:iembre)?";
const WORDS = [
  "today", "tonight", "tomorrow", "this week", "next week", "this weekend", "end of (?:the )?month", "hoy", "esta noche", "ma[ñn]ana", "pasado ma[ñn]ana", "esta semana", "la (?:pr[oó]xima|siguiente) semana", "fin de mes",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "lunes", "martes", "mi[eé]rcoles", "jueves", "viernes", "s[aá]bado", "domingo",
  "due", "overdue", "deadline", "expir\\w*", "renew\\w*", "auto-?renew\\w*", "trial", "cancel\\w*", "subscription", "rsvp", "respond by", "reply by", "sign by", "submit\\w*",
  "venc\\w*", "fecha l[ií]mite", "plazo", "renova\\w*", "renuev\\w*", "prueba gratuita", "suscripci[oó]n", "caduc\\w*", "confirma\\w*",
  "flight", "boarding", "check-?in", "reservation", "booking", "appointment", "delivery", "deliver\\w*", "arriv\\w*", "pick ?up", "shipped", "out for delivery",
  "vuelo", "embarque", "reserva\\w*", "cita", "entrega\\w*", "llega\\w*", "recog\\w*", "env[ií]o",
  "action required", "payment failed", "payment declined", "card declined", "suspend\\w*", "locked", "verify", "past due",
  "acci[oó]n requerida", "pago (?:rechazado|fallido)", "tarjeta rechazada", "suspendid\\w*", "bloquead\\w*", "verifica\\w*",
  "invoice", "bill", "statement", "payment", "factura", "pago", "recibo", "cuota",
];
const CUE = new RegExp(
  [
    `\\b(?:${WORDS.join("|")})\\b`,
    // 2026-11-20, 20/11, 11/20/2026, 20.11.2026
    "\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b",
    "\\b\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?\\b",
    // Nov 20, 20 Nov, 20 de noviembre
    `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+)?(?:${MONTHS})\\b`,
    // 10:30, 9am, 9 p.m.
    "\\b\\d{1,2}:\\d{2}\\b",
    "\\b\\d{1,2}\\s?(?:a\\.?m\\.?|p\\.?m\\.?)",
  ].join("|"),
  "iu",
);

/**
 * §3: whether a message is worth asking about: a date, a time, or a word that goes with one, in English or Spanish. A cost
 * filter, not a judgment: it errs towards reading, and the model decides.
 */
export function hasTimeCue(text: string, subject = ""): boolean {
  return CUE.test(subject) || CUE.test(text);
}
