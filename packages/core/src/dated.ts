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
/** Coming up looks this far ahead. */
export const COMING_UP_DAYS = 14;
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
function leadStart(kind: DatedKind, day: Date): number {
  return dayAt(day, -DATED_LEAD_DAYS[kind], REMIND_MORNING);
}

/**
 * The sixth panel round (revision 6): when an item shows, read here rather than stored, so an item kept under a shorter lead
 * shows by today's without a rescheduling pass: the earlier of its stored `actAt` and its kind's lead before its day, never
 * before its mail came (as `datedTiming`). An alert, a delivery and what has no day keep their stored moment.
 */
function showsFrom(r: Pick<DatedRow, "kind" | "dueDay" | "dated" | "actAt" | "arrivedAt">): number {
  if (!r.dated || r.kind === "alert" || r.kind === "delivery" || r.kind === "ask") return r.actAt;
  const day = localDay(r.dueDay);
  return day ? Math.max(r.arrivedAt, Math.min(r.actAt, leadStart(r.kind, day))) : r.actAt;
}

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
export function datedPlace(r: Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "dated" | "actAt" | "deferredUntil" | "arrivedAt">, now: number): DatedPlace {
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
      if (deferred) return showsAt - now <= COMING_UP_DAYS * 86_400_000 ? "comingUp" : "hidden";
      return now < missedUntil(r) ? "missed" : "hidden";
    }
  }
  if (showsAt <= now) return group;
  return showsAt - now <= COMING_UP_DAYS * 86_400_000 ? "comingUp" : "hidden";
}

/** A promise of yours, as Today places it (plan 142's row); `deferredUntil` its Later (the fifth panel round). */
type PromiseFacts = { kind: string; state: string; dated: boolean; dueAt: number; deferredUntil?: number | null };

/** Put off with Later until a moment still ahead: no row's promise meanwhile, and never Missed nor over. */
export const promiseDeferred = (r: PromiseFacts, now: number): boolean => r.deferredUntil != null && r.deferredUntil > now;

/** Due by now: the follow-ups worker marks it `due` at `followupWakeAt`, and a promise read before it ran is due all the same. */
const promiseDue = (r: PromiseFacts, now: number): boolean => !promiseDeferred(r, now) && (r.state === "due" || (r.state === "open" && followupWakeAt(r) <= now));

/** When a dated promise leaves Missed: as a dated item does (`missedUntil`), a week after its day, or after a Later past it. */
const promiseMissedUntil = (r: PromiseFacts): number => missedUntil({ dueDay: dayKeyOf(r.dueAt), deferredUntil: r.deferredUntil ?? null });

/** The fifth panel round: a dated promise shows a request's lead before its day (a week, at 9:00), or from its Later. */
const promiseShowsAt = (r: PromiseFacts): number => {
  const lead = dayAt(new Date(startOfDay(r.dueAt)), -DATED_LEAD_DAYS.respond, REMIND_MORNING);
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
 * unless put off with Later (Coming up while within its two weeks, else hidden); Missed once its day is over, for
 * `MISSED_DAYS` (from a Later that ran past it: a deferred one is never Missed); Needs you: undated and due, not put off
 * (the fourth panel round: it has no day to sit under). A nudge isn't a promise: it's Needs you's, by `dueAt`.
 */
export function promisePlace(r: PromiseFacts, now: number): PromisePlace {
  if (r.kind !== "promise" || (r.state !== "open" && r.state !== "due")) return "hidden";
  if (!r.dated) return promiseDue(r, now) ? "needsYou" : "hidden";
  const deferred = promiseDeferred(r, now);
  const showsAt = promiseShowsAt(r);
  if (now >= dayEnd(dayKeyOf(r.dueAt))) {
    if (deferred) return showsAt - now <= COMING_UP_DAYS * 86_400_000 ? "comingUp" : "hidden";
    return promiseOver(r, now) ? "hidden" : "missed";
  }
  if (showsAt <= now) return "deadlines";
  return showsAt - now <= COMING_UP_DAYS * 86_400_000 ? "comingUp" : "hidden";
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
export function nextTodayChange(items: readonly Pick<DatedRow, "kind" | "state" | "dueDay" | "dueAt" | "timed" | "dated" | "actAt" | "deferredUntil" | "arrivedAt">[], promises: readonly PromiseFacts[], now: number): number | null {
  let next = Infinity;
  const consider = (at: number) => {
    if (at > now && at < next) next = at;
  };
  const ahead = COMING_UP_DAYS * 86_400_000;
  for (const r of items) {
    if (r.state !== "open") continue;
    const from = showsFrom(r);
    const showsAt = r.deferredUntil !== null ? Math.max(from, r.deferredUntil) : from;
    consider(showsAt);
    consider(showsAt - ahead);
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
    consider(showsAt - ahead);
    if (p.deferredUntil != null) consider(p.deferredUntil);
    consider(dayEnd(dayKeyOf(p.dueAt)));
    consider(promiseMissedUntil(p));
  }
  // Codex code review: a row's words are by the day ("Tomorrow 7:40", "Due Friday"): while one shows, midnight changes them
  // (an ask's and an undated alert's aren't: they say no day), and (the seventh panel round) moves what's Soon's on its
  // day into Today
  if (items.some((r) => r.kind !== "ask" && !undatedAlert(r) && datedPlace(r, now) !== "hidden") || promises.some((p) => promisePlace(p, now) !== "hidden")) consider(dayAt(new Date(startOfDay(now)), 1, 0));
  return Number.isFinite(next) ? next : null;
}

/**
 * Today's sections in the order they're shown. The seventh panel round (change 1): they go by when, not by kind: Missed;
 * Today (what's due or happens today, and alerts while they show); Needs you (people waiting on an answer); Soon (what's
 * due after today, within its lead); Reminders; Coming up (behind its toggle). It's also the claim order: a conversation's
 * row is its first task in it (`places()`).
 */
export const TODAY_GROUP_ORDER = ["missed", "today", "needsYou", "soon", "reminders", "comingUp"] as const;
export type TodayGroupKind = (typeof TODAY_GROUP_ORDER)[number];

/** Where a task (a dated item, a promise of yours) can sit: Reminders hold your reminders alone. */
export type TaskGroup = Exclude<TodayGroupKind, "reminders">;

const COUNTED_GROUPS: ReadonlySet<TodayGroupKind> = new Set(["missed", "today", "needsYou", "soon"]);

/**
 * What "N need you" counts, the header's, the sidebar's and the morning notice's (the seventh panel round, revision 2): a
 * row in Missed, Today, Needs you or Soon, unless its own item is a Plan's kind (an event or a delivery: something
 * happening to you, wherever it sits). `kind` is the row's own item's (`why.item.kind`); a promise or a waiting row has none.
 */
export const todayCounted = (group: TodayGroupKind, kind?: DatedKind): boolean => COUNTED_GROUPS.has(group) && (kind === undefined || datedGroup(kind) !== "plans");

/**
 * The seventh panel round (revision 6): the group an item shows in, assigned after `datedPlace` has said whether it shows
 * (eligibility, expiry, Later), from the item's own day: Today on or after its day, Soon before it. An ask is Needs you's;
 * an alert is Today's while it shows (an undated one's stored day is for order only, an ask's is its arrival: neither
 * makes anything Today). Null: not shown. `today`, `now`'s day, for a caller placing many.
 */
export function datedGroupAt(r: Parameters<typeof datedPlace>[0], now: number, today = dayKeyOf(now)): TaskGroup | null {
  const place = datedPlace(r, now);
  if (place === "hidden") return null;
  if (place === "missed" || place === "comingUp" || place === "needsYou") return place;
  return r.kind === "alert" || r.dueDay <= today ? "today" : "soon";
}

/** The same for a promise of yours: an undated one due is Needs you's, a dated one Today's on its day and Soon's before. */
export function promiseGroupAt(r: PromiseFacts, now: number, today = dayKeyOf(now)): TaskGroup | null {
  const place = promisePlace(r, now);
  if (place === "hidden") return null;
  if (place === "missed" || place === "comingUp" || place === "needsYou") return place;
  return dayKeyOf(r.dueAt) <= today ? "today" : "soon";
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
