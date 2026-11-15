import { normalizeText, refKey, type DatedRow, type FollowupRow, type ItemRef } from "@terno/core";
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

/**
 * One errand read twice in one conversation: a bill or a request from them and your promise to do it ("$12 for the bus",
 * "send the signed slip and $12"), by the same amount, or (a request and your promise) the same object (`sameObject`).
 */
export function sameErrand(d: DatedRow, p: FollowupRow): boolean {
  if (d.threadId !== p.threadId || !ERRANDS.has(d.kind) || p.kind !== "promise") return false;
  if (shares(amounts(`${d.text}\n${d.quote}`), amounts(`${p.text}\n${p.quote ?? ""}`))) return true;
  return (d.kind === "respond" || d.kind === "ask") && sameObject(d.text, p.text);
}

/**
 * One request read twice in one conversation (the same draft asked for in two messages, a person's ask that came back with a
 * day): the same sender's, a request each, the same thing by their words (`sameThing`: one quote holds the other, or the
 * same object), never two different requests of one person.
 */
export function sameRequest(a: DatedRow, b: DatedRow): boolean {
  const request = (r: DatedRow) => r.kind === "respond" || r.kind === "ask";
  return a.id !== b.id && a.threadId === b.threadId && a.senderKey === b.senderKey && a.messageId !== b.messageId && request(a) && request(b) && sameThing(a, b);
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

const TRAVEL = /\b(flights?|vuelos?|trains?|tren(?:es)?|ferr(?:y|ies)|return|regreso|vuelta)\b/iu;

/**
 * A related detail: a trip's legs from one message (an outbound flight and its return), the later one under the earlier
 * while that shows. Other events in one mail (a keynote and a tech check) are rows of their own.
 */
export function isDetailOf(detail: DatedRow, of: DatedRow): boolean {
  return detail.kind === "event" && of.kind === "event" && detail.messageId === of.messageId && detail.id !== of.id && detail.dueDay > of.dueDay && TRAVEL.test(of.text) && TRAVEL.test(detail.text);
}

const keyOf = (source: ItemRef["source"], r: { id: number; sameAs?: string | null }): string => r.sameAs ?? refKey({ source, id: r.id });

/** Older first: a dated item before a promise stored at the same moment. */
const older = (a: { createdAt: number }, b: { createdAt: number }): boolean => a.createdAt < b.createdAt;

export interface Links {
  same: { item: ItemRef; sameAs: string }[];
  details: { id: number; detailOf: number }[];
}

/**
 * What the items stored since `seen` are the same as, or a detail of, among every open one: each newer one joins the older's
 * canonical (`keyOf`), so a canonical keeps its id as evidence arrives. Bucketed (by moment, conversation, message), never
 * every pair.
 */
export function findLinks(dated: readonly DatedRow[], promises: readonly FollowupRow[], seen: { dated: number; promise: number }): Links {
  const out: Links = { same: [], details: [] };
  const fresh = (source: ItemRef["source"], id: number) => id > (source === "dated" ? seen.dated : seen.promise);
  const byMoment = new Map<number, DatedRow[]>();
  const byMessage = new Map<number, DatedRow[]>();
  const datedByThread = new Map<number, DatedRow[]>();
  const promisesByThread = new Map<number, FollowupRow[]>();
  const promisesByMessage = new Map<number, FollowupRow[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => void m.set(k, [...(m.get(k) ?? []), v]);
  for (const r of dated) {
    if (r.kind === "event" && r.timed) push(byMoment, r.dueAt, r);
    if (r.kind === "event") push(byMessage, r.messageId, r);
    if (ERRANDS.has(r.kind)) push(datedByThread, r.threadId, r);
  }
  for (const p of promises) {
    if (p.kind !== "promise") continue;
    push(promisesByThread, p.threadId, p);
    push(promisesByMessage, p.messageId, p);
  }
  const taken = new Set<string>();
  const join = (item: ItemRef, row: { sameAs?: string | null }, canonical: string) => {
    const key = refKey(item);
    if (row.sameAs || taken.has(key) || canonical === key) return;
    taken.add(key);
    out.same.push({ item, sameAs: canonical });
  };
  for (const r of dated) {
    if (!fresh("dated", r.id)) continue;
    const other = r.kind === "event" && r.timed ? byMoment.get(r.dueAt)?.find((o) => o.id < r.id && sameEvent(o, r)) : undefined;
    if (other) join({ source: "dated", id: r.id }, r, keyOf("dated", other));
    if (r.kind === "event" && r.detailOf == null) {
      const outbound = byMessage.get(r.messageId)?.filter((o) => isDetailOf(r, o)).sort((a, b) => a.dueAt - b.dueAt)[0];
      if (outbound) out.details.push({ id: r.id, detailOf: outbound.id });
    }
    if (ERRANDS.has(r.kind)) {
      const asked = datedByThread.get(r.threadId)?.find((o) => o.id < r.id && sameRequest(o, r));
      if (asked) join({ source: "dated", id: r.id }, r, keyOf("dated", asked));
      const promise = promisesByThread.get(r.threadId)?.find((p) => sameErrand(r, p));
      // the newer joins the older's canonical
      if (promise && older(promise, r)) join({ source: "dated", id: r.id }, r, keyOf("promise", promise));
      else if (promise) join({ source: "promise", id: promise.id }, promise, keyOf("dated", r));
    }
  }
  for (const p of promises) {
    if (p.kind !== "promise" || !fresh("promise", p.id)) continue;
    const twin = promisesByMessage.get(p.messageId)?.find((o) => o.id < p.id && samePromise(o, p));
    if (twin) join({ source: "promise", id: p.id }, p, keyOf("promise", twin));
    const errand = datedByThread.get(p.threadId)?.find((d) => sameErrand(d, p));
    if (errand && older(errand, p)) join({ source: "promise", id: p.id }, p, keyOf("dated", errand));
    else if (errand) join({ source: "dated", id: errand.id }, errand, keyOf("promise", p));
  }
  return out;
}

/**
 * Plan 210 (iteration 2): membership is reconciled before any projection reads the items, so a duplicate never shows as a
 * row of its own. Only what's stored since the last look is matched (by id: both tables only grow), against every open item;
 * the first look after a start reads them all, once, bucketed. One at a time.
 */
export class TodayLinks {
  private seen = { dated: 0, promise: 0 };
  private running: Promise<boolean> | null = null;

  /** True: something was linked, and the items should be read again. */
  async reconcile(store: MailStore, dated: readonly DatedRow[], promises: readonly FollowupRow[]): Promise<boolean> {
    while (this.running) await this.running.catch(() => false);
    const top = { dated: Math.max(0, ...dated.map((r) => r.id)), promise: Math.max(0, ...promises.map((r) => r.id)) };
    // a store cleared (Clear AI data): ids may begin again
    if (top.dated < this.seen.dated) this.seen.dated = 0;
    if (top.promise < this.seen.promise) this.seen.promise = 0;
    if (top.dated === this.seen.dated && top.promise === this.seen.promise) return false;
    const run = (async () => {
      const links = findLinks(dated, promises, this.seen);
      this.seen = top;
      return (links.same.length || links.details.length ? await store.today.link(links) : 0) > 0;
    })();
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  /** For tests: what's been looked at. */
  get watermark(): { dated: number; promise: number } {
    return this.seen;
  }
}
