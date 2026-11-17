import { DATED_AGAIN_CHARS, DATED_AGAIN_SENTENCES, fitDates, type DatedInput, type DatedResult } from "@terno/ai";
import { DATED_KINDS, datedGroup, dayEnd, missedUntil, namesDayFrom, partOfDayIn, saysClock, saysDay, type DatedKind } from "@terno/core";
import { handledItself } from "./dated-automatic";
import { namesOtherThan, namesSpecifically, norm, otherAmounts, otherIds, otherPeriod, paragraphsOf, proposedIn, scamPressure, sentencesOf, sentencesWith, settlesKind, type Sentences } from "./dated-evidence";

/**
 * Plan 210 (iteration 5, revision 3, the owner's "a second look at a dated sentence that got no item"): a sentence of a read
 * mail that holds a day and a time or a closing ("We're meeting Tuesday the 17th at 7:00", "closes Wednesday, December 9 at
 * 11:59 PM") that nothing the first reading returned covers is asked about once more, inside `DatedWorker.consider`, before
 * its one `finish`: at most two sentences and `DATED_AGAIN_CHARS`, one call, the same provider, signal and accounting, the
 * mail already read as context, and what it finds through the same `checkDates`. Its trigger is pure and local, en and es.
 */

/** a closing: a deadline's own word ("closes", "due", "deadline", "vence", "cierra"), as `norm` reads it; never "closed", "ends" */
const CLOSING = /\b(?:clos(?:e|es|ing)|deadline|due|expir(?:e|es|ing)|last day|cut ?off|no later than|cierra\w*|cierre|vence\w*|caduca\w*|fecha limite|plazo|ultimo dia|a mas tardar)\b/u;
/** what reads as a day and isn't one: an amount ("$12.10", "10,99 €") or a street ("20th St") */
const NOT_A_DAY = /[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|£|\b(?:usd|eur|mxn|gbp|cad)\b)|\b\d{1,3}(?:st|nd|rd|th)\s+(?:st|street|ave|avenue|av|blvd|rd|road|floor|fl)\b/giu;
/** a schedule, not a moment: "runs every Monday at 6:00 AM", "cada lunes" */
const RECURRING = /\b(?:every|each|weekly|daily|cada|todos los|todas las)\b/u;
/** a list's line ("- RevOps Live — Thursday, Dec 3, 1 PM ET", "• Dec 3 — Summit", "1) …") */
const LISTED = /^\s*(?:[-–—•·*▪]|\d{1,2}[.)])\s/u;

/** Whether a sentence holds a moment the reader may have to meet: a day from the mail's own on, and a time or a closing. */
export function holdsMoment(sentence: string, arrivedAt: number): boolean {
  const said = sentence.replace(NOT_A_DAY, " ");
  return namesDayFrom(said, arrivedAt) && (saysClock(said) || CLOSING.test(norm(said))) && !RECURRING.test(norm(said));
}

/** a label on a line of its own, before what it labels ("Departs", "Sale:", "Hora de salida"): a few words, no figures */
const LABEL = /^[\p{L}][\p{L}'’ -]{0,28}:?$/u;
const label = (line: string): boolean => LABEL.test(line) && line.split(/\s+/u).length <= 3;

/**
 * Round 18 (Theo's Skyway flight, both mornings): a booking that writes the day on one line ("Mon, 16 Nov 2026") and the
 * clock on the next ("San Francisco (SFO) 8:15 AM → Austin (AUS) 1:52 PM"), or on the one after a label ("Departs"),
 * holds one moment across them, which no line of it holds alone. Those lines are read as one sentence; never a day's line
 * that ends a sentence ("…on Monday, November 16."). `joined`: each such sentence as `norm` reads it, and its day and clock
 * without the label (a label is no sale: "Sale:" is es for "Departs").
 */
export function splitMoments(text: string, arrivedAt: number): { text: string; joined: { read: string; bare: string }[] } {
  const lines = text.split("\n");
  const joined: { read: string; bare: string }[] = [];
  const out: string[] = [];
  const day = (line: string) => namesDayFrom(line.replace(NOT_A_DAY, " "), arrivedAt);
  const clock = (line: string) => saysClock(line.replace(NOT_A_DAY, " ")) && !day(line);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    const next = lines[n + 1]?.trim() ?? "";
    const at = next && label(next) ? n + 2 : n + 1;
    const said = lines[at]?.trim() ?? "";
    if (line && !/[.!?]$/u.test(line) && day(line) && !saysClock(line.replace(NOT_A_DAY, " ")) && said && clock(said)) {
      const whole = lines.slice(n, at + 1).map((l) => l.trim()).join(" ");
      out.push(whole);
      joined.push({ read: norm(whole), bare: `${line} ${said}` });
      n = at;
    } else out.push(lines[n]!);
  }
  return { text: out.join("\n"), joined };
}

/**
 * What the checks would never keep, read here so it's never asked about (the revision's "local rejections"), as `norm` reads
 * it: something already done (a receipt, a charge made, an order placed), a bill or renewal that the mail says happens by
 * itself, as `checkDates` reads it of that sentence (`handledItself`: its own words, with every veto: a failed charge, an
 * expired card, a balance owed, a trial, a request to pay), or a sale's end. Conservative: what slips through is asked, and
 * `checkDates` still reads the answer.
 */
const DONE = /\b(?:went through|was successful|has been (?:processed|charged|paid|renewed|delivered)|was (?:charged|paid|renewed|processed|delivered)|we (?:charged|received)|you paid|order (?:of|placed|confirmed)|se (?:cobro|cargo|renovo|proceso|entrego)|fue (?:cobrad|pagad|renovad|procesad|entregad)\w*|pagaste|solicitaste|^(?:delivered|returned|entered|paid|charged|placed|shipped|entregado|devuelto|pagado|cobrado))\b/u;
const SALE = /\b(?:sale|\d+% off|discount\w*|deals?|offer ends|promo\w*|coupon\w*|black friday|cyber monday|last chance|descuento\w*|oferta\w*|rebaja\w*|promocion\w*|ultima oportunidad)\b/u;
/** a sentence about a bill, a plan or a renewal: what may be paid or renewed by itself */
const BILLING = /\b(?:pay\w*|paid|bill\w*|invoice\w*|charg\w*|renew\w*|subscription\w*|plan|membership\w*|premium|auto ?pay|balance|amount|due|statement|pag\w*|factura\w*|cobr\w*|carg\w*|renov\w*|suscripcion\w*|membresia\w*|cuota|prima|saldo|importe|recibo\w*|domicilia\w*|vence\w*)\b/u;
/** a stay's check-out ("Check-out: Wednesday, November 18 (11:00 AM)"): the stay's detail, never an event of its own */
const CHECK_OUT = /\b(?:check ?out|checkout|salida del (?:hotel|alojamiento|apartamento))\b/u;

/**
 * Plan 210 (round 14's faults): a card's expiry in figures ("expires at the end of December (12/26)", "exp. 11/27", "vence
 * 12/26"), as its month ("2026-12"). The reading's card rule: the figures alone are the 26th, the earlier reading (the Codex
 * review of v11, kept in v16), and a day the mail says in words for that card ("before your current card expires on December
 * 31, 2026") is that day. Either way the figures and the words are one card, so here they name one month: a day of it
 * returned for the same card covers the other sentence, whichever reading the first one took.
 */
const CARD_EXPIRY = /\b(?:expir\w*|exp|valid thru|good thru|vence\w*|vencimiento|caduca\w*)\b/u;
const CARD_FIGURE = /(?<![\d/.])(0?[1-9]|1[0-2])\/(\d{2})(?![\d/.]\d)/gu;
export function cardMonths(words: string): string[] {
  if (!CARD_EXPIRY.test(norm(words))) return [];
  return [...words.matchAll(CARD_FIGURE)].map((m) => `20${m[2]}-${m[1]!.padStart(2, "0")}`);
}
/** whether some words say a date in a month ("2026-12"), as `saysDay` reads one (a weekday alone names no month's day) */
function saysDayIn(words: string, month: string): boolean {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) if (saysDay(words, `${month}-${String(d).padStart(2, "0")}`, { weekdays: false })) return true;
  return false;
}
/** whether a sentence is on an item's day: it says that day, or the same card's month, by its own figures or the item's */
function onDay(said: string, due: string, quote: string, arrivedAt: number): boolean {
  if (saysDay(said, due, { arrivedAt })) return true;
  if (cardMonths(said).includes(due.slice(0, 7))) return true;
  return cardMonths(quote).some((month) => saysDayIn(said, month));
}

export interface LookInput {
  /** the mail as the first reading read it (quotes stripped) */
  text: string;
  subject: string;
  arrivedAt: number;
  /** a list, bulk or no-reply sender (`DatedInput.from.automated`) */
  automated: boolean;
  /**
   * Iteration 5's code review (the panel's Diego, a person's post to a mailing list): the mail has a list header (List-Id or
   * bulk), and how the reader is among its recipients: a list's post the reader isn't named on is never looked at again
   */
  listed?: boolean;
  addressed?: "to" | "cc" | "none";
  /** the sender's name, in all their mail: it names none of their things */
  from?: string;
  /** now, for a day already past its Missed window (never returned by a look) */
  now?: number;
  /** the open items and promises that reading was shown (its conversation's and sender's): a sentence that says one's day and names it is about it */
  shown: readonly { due?: string | null; text?: string; kind?: string }[];
  first: Pick<DatedResult, "items" | "settled" | "moved" | "replaced">;
}

/**
 * The sentences a second look asks about, in the mail's order, within its bounds; none when nothing's uncovered. A sentence
 * is covered by any returned item's quote, settlement's, move's or replacement's evidence (the sentence it's in), by a day an
 * item, a move or an open item it was shown has, when the sentence is about that same thing (iteration 5's code review,
 * point 3: it names it apart, or, in a returned item's own paragraph, names nothing else), or by a local rejection; a scam's
 * pressure anywhere in the mail rejects all of it. An automated mail with more moments than the bound, or one on a list's
 * line, is a listing (a newsletter's calendar), never asked about; nor is a list's post the reader isn't named on, nor a
 * proposal the reader hasn't accepted (the claims ledger's third batch).
 */
export function lookAt(i: LookInput): string[] {
  if (i.listed && i.addressed === "none") return [];
  // round 18: a day's line and its clock's line under it are one sentence, one moment
  const split = splitMoments(i.text, i.arrivedAt);
  const sentences: Sentences = sentencesOf(split.text);
  const joinedAt = (n: number) => split.joined.find((j) => j.read === sentences[n]!.read);
  const joined = (n: number) => !!joinedAt(n);
  const moments = sentences.flatMap((s, at) => (holdsMoment(s.said, i.arrivedAt) ? [at] : []));
  if (!moments.length) return [];
  // an automated mail's list of moments (a newsletter's calendar, a booking's check-in, check-out and cancellation) was the
  // first reading's whole job: its one item there, or none
  if (i.automated && (moments.length > DATED_AGAIN_SENTENCES || moments.some((n) => LISTED.test(sentences[n]!.said)))) return [];
  if (scamPressure(`${i.subject}\n${i.text}`)) return [];
  // a proposal the reader hasn't accepted adds no plan or deadline: its question and its days go unasked, never a bill's or a
  // payment's, nor a request of the reader's own beside it (its code review); their own word for it (a promise of theirs the
  // mail names, shown with it) is an acceptance, and its days are read again as any
  const accepted = i.shown.some((o) => o.kind === "promise" && !!o.text && namesSpecifically({ text: o.text, quote: "" }, i.text, i.from));
  const proposed = accepted ? () => false : proposedIn(sentences);
  const paragraphs = paragraphsOf(i.text);
  const paragraphOf = (n: number) => paragraphs.findIndex((p) => p.read.includes(sentences[n]!.read));
  // iteration 5's code review (point 2): a bill or a renewal by itself only as the checks read it of this sentence's own
  // obligation, with their vetoes; never AutoPay said somewhere in the mail for all of it
  const automatic = (s: { said: string; read: string }) => BILLING.test(s.read) && handledItself({ kind: "pay", text: s.said, quote: s.said }, { subject: i.subject, paragraphs, tied: i.text, from: i.from });
  const rejected = (s: { said: string; read: string }) => settlesKind("pay", s.said) || DONE.test(s.read) || SALE.test(s.read) || automatic(s);
  const sameThing = (item: { text: string; quote: string }, s: { said: string }, near: boolean) => !otherIds(item, s.said) && !otherAmounts(item, s.said) && (namesSpecifically(item, s.said, i.from) || (near && !namesOtherThan(item, s.said, i.from)));
  const covered = new Set<number>();
  // a returned item's day covers a sentence that says it of the same thing: the model read that day (a statement's "Payment
  // due date: November 25" beside the balance it quoted), never another obligation's on that day
  // round 18 (Theo's flight, quoted by its day's line alone and given no time): an untimed item that never saw the clock (its
  // quote states none) covers no moment whose clock is on a line of its own
  const cover = (x: { text?: string | null; quote?: string | null }, due?: string | null, untimed = false) => {
    const item = { text: x.text ?? "", quote: x.quote?.trim() ?? "" };
    const sawClock = !untimed || saysClock(item.quote);
    const at = item.quote ? sentencesWith(item.quote, sentences) : [];
    for (const n of at) if (sawClock || !joined(n)) covered.add(n);
    if (!due) return;
    const near = new Set(at.map(paragraphOf));
    for (const n of moments) if ((sawClock || !joined(n)) && onDay(sentences[n]!.said, due, item.quote, i.arrivedAt) && sameThing(item, sentences[n]!, near.has(paragraphOf(n)))) covered.add(n);
  };
  for (const x of i.first.items) cover(x, x.due, untimed(x));
  for (const x of i.first.settled) cover({ quote: x.evidence });
  for (const x of i.first.moved) {
    cover({ quote: x.evidence, text: x.text }, x.due);
    cover({ quote: x.textEvidence });
  }
  for (const x of i.first.replaced) cover({ quote: x.evidence });
  // an open item's day (a reminder of it): only a sentence that names it
  for (const o of i.shown) if (o.due && o.text) cover({ text: o.text }, o.due);
  const bare = (n: number) => {
    const j = joinedAt(n);
    return j ? { said: j.bare, read: norm(j.bare) } : sentences[n]!;
  };
  const left = moments.filter((n) => !covered.has(n) && !rejected(bare(n)) && !proposed(n));
  const asked: string[] = [];
  let room = DATED_AGAIN_CHARS;
  for (const n of left) {
    const said = sentences[n]!.said.replace(/\s+/g, " ").trim();
    if (asked.length >= DATED_AGAIN_SENTENCES) break;
    if (said.length > room) continue;
    asked.push(said);
    room -= said.length;
  }
  return asked;
}

/**
 * Iteration 5's code review (the panel's round 14): what a look returns that's already there, or already gone, is dropped:
 * one that names an item the first reading returned, or an open item of its conversation or sender, on the same day (Diego's
 * October declaration, Priya's PC 7 flight read twice) or of the same family on any day (round 14's faults: Priya's card),
 * another moment of an event already there (a flight's arrival, a stay's last day), a check-out of its own, and a day already
 * past its Missed window (Jordan's questions due Nov 6).
 */
function repeats(x: { kind: string; text: string; quote: string; due: string | null }, there: readonly { kind?: string; text: string; quote: string; due?: string | null }[], o: { from?: string; now?: number }): boolean {
  if (x.kind === "event" && (CHECK_OUT.test(norm(x.quote)) || CHECK_OUT.test(norm(x.text)))) return true;
  if (x.due && o.now !== undefined && (DATED_KINDS as readonly string[]).includes(x.kind)) {
    const over = datedGroup(x.kind as DatedKind) === "plans" ? dayEnd(x.due) : missedUntil({ dueDay: x.due, deferredUntil: null });
    if (over <= o.now) return true;
  }
  const words = `${x.text}\n${x.quote}`;
  return there.some((e) => {
    const item = { text: e.text, quote: e.quote };
    if (!namesSpecifically(item, words, o.from)) return false;
    if ((!!x.due && e.due === x.due) || (x.kind === "event" && e.kind === "event")) return true;
    // round 14's faults (Priya's card, Dec 31 from the first reading and Dec 26 from the look): the same thing in the same
    // family is the same item whatever day each reading gave it, when the look's words name nothing the other's don't
    // beyond its kind ("expires"); never another part of it ("written questions" beside an RFP's response). The Codex code
    // review: never another of its kind either, by the look's whole words: another card's ending ("8822" beside "4417"),
    // another amount, another period's bill ("December electricity invoice" beside November's)
    if (otherIds(item, words) || otherAmounts(item, words) || otherPeriod(item, words)) return false;
    return !!e.kind && familyOf(e.kind) === familyOf(x.kind) && !namesOtherThan(item, x.text.replace(KIND_WORDS, " "), o.from);
  });
}

/**
 * Plan 210 (round 14's faults): the kinds that can be one thing read twice: what an account, a card or a plan needs (a
 * payment, a renewal, an expiry), what a person asks (with a day or without), an event, a delivery, an alert. A pay and a
 * respond of one declaration are two things on two days.
 */
const FAMILY: Record<string, string> = { pay: "account", renew: "account", expire: "account", respond: "request", ask: "request" };
const familyOf = (kind: string): string => FAMILY[kind] ?? kind;
/** a kind's own verbs, which say what happens to the thing, not which thing ("expires", "renew", "update", "vence") */
const KIND_WORDS = /\b(?:expir\w*|renew\w*|updat\w*|activat\w*|venc\w*|caduc\w*|renov\w*|actualiz\w*)\b/giu;

/** What a second look gives `consider`: the reading to check (the first's, with the look's items), and whether it's whole. */
export interface Looked {
  result: DatedResult;
  /** sentences asked about (0: none) */
  asked: number;
  /** no look was needed, or it was asked and answered: only then may "nothing asked" be written */
  complete: boolean;
  /** the look failed after the first reading: that reading is still written, and the failure's hold applies */
  error?: unknown;
}

export interface LookDeps {
  /** Spam, a muted sender and the settings, read again before anything leaves: "go", or what `consider` does instead */
  recheck(): Promise<"go" | "drop" | "stop">;
  /** the mark's one claim (`marks.claimLook`): false, already asked once */
  claim(): Promise<boolean>;
  /** the same task, provider and signal as the first reading; throws when that signal ends it */
  read(input: DatedInput): Promise<DatedResult>;
  /** the first reading's signal ended (a change of provider, Spam, Clear AI data): its error is `consider`'s, not the look's */
  aborted(): boolean;
}

/**
 * The second look, from the first reading's answer: asks about `lookAt`'s sentences at most once per mark (claimed before it
 * leaves), with the input the first reading sent (the text already read, no rescan) fitted again with them. Only items that
 * quote an asked sentence are kept from it; its settlements, moves and replacements never (the first reading had them all).
 */
export async function secondLook(first: DatedResult, o: Omit<LookInput, "first"> & { input: DatedInput; promptChars: number }, deps: LookDeps): Promise<Looked | "drop" | "stop"> {
  const sentences = lookAt({ ...o, first });
  if (!sentences.length) return { result: first, asked: 0, complete: true };
  const go = await deps.recheck();
  if (go !== "go") return go;
  if (!(await deps.claim())) return { result: first, asked: 0, complete: false };
  let again: DatedResult;
  try {
    again = await deps.read(fitDates({ ...o.input, again: sentences }, o.promptChars));
  } catch (error) {
    if (deps.aborted()) throw error;
    return { result: first, asked: sentences.length, complete: false, error };
  }
  const read = sentences.map(norm);
  const inAsked = (quote: string) => {
    const q = norm(quote);
    return !!q && read.some((s) => s.includes(q) || q.includes(s));
  };
  const asked = again.items.filter((x) => inAsked(x.quote));
  const items = timedByTwins(first.items, asked, o.text, o.from);
  const there = [...items, ...o.shown.map((x) => ({ kind: x.kind, text: x.text ?? "", quote: "", due: x.due }))];
  const found = asked.filter((x) => !repeats(x, there, o));
  return { result: { ...first, items: [...items, ...found] }, asked: sentences.length, complete: true };
}

type Item = DatedResult["items"][number];
/** a request's part of the day, read from its quote as `checkDates` reads it ("by Saturday morning"); a clock wins over it */
const partOf = (x: Item): boolean => x.kind === "respond" && !!partOfDayIn(x.quote);
const untimed = (x: Item): boolean => x.time === null && !partOf(x);

/** Two quotes in one paragraph of the mail (or one inside the other's). */
const together = (a: string, b: string, paragraphs: Sentences): boolean => {
  const at = sentencesWith(a, paragraphs);
  return at.length > 0 && sentencesWith(b, paragraphs).some((n) => at.includes(n));
};

/**
 * Words that tell two moments of one trip apart, as `norm` reads them: its way (out, back) and its end (leaving, getting
 * there). One side's word with none of its opposite, against the other's opposite with none of it, is two moments.
 */
const WAYS: readonly [RegExp, RegExp][] = [
  [/\b(?:outbound|outward|ida)\b/u, /\b(?:return\w*|inbound|back|homebound|vuelta|regreso|retorno)\b/u],
  [/\b(?:depart\w*|leav\w*|takes off|salida|sale|despega)\b/u, /\b(?:arriv\w*|lands?|landing|llegada|llega\w*|aterriza\w*)\b/u],
];
/** a flight's number ("PC 7", "UA1234") and a route's ends ("SFO → BLR", "AUS-SFO"), as written */
const FLIGHT_NO = /\b(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4}\b/gu;
const ROUTE = /\b([A-Z]{3})\s*(?:→|->|–|—|-|to)\s*([A-Z]{3})\b/gu;
/** the places a trip goes to and comes from, by name ("to Austin", "desde Austin") */
const TO = /\b(?:to|into|a|hacia|para)\s+(\p{Lu}[\p{L}'-]*)/gu;
const FROM = /\b(?:from|desde|de)\s+(\p{Lu}[\p{L}'-]*)/gu;
const found = (words: string, re: RegExp, key: (m: RegExpMatchArray) => string): Set<string> => new Set([...words.matchAll(re)].map(key));
/** both name some, and none in common */
const differ = (a: Set<string>, b: Set<string>): boolean => a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));

/**
 * Round 17's code review: two items of one trip on one day that are two of its moments (out and back, leaving and getting
 * there), two flights (their numbers or routes differ), or one going to a place the other comes from.
 */
function apart(a: string, b: string): boolean {
  const [ra, rb] = [norm(a), norm(b)];
  for (const [x, y] of WAYS) {
    const [ax, ay, bx, by] = [x.test(ra), y.test(ra), x.test(rb), y.test(rb)];
    if ((ax && !ay && by && !bx) || (ay && !ax && bx && !by)) return true;
  }
  const flight = (m: RegExpMatchArray) => m[0].replace(/\s+/gu, "");
  const route = (m: RegExpMatchArray) => `${m[1]}>${m[2]}`;
  if (differ(found(a, FLIGHT_NO, flight), found(b, FLIGHT_NO, flight)) || differ(found(a, ROUTE, route), found(b, ROUTE, route))) return true;
  const place = (m: RegExpMatchArray) => norm(m[1]!);
  const [toA, fromA, toB, fromB] = [found(a, TO, place), found(a, FROM, place), found(b, TO, place), found(b, FROM, place)];
  return [...toA].some((p) => fromB.has(p) && !toB.has(p)) || [...toB].some((p) => fromA.has(p) && !toA.has(p));
}

/**
 * Round 17's faults (Priya's Bengaluru flight, both mornings): the first reading quoted the day's heading ("DEPART —
 * Saturday, 05 Dec 2026") and gave no time; the look, asked about the line with it, returned the same flight at 23:55, which
 * `repeats` dropped whole, its time with it. A look's twin of a first item (its kind and day, naming it) that has the time,
 * or a request's part of the day, the first item lacks gives it that time: the same item, timed, never a second row. A first
 * item already timed keeps its own, whatever the twin says; the twin is dropped as a repeat either way.
 */
export function timedByTwins(first: readonly Item[], looked: readonly Item[], text: string, from?: string): Item[] {
  const paragraphs = paragraphsOf(text);
  // its code review (a "Flight to Austin" took the "Return flight from Austin" 23:10): the twin is that item only beside its
  // quote (one paragraph: Priya's heading and the line under it), with nothing that tells the two apart, and only one way
  const same = (e: Item, x: Item) =>
    x.kind === e.kind && x.due === e.due && !untimed(x) && namesSpecifically(e, `${x.text}\n${x.quote}`, from) && together(e.quote, x.quote, paragraphs) && !apart(`${e.text}\n${e.quote}`, `${x.text}\n${x.quote}`);
  const open = first.filter((e) => !!e.due && untimed(e));
  return first.map((e) => {
    if (!open.includes(e)) return e;
    const twins = looked.filter((x) => same(e, x));
    // ambiguous (two twins, or a twin another untimed item could take too): left untimed
    if (twins.length !== 1 || open.some((o) => o !== e && same(o, twins[0]!))) return e;
    const twin = twins[0]!;
    // a part of the day lives in its quote; a time in its own fields, the first's quote kept
    if (twin.time === null) return { ...e, quote: twin.quote };
    const { wall, at } = twin;
    return { ...e, time: twin.time, ...(wall !== undefined ? { wall } : {}), ...(at !== undefined ? { at } : {}) };
  });
}
