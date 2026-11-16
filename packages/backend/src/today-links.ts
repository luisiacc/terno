import { dayKeyOf, normalizeText, refKey, type DatedRow, type FollowupRow, type ItemRef } from "@terno/core";
import type { MailStore } from "@terno/store";
import { namingWords, norm, sameObject, sameThing } from "./dated-evidence";

/**
 * Plan 210 (iteration 2, the panel's B7; Codex's risk 5): which open items are one thing, and which is a detail of another,
 * recorded once (`same_as`, `detail_of`) so a row, its act and its history line are one, whatever reloads. Conservative:
 * evidence of the same event or deliverable (the same place at the same moment; the same amount or object in one
 * conversation; one sentence of yours read as two promises of one thing), never a shared person, day or noun alone.
 * Pure but for `TodayLinks.reconcile`, which writes what it finds.
 */

/** What says who, not where: "with Jess", "con Ana", "to Marcus" name a person, never a place. */
const PERSON_LEAD = new Set(["with", "con", "to", "for", "para", "from", "de", "by"]);

/** The proper names an item's words give for a place: capitalized past the first word, never right after "with" and the like. */
function places(text: string): Set<string> {
  const words = text.split(/[^\p{L}\p{M}\p{N}'’]+/u).filter(Boolean);
  const out = new Set<string>();
  words.forEach((w, i) => {
    if (i === 0 || !/^\p{Lu}/u.test(w) || PERSON_LEAD.has(words[i - 1]!.toLowerCase())) return;
    const key = normalizeText(w).toLowerCase();
    if (key.length >= 3) out.add(key);
  });
  return out;
}

const shares = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((w) => b.has(w));

/**
 * One event read twice (the restaurant's confirmation and a friend's note of the same dinner): both events at the very same
 * moment, from two messages, and the same words or the same place named ("Dinner at Nopa", "Dinner with Jess at Nopa").
 */
export function sameEvent(a: DatedRow, b: DatedRow): boolean {
  if (a.kind !== "event" || b.kind !== "event" || !a.timed || !b.timed || a.dueAt !== b.dueAt || a.messageId === b.messageId) return false;
  return norm(a.text) === norm(b.text) || shares(places(a.text), places(b.text));
}

/** Amounts as the mail writes them: "$12", "12 €", "US$1,186.40" → "12", "1186.40". */
const AMOUNT = /(?:[$€£]|us\$|usd\s?|eur\s?)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:€|eur\b|usd\b|dollars?\b|d[oó]lares\b|pesos\b|euros?\b)/giu;
function amounts(text: string): Set<string> {
  return new Set([...text.matchAll(AMOUNT)].map((m) => (m[1] ?? m[2])!.replace(/,/gu, "").replace(/\.00$/u, "")));
}
const ERRANDS: ReadonlySet<string> = new Set(["pay", "respond", "ask", "expire", "renew"]);

/** What an amount is for: three letters or more ("bus" is a thing), never the verbs and small words any errand has. */
const ERRAND_STOP = new Set(
  (
    "the and for you your our with from this that will send pay paid give bring get all are was can " +
    "para por con del los las una uno que sus tus mis nos les pagar paga pague enviar envia envio mandar manda traer trae dar"
  ).split(" "),
);
const objectWords = (text: string, quote: string | null): Set<string> =>
  new Set([...namingWords(`${text}\n${quote ?? ""}`, { names: false }), ...normalizeText(`${text} ${quote ?? ""}`).toLowerCase().split(/[^\p{L}]+/u)].filter((w) => w.length >= 3 && !/\d/u.test(w) && !ERRAND_STOP.has(w)));

/**
 * Months and dates an item's words name: a request for November's report and one for December's are two (Codex code review
 * of iteration 2), whatever else their words share.
 */
const PERIOD = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|q[1-4]|\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/giu;
// a month's name by its first three letters (either language's, either length), a date or a quarter whole (Codex code review)
const periods = (text: string): Set<string> => new Set([...normalizeText(text).toLowerCase().matchAll(PERIOD)].map((m) => (/^[a-z]/u.test(m[0]) && !/^q\d/u.test(m[0]) ? m[0].slice(0, 3) : m[0])));
const periodsDiffer = (a: string, b: string): boolean => {
  const [pa, pb] = [periods(a), periods(b)];
  return pa.size > 0 && pb.size > 0 && !shares(pa, pb);
};

/**
 * One errand read twice in one conversation: a bill or a request from them and your promise to do it ("$12 for the bus",
 * "send the signed slip and $12 for the bus"): the same amount and the thing it's for (Codex code review of iteration 2: an
 * amount alone isn't one errand, "$12 for the museum" is another), or (a request and your promise) the same object
 * (`sameObject`). Never across periods named apart.
 */
export function sameErrand(d: DatedRow, p: FollowupRow): boolean {
  if (d.threadId !== p.threadId || !ERRANDS.has(d.kind) || p.kind !== "promise") return false;
  // plan 210 (iteration 3): a promise its reply's verdict linked to a request (`answers`) is that request's by the link, never
  // merged with a request by its words: its row carries the request's day
  if (p.answers != null && (d.kind === "respond" || d.kind === "ask")) return false;
  if (periodsDiffer(`${d.text}\n${d.quote}`, `${p.text}\n${p.quote ?? ""}`)) return false;
  if (shares(amounts(`${d.text}\n${d.quote}`), amounts(`${p.text}\n${p.quote ?? ""}`)) && shares(objectWords(d.text, d.quote), objectWords(p.text, p.quote))) return true;
  return (d.kind === "respond" || d.kind === "ask") && sameObject(d.text, p.text);
}

/**
 * One request read twice in one conversation (the same draft asked for in two messages, a person's ask that came back with a
 * day): the same sender's, a request each, the same thing by their words (`sameThing`: one quote holds the other, or the
 * same object), never two different requests of one person.
 */
export function sameRequest(a: DatedRow, b: DatedRow): boolean {
  const request = (r: DatedRow) => r.kind === "respond" || r.kind === "ask";
  return a.id !== b.id && a.threadId === b.threadId && a.senderKey === b.senderKey && a.messageId !== b.messageId && request(a) && request(b) && !periodsDiffer(`${a.text}\n${a.quote}`, `${b.text}\n${b.quote}`) && sameThing(a, b);
}

/**
 * One promise of yours read as two from one sentence ("I'll scan both papers and email them"): the same message, the same
 * day, their quotes one sentence, and an object in common. Two things promised in one sentence ("send the deck and sign the
 * form") share none, and stay two.
 */
export function samePromise(a: FollowupRow, b: FollowupRow): boolean {
  if (a.kind !== "promise" || b.kind !== "promise" || a.messageId !== b.messageId || a.dueAt !== b.dueAt || !a.quote || !b.quote) return false;
  const [qa, qb] = [norm(a.quote), norm(b.quote)];
  if (qa.split(" ").length < 3 || qb.split(" ").length < 3 || !(qa.includes(qb) || qb.includes(qa))) return false;
  return shares(namingWords(a.text, { names: false }), namingWords(b.text, { names: false }));
}

/** What says you'll be there, en and es: attend, be there, join, come, make it, show up; asistir, ir a, estar ahí, llegar. */
const ATTEND = /(?<![\p{L}])(?:attend(?:ing)?|be (?:there|at|in)|join(?:ing)?|come|coming|make it|show up|go(?:ing)? to|asistir(?:é)?|ir(?:é)? al?|estar(?:é)? (?:ahí|allí|ahi|alli|en)|llegar(?:é)?(?: a)?|unirme a)(?![\p{L}])/giu;

/** What a promise hands over besides being there, en and es: a thing sent, brought, signed or paid is its own errand. */
const DELIVERS = /(?<![\p{L}])(?:send(?:ing)?|bring(?:ing)?|share|sign|pay|e-?mail|forward|submit|upload|deliver|prepare|enviar(?:é)?|env[ií]o|mandar(?:é)?|mando|traer(?:é)?|traigo|compartir(?:é)?|firmar(?:é)?|pagar(?:é)?|subir(?:é)?|entregar(?:é)?|preparar(?:é)?)(?![\p{L}])/iu;

/**
 * Plan 210 (iteration 4): what you'll bring to an event, or who comes with you: "bring … for/to the <event>" (Jordan's
 * "I'll bring our CSM, Nina, and our solutions engineer for the Memphis conversation"), en and es; the words after "for"
 * or "to" are what it names.
 */
const BRINGS = /(?<![\p{L}])(?:bring(?:ing)?|traer(?:é)?|traigo|llevar(?:é)?|llevo)(?![\p{L}])[^.;]*?(?<![\p{L}])(?:for|to|para|al?)\s+(?:the|this|our|your|that|la|el|los|las|esta|este|ese|esa|nuestra|nuestro|tu)\s+([^.;,]+)/iu;

/**
 * Plan 210 (iteration 3, revision 9): your promise to attend is the event it names, in the same conversation, on its day:
 * the event's words in the promise's (the attending words aside: "attend the tech check", "I'll be there for the tech
 * check"), and, when several of that day's events share them, the promise's own time. Never by a shared day alone: "I'll be
 * there for the tech check" isn't that evening's keynote. The event leads the row. The promise's own words say it's to
 * attend, and only that (Codex code review): its quote is the sentence it came from, which may say more ("I'll attend the
 * tech check and send its slides tonight": the slides are a promise of their own, and Done on the event, or its day
 * passing, must never finish them). Iteration 4: so is what you'll bring to it or who comes with you ("bring … for/to the
 * <event>": named by the words after "for", or the conversation's only event when they name none), and a promise with no
 * day, among the conversation's events. `events`: the conversation's that day, or (no day) all of its open ones.
 */
export function attendsEvent(p: FollowupRow, events: readonly DatedRow[]): DatedRow | null {
  if (p.kind !== "promise" || !events.length) return null;
  ATTEND.lastIndex = 0;
  const brings = BRINGS.exec(p.text);
  const attends = !brings && ATTEND.test(p.text);
  // what it hands over besides: the bring itself aside ("bring … for the"), nothing
  if ((!brings && !attends) || DELIVERS.test(brings ? p.text.replace(brings[0].slice(0, brings[0].length - brings[1]!.length), " ") : p.text)) return null;
  const day = p.dated ? dayKeyOf(p.dueAt) : null;
  const same = events.filter((e) => e.kind === "event" && e.threadId === p.threadId && (day === null || e.dueDay === day));
  const words = namingWords(brings ? brings[1]! : p.text.replace(ATTEND, " "));
  let named = same.filter((e) => shares(words, namingWords(e.text)));
  // several named: the promise's time picks one
  if (named.length > 1 && p.dated && p.timed) named = named.filter((e) => e.timed && e.dueAt === p.dueAt);
  if (named.length === 1) return named[0]!;
  return brings && !named.length && same.length === 1 ? same[0]! : null;
}

const TRAVEL = /\b(flights?|vuelos?|trains?|tren(?:es)?|ferr(?:y|ies)|return|regreso|vuelta)\b/iu;

/**
 * A related detail: a trip's legs from one message (an outbound flight and its return), the later one under the earlier
 * while that shows. Other events in one mail (a keynote and a tech check) are rows of their own.
 */
export function isDetailOf(detail: DatedRow, of: DatedRow): boolean {
  return detail.kind === "event" && of.kind === "event" && detail.messageId === of.messageId && detail.id !== of.id && detail.dueDay > of.dueDay && TRAVEL.test(of.text) && TRAVEL.test(detail.text);
}

/** Stored first: by when, then (one table's) the lower id; a dated item before a promise stored at the same moment. */
const older = (a: { id: number; createdAt: number }, b: { id: number; createdAt: number }): boolean => a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
const promiseOlder = (p: { createdAt: number }, d: { createdAt: number }): boolean => p.createdAt < d.createdAt;

export interface Links {
  same: { item: ItemRef; sameAs: string }[];
  details: { id: number; detailOf: number }[];
}

/**
 * What the items not looked at yet (`fresh`) are the same as, or a detail of, among every open one: each newer one joins the
 * older's canonical, so a canonical keeps its id as evidence arrives. A link found in this pass is counted at once
 * (Codex code review of iteration 2): what joins an item that has just joined another joins that one's canonical, never
 * makes a chain the store would refuse. Bucketed (by moment, conversation, message), never every pair. Plan 210 (iteration 3,
 * the code review's second round): a promise that answers a request (`answers`) is never joined into that request's item,
 * nor is the request joined into its; and its twin (`samePromise`, the same promise read twice from your reply) answers
 * what it answers, so neither reading brings the request back through the other.
 */
export function findLinks(dated: readonly DatedRow[], promises: readonly FollowupRow[], fresh: (key: string, threadId: number) => boolean): Links {
  const out: Links = { same: [], details: [] };
  const byMoment = new Map<number, DatedRow[]>();
  const byMessage = new Map<number, DatedRow[]>();
  const datedByThread = new Map<number, DatedRow[]>();
  /** plan 210 (iteration 3): a conversation's events of a day ("thread:day"), what a promise to attend may name */
  const eventsByDay = new Map<string, DatedRow[]>();
  /** (iteration 4) a conversation's events, what a promise with no day may name */
  const eventsByThread = new Map<number, DatedRow[]>();
  const promisesByThread = new Map<number, FollowupRow[]>();
  const promisesByMessage = new Map<number, FollowupRow[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const r of dated) {
    if (r.kind === "event" && r.timed) push(byMoment, r.dueAt, r);
    if (r.kind === "event") push(byMessage, r.messageId, r);
    if (r.kind === "event") push(eventsByDay, `${r.threadId}:${r.dueDay}`, r);
    // plan 210 (iteration 4, revision 11): an ask that confirms an event is that event's, never one item with another
    if (r.kind === "event") push(eventsByThread, r.threadId, r);
    if (ERRANDS.has(r.kind) && r.confirms == null) push(datedByThread, r.threadId, r);
  }
  for (const p of promises) {
    if (p.kind !== "promise") continue;
    push(promisesByThread, p.threadId, p);
    push(promisesByMessage, p.messageId, p);
  }
  // what each promise answers: its own link, else a twin's (only messages that answer something are read)
  const answers = new Map<number, number>();
  for (const p of promises) {
    if (p.kind !== "promise" || p.answers == null) continue;
    answers.set(p.id, p.answers);
    for (const o of promisesByMessage.get(p.messageId) ?? []) if (o.answers == null && !answers.has(o.id) && samePromise(o, p)) answers.set(o.id, p.answers);
  }
  const answeredBy = new Map<number, FollowupRow[]>();
  for (const p of promises) {
    const r = answers.get(p.id);
    if (r !== undefined) push(answeredBy, r, p);
  }
  const datedById = new Map(dated.map((r) => [r.id, r]));
  const errand = (d: DatedRow, p: FollowupRow) => sameErrand(d, answers.has(p.id) && p.answers == null ? { ...p, answers: answers.get(p.id)! } : p);
  // each item's canonical, this pass's links included; an item others are the same as is never made anyone's
  const joined = new Map<string, string>();
  const canonicals = new Set<string>([...dated, ...promises].flatMap((r) => (r.sameAs ? [r.sameAs] : [])));
  const own = (source: ItemRef["source"], r: { id: number }) => refKey({ source, id: r.id });
  const canonicalOf = (source: ItemRef["source"], r: { id: number; sameAs?: string | null }) => r.sameAs ?? joined.get(own(source, r)) ?? own(source, r);
  /** a promise and the request it answers never one item, whichever joins the other */
  const keptApart = (source: ItemRef["source"], row: { id: number }, to: string): boolean => {
    if (source === "promise") {
      const r = datedById.get(answers.get(row.id) ?? -1);
      return !!r && canonicalOf("dated", r) === to;
    }
    return (answeredBy.get(row.id) ?? []).some((p) => canonicalOf("promise", p) === to);
  };
  const join = (source: ItemRef["source"], row: { id: number; sameAs?: string | null }, to: string) => {
    const key = own(source, row);
    if (row.sameAs || joined.has(key) || canonicals.has(key) || to === key || keptApart(source, row, to)) return;
    joined.set(key, to);
    canonicals.add(to);
    out.same.push({ item: { source, id: row.id }, sameAs: to });
  };
  const isFresh = (source: ItemRef["source"], r: { id: number; threadId: number }) => fresh(own(source, r), r.threadId);
  const eventsOf = (p: FollowupRow) => (p.dated ? eventsByDay.get(`${p.threadId}:${dayKeyOf(p.dueAt)}`) : eventsByThread.get(p.threadId)) ?? [];
  for (const r of dated) {
    if (!isFresh("dated", r)) continue;
    const other = r.kind === "event" && r.timed ? byMoment.get(r.dueAt)?.find((o) => o.id !== r.id && older(o, r) && sameEvent(o, r)) : undefined;
    if (other) join("dated", r, canonicalOf("dated", other));
    if (r.kind === "event" && r.detailOf == null) {
      const outbound = byMessage.get(r.messageId)?.filter((o) => isDetailOf(r, o)).sort((a, b) => a.dueAt - b.dueAt)[0];
      if (outbound) out.details.push({ id: r.id, detailOf: outbound.id });
    }
    if (ERRANDS.has(r.kind) && r.confirms == null) {
      const asked = datedByThread.get(r.threadId)?.find((o) => o.id !== r.id && older(o, r) && sameRequest(o, r));
      if (asked) join("dated", r, canonicalOf("dated", asked));
      const promise = promisesByThread.get(r.threadId)?.find((p) => errand(r, p));
      // the newer joins the older's canonical
      if (promise && promiseOlder(promise, r)) join("dated", r, canonicalOf("promise", promise));
      else if (promise) join("promise", promise, canonicalOf("dated", r));
    }
    // plan 210 (iteration 3): a promise already here to attend this new event joins it, the event leading
    if (r.kind === "event") for (const p of promisesByThread.get(r.threadId) ?? []) if (attendsEvent(p, eventsOf(p)) === r) join("promise", p, canonicalOf("dated", r));
  }
  for (const p of promises) {
    if (p.kind !== "promise" || !isFresh("promise", p)) continue;
    const twin = promisesByMessage.get(p.messageId)?.find((o) => o.id !== p.id && older(o, p) && samePromise(o, p));
    if (twin) join("promise", p, canonicalOf("promise", twin));
    const same = datedByThread.get(p.threadId)?.find((d) => errand(d, p));
    if (same && !promiseOlder(p, same)) join("promise", p, canonicalOf("dated", same));
    else if (same) join("dated", same, canonicalOf("promise", p));
    // plan 210 (iteration 3): your promise to attend is the event it names, whichever came first: the event leads
    const event = attendsEvent(p, eventsOf(p));
    if (event) join("promise", p, canonicalOf("dated", event));
  }
  return out;
}

/**
 * Plan 210 (iteration 2): membership is reconciled before any projection reads the items, so a duplicate never shows as a
 * row of its own. What's matched is what hasn't been looked at in the conversation it's in now (Codex code review: a merge of
 * conversations brings two items together, so an item moved is looked at again), against every open item; the first look
 * after a start reads them all, once, bucketed. One at a time, and never while an act resolves a row's members
 * (`exclusive`), so no member joins between an act's read and its write.
 */
export class TodayLinks {
  /** each item looked at, by its key, and the conversation it was in then */
  private seen = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs `work` alone: no reconcile meanwhile, nor another act. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** ups each time membership is written: a read from before it is stale (Codex code review, round 2) */
  private written = 0;

  get version(): number {
    return this.written;
  }

  /**
   * True: something was linked, and the items should be read again. In the queue, after any reconcile or act on its way,
   * and `seen` set only once what it found is written, so a projection read beside another sees a membership written
   * meanwhile by `version` (Codex code review, round 2).
   */
  reconcile(store: MailStore, dated: readonly DatedRow[], promises: readonly FollowupRow[]): Promise<boolean> {
    return this.exclusive(async () => {
      const fresh = (key: string, threadId: number) => this.seen.get(key) !== threadId;
      const anyFresh = dated.some((r) => fresh(refKey({ source: "dated", id: r.id }), r.threadId)) || promises.some((r) => fresh(refKey({ source: "promise", id: r.id }), r.threadId));
      if (!anyFresh) return false;
      const links = findLinks(dated, promises, fresh);
      const wrote = (links.same.length || links.details.length ? await store.today.link(links) : 0) > 0;
      // bounded: what's open now, as it is now
      this.seen = new Map([...dated.map((r) => [refKey({ source: "dated", id: r.id }), r.threadId] as const), ...promises.map((r) => [refKey({ source: "promise", id: r.id }), r.threadId] as const)]);
      if (wrote) this.written++;
      return wrote;
    });
  }
}
