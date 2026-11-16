import { DATED_AGAIN_CHARS, DATED_AGAIN_SENTENCES, fitDates, type DatedInput, type DatedResult } from "@terno/ai";
import { namesDayFrom, saysClock, saysDay } from "@terno/core";
import { norm, scamPressure, sentencesOf, sentencesWith, settlesKind, type Sentences } from "./dated-evidence";

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

/**
 * What the checks would never keep, read here so it's never asked about (the revision's "local rejections"), as `norm` reads
 * it: something already done (a receipt, a charge made, an order placed), a charge or renewal the mail says happens by itself
 * (unless it says that's off or failed), or a sale's end. Conservative: what slips through is asked, and `checkDates` still
 * reads the answer.
 */
const DONE = /\b(?:went through|was successful|has been (?:processed|charged|paid|renewed|delivered)|was (?:charged|paid|renewed|processed|delivered)|we (?:charged|received)|you paid|order (?:of|placed|confirmed)|se (?:cobro|cargo|renovo|proceso|entrego)|fue (?:cobrad|pagad|renovad|procesad|entregad)\w*|pagaste|solicitaste|^(?:delivered|returned|entered|paid|charged|placed|shipped|entregado|devuelto|pagado|cobrado))\b/u;
const BY_ITSELF = /\b(?:renews? automatically|automatically renew\w*|auto ?renew(?:s|al)? (?:is )?(?:on|enabled|active)|(?:be )?(?:charged|debited|renewed|paid) automatically|automatically (?:charge|debit)\w*|auto ?pay (?:is )?(?:on|enabled|active|set up)|se renueva automaticamente|se renovara automaticamente|se (?:cargara|cobrara) automaticamente|renovacion automatica (?:esta )?activ\w*|domiciliacion (?:activa|activada)|pago automatico (?:activo|activado))\b/u;
const NOT_BY_ITSELF = /\b(?:off|disabled|not|won t|will not|fail\w*|declin\w*|unable|desactivad\w*|no se|no pudimos|rechaz\w*)\b/u;
const SALE = /\b(?:sale|\d+% off|discount\w*|deals?|offer ends|promo\w*|coupon\w*|black friday|cyber monday|last chance|descuento\w*|oferta\w*|rebaja\w*|promocion\w*|ultima oportunidad)\b/u;

const byItself = (s: { read: string }) => BY_ITSELF.test(s.read) && !NOT_BY_ITSELF.test(s.read);
const rejected = (s: { said: string; read: string }) => settlesKind("pay", s.said) || DONE.test(s.read) || SALE.test(s.read) || byItself(s);

export interface LookInput {
  /** the mail as the first reading read it (quotes stripped) */
  text: string;
  subject: string;
  arrivedAt: number;
  /** a list, bulk or no-reply sender (`DatedInput.from.automated`) */
  automated: boolean;
  /** the open items and promises that reading was shown, by their days: a sentence that says one's day is about it */
  shown: readonly { due?: string | null }[];
  first: Pick<DatedResult, "items" | "settled" | "moved" | "replaced">;
}

/**
 * The sentences a second look asks about, in the mail's order, within its bounds; none when nothing's uncovered. A sentence
 * is covered by any returned item's quote, settlement's, move's or replacement's evidence (the sentence it's in), by a day an
 * item or a move returned, by an open item's day the reading was shown, or by a local rejection; a scam's pressure or a
 * charge made by itself anywhere in the mail rejects all of it. An automated mail
 * with more moments than the bound, or one on a list's line, is a listing (a newsletter's calendar), never asked about.
 */
export function lookAt(i: LookInput): string[] {
  const sentences: Sentences = sentencesOf(i.text);
  const moments = sentences.flatMap((s, at) => (holdsMoment(s.said, i.arrivedAt) ? [at] : []));
  if (!moments.length) return [];
  // an automated mail's list of moments (a newsletter's calendar, a booking's check-in, check-out and cancellation) was the
  // first reading's whole job: its one item there, or none
  if (i.automated && (moments.length > DATED_AGAIN_SENTENCES || moments.some((n) => LISTED.test(sentences[n]!.said)))) return [];
  if (scamPressure(`${i.subject}\n${i.text}`) || sentences.some(byItself)) return [];
  const covered = new Set<number>();
  // a returned item's day covers the sentences that say it too: the model read that day (a statement's "Payment due date:
  // November 25" beside the balance it quoted)
  const cover = (quote: string | null | undefined, due?: string | null) => {
    if (quote?.trim()) for (const n of sentencesWith(quote, sentences)) covered.add(n);
    if (due) for (const n of moments) if (saysDay(sentences[n]!.said, due, { arrivedAt: i.arrivedAt })) covered.add(n);
  };
  for (const x of i.first.items) cover(x.quote, x.due);
  for (const x of i.first.settled) cover(x.evidence);
  for (const x of i.first.moved) {
    cover(x.evidence, x.due);
    cover(x.textEvidence);
  }
  for (const x of i.first.replaced) cover(x.evidence);
  const days = i.shown.flatMap((o) => (o.due ? [o.due] : []));
  const left = moments.filter((n) => !covered.has(n) && !rejected(sentences[n]!) && !days.some((d) => saysDay(sentences[n]!.said, d, { arrivedAt: i.arrivedAt })));
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
  return { result: { ...first, items: [...first.items, ...again.items.filter((x) => inAsked(x.quote))] }, asked: sentences.length, complete: true };
}
