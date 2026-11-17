import { AiError, DATED_PROMPT_VERSION, DATED_SUBJECT_CHARS, DATED_TEXT_CHARS, costAt, datedBudget, fitDates, inZone, priceOf, wallHolds, type AiTasks, type DatedResult } from "@terno/ai";
import { addressKey, automatedSender, mutedOf, canLapse, namesDayFrom, saysClock, saysDay, withEventEnds, lapsesUnlessRenewed, localDay, needsPresence, saysNoReplyNeeded, DATED_ITEMS_MAX, DATED_KINDS, DATED_OPEN_SHOWN, followupDue, validFollowupDate, type FollowupRow, DATED_SCAN_DAYS, DATED_SCAN_MAX, datedOver, dayKeyOf, datedTiming, dayEnd, dueCutoff, hasTimeCue, partMoment, partOfDayIn, type PartOfDay, normalizeText, withoutQuotes, type SettledHow, type AiErrorKind, type DatedKind, type DatedRow, type DatedTiming, type DatedWall } from "@terno/core";
import { captureError } from "@terno/core/diag";
import type { AppSettings } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { readNothingAsked, type DatedMark, type DatedSource, type DatedWrite, type MailStore } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { silenced, silenceOf, withoutMuted } from "./dated-mutes";
import { secondLook } from "./dated-second-look";
import { UI_LOCALE_KEY } from "./forwarding";
import { handledItself } from "./dated-automatic";
import { amountsOf, bareDayAhead, contextOf, directsReader, giftCardScam, insideQuotes, quoteSpan, saidClauses, type Sentences, namesApart, namesItem, namingWords, negatedReceipt, norm, otherAmounts, otherIds, monthEndDay, namesSpecifically, paragraphsOf, plainEvidence, proposedIn, replacesPlainly, sameObject, sameParcel, sameThing, saysReplaced, saysWhen, scamPressure, sentencesOf, sentencesWith, settlesKind, startClock, zeroNamesItem, zeroOnly } from "./dated-evidence";
import { mayRelay, relayedAsk, relays, type Relay } from "./dated-relay";
import { untrustedSenders, withoutUntrusted } from "./suspicious-sender";
import { sameEvent } from "./today-links";
import type { AccountGate } from "./account-gate";

/**
 * Plan 204 §3: the dated reader. Reads live mail the user got (and, with a yes, the last 14 days), oldest first, and keeps
 * what has a date that matters, after local checks. Plan 142's worker's shape: one request at a time, no timers when
 * empty, a minute's hold after a provider fails, Clear AI data refuses late writes. Nothing logged carries mail.
 */

const PAGE = 50;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 60_000;
/** what a message costs to read, for the check's estimate: ~600 tokens in, ~100 out */
const SCAN_TOKENS = { inputTokens: 600, outputTokens: 100 };
/** the 14-day check walks this many received messages at most, to find the `DATED_SCAN_MAX` worth reading (Codex code review) */
const SCAN_WALK = 3000;

export interface DatedHost {
  readonly store: MailStore;
  now(): number;
  settings(): Promise<AppSettings>;
  /** the gate (plans 147, 150): AI can run at all */
  allowed(settings: AppSettings): Promise<boolean>;
  /** plan 211: the accounts' switches: its mail is read only where both AI and What matters are on */
  readonly gate: Pick<AccountGate, "reads" | "readsOff">;
  forTask(): Promise<AiTasks>;
  /** a request a change of provider aborts */
  begin(requestId: string, clientId: string): { signal: AbortSignal; release: () => void };
  /** what Today holds changed: the list and the count read again */
  changed(): void;
  /** a promise of yours got a new day: follow-ups look again (their snapshot to the windows, their timer) */
  promisesMoved(): void;
  /**
   * Plan 210 (iteration 3): follow-ups is on, since when: a request read after a reply of yours sends that reply to it again,
   * for its verdict (`DatedFinish.replies`); undefined, off
   */
  replies(): { since: number | null } | undefined;
  /** Plan 210 (iteration 3): the reader read what it could: a reply of yours waiting on it (or marked again) may be read */
  caughtUp(): void;
  statusChanged(status: { blockedBy: { kind: AiErrorKind; message: string } | null }): void;
  /** work over a list in the backend's slices */
  runBudgeted<T>(items: readonly T[], work: (chunk: T[]) => void | Promise<void>): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void;
}

/** HH:MM, local: an open item's time as the model reads it (prompt v7) */
const clockOf = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const inWords = (ms: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language === "es" ? "es" : "en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
};

/** prompt v10: the reader's zone, the machine's, in which `inWords`, `clockOf` and `datedTiming` read days and times, and a time the mail gives in another is converted to; read each time, as a trip changes it */
const readerZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const KINDS: ReadonlySet<string> = new Set(DATED_KINDS);

/**
 * One item a message per kind, day and time (revision 8: a keynote at 9:30 and a tech check at 4:00 are two), unless their
 * words say they're two things (plan 210, the Codex review of iteration 1, revision 3: "send the deck Friday" and "sign the
 * form Friday"). A bill, a renewal, an expiry and an alert stay one a day: a model splits one bill in two far more often than
 * a mail has two.
 */
// plan 210 (iteration 3): a renewal and an expiry on one day are one thing (Haiku gave a domain "Renew …" as both, 1 in 5)
const itemKey = (kind: string, t: { dueDay: string; dueAt: number; timed: boolean }) => `${kind === "renew" ? "expire" : kind}:${t.dueDay}:${t.timed ? t.dueAt : ""}`;
// the claims ledger's second batch: and two undated questions of one mail (an ask's day is its mail's), unless their words
// say they're one (Sam's Mom: a ride from the airport, and which room)
const TWO_A_DAY: ReadonlySet<string> = new Set(["respond", "ask", "event", "delivery"]);
/** the kinds a scam's pressure makes (`scamPressure`): a bill, a booking or a parcel keep their own checks */
const PRESSED: ReadonlySet<string> = new Set(["alert", "respond", "expire", "ask"]);
/** round 17: a receipt's paid line ("AMOUNT PAID: $64.58", "Total pagado: $64.58", "Payment received: $64.58"), as `norm` reads it */
const PAID_LINE = /\b(?:amount paid|total paid|paid|payment (?:received|amount)|monto pagado|total pagado|importe pagado|pagado|pago recibido)\b/u;
/** round 18: the kinds a proposal's mail still gives: a bill, a request (the answer it waits on), an alert */
const UNPROPOSED: ReadonlySet<string> = new Set(["respond", "ask", "pay", "alert"]);

/** A name's words, as a quote's are read: "Lucía Romero" → ["lucia", "romero"]; an initial or a bare letter isn't one. */
const nameWords = (name: string) => norm(name).split(" ").filter((w) => w.length >= 2);

/** How far before an ask's quote the reader's name may be ("Nora, could you…" quoted from "could you"): a few words. */
const NAMED_BEFORE_CHARS = 24;

/** Folded as `norm` folds a name, punctuation and line ends kept, so a sentence and a vocative comma can still be found. */
const fold = (text: string) => normalizeText(text).replace(/[^\S\n]+/g, " ");

/**
 * Who an ask is addressed to by name: the words before the first comma or colon of the sentence it's in, when that's a
 * vocative of three words or fewer ("Oren, could you…", "Hi Oren, can you…", "¿Marta, puedes…?"); never a bare first word,
 * as "Will you…" isn't to Will. The sentence is the mail's, from its start (or its line's) to the quote's end, or the
 * quote's own when the model joined two lines. Words as `nameWords` reads them.
 */
function addressedTo(quote: string, text: string): string[] {
  const flat = fold(text);
  const q = fold(quote).trim();
  const at = q ? flat.indexOf(q) : -1;
  const sentence = (at < 0 ? q : flat.slice(0, at + q.length)).replace(/[\s.!?]+$/u, "").split(/[.!?\n]/u).pop()!;
  const lead = sentence.replace(/^[^\p{L}\p{N}]+/u, "");
  const comma = lead.search(/[,:]/u);
  const vocative = comma > 0 ? norm(lead.slice(0, comma)).split(" ") : [];
  return vocative.length <= 3 ? vocative.filter((w) => w.length >= 2) : [];
}

/** The seventh panel round: addressed by name to another of the mail's recipients, and not to the reader too. */
function toAnother(quote: string, text: string, reader: string, others: readonly string[] = []): boolean {
  const mine = new Set(nameWords(reader));
  const theirs = new Set(others.flatMap(nameWords).filter((w) => !mine.has(w)));
  const to = addressedTo(quote, text);
  return to.some((w) => theirs.has(w)) && !to.some((w) => mine.has(w));
}

/**
 * The third panel round (revision 1): who an ask may be from and to, read here and not only from the model: a person
 * (`senderIsPerson`, never a list, bulk or no-reply address, but for a person's ask it relays), and the reader addressed in
 * To or named where the mail asks.
 * The seventh panel round: never one the mail addresses by name to another of its recipients ("Oren, could you send me the
 * contract?" to Oren and the reader), unless it names the reader there too. `said` is the mail as `norm` reads it, `text` as
 * it was written; `others` the other recipients' names, never an address.
 */
function askAllowed(quote: string, said: string, text: string, o: { sender?: { person: boolean }; reader?: { name: string; addressed: "to" | "cc" | "none" }; others?: readonly string[]; relay?: Relay | null }): boolean {
  // plan 210 (iteration 5, revision 8): or a person's ask a service relays (`relayedAsk`), quoted from the relay's own words;
  // the service is still no person
  if (!(o.sender?.person || relays(o.relay, quote)) || !o.reader || toAnother(quote, text, o.reader.name, o.others)) return false;
  if (o.reader.addressed === "to") return true;
  const q = norm(quote);
  const at = said.indexOf(q);
  const where = ` ${at < 0 ? q : said.slice(Math.max(0, at - NAMED_BEFORE_CHARS), at + q.length)} `;
  return nameWords(o.reader.name).some((w) => where.includes(` ${w} `));
}

/**
 * The claims ledger's second batch: Earlier said "Settled" for a dinner, a flight, an appointment and a hotel the mail
 * cancelled, and for a parcel it said arrived. How a mail settles an item, by its evidence's words (en, es): a cancellation,
 * of anything but a bill paid ("Payment received; the late fee was cancelled" is paid); a delivery's arrival. Else none:
 * "settled", which a bill's kind says as "Paid".
 */
const CANCELS = /\b(?:cancel(?:l)?ed|cancel(?:l)?ation|cancels|called off|calls off|cancelad[oa]s?|cancelacion|cancelamos|cancelo|anulad[oa]s?|anulacion|se cancela|se suspende|suspendid[oa]s?)\b/u;
const ARRIVES = /\b(?:delivered|arrived|picked up|signed for|left at (?:your|the) (?:door|front|porch|mailbox)|entregad[oa]s?|se entrego|entregamos|llego|llegaron|recogid[oa]s?)\b/u;
const PAID_WORDS = /\b(?:paid|payment (?:received|processed|went through)|received (?:your )?payment|charged|pagad[oa]|pago recibido|recibimos (?:tu|su) pago|cobramos|cobrado)\b/u;
// its code review: a word said of it, never denied just before ("wasn't cancelled", "no fue cancelado")
const DENIED_BEFORE = /\b(?:not|never|wasn t|weren t|isn t|hasn t|haven t|no|nunca)(?: \S+){0,2}$/u;
const says = (re: RegExp, read: string) => [...read.matchAll(new RegExp(re.source, "gu"))].some((m) => !DENIED_BEFORE.test(read.slice(0, m.index).trim()));
/**
 * a clause's edge inside a sentence: a comma, a semicolon, or a word that starts another ("while", "mientras"); round two:
 * never a date's comma ("Friday, November 13", "viernes, 13 de noviembre", "Nov 13, 2026") nor one in parentheses
 */
const MONTH_WORDS = String.raw`jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre`;
const CLAUSE_EDGE = new RegExp(String.raw`,(?!\s*(?:\d|(?:${MONTH_WORDS})\b))|;|\s(?:while|whereas|but|although|though|however|mientras|pero|aunque|sin embargo)\s`, "iu");
/** a sentence's clauses, never split inside parentheses */
function clausesOf(sentence: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < sentence.length; i++) {
    const c = sentence[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (depth) continue;
    const edge = CLAUSE_EDGE.exec(sentence.slice(i));
    if (edge?.index === 0) {
      out.push(sentence.slice(from, i));
      i += edge[0].length - 1;
      from = i + 1;
    }
  }
  out.push(sentence.slice(from));
  return out;
}
/**
 * The evidence's own clauses of its sentence: those it overlaps (its code review: "Your Blue cotton tees were delivered,
 * while your separate order was cancelled" is the tees' "delivered" alone). `sentence` absent: the evidence alone.
 */
function ownClause(evidence: string, sentence = ""): string {
  const e = norm(evidence);
  const clauses = clausesOf(sentence).map(norm).filter(Boolean);
  const whole = clauses.join(" ");
  const at = e ? whole.indexOf(e) : -1;
  if (at < 0) return e;
  let start = 0;
  // the clauses its words span ("Your reservation for Saturday, November 14 … has been cancelled": both its halves)
  const own = clauses.filter((c) => {
    const [from, to] = [start, start + c.length];
    start = to + 1;
    return from < at + e.length && to > at;
  });
  return own.join(" ");
}
export function settledHow(kind: string, evidence: string, sentence?: string): SettledHow | null {
  const read = ownClause(evidence, sentence);
  // a parcel's arrival in its own clause wins
  if (kind === "delivery" && says(ARRIVES, read)) return "arrived";
  return says(CANCELS, read) && !(kind === "pay" && PAID_WORDS.test(read)) ? "cancelled" : null;
}

/**
 * a sentence that says again what another said ("I mean…", "i.e.", "o sea…", "es decir…"), as written: its marker at the
 * sentence's or a clause's start, after a comma, a colon or a dash (round two: never a relative "that is available");
 * "that is" and "namely" only set off by a comma or a colon ("…, that is, the supplier agreement")
 */
const RESTATES = /(?:^|[,;:(—–-]\s*)(?:i mean|i\.\s?e\.|in other words|to be clear|o sea|osea|es decir|quiero decir|mejor dicho|(?:that is|namely)\s*[,:])/u;
const restates = (said: string) => RESTATES.test(normalizeText(said).toLowerCase().trim());

/**
 * a mailing's address ("news@", "newsletter@", "marketing@", "promo@", "updates@", "boletin@"), never a person's. Round two:
 * never an address a small studio writes from itself ("hello@", "hi@", "contact@", "info@"): its footer tells instead
 */
const BULK_LOCAL = /(?:^|[._+-])(?:news|newsletters?|marketing|promos?|promotions?|campaigns?|mailer|mailings?|digest|bulletin|updates|notifications?|announce\w*|boletin|noticias|novedades|ofertas)(?:$|[._+-])/u;
/** a mailing's footer: unsubscribe, view it in a browser, manage what you get (en, es), as `norm` reads it */
const BULK_FOOTER = /\b(?:unsubscribe|opt out|view (?:it |this (?:email )?)?in (?:your |a )?browser|manage (?:your )?(?:preferences|subscription|email settings)|update (?:your )?preferences|darte de baja|date de baja|dar(?:se)? de baja|cancelar (?:tu |la )?suscripcion|desuscribir\w*|ver (?:este correo |el correo )?en (?:tu |el )?navegador|(?:administrar|gestionar|actualizar) (?:tus )?preferencias)\b/u;

/** a greeting's words before the reader's name ("¡Hola Diego!", "Hi Diego,", "Dear Diego") */
const GREETING = /^(?:(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|hola|buenas|buenos dias|buenas tardes|buenas noches|querid[oa]|estimad[oa]|que tal)\s+)?/u;

/**
 * The claims ledger's second batch (Diego's Fer, writing from comunidad@colmenacowork.mx): a role address a person writes
 * from as themselves is that person, as an ask's checks and the reading's header read it. Only with no machine's sign (no
 * list, bulk or no-reply), the mail's first line greeting the reader by their first name, and one of its last lines the
 * From name's first word alone (a person's sign-off, "Fer"), that word not the address's own organisation ("Cobaltline
 * Finance" signing as itself). Pure.
 */
export function personAtRole(src: { automated: boolean; fromEmail: string; fromName: string }, text: string, readerName: string): boolean {
  const first = nameWords(src.fromName)[0];
  const reader = nameWords(readerName)[0];
  if (!first || !reader || automatedSender(src) || norm(src.fromEmail.split("@")[1] ?? "").split(" ").some((w) => w.includes(first))) return false;
  // its code review: a newsletter's personalised greeting and signature are no person: a list's address, or its footer
  if (BULK_LOCAL.test(src.fromEmail.split("@")[0]!.toLowerCase()) || BULK_FOOTER.test(norm(text))) return false;
  const lines = text.split("\n").map(norm).filter(Boolean);
  const greets = (lines[0] ?? "").replace(GREETING, "").split(" ");
  if (greets[0] !== reader || greets.length > 4) return false;
  return lines.slice(-6).some((l) => l === first);
}

// a verb that asks for it, then within the sentence what it asks for; read without accents, so "envíame" is "enviame"
const SEND_VERB = String.raw`send|share|give|provide|forward|e-?mail|text|tell|reply with|respond with|confirm|need|what['’]?s|what is|(?:envi|mand|pas|indic|proporcion|confirm)(?:as?|es?|ar)(?:me|nos)?|compart(?:es?|as?|ir)(?:me|nos)?|dame|danos|darme|darnos|dime|decirme|responde(?:me)? con|necesito|cual es`;
const SECRET = String.raw`password|passcode|passphrase|pin (?:number|code)|(?:one[- ]time|verification|security|login|sign[- ]in|access|authentication|2fa|6[- ]digit|six[- ]digit) code|otp|code (?:we|i|you|they) (?:just )?(?:sent|texted|emailed|got|received)|(?:bank )?account (?:number|no|details)|bank details|card (?:number|details)|cvv|cvc|routing (?:number|no)|iban|swift code|sort code|social security|ssn|(?:scan|copy|photo|picture) of (?:your |the )?(?:id|passport|driver['’]?s licen[cs]e)|(?:id|passport|licen[cs]e) (?:scan|copy|number|details)|(?:your|tu|su) (?:pin|id)|contrasena|(?:tu|su) (?:clave|nip|dni|ine|cedula|identificacion)|codigo (?:de (?:verificacion|seguridad|acceso|confirmacion)|otp|que (?:te|le) (?:llego|enviamos|mandamos|envie|mande))|numero de (?:cuenta|tarjeta|ruta|seguro social)|datos (?:bancarios|de (?:la|tu|su) tarjeta)|clabe|(?:foto|copia|escaneo|numero) de (?:tu |su |la )?(?:ine|dni|cedula|pasaporte|identificacion|licencia)`;
const ASKS_FOR_SECRETS = new RegExp(String.raw`\b(?:${SEND_VERB})\b[^.!?\n]{0,60}?\b(?:${SECRET})\b`, "i");

/**
 * Plan 210 (iteration 2): an ask now keeps its conversation in Needs you, so a sentence that says it only informs ("Nora,
 * just so you know, the caterer is confirmed", "FYI…", "para que sepas…") is never one, whatever the model made of it (Haiku
 * did, 7 in 15 readings in Spanish on prompt v12). Conservative (the Codex code review, two rounds): after the lead-in, it
 * must state something about something ("the caterer is confirmed", "el catering está confirmado") and mustn't ask, need,
 * want, tell the reader to do something or speak to them ("FYI, send me the contract", "FYI, I need your approval", "FYI,
 * fill out the form", "para que sepas, completa el formulario" are asks). Read without accents. Pure.
 */
const TELLS = /^(?:[\p{L}'’.-]+(?: [\p{L}'’.-]+)?,\s*)?(?:just so you know|just a heads[- ]up|heads[- ]up|fyi|for your information|(?:solo )?para que (?:lo )?sepas|te aviso que)\b[\s,:;.-]*/iu;
const STILL_ASKS = new RegExp(
  String.raw`[?¿]|\b(?:${SEND_VERB}|please|could|can|would|will you|let me|approve|sign|review|check|call|reply|answer|pay|bring|book|schedule|want|wanted|like|need|needs|must|should|you|your|yours|yourself|por favor|puedes|podrias|puede|podria|avisame|necesit\w*|quier\w*|quisier\w*|gustaria|firm\w*|revis\w*|llam\w*|respond\w*|contest\w*|pag\w*|tra[ei]\w*|reserv\w*|hay que|tienes que|tiene que|debes|deberias|te|ti|tu|tus|usted|ustedes|contigo)\b`,
  "i",
);
/** round 2: what follows the lead-in is a statement about something ("the caterer is confirmed"), never a bare imperative ("fill out the form") */
const STATES = /^(?:the|our|my|his|her|their|its|this|that|these|those|it|everything|el|la|los|las|lo|nuestro|nuestra|nuestros|nuestras|mi|mis|su|sus|este|esta|estos|estas|ese|esa|todo)\b[^.!;]*?\b(?:is|are|was|were|has|have|had|got|esta|estan|es|son|fue|fueron|quedo|quedaron|ha|han|sigue|siguen)\b/i;
export function onlyTells(quote: string): boolean {
  const q = quote.trim().normalize("NFD").replace(/\p{M}/gu, "").replace(/^[^\p{L}]+/u, "");
  const lead = TELLS.exec(q);
  if (!lead || q.includes("?")) return false;
  const rest = q.slice(lead[0].length);
  return STATES.test(rest) && !STILL_ASKS.test(rest);
}

/**
 * Plan 210 (iteration 3, point 7): a courtesy that waits on the reader's coming or needing something ("Cuando vengas a
 * Tepoz avísanos, aquí tienes tu casa", "if you're ever in town, let us know", "let me know if you need anything") asks
 * nothing, so it's never an ask: a condition about the reader's visit or need, a "let me know", no question and nothing else
 * asked ("when you get a chance, let me know what you think of the draft" is one). The sentence as `norm` reads it, en and es.
 * The code review of iteration 3: the "let me know" asks only for notice of that visit or need (nothing after it in its
 * clause, the condition itself, "let me know when you're in town", or the sender's own "and we'll work it out"); one that
 * asks for something ("When you're back, let me know what you think of the draft", "dime qué opinas") is an ask. The code
 * review's second round: what follows "and"/"y" is the sender's only when it says so ("and we'll sort it out", "and I'll
 * pick you up", "y lo arreglamos", "y te ayudo"); "let me know and approve the final draft" asks the reader for more.
 * Round 15's second morning (Margaret): help offered in case the reader's way is hard ("If the scanner at the library is a
 * hassle I can come by on the weekend, just tell me", "si se te complica, paso yo, nada más avísame") is the same courtesy,
 * the prompt's "I can cover for you if needed": read as an ask, it stayed open after she scanned the papers herself. The
 * sender's own "I can" isn't asked of the reader; an offer that waits on a yes with no trouble in it ("If it's easier, I
 * can swing by Saturday … Just let me know") is still an ask.
 */
const TROUBLE_IF = String.raw`if (?:\p{L}+ ){0,6}?(?:is|s|are|gets|becomes|turns out to be) (?:a (?:hassle|pain|problem|bother)|too much|(?:too |very )?(?:difficult|hard|tricky|complicated|inconvenient))|if (?:you (?:have|run into|hit)|(?:\p{L}+ ){1,6}?gives? you) (?:any )?(?:trouble|problems?|issues?)|if you get stuck|if (?:it|that|this) (?:doesn t|does not|won t|will not) work(?: out)?|si (?:\p{L}+ ){0,6}?(?:es|resulta|te es|te resulta) (?:(?:muy|mucha|una|un) )?(?:molestia|lata|problema|complicado|dificil|engorroso)|si (?:se te |te )?complica\p{L}*|si te cuesta\p{L}*|si tienes (?:algun |cualquier )?problema\p{L}*|si no (?:te )?funciona`;
const COURTESY_IF = new RegExp(String.raw`\b(?:${TROUBLE_IF}|if (?:something|anything)(?: s| is)? (?:in the way|comes up)|si algo te lo impide|si surge algo|when(?:ever)? you(?: re| are)? (?:come|coming|visit|visiting|next in|in town|back|around|passing through|pass through|over here|here)|if you(?: re| are)? ever (?:in|around|back|over|passing|here)|next time you(?: re| are)? (?:in|around|here|over|back)|if you (?:ever )?need (?:anything|something|a hand|help)|cuando (?:vengas|vengan|pases|pasen|estes|esten|andes|regreses|vuelvas)|si (?:vienes|pasas|andas|estas por)|la proxima vez que (?:vengas|pases|estes)|si (?:necesitas|ocupas) (?:algo|cualquier cosa|ayuda))\b`, "u");
const LET_KNOW = /\b(?:let (?:me|us) know|tell me|dimelo|give (?:me|us) a (?:shout|call|ring|heads up)|drop (?:me|us) a line|avisa(?:me|nos)|me avisas|nos avisas|dime|escribe(?:me|nos)|llama(?:me|nos))\b/u;
// the sender's own "I can come by", never asked of the reader
const SENDER_CAN = /\b(?:i|we) (?:can|could)\b/gu;
const ASKS_MORE = /\b(?:please|could|can|would|will you|send|bring|need you|want you|por favor|puedes|podrias|envia\w*|manda\w*|trae\w*|necesito que)\b/u;
const COURTESY_HERE = new RegExp(`^(?:${COURTESY_IF.source})`, "u");
// the sender reassuring, in their own person: "and we'll work it out", "so I can help", "y lo arreglamos", "y ya te ayudo"
const AND_WE = /^(?:and|so|y|e|asi) (?:(?:we|i)(?: (?:ll|will|can|could|d|would|shall))?\b|(?:(?:yo|nosotros|ya|lo|la|los|las|te|les|nos|se) )*(?!(?:luego|pronto|rapido|todo|algo|eso|esto|como|tambien)\b)\p{L}+(?:amos|emos|imos|o)\b)/u;
/** every "let me know" in these words (a clause, as `norm` reads it) asks only for notice: nothing after it but the courtesy */
function noticeOnly(clause: string): boolean {
  return [...clause.matchAll(new RegExp(LET_KNOW.source, "gu"))].every((m) => {
    const rest = clause.slice(m.index + m[0].length).trim();
    return !rest || COURTESY_HERE.test(rest) || AND_WE.test(rest);
  });
}
/**
 * The Codex code review of round 15's second morning: a courtesy tells the reader to do nothing; "If the portal gives you
 * trouble, call IT and let me know" does (a clause, or a part of one after "and", that starts on something the reader is to
 * do, once the condition, the sender's own "I can …" and the "let me know" are set aside), and it's an ask.
 */
const READER_DOES = /^(?:(?:and|then|just|please|y|luego|nada mas|solo) )*(?:call|phone|email|e mail|text|contact|ask|try|use|go|fill|sign|submit|reach out|check|reset|restart|follow|file|llama|marca|escribe|contacta|pregunta|intenta|usa|ve|llena|firma|envia|revisa|reinicia|sigue)\b/u;
function readerTold(sentence: string): boolean {
  return sentence.split(/[.,;:!\n]/u).some((clause) => {
    const rest = norm(clause).replace(COURTESY_IF, " ").replace(/\b(?:i|we) (?:can|could)\b.*$/u, " ").replace(new RegExp(LET_KNOW.source, "gu"), " ");
    return rest.split(/\b(?:and|y)\b/u).some((part) => READER_DOES.test(part.trim()));
  });
}
export function courtesyOnly(sentence: string): boolean {
  if (/[?¿]/u.test(sentence)) return false;
  const read = norm(sentence);
  return COURTESY_IF.test(read) && LET_KNOW.test(read) && !readerTold(sentence) && !ASKS_MORE.test(read.replace(COURTESY_IF, " ").replace(LET_KNOW, " ").replace(SENDER_CAN, " ")) && sentence.split(/[.,;:!\n]/u).every((clause) => noticeOnly(norm(clause)));
}

/**
 * Plan 210 (the second morning, María's d08): a person wishing the reader well for something of theirs ("Good luck at the
 * game this morning, tell Sofia her tía says score one for me!", "¡Suerte en el partido!", "have fun at the party") tells
 * them nothing about it, so it's never an event, nor an ask to pass the wish on ("tell Sofia her tía says score one"): a
 * thanks mail made "Sofia's game (tell her Elena says score one)" a second row beside the game the reader already had. One
 * that gives the time ("good luck at the 10:00 game, Field 3") is news, and read as any event; one that asks a question
 * ("good luck Friday, can you send me the slides?") is still asked. The sentence as `norm` reads it, en and es.
 */
const WELL_WISH = /\b(?:good luck|best of luck|break a leg|have (?:fun|a (?:great|good|wonderful|lovely|blast))|enjoy|hope (?:it|the \p{L}+|you) (?:goes|go|went) (?:well|great)|fingers crossed|(?:buena |mucha )?suerte|que (?:te|les|le) vaya (?:bien|super)|que (?:te|se) (?:diviertas|diviertan)|disfrut(?:a|en|alo|enlo)|exito en)\b/u;
/**
 * The Codex code review of the second morning (point 2): a sentence is a wish only when every clause of it wishes, cheers or
 * passes a wish on ("tell Sofia her tía says score one for me"); a clause that asks ("Enjoy your trip, please send me the
 * itinerary") or tells what's planned ("Enjoy the concert; it has moved to Sunday") is the sentence's news, and it's read as
 * any other. A clause of a word or two ("Elena", "love you") says neither.
 */
const CHEERS = /\b(?:you(?: ve)? got this|rooting for|cheering (?:for|you on)|proud of|knock (?:em|them) dead|tu puedes|echale ganas|animo)\b/u;
const RELAYS = /^(?:and |y )?(?:tell|give|say (?:hi|hello) to|dile|diles|dale|dales|saluda a|saludos a)\b/u;
const PASSED_ON = /\b(?:says|said|from (?:me|us)|my love|our love|hi|hello|hugs?|kisses|dice|de mi parte|de nuestra parte|abrazos?|besos?|saludos)\b/u;
// what a wish's sentence may also say that's news: a change or a plan's facts ("it has moved to Sunday", "se cambió al domingo")
const NEWS = /\b(?:moved|changed|rescheduled|postponed|pushed|cancel\w*|instead|now (?:at|on|in)|starts?|begins?|doors open|se (?:movio|cambio|pospuso|cancelo)|cambio|ahora es|empieza|inicia|en vez de|en lugar de)\b/u;
// a clause that wishes, cheers, or passes a wish on, never one that has them do something ("tell Sofia to bring her cleats")
const wishClause = (clause: string) => !NEWS.test(clause) && (WELL_WISH.test(clause) || CHEERS.test(clause) || (RELAYS.test(clause) && PASSED_ON.test(clause) && !/^(?:and )?tell \p{L}+ to\b/u.test(clause)));
export function wellWishOnly(sentence: string): boolean {
  if (!WELL_WISH.test(norm(sentence)) || saysClock(sentence) || /[?¿]/u.test(sentence) || asksDirectly(sentence)) return false;
  return sentence.split(/[,;:.!—–\n]+/u).map(norm).every((clause) => clause.split(" ").filter(Boolean).length <= 2 || wishClause(clause));
}

/**
 * Round 19 (María's Keisha: "Also we need a coffee after shift soon, I have so much tea about the new manager.", read as a
 * second ask beside the real question): a get-together suggested with no question and no day ("we need a coffee soon", "we
 * should grab lunch sometime", "let's catch up", "tenemos que ir por un café un día de estos", "a ver cuándo nos vemos")
 * asks the reader nothing. One with a question ("we should grab lunch, are you free Friday?"), a day or a time ("let's grab
 * lunch Thursday"), or a request beside it ("we need a coffee soon, and please bring the forms") is read as any. The
 * sentence as `norm` reads it, en and es; the meal or drink with an article or a verb, so "we need coffee for the meeting"
 * is no get-together.
 * Its code review: only a collective suggestion, the get-together right after it (a going verb at most: "ir por", "go
 * out for", "tomarnos"), never a task about one ("We need you to book a dinner venue", "we need to book a dinner", "a
 * dinner venue"); and nothing asked in any clause, split as written ("…, and send me your schedule", "… — send me…").
 */
const SUGGESTS = String.raw`(?:we (?:really |totally |definitely |so |still |seriously )?(?:need|should|have to|gotta|got to|must|ought to)(?: to)?(?: (?:really|totally|definitely|seriously|just|all))?|let s|lets|(?:tenemos|tendriamos) que|hay que|deberiamos|a ver (?:cuando|si))`;
/** what makes a meal the thing to arrange, never the meeting: "a dinner venue", "lunch order", "coffee machine" */
const ARRANGED = String.raw`(?!\s+(?:venue|venues|reservations?|order|orders|menu|budget|plans?|meeting|place|spot|break|machine|bill|run|options?|catering|invites?|invitations?|list|tickets?|table))`;
const MEAL = String.raw`(?:coffee|lunch|dinner|drinks?|beers?|brunch|breakfast|catch up)${ARRANGED}`;
const GOING = String.raw`(?:go|go out|ir por|ir a tomar(?:nos)?|tomar(?:nos)?|echar(?:nos)?|nos tomamos|nos echamos)`;
const GATHERING = String.raw`(?:(?:a|an|some|grab|get|have|do|go for|go out for|go get)\s+(?:(?!(?:you|your|u)\b)\p{L}+\s+)?${MEAL}|catch up|get together|hang out|(?:un|unos|unas)\s+(?:cafe|cafecito|trago|tragos|chelas|cervezas|cerveza)\b${ARRANGED}|vernos|juntarnos|nos (?:vemos|juntamos)|ponernos al dia|ir a (?:comer|cenar|desayunar))`;
const GET_TOGETHER = new RegExp(String.raw`\b(?:${SUGGESTS}\s+(?:${GOING}\s+)?${GATHERING}|we re (?:long |so )?(?:overdue|due) for (?:a |an |some )?${MEAL})\b`, "u");
export function getTogetherOnly(sentence: string, arrivedAt: number): boolean {
  if (/[?¿]/u.test(sentence) || saysClock(sentence) || namesDayFrom(sentence, arrivedAt)) return false;
  if (!GET_TOGETHER.test(norm(sentence))) return false;
  // nothing else asked, clause by clause as written, the suggestion set aside ("we need a coffee soon, send me the forms" asks)
  return saidClauses(sentence).every((clause) => {
    const rest = clause.replace(GET_TOGETHER, " ").trim();
    return !directsReader(rest) && !asksDirectly(rest);
  });
}

/**
 * The claims ledger's third batch (Diego's client Tomás: "queremos abrir la sucursal de Narvarte el 21", read as an event):
 * what the sender's own business does on a day (an opening, a launch, a release) is theirs, never a plan of the reader's,
 * unless the mail invites the reader or counts on them there (the prompt's event is a flight, a booking, a meeting of
 * the reader's). The sentence and the paragraph as `norm` reads them, en and es.
 */
const THEIR_OWN = /\b(?:we(?: re| are| ll| will| want to| plan to| hope to| d like to| re going to| are going to)? (?:open|opening|launch|launching|release|releasing|relaunch|relaunching|unveil|unveiling)|our (?:grand )?(?:opening|launch|release|relaunch)|(?:queremos|vamos a|pensamos|planeamos|esperamos) (?:abrir|inaugurar|lanzar|estrenar|reabrir)|abrimos|inauguramos|lanzamos|estrenamos|reabrimos|nuestra (?:apertura|inauguracion|reapertura)|nuestro (?:lanzamiento|estreno))\b/u;
const INVITES_READER = /\b(?:you re invited|you are invited|invite you|join us|come by|come to|you can come|can you come|will you come|we d love (?:to see you|to have you|you there)|hope (?:you can|to see you)|see you there|rsvp|save the date|your (?:spot|seat|ticket|invitation)|te invit\w*|los invit\w*|acompan\w*|vienes|ven a|vengan|te esperamos|nos encantaria (?:verte|que vinieras)|nos vemos|cuento contigo|contamos contigo|tu lugar|invitation|invitacion)\b/u;
// its code review: the invitation anywhere in the mail or its subject ("We're opening the studio … \n\nJoin us!", "You're invited")
function theirsOnly(sentence: string, mail: string): boolean {
  return THEIR_OWN.test(norm(sentence)) && !INVITES_READER.test(norm(mail));
}

/**
 * Plan 210 (the second morning's code review, round 15's Diego): a gathering a mailing list's post offers to whoever on it
 * wants it ("para quien ande en CDMX, la reunión mensual de la lista es el jueves 19 a las 20:00", "all welcome", "the list's
 * meetup") is no plan of the reader's, when the post isn't addressed to them (the prompt's listing rule, which the reading
 * breaks now and then): an event or a delivery from it is dropped unless its paragraph names the reader or their own part
 * ("your spot", "you're registered", "tu lugar"). A list's mail about the reader's own arrangement, with no offer to whoever
 * (the team's schedule, the game moved), is read as any; the paragraph as `norm` reads it, en and es.
 */
const OFFERED_TO_ANYONE = new RegExp(
  [
    String.raw`\b(?:anyone|anybody|whoever|those of you|any of you|folks|people) (?:who|in|around|near|nearby|free|interested|local)\b`,
    String.raw`\b(?:all|everyone|everybody) (?:are |is |s )?(?:welcome|invited)\b`,
    String.raw`\bopen to (?:all|everyone|anyone|the public)\b`,
    String.raw`\bif (?:anyone|anybody) (?:is |s )?(?:around|in town|free|interested|nearby)\b`,
    String.raw`\bthe list s (?:meetup|meet up|meeting|gathering|get together|dinner|drinks)\b`,
    String.raw`\blist (?:meetup|meet up|members meetup)\b`,
    String.raw`\bpara (?:quien|quienes|los que|las que|todos los que|todas las que) (?:ande|anden|este|esten|viva|vivan|quiera|quieran|pueda|puedan|guste|gusten)\b`,
    String.raw`\b(?:quien|quienes) (?:quiera|quieran|guste|gusten|pueda|puedan) (?:venir|ir|llegar|caer|unirse|acompanar)`,
    String.raw`\b(?:todos|todas|todo el mundo) (?:son |estan |esta )?(?:bienvenid\w*|invitad\w*)`,
    String.raw`\babiert\w* a (?:todos|todas|todo el mundo|cualquiera)\b`,
    String.raw`\bsi alguien (?:anda|esta|quiere|puede)\b`,
    String.raw`\b(?:reunion|junta|comida|cena|carne asada|quedada) (?:mensual |semanal |anual )?de la lista\b`,
  ].join("|"),
  "u",
);
const OWN_PART = /\b(?:your (?:spot|seat|ticket|tickets|booking|reservation|registration|rsvp|place|order|table)|you(?: re| are) (?:registered|confirmed|signed up|booked|on the list)|we (?:saved|have|ve got) (?:you|your)|tu (?:lugar|boleto|boletos|reserva|reservacion|registro|asiento|mesa|pedido)|(?:estas|quedaste) (?:inscrit\w*|registrad\w*|confirmad\w*|apuntad\w*)|te (?:guarde|guardamos|apartamos|aparte))\b/u;
function offeredToTheList(paragraph: string, reader: { name: string } | undefined): boolean {
  const read = ` ${norm(paragraph)} `;
  if (!OFFERED_TO_ANYONE.test(read) || OWN_PART.test(read)) return false;
  return !nameWords(reader?.name ?? "").some((w) => w.length >= 3 && read.includes(` ${w} `));
}

/**
 * Plan 210 (iteration 3, point 7): the sender's own offer that waits on the reader's yes ("If it's easier, I can swing by
 * Saturday morning and take pictures of them. Just let me know.", "paso el sábado y les tomo fotos, nada más avísame") is an
 * ask with no day: the day is the offer's, not one the reader must meet (Luna made it a request due the Friday, 1 in 5).
 * Never one that gives a deadline ("I can take them if you send them by Friday").
 */
const OFFERS = /\b(?:i can|i could|i d be happy to|i m happy to|happy to|we can|we could|puedo|podria|te puedo|paso|pasamos|con gusto te)\b/u;
const DEADLINE_CUE = /\b(?:by|before|no later than|until|deadline|due|antes|a mas tardar|hasta el|para el|limite)\b/u;
function offerOnly(sentences: string, paragraph: string): boolean {
  const read = norm(sentences);
  // "swing by Saturday" is a visit, not a deadline; its "just let me know" may be the next sentence
  return OFFERS.test(read) && LET_KNOW.test(norm(paragraph)) && !DEADLINE_CUE.test(read.replace(/\b(?:swing|come|stop|drop|pop|pass) by\b/gu, " "));
}

/**
 * Plan 210 (round 15's second morning, Margaret's David): an offer of the sender's that's an open ask ("I can come by on the
 * weekend, just tell me") is settled by their own later mail in that conversation taking it back ("No need for me to come by
 * tomorrow then", "ya no hace falta que pase"): the reading listed it and settled nothing. Only their offer (the sender's
 * "I can …" in its quote), from them, in its conversation, and only when what they no longer need to do is what they offered
 * (the verb's stem in the offer's words).
 */
const WITHDRAWS = /\b(?:no need (?:for (?:me|us) )?to|(?:i|we) (?:won t|will not|don t|do not) need to|no (?:hace|hara) falta que|ya no (?:hace falta|es necesario) que|no es necesario que) (\p{L}+)((?: [\p{L}\p{N}]+)*)/gu;
/**
 * The Codex code review of round 15's second morning: a withdrawal said under a condition ("If there's no need for me to come
 * by tomorrow, let me know", "si no hace falta que pase, avísame") still waits on the reader, so it settles nothing; and what
 * its clause names past the verb ("send the contract") must be in the offer too, so "no need to send the contract" never
 * settles an offer to send the budget. Times ("tomorrow then", "el sábado") name nothing offered.
 */
const CONDITIONAL = /\b(?:if|whether|in case|unless|en caso de que|a menos que)\b|(?:^|[^\p{L}])si(?![\p{L}])/iu;
const WHEN_WORDS = new Set("then anymore after today tomorrow tonight weekend morning afternoon evening week monday tuesday wednesday thursday friday saturday sunday instead entonces ahora manana tarde noche semana lunes martes miercoles jueves viernes sabado domingo".split(" "));
function offerWithdrawn(row: Pick<DatedRow, "quote" | "senderKey" | "threadId">, input: { senderKey?: string; threadId?: number }, sentences: Sentences): boolean {
  if (input.senderKey === undefined || row.senderKey !== input.senderKey || (input.threadId !== undefined && row.threadId !== input.threadId)) return false;
  const offered = norm(row.quote);
  if (!OFFERS.test(offered)) return false;
  const words = offered.split(" ").filter((w) => w.length >= 3);
  const inOffer = (w: string, n: number) => words.some((o) => o.slice(0, n) === w.slice(0, n));
  const named = (tail: string) => [...namingWords(tail)].filter((w) => !WHEN_WORDS.has(w));
  return sentences.some((s) => !/[?¿]/u.test(s.said) && !CONDITIONAL.test(s.said) && s.said.split(/[,;:.!\n]+/u).some((clause) =>
    [...norm(clause).matchAll(WITHDRAWS)].some((m) => inOffer(m[1]!, 3) && named(m[2]!).every((w) => inOffer(w, 5)))));
}

/**
 * Plan 210 (iteration 3): the sender saying what they can do, with nothing to answer ("Can you set that up? I can prep the
 * usage story": the request is the reader's, the offer is no ask), unlike an offer that waits on the reader's yes ("…just
 * let me know"). Haiku took Nina's 1 in 1 after v13 named concrete offers as asks.
 */
function selfOffer(sentences: string, paragraph: string): boolean {
  return !/[?¿]/u.test(sentences) && OFFERS.test(norm(sentences)) && !LET_KNOW.test(norm(paragraph));
}

/**
 * Plan 210 (iteration 5): a reminder of what the reader said they'd do ("Margaret, you said you'd do the discussion questions
 * this time, thank you!") asks nothing new: their promise is follow-ups' (Haiku made it an ask, 1 in 5, once v16 let two
 * asks stand). Never one whose sentence also asks ("you said you'd send it: could you do it by Friday?").
 */
const YOUR_WORD = /\b(?:you said you d|you said you would|you said you ll|you offered to|you promised|you volunteered|you mentioned you d|dijiste que|quedaste en|te ofreciste a|prometiste|te comprometiste a)\b/u;
function yourOwnWord(sentence: string): boolean {
  return YOUR_WORD.test(norm(sentence)) && !asksDirectly(sentence);
}

/**
 * Plan 210 (iteration 3, point 7): mail the reader is only copied on to know about it ("Diego, te copio para que estés al
 * tanto", "cc'ing you for visibility", "FYI") asks them nothing, whatever it says they'll do ("Diego las monta en las
 * etiquetas esa misma semana"): a request from it is the reader's only when its sentence speaks to them by name and isn't
 * that line itself. `read`: the mail as `norm` reads it. The code review of iteration 3: that line may still ask them
 * something directly ("Diego, FYI, could you review the colors by Friday?"), and then it's theirs. The code review's second
 * round: in the request words the other checks know, a "let me know" (`LET_KNOW`) and the sender's need or want ("I need
 * your approval by Friday", "necesito tu visto bueno"); the copy line never vetoes them on its own.
 */
const COPIED = /\b(?:te copio|te pongo en copia|te incluyo en copia|(?:cc ing|cc d|copying|looping in) you|(?:for|so) (?:you re|you are) in the loop|for your (?:information|visibility|awareness|reference)|for visibility|fyi|para que (?:estes|este|esten) (?:al tanto|al pendiente|enterad\w*)|para tu (?:informacion|conocimiento))\b/u;
// a request made to them: a question, "could you…", "¿puedes…?", "let me know…", "I need…", or a clause that starts with what they're to do
const ASKS_DIRECTLY = /\b(?:please|could you|can you|would you|will you|would you mind|need you to|want you to|por favor|puedes|podrias|podria|necesito que|te pido que)\b/u;
const NEEDS_FROM_YOU = /\b(?:(?:i|we)(?: really| still| ll| d)? (?:need|want|like|love|require)|you(?: ll| will)? (?:need|have) to|you must|necesit(?:o|amos|aria|ariamos)|(?:quiero|queremos|quisiera|quisieramos) que|me gustaria|tienes que|debes)\b/u;
const DO_THIS = /^(?:review|send|sign|check|call|reply|answer|approve|confirm|fill|submit|bring|book|pay|update|revisa|revisen|envia(?:me|nos)?|manda(?:me|nos)?|firma|llama(?:me|nos)?|responde(?:me|nos)?|aprueba|confirma(?:me|nos)?|llena|trae|paga|actualiza)\b/u;
function asksDirectly(sentence: string): boolean {
  const read = norm(sentence);
  return /[?¿]/u.test(sentence) || ASKS_DIRECTLY.test(read) || LET_KNOW.test(read) || NEEDS_FROM_YOU.test(read) || sentence.split(/[,;:.!\n]/u).some((clause) => DO_THIS.test(norm(clause)));
}
function onlyCopied(item: { quote: string }, text: string, sentences: Sentences, reader: { name: string; addressed: "to" | "cc" | "none" } | undefined): boolean {
  if (reader?.addressed !== "cc" || !COPIED.test(norm(text))) return false;
  const sentence = contextOf(item.quote, sentences);
  const mine = new Set(nameWords(reader.name));
  if (!addressedTo(item.quote, text).some((w) => mine.has(w))) return true;
  return COPIED.test(norm(sentence)) && !asksDirectly(sentence);
}

/**
 * Plan 210 (iteration 3, point 7): the one ask an automated sender may make: the reader's appointment it cancels (settled in
 * this reading, or said cancelled in the mail) and asks them to book again ("Please call (614) 555-0147 to choose a new
 * time"), to the reader in To. Read on the ask's sentence, en and es.
 */
const CANCELLED = /\b(?:appointment|visit|reservation|booking|session|class|cita|consulta|reserva\w*|sesion|clase)\b(?: \S+){0,20}? (?:cancel\w*|anulad\w*)\b/u;
const REBOOK = /\b(?:(?:choose|pick|book|schedule|find|set up|arrange) (?:a )?new (?:time|date|appointment|slot)|reschedul\w*|rebook\w*|(?:elegir|escoger|agendar|programar|buscar|reservar) (?:una )?nueva (?:fecha|hora|cita)|reprogram\w*|reagend\w*)\b/u;

/**
 * Plan 210 (iteration 4, revision 11): asked to confirm by replying ("Reply C to confirm", "reply YES to confirm your
 * appointment", "confirm by replying", "Responde C para confirmar"), read as `norm` reads it, en and es.
 */
const CONFIRM_BY_REPLY = /\b(?:(?:reply|respond|text|answer|write back)(?: with)?(?: (?:the letter )?[a-z0-9]{1,3})? to confirm|confirm by (?:replying|reply|texting|responding)|(?:responde|responda|contesta|conteste|escribe|escriba|envia|envie|manda|mande)(?:nos)?(?: con)?(?: (?:la letra )?[a-z0-9]{1,3})? para confirmar|confirm\w* respondiendo)\b/u;
const confirmsByReply = (words: string): boolean => CONFIRM_BY_REPLY.test(norm(words));

/** Plan 210 (iteration 4): a request's words that are a reply to someone ("Reply to Karin…", "Answer Karin about…", "Responder a Karin…"). */
const REPLY_TO = /^(?:reply|respond|answer|write back|get back)\b|^(?:responder|responderle|contestar|contestarle|escribir|escribirle)\b/u;
/** a list's line: "1. An ETA", "- the deck", "• the form" */
const LIST_LINE = /^\s*(?:[-–•*·]|\d{1,2}[.)])\s+/u;

/**
 * Plan 210 (iteration 5, revision 8): one thing asked is part of another's request only when its quote is in that request's
 * own sentence or in the list the request introduces (Karin's "I need a reply from you today with: 1. An ETA…"); two
 * questions from one sender otherwise stay two (María's Elena: the head count by Sunday, and "can you bring the tamales?").
 */
function partOfRequest(request: string, quote: string, sentences: Sentences, paragraphs: Sentences): boolean {
  const q = norm(quote);
  const r = norm(request);
  if (!q || !r) return false;
  if (norm(contextOf(request, sentences)).includes(q)) return true;
  const lines = paragraphs.find((p) => p.read.includes(r))?.said.split("\n") ?? [];
  const at = lines.findIndex((l) => norm(l).includes(r) || r.includes(norm(l)));
  if (at < 0) return false;
  const introduces = /:\s*$/u.test(lines[at]!);
  return lines.slice(at + 1).some((l) => (introduces || LIST_LINE.test(l)) && !!norm(l) && (norm(l).includes(q) || q.includes(norm(l))));
}

/**
 * Plan 210 (iteration 5, R10): an ask turned into a request by a mail that names another thing keeps whom it answers, never
 * the old question ("Answer Elena about working Thanksgiving" moved by "Let me know by Sunday if it's you, Chris and both
 * kids" is "Answer Elena", by Sunday).
 */
const ABOUT = /^(.*?)\s+(?:about|on|regarding|whether|if|sobre|acerca de|si)\s+/iu;
const whomOnly = (text: string): string => (REPLY_TO.test(norm(text)) ? (ABOUT.exec(text)?.[1] ?? text) : text);

/**
 * The seventh panel round (revision 7): an ask, or the request it turns into with a day, never asks the reader to send a
 * password, a one-time code, an account, card or routing number, or an ID (en, es), whatever the model made of it: read
 * on its words and its quote. Pure.
 */
export function asksForSecrets(item: { text: string; quote: string }): boolean {
  return ASKS_FOR_SECRETS.test(`${item.text}\n${item.quote}`.normalize("NFD").replace(/\p{M}/gu, ""));
}

type Move = Omit<DatedResult["moved"][number], "text" | "textEvidence"> & Partial<Pick<DatedResult["moved"][number], "text" | "textEvidence">>;

/**
 * Plan 210 (iteration 4's code review, Codex): a time the mail gave in another zone is the instant the reader read on that
 * zone's clock (`at`), kept when the reader's day and time name it: in the hour the reader's clock shows twice they name two,
 * and the local day and time alone would give the first (New York's 4:30 AM on November 1, 2026 is Los Angeles' second 1:30).
 */
const atInstant = (timing: DatedTiming | null, at: number | undefined): DatedTiming | null =>
  timing?.timed && at !== undefined && dayKeyOf(at) === timing.dueDay && clockOf(at) === clockOf(timing.dueAt) ? { ...timing, dueAt: at } : timing;

/**
 * Plan 210 (iteration 5, V2): the one start time an event's quote states (`startClock`), on the reader's clock: a zone it
 * names is converted, and one that moves it to another day gives none.
 */
function startOf(quote: string, due: string): string | null {
  const start = startClock(quote);
  if (!start) return null;
  const here = readerZone();
  if (!start.zone || start.zone === here) return start.time;
  const at = inZone({ due, time: start.time }, start.zone, here);
  return at.time && at.due === due ? at.time : null;
}

/** The day after a YYYY-MM-DD day. */
const nextDay = (day: string): string => {
  const d = localDay(day);
  if (!d) return day;
  d.setDate(d.getDate() + 1);
  return dayKeyOf(d.getTime());
};

/**
 * The claims ledger's third batch (Sam's Tyler: "Lab Report 3 is due this Friday and I don't think I can do a good job on it
 * by then. Could I have an extension until next Wednesday?"): a person's ask for more time is answered by the deadline it's
 * about, the day a sentence before it in its paragraph says that is due (from the mail's own day, within two weeks); never
 * the day it asks for. Read as `norm` reads them, en and es; a deadline already gone ("was due") gives none. Its code review:
 * only the deadline whose sentence names what the ask is about (a naming word of its words or its quote, beyond the asking
 * for time: "The report is due November 20. The electricity bill is due November 13. Could I have more time for the
 * report?" is the 20th); none or several such: no day.
 */
const MORE_TIME = /\b(?:extension|extend|more time|extra (?:time|day|days)|prorroga|mas tiempo|(?:unos|un par de) dias mas|extender|ampliar el plazo)\b/u;
const IS_DUE = /\b(?:due|deadline|vence|vencen|se entrega|hay que entregar|fecha limite|toca entregar)\b/u;
const WAS_DUE = /\b(?:was due|were due|vencio|vencieron)\b/u;
/** what asking for time says of any deadline, never which one */
const TIME_WORDS = new Set(["extension", "extend", "extended", "time", "extra", "more", "days", "deadline", "prorroga", "tiempo", "plazo", "dias", "mas", "ampliar", "extender"]);
const DUE_SCAN_DAYS = 14;
function dueAskedAbout(ask: { text: string; quote: string }, paragraphs: Sentences, arrivedAt: number): string | null {
  if (!MORE_TIME.test(norm(ask.quote))) return null;
  const about = [...namingWords(`${ask.text}\n${ask.quote}`)].filter((w) => !TIME_WORDS.has(w));
  const own = sentencesOf(contextOf(ask.quote, paragraphs));
  const at = sentencesWith(ask.quote, own)[0] ?? 0;
  const named = own.slice(0, at).filter((s) => IS_DUE.test(s.read) && about.some((w) => namingWords(s.said).has(w)));
  if (named.length !== 1 || WAS_DUE.test(named[0]!.read)) return null;
  let day = dayKeyOf(arrivedAt);
  for (let k = 0; k < DUE_SCAN_DAYS; k++, day = nextDay(day)) if (saysDay(named[0]!.said, day, { arrivedAt })) return day;
  return null;
}

/** Plan 210 (iteration 4, revision 11): a day asked before is kept only as the day after the one it sorts under. */
const askedBefore = (before: string | null | undefined, due: string): string | null => (before && before === nextDay(due) ? before : null);

/**
 * Plan 210 (iteration 5, revision 4): a request for a part of its day ("can you get me notes by saturday morning?"), read
 * locally from its quote (en and es; the reader's prompt is untouched): untimed whatever clock the reader gave it (its quote
 * states none), over at that part's end. Only a person's request with a day; anything else as it is.
 */
const partTiming = (kind: string, quote: string, timing: DatedTiming | null, arrivedAt: number): (DatedTiming & { partOfDay?: PartOfDay }) | null => {
  const part = kind === "respond" && timing?.dated ? partOfDayIn(quote) : null;
  if (!part || !timing) return timing;
  const day = timing.timed ? datedTiming({ kind: "respond", due: timing.dueDay, time: null, arrivedAt }) : timing;
  return day ? { ...day, partOfDay: part } : timing;
};

/**
 * Plan 210 (iteration 2, the panel's A5 and A6), decided once as an item is read, never on a count: a person's request to the
 * reader (`askAllowed`) shows from its arrival, in Today's people with its day ("by Nov 30"); a delivery that needs someone
 * there (a signature) from the day before. Iteration 3 (revision 11): `words`, the mail's own around the quote, never the
 * item's.
 */
function shownEarly(kind: DatedKind, item: { quote: string }, words: string, said: string, input: Parameters<typeof checkDates>[1]): boolean {
  if (kind === "respond") return askAllowed(item.quote, said, input.text, input);
  return kind === "delivery" && needsPresence(words);
}

/** Plan 210 (iteration 3, revision 11): how much of the mail around a quote its facts are read from */
const FACT_WORDS_MAX = 2000;

/**
 * Plan 210 (iteration 4, revision 12): a delivery the mail only estimates ("should arrive within 7 to 10 business days", "en
 * 5 a 7 días hábiles") has no day: no item, unless its words say that day as well.
 */
const ESTIMATE = /\b(?:within|in) (?:about )?\d{1,2}(?: ?(?:to|-|or) ?\d{1,2})? (?:business |working |calendar )?days\b|\ben (?:un plazo de )?(?:unos )?\d{1,2}(?: ?(?:a|-|o) ?\d{1,2})? dias(?: habiles| laborables| naturales)?\b/u;
const estimateOnly = (words: string, due: string, arrivedAt: number): boolean => ESTIMATE.test(norm(words)) && !saysDay(words.replace(/\d{1,2} ?(?:to|-|a|o) ?\d{1,2}|\d{1,2} (?:business |working |calendar )?d[ií]as?/giu, " "), due, { arrivedAt });

/**
 * Plan 210 (iteration 4, revision 12): a person's wish that asks nothing by a day ("I'd like to sit down with you before next
 * year and look at the deductible") is never a request with a day: no question, no "please" or "could you", nothing told to
 * do, and the sentence names no day the model gave it. At most an undated ask (Margaret's Gary, read as due Dec 31).
 */
const WISH = /\b(?:i d (?:like|love) to|i would (?:like|love) to|we d (?:like|love) to|we would (?:like|love) to|me gustaria|nos gustaria|quisiera|quisieramos)\b/u;
function wishOnly(sentence: string, due: string | null, arrivedAt: number): boolean {
  const read = norm(sentence);
  return WISH.test(read) && !/[?¿]/u.test(sentence) && !ASKS_DIRECTLY.test(read) && !sentence.split(/[,;:.!\n]/u).some((c) => DO_THIS.test(norm(c))) && (!due || !saysDay(sentence, due, { arrivedAt }));
}

/**
 * A promise's new day from its person's mail (the second panel round), and (plan 210, iteration 2) its time: the move's own
 * (already in the reader's zone, as every move's), else, for a promise with a stated time, its clock as it was, on the new
 * day (Codex code review: never its words' clock read again on a day already converted); and, when that mail came after its
 * day was over, the day it had (`brokenDueAt`: its row keeps saying "You said Tue 10 (missed)").
 */
function movedPromise(p: { dueAt?: number; dated?: boolean; timed?: boolean; partOfDay?: PartOfDay | null }, day: string, time: string | null, arrivedAt: number, evidence = ""): { dueAt: number; timed: boolean; brokenDueAt: number | null; partOfDay?: PartOfDay } {
  const due = followupDue({ kind: "promise", sentAt: arrivedAt, due: day, nudgeAfterDays: 0 });
  // plan 210 (iteration 5, revision 4): broken once its part of the day was over ("Friday morning": noon), and the part of
  // its new day the mail names ("Saturday morning", no clock), at that part's moment
  const broken = p.dated && p.dueAt !== undefined && dueCutoff(dayKeyOf(p.dueAt), p.partOfDay) <= arrivedAt ? p.dueAt : null;
  const part = time === null ? partOfDayIn(evidence) : null;
  const partAt = part ? partMoment(day, part, arrivedAt) : null;
  if (part && partAt !== null) return { dueAt: partAt, timed: false, brokenDueAt: broken, partOfDay: part };
  const was = p.timed && p.dueAt !== undefined ? new Date(p.dueAt) : null;
  const clock = time ?? (was ? `${was.getHours()}:${String(was.getMinutes()).padStart(2, "0")}` : null);
  const at = clock ? localDay(day) : null;
  if (at && clock) {
    const [h, m] = clock.split(":").map(Number) as [number, number];
    at.setHours(h, m, 0, 0);
    if (at.getTime() > arrivedAt) return { dueAt: at.getTime(), timed: true, brokenDueAt: broken };
  }
  return { dueAt: due.dueAt, timed: false, brokenDueAt: broken };
}

/**
 * §3's local checks, before anything's stored: the quote is the mail's (its text or subject), the kind is one of ours, a
 * day parses and is worth keeping (`datedTiming`), at most `DATED_ITEMS_MAX`, one per kind, day and time; an ask only from
 * a person to the reader (`askAllowed`) and never for credentials or an ID (`asksForSecrets`), and one with a day, so
 * allowed, is the request it is (`respond`); a settlement names an item it was shown and quotes the mail; a move gives a new
 * day or, for a timed item, a new moment, and its new words only with the mail's own. Plan 210 (the Codex review of iteration
 * 1, revision 2): a settlement or a move rests on evidence tied to that item (`tiedTo`). Pure.
 */
export function checkDates(result: { items: readonly (Omit<DatedResult["items"][number], "kind"> & { kind: string })[]; settled: DatedResult["settled"]; moved?: readonly Move[]; replaced?: DatedResult["replaced"] }, input: { text: string; subject: string; arrivedAt: number; open: ReadonlyMap<string, DatedRow>; promises?: ReadonlyMap<string, Pick<FollowupRow, "id" | "revision"> & Partial<Pick<FollowupRow, "text" | "dueAt" | "dated" | "timed" | "partOfDay">>>; fromScan: boolean; now: number; sender?: { person: boolean }; reader?: { name: string; addressed: "to" | "cc" | "none" }; others?: readonly string[]; threadId?: number; senderKey?: string; from?: string; paysInThread?: number; relay?: Relay | null; listed?: boolean }): { rows: DatedWrite[]; settled: { id: number; revision: number; how?: SettledHow }[]; moved: { id: number; dueDay: string; dueAt: number; timed: boolean; actAt: number; text?: string; before?: string | null; wall?: DatedWall | null; partOfDay?: PartOfDay }[]; movedPromises: { id: number; revision: number; dueAt: number; timed: boolean; brokenDueAt: number | null; before?: string | null; partOfDay?: PartOfDay }[]; replaced: { id: number; revision: number; item: number }[]; asked: boolean } {
  const said = `${norm(input.subject)}\n${norm(input.text)}`;
  const quoted = (words: string) => {
    const w = norm(words);
    return w.length >= 3 && said.includes(w);
  };
  const sentences = sentencesOf(input.text);
  const paragraphs = paragraphsOf(input.text);
  /**
   * Plan 210 (the Codex review of iteration 1, revision 2): quoted words prove only that the mail says them, so a settlement
   * or a move also needs them tied to that item: two words or more, in a sentence that doesn't talk to the app ("mark o1 as
   * done", "ignore the above"); a move's paragraph says the new day or time. An item from another conversation only by the
   * same sender's mail that names it ("your electricity bill", "invoice 2231"; never by the sender's own name, `from`, which is
   * in all their mail), or, to settle it, says what settles its kind
   * when it's that sender's only open one of its kind ("Payment received" for their one bill): a receipt for that bill, never
   * "all paid". Someone else's mail in its conversation settles or moves it only when the sentence names it. The worker
   * passes the thread and the sender; a caller that doesn't reads every open item as this conversation's and this sender's.
   * The Codex code review of v11: a move's paragraph says the day it moves to (`saysWhen`, point 3); a sentence that names
   * open items names this one apart from the others it names, and gives no identifier it doesn't have (point 2).
   */
  const tiedTo = (row: Pick<DatedRow, "id" | "threadId" | "senderKey" | "kind" | "text" | "quote" | "dueDay"> | null, evidence: string, move: { due: string; timeOnly: boolean } | null) => {
    const context = contextOf(evidence, sentences);
    if (!quoted(evidence) || !plainEvidence(evidence, context) || (move && !saysWhen(evidence, contextOf(evidence, paragraphs), move, input.arrivedAt))) return false;
    if (!row) return true;
    if (otherIds(row, context)) return false;
    // the Codex code review of the second morning (point 1): a zero balance is checked against the mail it's in, never exempt
    if (zeroOnly(context) && !zeroNamesItem(row, `${input.subject}\n${input.text}`)) return false;
    // plan 210 (iteration 3, revision 5): paid is paid, narrowly. A receipt said not to have happened settles no bill; one
    // naming another amount settles it only as its own sender's receipt in its own conversation, the one open bill there
    // (counted in the store: Diego's card read as its $1,105.00 minimum, paid with "Recibimos tu pago por $8,432.17")
    if (!move && row.kind === "pay" && negatedReceipt(`${evidence}\n${context}`)) return false;
    // round 17 (Margaret's water bill): its sender's receipt, quoted on its paid line, that states the bill's own amount on a line of its own ("Bill dated
    // 11/02/2026 (due 11/10/2026): $58.71") pays it, though what it quotes is the total with the late fee ("AMOUNT PAID:
    // $64.58") and it came as a new conversation
    const billStated = (r: Pick<DatedRow, "text">) => {
      const own = amountsOf(r.text);
      const said = amountsOf(input.text);
      return own.size > 0 && [...own].every((a) => said.has(a));
    };
    const sameThread = input.threadId !== undefined && row.threadId === input.threadId && input.paysInThread === 1;
    // (a receipt's label, "AMOUNT PAID: $64.58", says nothing alone: the mail's own words do, "PAYMENT RECEIPT", "Thank you
    // for your payment", and none of it says the payment didn't happen)
    // (the Codex code review: never one whose mail names another invoice or account than the bill's: "Invoice 1002" with the
    // same $58.71 is another bill's receipt)
    const statedReceipt = () => PAID_LINE.test(norm(evidence)) && billStated(row) && !otherIds(row, `${input.subject}\n${input.text}`) && settlesKind("pay", `${input.subject}\n${input.text}`) && !negatedReceipt(input.text);
    const receipt = !move && row.kind === "pay" && row.senderKey === input.senderKey && ((sameThread && settlesKind("pay", `${evidence}\n${context}`)) || statedReceipt());
    if (otherAmounts(row, context) && !receipt) return false;
    // round 16 (Priya's board meeting): the same occasion read twice (Jess's note and the calendar's invitation, one moment,
    // one place) is never "another" item the mail must tell this one apart from: Jess's "It's now Monday, Nov 23" moved the
    // invitation and left Priya's own item on Thursday
    const full = [...input.open.values()].find((r) => r.id === row.id);
    const named = [...input.open.values()].filter((r) => namesItem(r, context, input.from) && (r.id === row.id || !full || !sameEvent(full, r)));
    if (named.length && !namesApart(row, named, context, input.from)) return false;
    if (input.threadId !== undefined && row.threadId !== input.threadId) {
      if (row.senderKey !== input.senderKey) return false;
      const theirs = [...input.open.values()].filter((r) => r.senderKey === row.senderKey && r.kind === row.kind);
      return namesItem(row, `${input.subject}\n${context}`, input.from) || (!move && theirs.length === 1 && settlesKind(row.kind, `${evidence}\n${context}`));
    }
    if (input.senderKey !== undefined && row.senderKey !== input.senderKey) return namesItem(row, context, input.from);
    return true;
  };
  // the fifth panel round: an item's new words, only quoted from this mail; an o item's alone (a promise's are yours)
  const newWords = (m: Move) => (m.text?.trim() && m.textEvidence && quoted(m.textEvidence) ? m.text.trim() : undefined);
  /**
   * Plan 210 (iteration 5, V2): a delivery of the one parcel already on its way in this conversation is that item moved, with
   * its new words, never a second item (round 13: Diego's monitor arm, its estimate expiring into Earlier beside the new
   * day's row). Only when the model neither moved nor settled it, and its words name it; checked as any move. One the checks
   * refuse is the item it was, unless it says the day the open one already has.
   */
  const parcels = [...input.open.entries()].filter(([, r]) => r.kind === "delivery" && (input.threadId === undefined || r.threadId === input.threadId));
  const touched = new Set([...(result.moved ?? []).map((m) => m.label), ...result.settled.map((x) => x.label)]);
  const parcelMoves = new Map<string, (typeof result.items)[number]>();
  for (const i of result.items) {
    if (i.kind !== "delivery" || !i.due) continue;
    const same = parcels.filter(([label, r]) => !touched.has(label) && !parcelMoves.has(label) && sameParcel(r.text, i.text, input.from));
    if (same.length === 1) parcelMoves.set(same[0]![0], i);
  }
  const allMoved: readonly Move[] = [...(result.moved ?? []), ...[...parcelMoves].map(([label, i]) => ({ label, due: i.due!, time: i.time, evidence: i.quote, text: i.text, textEvidence: i.quote, ...(i.at !== undefined ? { at: i.at } : {}), ...(i.wall ? { wall: i.wall } : {}) }))];
  const asParcels = new Set(parcelMoves.values());
  const settled: { id: number; revision: number; how?: SettledHow }[] = result.settled.flatMap((s) => {
    const row = input.open.get(s.label);
    if (!row || !tiedTo(row, s.evidence, null)) return [];
    // the claims ledger's second batch: what its mail says happened, for Earlier's word ("Cancelled Mon", "Arrived Tue")
    const how = settledHow(row.kind, s.evidence, contextOf(s.evidence, sentences));
    return [{ id: row.id, revision: row.revision, ...(how ? { how } : {}) }];
  });
  // after the panel: a new day for an open item, quoted, from this message's own day; one it settles isn't moved
  const settledIds = new Set(settled.map((s) => s.id));
  // round 15's second morning: an offer of theirs read as an ask, which they now take back themselves
  for (const row of input.open.values()) {
    if (row.kind !== "ask" || settledIds.has(row.id) || !offerWithdrawn(row, input, sentences)) continue;
    settled.push({ id: row.id, revision: row.revision });
    settledIds.add(row.id);
  }
  // Codex code review (round 4): a day for an open ask ("I need it by Friday") makes it the request it now is: the ask is
  // settled and a `respond` with its words and that day is this message's
  const answered: DatedResult["items"] = [];
  // revision 7 and the seventh panel round: no request of the reader's, an ask or a `respond` however it came, asks for
  // credentials or an ID, or is addressed by name to another recipient (Codex code review of the seventh round: a model's own
  // `respond` too, and before `requested`, so a refused one never hides a real ask)
  // plan 210 (iteration 3, point 7): nor one from mail the reader is only copied on to know about it
  const refused = (i: { kind: string; text: string; quote: string }) => (i.kind === "ask" || i.kind === "respond") && (asksForSecrets(i) || toAnother(i.quote, input.text, input.reader?.name ?? "", input.others) || onlyCopied(i, input.text, sentences, input.reader));
  for (const m of result.moved ?? []) {
    const row = input.open.get(m.label);
    if (!row || row.kind !== "ask" || settledIds.has(row.id) || !tiedTo(row, m.evidence, { due: m.due, timeOnly: false })) continue;
    // plan 210 (iteration 5): with no new words, the old question's only when the mail's sentence names it
    const request = { kind: "respond" as const, text: newWords(m) ?? (namesItem(row, contextOf(m.evidence, sentences), input.from) ? row.text : whomOnly(row.text)), quote: m.evidence, due: m.due, time: m.time };
    // revision 7: a request for credentials or an ID neither becomes one nor answers the ask, which stays as it was; nor
    // does one the mail addresses to another of its recipients (the seventh panel round)
    if (refused(request)) continue;
    // the claims ledger's third batch (Jordan's SOC 2 report): asked again, not settled; the new request carries it on
    settled.push({ id: row.id, revision: row.revision, how: "reasked" });
    settledIds.add(row.id);
    answered.push(request);
  }
  const moved = allMoved.flatMap((m) => {
    const row = input.open.get(m.label);
    if (!row || row.kind === "ask" || settledIds.has(row.id) || !tiedTo(row, m.evidence, { due: m.due, timeOnly: m.due === row.dueDay && !!m.time })) return [];
    const timing = partTiming(row.kind, m.evidence, atInstant(datedTiming({ kind: row.kind, due: m.due, time: m.time, arrivedAt: input.arrivedAt }), m.at), input.arrivedAt);
    // the fourth panel round (revision 5): a new moment on the same day moves it too ("the game is moved earlier to 8:00");
    // the same day with no time keeps the item's own; an untimed item's 9:00 is a default, so "at 9:00" gives it a time
    // plan 210 (iteration 5's code review): and a part of the day the mail names that isn't the row's ("Monday afternoon
    // instead" for Monday morning's), at that part; one it doesn't name keeps the row's
    const changed = timing && (timing.dueDay !== row.dueDay || (timing.timed && (!row.timed || timing.dueAt !== row.dueAt)) || (!!timing.partOfDay && timing.partOfDay !== (row.partOfDay ?? null)));
    const text = newWords(m);
    if (!changed) {
      // plan 210 (iteration 4, revision 12): its own moment again with new words, the mail's own, changes the words and keeps
      // the moment (Theo's tees "Expected: Today, by 8:00 PM", which the reader gave and the app dropped)
      if (!timing || !text || text === row.text) return [];
      return [{ id: row.id, kind: row.kind, dueDay: row.dueDay, dueAt: row.dueAt, timed: row.timed, actAt: row.actAt ?? timing.actAt, text, ...(row.before ? { before: row.before } : {}), ...(row.wall ? { wall: row.wall } : {}), ...(row.partOfDay ? { partOfDay: row.partOfDay } : {}) }];
    }
    // plan 210 (iteration 4, revision 11): the day it's now asked before, read with the move (none: a plain day)
    const before = askedBefore(m.before, timing.dueDay);
    // plan 210 (iteration 4, revision 10): the mail's own clock at its new moment, when it reads back as that moment
    const wall = m.wall && timing.timed && wallHolds(m.wall, timing.dueAt) ? m.wall : null;
    return [{ id: row.id, kind: row.kind, dueDay: timing.dueDay, dueAt: timing.dueAt, timed: timing.timed, actAt: timing.actAt, ...(text ? { text } : {}), ...(before ? { before } : {}), ...(wall ? { wall } : {}), ...(timing.partOfDay ? { partOfDay: timing.partOfDay } : {}) }];
  });
  // plan 210 (iteration 5, V2): a parcel's new mail the checks didn't take as a move stays its item, unless it says the open one's own day
  const items = result.items.filter((i) => {
    if (!asParcels.has(i)) return true;
    const label = [...parcelMoves].find(([, x]) => x === i)![0];
    const row = input.open.get(label)!;
    return !moved.some((m) => m.id === row.id) && i.due !== row.dueDay;
  });
  const rows: DatedWrite[] = [];
  // a moved item keeps its id: the same kind on its new day isn't added again (Codex review of the fixes), whatever its words
  const movedKeys = new Set<string>(moved.map((m) => itemKey(m.kind, m)));
  // revision 2 of the fourth round: an ask with a day is an ask first (a person, to the reader), then the request it is
  const datedAsk = (i: { kind: string; due: string | null; quote: string }) => i.kind === "ask" && !!i.due && askAllowed(i.quote, said, input.text, input);
  // a promise of yours: its day from this message (the person you made it to), as follow-ups place a dated promise; offered
  // only to that person, in its conversation, and tied by its words and the day they say. The Codex code review of v11 (point
  // 1): with more than one promise offered, the sentence names this one apart from the others ("the report can wait until
  // Friday" moves the report, never the budget); naming none of them, it moves none
  const offered = [...(input.promises ?? new Map()).values()].map((p) => ({ id: p.id, text: p.text ?? "", quote: "", dueDay: "" }));
  const promiseMove = (m: Pick<Move, "label" | "due" | "time" | "evidence" | "before">) => {
    const p = input.promises?.get(m.label);
    if (!p || !tiedTo(null, m.evidence, { due: m.due, timeOnly: false })) return [];
    if (offered.length > 1) {
      const context = contextOf(m.evidence, sentences);
      const named = offered.filter((o) => namesItem(o, context, input.from));
      const mine = offered.find((o) => o.id === p.id)!;
      if (!named.some((o) => o.id === p.id) || !namesApart(mine, named, context, input.from)) return [];
    }
    const day = validFollowupDate(m.due, input.arrivedAt);
    return day ? [{ p, day, time: m.time ?? null, evidence: m.evidence, before: askedBefore(m.before, day) }] : [];
  };
  const modelMoves = (result.moved ?? []).flatMap(promiseMove);
  /**
   * Plan 210 (iteration 3, point 7): a request with a day, from the promise's person (the only one it's offered to), for what
   * was promised (`sameObject`) is that promise's move, whatever the model called it: Haiku read David's chase ("she needs
   * both papers by Monday") as a request to send the papers, beside the promise it should have moved (2 in 5). Its quote is
   * the move's evidence, checked as a move's is; the pair rule below then keeps the move alone.
   */
  // never one the mail replaces (a request that says what it replaces names it too: "a full draft of Chapter 2 (replaces the
  // marco teórico)")
  const movedByModel = new Set(modelMoves.map((m) => m.p.id));
  const replacing = new Set((result.replaced ?? []).map((x) => x.label));
  const requestMoves = [...(input.promises ?? new Map()).entries()].flatMap(([label, p]) => {
    if (!p.text || movedByModel.has(p.id) || replacing.has(label)) return [];
    const request = items.find((i) => (i.kind === "respond" || i.kind === "ask") && !!i.due && sameObject(i.text, p.text!) && !saysReplaced(contextOf(i.quote, paragraphs)));
    return request ? promiseMove({ label, due: request.due!, time: request.time, evidence: request.quote, before: request.before }) : [];
  });
  const promiseMoves = [...modelMoves, ...requestMoves];
  /**
   * Plan 210 (prompt v11): a promise's move and a request for that same day, from one mail, can be one thing. The move, when
   * the request names what was promised ("we haven't received the summary: could you get it to me before then?"); the
   * request, when the mail says it takes the promise's place ("skip the piecemeal version: send me a full draft of Chapter 2
   * by Monday"), and the promise isn't moved (iteration 3: it closes as replaced when `replaced` passes its checks, below). The Codex code review of v11 (point 5): only on those words; a request
   * for something else beside the move ("The report can wait until Friday. Send the receipt by Friday") leaves both.
   */
  const promised = new Set<object>();
  const replaced = new Set<object>();
  for (const m of promiseMoves) {
    const words = m.p.text;
    if (words === undefined) continue;
    const sameDay = items.filter((i) => (i.kind === "respond" || (i.kind === "ask" && !!i.due)) && i.due === m.day);
    const naming = sameDay.filter((i) => sameObject(i.text, words));
    if (naming.length) for (const i of naming) promised.add(i);
    else if (sameDay.some((i) => saysReplaced(`${contextOf(i.quote, paragraphs)}\n${contextOf(m.evidence, paragraphs)}`))) replaced.add(m);
  }
  // plan 210 (iteration 3, point 7): a person's offer that waits on the reader's yes is an ask, never a request with a day
  // plan 210 (iteration 4, revision 5): a quote not the mail's, verbatim, is the one span that holds what it names and its day
  const spanned = <T extends { quote: string; due: string | null }>(i: T): T => {
    if (quoted(i.quote)) return i;
    const span = quoteSpan(i.quote, i.due, input.subject, sentences, input.arrivedAt);
    return span ? { ...i, quote: span } : i;
  };
  const candidates = [...answered, ...items].filter((i) => !promised.has(i)).map(spanned).filter((i) => !refused(i)).map((i) => (i.kind === "respond" && input.sender?.person && (offerOnly(`${i.quote}\n${contextOf(i.quote, sentences)}`, contextOf(i.quote, paragraphs)) || wishOnly(contextOf(i.quote, sentences), i.due, input.arrivedAt)) ? { ...i, kind: "ask", due: null, time: null } : i)).map((i) => {
    // the claims ledger's third batch: an undated ask for more time carries the day of the deadline it's about (checked as an
    // ask, then the request with that day)
    const due = i.kind === "ask" && !i.due && input.sender?.person ? dueAskedAbout(i, paragraphs, input.arrivedAt) : null;
    return due ? { ...i, due } : i;
  });
  // plan 210 (iteration 4, revision 12): an item's facts (someone there, a lapse, charged by itself) from the whole mail, but
  // only its paragraphs: every one but those that hold another item's quote and not its own (Priya's "An adult signature is
  // required", two paragraphs below the laptops)
  const quotes = candidates.map((i) => norm(i.quote)).filter(Boolean);
  const tiedWords = (quote: string) => {
    const mine = norm(quote);
    return paragraphs.filter((p) => (mine && p.read.includes(mine)) || !quotes.some((q) => q !== mine && p.read.includes(q))).map((p) => p.said).join("\n\n");
  };
  // the eval: a person's request with a day is the `respond`, never also an undated ask beside it for the same thing; an ask
  // about something else stays (plan 210, the Codex review of iteration 1, revision 3)
  const requests = candidates.filter((i) => (i.kind === "respond" || datedAsk(i)) && quoted(i.quote));
  // plan 210 (iteration 4): a reply to the sender asked by a day is the one reply: an undated "answer them about…" beside it
  // whose own sentence asks nothing is that reply again (Haiku gave Karin's outage both, its ask quoting "I have to brief our
  // COO at 3pm Central"). Iteration 5 (revision 8): never one that asks something of its own ("can you bring the tamales?",
  // dropped beside Elena's head count in round 13), unless its quote is in the request's own sentence or list
  const sender = nameWords(input.from ?? "");
  const senderNaming = namingWords(input.from ?? "");
  const replyTo = (text: string) => REPLY_TO.test(norm(text)) && sender.some((w) => ` ${norm(text)} `.includes(` ${w} `));
  const partOf = (r: { quote: string }, x: { quote: string }) => partOfRequest(r.quote, x.quote, sentences, paragraphs);
  /**
   * The claims ledger's second batch (Jordan's Lena): the line of the mail a request's words name, its own sentence or list
   * line: the one holding the most of its naming words, at least two, and no other as many; -1 when none is.
   */
  const lineWords = sentences.map((s) => namingWords(s.said));
  const ownLine = (text: string): number => {
    const words = [...namingWords(text)].filter((w) => !senderNaming.has(w));
    const counts = lineWords.map((ws) => words.filter((w) => ws.has(w)).length);
    const most = Math.max(0, ...counts);
    return most >= 2 && counts.filter((n) => n === most).length === 1 ? counts.indexOf(most) : -1;
  };
  /**
   * Two requests of one mail that quote one sentence (the deadline "If I can have both by Tuesday" after a list) are two
   * when their words name two things, each on a line of its own, neither line in the request the shared quote makes (a list
   * it introduces: Karin's "a reply from you today with:").
   */
  // its code review: never a line that restates the other ("I mean the countersigned supplier agreement", "o sea…")
  const apart = (a: { text: string; quote: string }, b: { text: string; quote: string }) => {
    if (sameObject(a.text, b.text)) return false;
    const [la, lb] = [ownLine(a.text), ownLine(b.text)];
    if (la < 0 || lb < 0 || la === lb || [la, lb].some((l) => restates(sentences[l]!.said))) return false;
    return !partOf(a, { quote: sentences[la]!.said }) && !partOf(b, { quote: sentences[lb]!.said });
  };
  const requested = (ask: { text: string; quote: string }) => requests.some((r) => sameThing(r, ask) || partOf(r, ask) || (replyTo(r.text) && replyTo(ask.text) && !asksDirectly(contextOf(ask.quote, sentences))));
  // the fourth panel read: a person who says no answer is needed ("No need to reply now") asks nothing
  const noReply = saysNoReplyNeeded(input.text);
  // plan 210 (iteration 3, point 7): an automated sender's mail that cancels the reader's appointment may ask them to book again
  const cancelled = [...input.open.values()].some((r) => r.kind === "event" && settledIds.has(r.id)) || CANCELLED.test(norm(input.text));
  const rebooks = (ask: { quote: string }) => cancelled && input.reader?.addressed === "to" && REBOOK.test(norm(contextOf(ask.quote, sentences)));
  /**
   * Round 18 (Diego's workshop, Thursday's plan while Fer still waits on his yes): a mail that proposes something the reader
   * hasn't accepted (`proposedIn`, as the second look reads it) gives no plan or deadline from the proposal's sentences: a
   * bill, a request (the answer it waits on) and an alert stand. Their own word for it, an open promise of theirs the mail
   * names (their later mail that accepted it), is an acceptance, and its days are read as any.
   */
  const accepted = [...(input.promises ?? new Map()).values()].some((p) => !!p.text && namesSpecifically({ text: p.text, quote: "" }, input.text, input.from));
  const proposed = accepted ? () => false : proposedIn(sentences);
  const fromProposal = (quote: string) => {
    const at = sentencesWith(quote, sentences);
    return at.length > 0 && at.every(proposed);
  };
  let asked = false;
  // plan 210 (iteration 4, revision 11): "Reply C to confirm" is an ask that waits on the reader from its mail's day and ends
  // with the event it confirms (this mail's one event), whatever day the model gave it (v13 dated it on the mail's own day,
  // so it was dropped as past); read after every other item, so that event's row is known
  const day = dayKeyOf(input.arrivedAt);
  const confirming = new Set(candidates.filter((i) => (i.kind === "ask" || (i.kind === "respond" && (!i.due || i.due <= nextDay(day)))) && confirmsByReply(`${i.quote}\n${contextOf(i.quote, sentences)}`)));
  for (const item of [...candidates.filter((i) => !confirming.has(i)), ...confirming]) {
    if (!KINDS.has(item.kind) || !item.text.trim() || !quoted(item.quote)) continue;
    const events = confirming.has(item) ? rows.filter((r) => r.kind === "event") : [];
    if (events.length === 1 && !rows.some((r) => r.confirmsItem !== undefined) && (input.reader?.addressed === "to" || askAllowed(item.quote, said, input.text, input))) {
      asked = true;
      if (rows.length < DATED_ITEMS_MAX) rows.push({ kind: "ask", item: rows.length, text: item.text.trim(), quote: item.quote.trim(), ...datedTiming({ kind: "ask", due: null, arrivedAt: input.arrivedAt })!, confirmsItem: events[0]!.item });
      continue;
    }
    // an ask is never a dated kind's substitute: one with a day is a request with a day, if it's an ask at all
    if (item.kind === "ask" && item.due && !datedAsk(item)) continue;
    const kind = (item.kind === "ask" && item.due ? "respond" : item.kind) as DatedKind;
    // plan 210 (iteration 3): an offer is its own question, never hidden by a request about the same papers
    const around = `${item.quote}\n${contextOf(item.quote, sentences)}`;
    if (kind === "ask" && ((requested(item) && !offerOnly(around, contextOf(item.quote, paragraphs))) || noReply || onlyTells(item.quote) || onlyTells(contextOf(item.quote, sentences)) || courtesyOnly(around) || selfOffer(around, contextOf(item.quote, paragraphs)) || yourOwnWord(contextOf(item.quote, sentences)) || !(askAllowed(item.quote, said, input.text, input) || rebooks(item)))) continue;
    // round 19: a get-together suggested with no question and no day asks nothing
    if (kind === "ask" && getTogetherOnly(contextOf(item.quote, sentences), input.arrivedAt)) continue;
    // plan 210 (the second morning): a person's good wishes for something of the reader's are no plan of theirs, nor an ask
    if ((kind === "event" || kind === "ask") && input.sender?.person && wellWishOnly(contextOf(item.quote, sentences))) continue;
    // the claims ledger's third batch: the sender's own opening or launch, the reader not invited, is no plan of theirs
    if (kind === "event" && theirsOnly(contextOf(item.quote, sentences), `${input.subject}\n${input.text}`)) continue;
    // round 18: a plan or a deadline from a proposal the reader hasn't accepted
    if (!UNPROPOSED.has(kind) && fromProposal(item.quote)) continue;
    // the second morning's code review: a gathering a list's post offers to whoever on it, the reader not addressed
    if ((kind === "event" || kind === "delivery") && input.listed && input.reader?.addressed === "none" && offeredToTheList(contextOf(item.quote, paragraphs), input.reader)) continue;
    // plan 210 (iteration 4's code review): what a scam says happened or demands is no item, an alert, a request or an
    // expiry (prompt v15, and this backstop); never "something asked" either
    if (PRESSED.has(kind) && scamPressure(`${input.subject}\n${tiedWords(item.quote).slice(0, FACT_WORDS_MAX)}\n${item.quote}`)) continue;
    // round 17 (Jordan's CEO from a gmail address): gift cards whose codes are wanted back are the gift-card scam, any kind of to-do
    if (kind !== "event" && kind !== "delivery" && giftCardScam(`${item.text}\n${item.quote}\n${contextOf(item.quote, sentences)}`)) continue;
    // plan 210 (the Codex code review of iteration 2): a request of the reader, kept below or not (a day already past or
    // over in a scan, a duplicate, past the bound): never "nothing asked"
    if (kind === "ask" || kind === "respond") asked = true;
    // plan 210 (iteration 3, revision 11): a deadline's bare day of the month read into the past is the next one
    const ahead = item.due && (kind === "respond" || kind === "pay") ? bareDayAhead(item.due, contextOf(item.quote, paragraphs), dayKeyOf(input.arrivedAt)) : item.due;
    // round 18 (Jordan's Tallis call, Diego's cowork renewal): a month's end its quote says is that month's last day, never
    // the day before it
    const due = ahead ? monthEndDay(ahead, item.quote, input.arrivedAt) : ahead;
    // plan 210 (iteration 4, revision 11): the day it was asked before, rolled with a bare day read forward; none at a month's end
    const before = due && item.before && due === ahead ? askedBefore(due === item.due ? item.before : nextDay(due), due) : null;
    // plan 210 (iteration 5, V2): an event its quote gives one start time for, given none, takes it (on the reader's clock);
    // never one the model put on a place's clock (travel: the quote's time is that place's)
    const time = item.time ?? (kind === "event" && due && !item.wall ? startOf(item.quote, due) : null);
    const timing = atInstant(datedTiming({ kind, due, time, arrivedAt: input.arrivedAt }), item.at);
    if (!timing) continue;
    // plan 210 (iteration 5's code review): its part of the day read first, so the 14-day check keeps nothing already over
    // (§6) at that part's end too: a morning's request after its noon
    const parted = partTiming(kind, item.quote, timing, input.arrivedAt)!;
    if (input.fromScan && parted.dated && (parted.partOfDay ? dueCutoff(parted.dueDay, parted.partOfDay) : dayEnd(parted.dueDay)) <= input.now) continue;
    // the bound, after a request past it is still known
    if (rows.length >= DATED_ITEMS_MAX) continue;
    const key = itemKey(kind, timing);
    if (movedKeys.has(key)) continue;
    // plan 210 (iteration 4): two replies to the sender on one day are the one reply (Haiku split Karin's numbered list, 1 in 5);
    // iteration 5 (revision 8): when one's quote is in the other's own sentence or list
    // the claims ledger's second batch: two things asked that share a quote are two when their words name two lines (`apart`);
    // two questions, when neither's quote is in the other's sentence or list
    const request = kind === "respond" || kind === "ask";
    if (rows.some((r) => itemKey(r.kind, r) === key && (!TWO_A_DAY.has(kind) || (sameThing(r, item) && !(request && apart(r, item))) || (kind === "respond" && replyTo(r.text) && replyTo(item.text) && (partOf(r, item) || partOf(item, r))) || (kind === "ask" && (partOf(r, item) || partOf(item, r)))))) continue;
    // plan 210 (iteration 3, revision 11): facts from the mail's words, never the item's; iteration 4, the paragraphs tied to it
    const words = `${tiedWords(item.quote).slice(0, FACT_WORDS_MAX)}\n${item.quote}`;
    // plan 210 (iteration 5, revision 1): a plan that renews by itself and a bill paid by itself or already, in its own words,
    // are no items; iteration 4 (revision 12): a delivery only estimated is none either
    if (handledItself({ kind, text: item.text, quote: item.quote }, { subject: input.subject, paragraphs, tied: tiedWords(item.quote).slice(0, FACT_WORDS_MAX), from: input.from })) continue;
    if (kind === "delivery" && estimateOnly(contextOf(item.quote, paragraphs), timing.dueDay, input.arrivedAt)) continue;
    rows.push({ kind, item: rows.length, text: item.text.trim(), quote: item.quote.trim(), ...parted,...(shownEarly(kind, item, words, said, input) ? { early: true } : {}), ...(canLapse(kind) && lapsesUnlessRenewed(words) ? { lapses: true } : {}), ...(before && timing.dated && !timing.timed ? { before } : {}), ...(item.wall && timing.timed && wallHolds(item.wall, timing.dueAt) ? { wall: item.wall } : {}) });
  }
  /**
   * Plan 210 (iteration 3, revision 4, the owner's "Close replaced promises"): a promise its person's later mail in its
   * conversation (the only one it's offered) replaces with a different request. Checked hard: the mail's own plain words, not
   * someone's retold in quotation marks, that say it's dropped ("Let's skip the piecemeal version"; never "don't skip it", read
   * in the mail's clause around the quote, so "Don't skip the methods section" quoted from "skip" is still denied),
   * their paragraph naming what was promised apart from any other promise offered, and a request kept from this mail that
   * isn't what was promised (that's a move). The store closes the promise only with that request written.
   */
  const replacements = (result.replaced ?? []).flatMap((x) => {
    const p = input.promises?.get(x.label);
    if (!p?.text || !tiedTo(null, x.evidence, null) || !replacesPlainly(x.evidence, `${input.subject}\n${input.text}`) || insideQuotes(x.evidence, input.text)) return [];
    const paragraph = contextOf(x.evidence, paragraphs);
    const named = offered.filter((o) => namesItem(o, paragraph, input.from));
    const mine = offered.find((o) => o.id === p.id)!;
    if (!named.some((o) => o.id === p.id) || !namesApart(mine, named, paragraph, input.from)) return [];
    // what the mail asks (its quote) or the model's words for it: one that names the old deliverable beside the new is still new
    const request = rows.find((r) => (r.kind === "respond" || r.kind === "ask") && !(sameObject(r.text, p.text!) && sameObject(r.quote, p.text!)));
    return request ? [{ id: p.id, revision: p.revision, item: request.item }] : [];
  });
  const gone = new Set(replacements.map((r) => r.id));
  const movedPromises = promiseMoves.filter((m) => !replaced.has(m) && !gone.has(m.p.id)).map(({ p, day, time, before, evidence }) => {
    const at = movedPromise(p, day, time, input.arrivedAt, evidence);
    return { id: p.id, revision: p.revision, ...at, ...(before && !at.timed ? { before } : {}) };
  });
  return { rows, settled, moved: moved.map(({ kind: _kind, ...m }) => m), movedPromises, replaced: replacements, asked };
}

export class DatedWorker {
  private active = false;
  private stopped = false;
  private running = false;
  private again = false;
  private generation = new AbortController();
  private paused: { kind: AiErrorKind; message: string } | null = null;
  private limited: string | null = null;
  private heldUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly attempts = new Map<number, number>();
  private prunedDay: string | null = null;
  /** the request on its way out: checked again as it leaves the limiter, repairs included (revision 3) */
  private leaving: { messageId: number; threadId: number; accountId: number; senderKey: string; date: number; open: readonly number[]; stop: AbortController } | null = null;

  constructor(private readonly host: DatedHost) {}

  get isActive(): boolean {
    return this.active && !this.stopped;
  }
  get blockedBy(): { kind: AiErrorKind; message: string } | null {
    return this.paused;
  }
  /** a live timer waiting on a provider (null otherwise); for tests */
  get retrying(): ReturnType<typeof setTimeout> | null {
    return this.retryTimer;
  }

  /** Ingest's question: mark live mail for it? From when (mail from before it went on isn't marked). */
  async wanted(): Promise<{ since: number | null } | undefined> {
    if (!this.isActive) return undefined;
    const settings = await this.host.settings();
    return settings.dated.enabled && (await this.host.allowed(settings)) ? { since: settings.dated.enabledAt } : undefined;
  }

  async start(): Promise<void> {
    const settings = await this.host.settings();
    this.active = settings.dated.enabled;
    if (this.stopped) return;
    if (this.active) this.wake();
  }

  /** Once a day with nothing to read too: the day's bounds, and what's over retired. */
  async daily(): Promise<void> {
    if (!this.isActive) return;
    if (!this.running) await this.bounds();
    // round 2: at every moment the clock wakes for, not only the day's first: a Plan ends at 9:40 too
    await this.retire();
  }

  stop(): void {
    this.stopped = true;
    this.generation.abort();
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** New mail, a body, the network. A no-op when off, paused, or for a minute after a provider failed. */
  wake(o: { network?: boolean } = {}): void {
    if (!this.isActive || this.paused) return;
    if (o.network) this.heldUntil = 0;
    if (this.host.now() < this.heldUntil) return;
    const today = new Date(this.host.now()).toDateString();
    if (this.limited) {
      if (this.limited === today) return;
      this.limited = null;
    }
    void this.drain().catch((error: unknown) => {
      captureError(error, { code: "ai.failed" });
      this.host.log("warn", "dated reader stopped", error instanceof Error ? error.name : "error");
    });
  }

  settingsChanged(settings: AppSettings): void {
    const on = settings.dated.enabled;
    const off = this.active && !on;
    this.active = on;
    const wasPaused = this.paused !== null;
    this.paused = null;
    if (wasPaused) this.host.statusChanged(this.status());
    this.limited = null;
    this.heldUntil = 0;
    this.clearRetry();
    if (off) {
      this.generation.abort();
      this.generation = new AbortController();
      void this.host.store.dated.marks.clear().catch(() => {});
      this.host.changed();
      return;
    }
    this.host.changed();
    this.wake();
  }

  /** Called as a dated request is about to leave, after any wait: Spam, Trash or a moved message stop it there (revision 3). */
  async holdingUp(): Promise<void> {
    const leaving = this.leaving;
    if (!leaving || leaving.stop.signal.aborted) return;
    const { store } = this.host;
    const src = await store.dated.source(leaving.messageId);
    if (!src || src.spam || src.trash || src.threadSpam || src.threadId !== leaving.threadId || !this.host.gate.reads(src.accountId)) return leaving.stop.abort();
    // plan 210 (iteration 4): a sender muted meanwhile, before anything leaves
    if ((await this.muted()).senders.has(leaving.senderKey)) return leaving.stop.abort();
    // Codex code review: the open items it carries are material too; one whose conversation went to Spam stops it
    if (!leaving.open.length) return;
    const still = new Set((await store.dated.openFor({ threadId: leaving.threadId, senderKey: leaving.senderKey, before: leaving.date, limit: DATED_OPEN_SHOWN, excludeAccounts: this.host.gate.readsOff })).map((r) => r.id));
    if (leaving.open.some((id) => !still.has(id))) leaving.stop.abort();
  }

  /** Plan 210 (iteration 4): what the reader muted, read where it's needed (a table bounded at 200). */
  private async muted() {
    return mutedOf(await this.host.store.dated.mutes.list());
  }

  /** Plan 211: the account's AI or What matters went off: its reading on the way stops, and its marks go as they're reached. */
  accountOff(accountId: number): void {
    const leaving = this.leaving;
    if (leaving?.accountId === accountId) leaving.stop.abort();
  }

  /**
   * Plan 210 (iteration 4): a sender just muted: a reading of theirs on its way stops (the store refuses its finish too),
   * and its mark goes when it's considered again. An Unmute changes nothing here: mail from then on is read.
   */
  mutesChanged(muted: { senders: ReadonlySet<string> }): void {
    const leaving = this.leaving;
    if (leaving && muted.senders.has(leaving.senderKey)) leaving.stop.abort();
  }

  private async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.bounds();
        await this.pass(this.generation);
      } while (this.again && this.isActive && !this.paused && !this.limited);
    } finally {
      this.running = false;
      this.host.caughtUp();
    }
  }

  private async bounds(): Promise<void> {
    const today = new Date(this.host.now()).toDateString();
    if (this.prunedDay === today) return;
    this.prunedDay = today;
    await this.host.store.dated.marks.prune(this.host.now());
    await this.host.store.dated.prune(this.host.now());
    await this.retire();
  }

  /**
   * Codex code review: what's over for good (a Plan that's ended, a deadline past Missed's days) is closed as `expired`, so
   * the open set, bounded at 1,000, holds only what can still show and never refuses new items for old ones.
   */
  async retire(): Promise<number> {
    const { store } = this.host;
    const now = this.host.now();
    const over = withEventEnds(await store.dated.active()).filter((r) => datedOver(r, now));
    let n = 0;
    await this.host.runBudgeted(over, async (chunk) => {
      for (const r of chunk) if (await store.dated.update(r.id, r.revision, { state: "dismissed", closedReason: "expired", closedAt: now }, { dueDay: r.dueDay, dueAt: r.dueAt })) n++;
    });
    if (n) this.host.changed();
    return n;
  }

  /** Oldest first; a message waiting for its body holds later ones from its thread and its sender (revision 5). */
  private async pass(generation: AbortController): Promise<void> {
    let after: { arrivedAt: number; messageId: number } | null = null;
    const heldThreads = new Set<number>();
    const heldSenders = new Set<string>();
    for (;;) {
      const page: DatedMark[] = await this.host.store.dated.marks.page(after, PAGE);
      if (!page.length) return;
      for (const mark of page) {
        if (generation !== this.generation || !this.isActive) return;
        after = { arrivedAt: mark.arrivedAt, messageId: mark.messageId };
        if (heldThreads.has(mark.threadId)) continue;
        const next = await this.consider(mark, generation, heldSenders);
        if (next === "stop") return;
        if (typeof next === "object") {
          heldThreads.add(mark.threadId);
          heldSenders.add(next.hold);
        }
      }
    }
  }

  private async consider(mark: DatedMark, generation: AbortController, heldSenders: ReadonlySet<string>): Promise<"next" | "stop" | { hold: string }> {
    const { store } = this.host;
    const clearGeneration = store.dated.clearGeneration();
    const settings = await this.host.settings();
    if (!settings.dated.enabled || !(await this.host.allowed(settings))) return "stop";
    const src = await store.dated.source(mark.messageId);
    const drop = async () => {
      await store.dated.marks.consume(mark.messageId);
      return "next" as const;
    };
    // the owner's rule: mail in Spam reaches no AI, the whole thread's
    if (!src || src.draft || src.sent || src.own || src.spam || src.trash || src.threadSpam) return drop();
    // plan 211: nor an account with AI or What matters off (turned back on, its new mail is read)
    if (!this.host.gate.reads(src.accountId)) return drop();
    // plan 210 (iteration 4, revision 2): a muted sender's mail isn't read for What matters at all, before its body or a
    // provider is reached; not read later either (Unmute is for mail from then on: one queued while they were muted stays unread)
    if (silenced(src, await silenceOf(store))) return drop();
    // after the fourth panel round: a sender named like a security desk is read for nothing (no item, settlement or move),
    // unless you've written to them (Codex's second pass)
    // plan 210 (iteration 4's code review): and one named like the reader's own organization's ("lumora-io.co" for lumora.io)
    const accounts = await store.accounts.list();
    if ((await untrustedSenders([src.fromEmail], (keys) => store.dated.written(keys), accounts.map((a) => a.email))).size) return drop();
    if (heldSenders.has(src.senderKey)) return { hold: src.senderKey };
    // what came before it went on is read only with the check's yes
    if (mark.source === "live" && settings.dated.enabledAt !== null && src.date < settings.dated.enabledAt) return drop();
    // revision 5: what could settle an open item is read before any cost filter
    const open = await store.dated.openFor({ threadId: src.threadId, senderKey: src.senderKey, before: src.date, limit: DATED_OPEN_SHOWN, excludeAccounts: this.host.gate.readsOff });
    // plan 210 (iteration 5, revision 8): Social and Promotions only for a person's ask a service relays (its body tells)
    const filtered = !open.length && (src.tab === "social" || src.tab === "promotions");
    if (filtered && !mayRelay(src.subject) && src.bodyState !== "full") return drop();
    if (src.bodyState !== "full" && !src.bodyUnavailable) return { hold: src.senderKey };
    const { text, whole } = await this.text(src);
    const readerName = accounts.find((a) => a.id === src.accountId)?.displayName ?? "";
    // the claims ledger's second batch: a person writing from a role address, as themselves, is a person
    const person = src.person || personAtRole(src, text, readerName);
    const relay = person ? null : relayedAsk(src.subject, text, src.fromName || src.fromEmail.split("@")[0]!, readerName);
    if (filtered && !relay) return drop();
    // a cost filter, not a judgment (§3): a person's mail is read whatever its words, and so is a person's relayed ask
    if (!open.length && src.automated && !relay && !hasTimeCue(text, src.subject)) return drop();
    if (!text.trim() && !src.subject.trim()) return drop();
    const asked = this.host.begin(`dated:${mark.messageId}`, "dated-worker");
    const stop = new AbortController();
    this.leaving = { messageId: src.id, threadId: src.threadId, accountId: src.accountId, senderKey: src.senderKey, date: src.date, open: open.map((r) => r.id), stop };
    try {
      const ai = await this.host.forTask();
      const language = await this.readerLanguage(settings);
      const labels = new Map(open.map((r, i) => [`o${i + 1}`, r]));
      // the second panel round: your open promises on this thread, offered only to a message from the person you made them
      // to (they may move the day; nobody else may), to be moved, never settled (Codex review)
      const promised = (await store.followups.ofThread(src.threadId)).filter((p) => p.kind === "promise" && (p.state === "open" || p.state === "due") && p.personEmail && addressKey(p.personEmail) === src.senderKey && p.sentAt < src.date).slice(0, DATED_OPEN_SHOWN);
      const promises = new Map(promised.map((p, i) => [`p${i + 1}`, p]));
      const budget = datedBudget(ai.contextTokens);
      // names only: who the reader is and how it reached them, so a task for someone else stays theirs (the eval)
      const nameOf = (p: { name: string; email: string }) => p.name || p.email.split("@")[0]!;
      const reader = { name: readerName, addressed: src.readerIn };
      // the seventh panel round: the mail's other recipients, by name, for an ask addressed to one of them ("Oren, could you…")
      const own = new Set(accounts.map((a) => addressKey(a.email)));
      const others = [...src.to, ...src.cc].filter((p) => !own.has(addressKey(p.email))).map(nameOf);
      // the third panel round: "a person" as the ask's local check reads it (a role address you never wrote to isn't one)
      const input = fitDates({ text, subject: src.subject, from: { name: src.fromName || src.fromEmail.split("@")[0]!, automated: src.automated || !person }, reader, to: src.to.map(nameOf), cc: src.cc.map(nameOf), receivedAt: inWords(src.date, language), zone: readerZone(), open: [...[...labels].map(([label, r]) => ({ label, kind: r.kind as DatedKind | "promise", text: r.text, due: r.dated ? r.dueDay : null, time: r.timed ? clockOf(r.dueAt) : null })), ...[...promises].map(([label, p]) => ({ label, kind: "promise" as const, text: p.text, due: p.dated ? dayKeyOf(p.dueAt) : null }))], language, outputTokens: budget.outputTokens }, budget.promptChars);
      // a change of provider or key, the setting, Spam meanwhile: each stops it, at the provider too
      const signal = AbortSignal.any([generation.signal, asked.signal, stop.signal]);
      if (signal.aborted) return await drop();
      const read = async (i: typeof input) => {
        const r = await ai.readDates(i, signal);
        if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
        return r;
      };
      // plan 210 (iteration 5, revision 3): a dated sentence the reading noted nothing for is asked about once more, before
      // the one finish: Spam, a mute and the settings read again first, its one claim on the mark, the text already read
      const looked = await secondLook(await read(input), { text, subject: src.subject, arrivedAt: src.date, automated: input.from.automated, listed: src.automated, addressed: src.readerIn, from: input.from.name, now: this.host.now(), shown: input.open, input, promptChars: budget.promptChars }, {
        recheck: async () => {
          const current = await this.host.settings();
          if (!current.dated.enabled || !(await this.host.allowed(current))) return "stop";
          const at = await store.dated.source(src.id);
          if (!at || at.spam || at.trash || at.threadSpam || at.threadId !== src.threadId || !this.host.gate.reads(at.accountId) || silenced(at, await silenceOf(store))) return "drop";
          return "go";
        },
        claim: () => store.dated.marks.claimLook(src.id, this.host.now()),
        read,
        aborted: () => signal.aborted,
      });
      if (looked === "drop") return await drop();
      if (looked === "stop") return "stop";
      const result = looked.result;
      const fromScan = mark.source === "scan";
      const now = this.host.now();
      // only what was really sent, after fitting to the window, may be named back (Codex review)
      const sent = new Set(input.open.map((o) => o.label));
      // plan 210 (iteration 3, revision 5): a receipt's one bill is counted in the store, never among the labels sent; read
      // only when the model settled something
      const paysInThread = result.settled.length ? (await store.dated.ofThread(src.threadId)).filter((r) => r.kind === "pay").length : 0;
      const checked = checkDates(result, { text, subject: src.subject, arrivedAt: src.date, open: new Map([...labels].filter(([l]) => sent.has(l))), promises: new Map([...promises].filter(([l]) => sent.has(l))), fromScan, now, sender: { person }, reader, others, threadId: src.threadId, senderKey: src.senderKey, from: input.from.name, paysInThread, relay, listed: src.automated });
      // plan 210 (iteration 2, the Codex code review): "nothing asked" only of a message the model saw all of (never one cut
      // to the window or the reader's limit, nor a subject past what's sent), and in which the checks found no request at all;
      // iteration 5 (revision 3): nor while a second look it needed is incomplete (claimed before, or failed)
      const readWhole = whole && text.length <= DATED_TEXT_CHARS && input.text === text && src.subject.length <= DATED_SUBJECT_CHARS && looked.complete;
      const replies = this.host.replies();
      const write = { messageId: src.id, threadId: src.threadId, fromScan, rows: checked.rows, settled: checked.settled, moved: checked.moved, movedPromises: checked.movedPromises, replaced: checked.replaced, now, model: ai.model, provider: ai.providerId, promptVersion: DATED_PROMPT_VERSION, nothingAsked: readWhole && !checked.asked, ...(replies ? { replies } : {}), clearGeneration };
      const outcome = await store.dated.finish(write);
      this.attempts.delete(src.id);
      // a merge moved it under the request: read again on its new thread (revision 6)
      if (outcome === "moved") this.again = true;
      if (outcome === "written" && (checked.movedPromises.length || checked.replaced.length)) this.host.promisesMoved();
      // plan 210 (iteration 2): nothing asked of the reader takes a waiting conversation out of Needs you, in the same write
      const quiet = readNothingAsked(write);
      if (outcome === "written" && (quiet || checked.rows.length || checked.settled.length || checked.moved.length || checked.movedPromises.length || checked.replaced.length)) this.host.changed();
      // a second look that failed after the reading was written: its provider's hold or pause, the mark already gone
      return looked.error === undefined ? "next" : await this.failed(null, looked.error);
    } catch (error) {
      // Spam or Trash meanwhile: never asked about again; an open item gone to Spam: asked again without it
      if (stop.signal.aborted) {
        const now = await store.dated.source(src.id);
        if (now && !now.spam && !now.trash && !now.threadSpam && now.threadId === src.threadId && this.host.gate.reads(now.accountId)) {
          this.again = true;
          return "stop";
        }
        return await drop();
      }
      return this.failed(mark, error);
    } finally {
      asked.release();
      if (this.leaving?.stop === stop) this.leaving = null;
    }
  }

  /** `whole`: the store gave all of it (under the limit, the body captured in full), for "nothing asked" (plan 210) */
  private async text(src: DatedSource): Promise<{ text: string; whole: boolean }> {
    const texts = await this.host.store.aiSummaries.text([{ messageId: src.id, limit: DATED_TEXT_CHARS * 2 }]);
    const raw = texts.get(src.id) ?? "";
    return { text: withoutQuotes(raw), whole: raw.length < DATED_TEXT_CHARS * 2 && !src.bodyUnavailable };
  }

  /** `mark` null: a second look's failure after its reading was written (plan 210, iteration 5): the mark's gone, the hold applies */
  private async failed(mark: DatedMark | null, error: unknown): Promise<"next" | "stop"> {
    const { store } = this.host;
    if (error instanceof DailyLimitError || error instanceof MonthlyLimitError) {
      this.limited = new Date(this.host.now()).toDateString();
      return "stop";
    }
    if (!(error instanceof AiError)) captureError(error instanceof Error ? new Error(error.name) : new Error("error"), { code: "ai.failed" });
    const kind: AiErrorKind = error instanceof AiError ? error.kind : "unavailable";
    this.host.log("info", "dated read failed", { aiKind: kind });
    switch (kind) {
      case "cancelled":
        if (this.isActive) this.again = true;
        return "stop";
      case "auth":
      case "not_configured":
      case "blocked":
        this.paused = { kind, message: error instanceof Error ? error.message : String(error) };
        this.host.statusChanged(this.status());
        return "stop";
      case "invalid_output":
      case "refused":
      case "unsupported":
        if (mark) await store.dated.marks.consume(mark.messageId);
        return "next";
      case "rate_limited":
      case "unavailable":
      case "timeout": {
        const tries = mark ? (this.attempts.get(mark.messageId) ?? 0) + 1 : 0;
        if (mark && tries >= MAX_ATTEMPTS) {
          this.attempts.delete(mark.messageId);
          await store.dated.marks.consume(mark.messageId);
        } else if (mark) this.attempts.set(mark.messageId, tries);
        this.heldUntil = this.host.now() + RETRY_WAIT_MS;
        if (kind === "rate_limited" && !this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.wake({ network: true });
          }, RETRY_WAIT_MS);
          (this.retryTimer as { unref?: () => void }).unref?.();
        }
        return "stop";
      }
    }
  }

  private async readerLanguage(settings: AppSettings): Promise<LocaleId> {
    if (isLocaleId(settings.language)) return settings.language;
    const ui = await this.host.store.settings.get<string | null>(UI_LOCALE_KEY, null);
    return isLocaleId(ui) ? ui : DEFAULT_LOCALE;
  }

  // ─── what the user does (§5): plan 210 (iteration 2), What matters' one act on items (`TodayService.act`) ───

  /** Codex's second pass: an item stored from a suspicious sender before the guard isn't shown, as in Today. */
  async ofThread(threadId: number, include?: number): Promise<DatedRow[]> {
    const { dated } = this.host.store;
    // plan 210 (iteration 2): a history line opened shows its own closed item, of this conversation only
    const extra = include === undefined ? null : await dated.get(include);
    const rows = [...(await dated.ofThread(threadId)), ...(extra && extra.threadId === threadId && extra.state !== "open" ? [extra] : [])];
    // plan 210 (iteration 4): an open item of a muted sender or kind is hidden here too (a history line's own stays)
    // (an ask's event is found before anything is hidden, as in the list)
    const muted = await this.muted();
    const shown = withEventEnds(rows).filter((r) => r.state !== "open" || withoutMuted([r], muted).length);
    return [...(await withoutUntrusted(shown, (keys) => dated.written(keys)))];
  }

  // ─── §6: the one-time check ──────────────────────────────────────────────

  /**
   * Codex code review: the check's messages are those the reader would ask about, chosen before its bound: newest first,
   * not Spam, Trash, Promotions or Social, and automated mail only with a time cue. Walked in the backend's slices.
   */
  private async scanPicks(now: number): Promise<number[]> {
    const { store } = this.host;
    const walked = await store.dated.scanCandidates(now - DATED_SCAN_DAYS * 86_400_000, SCAN_WALK);
    // plan 210 (iteration 4): a muted sender's mail is neither counted nor read, nor what came before their Unmute
    const silence = await silenceOf(store);
    const readers = new Map((await store.accounts.list()).map((a) => [a.id, a.displayName ?? ""]));
    // newest first: whether each is worth reading by itself, and who and where it's from
    const seen: { s: DatedSource; worth: boolean }[] = [];
    await this.host.runBudgeted(walked, async (chunk) => {
      // plan 211: nor an account with AI or What matters off
      const sources = (await Promise.all(chunk.map((id) => store.dated.source(id)))).filter((s): s is DatedSource => !!s && !s.spam && !s.trash && !s.threadSpam && !s.draft && !s.sent && !s.own && !silenced(s, silence) && this.host.gate.reads(s.accountId));
      // plan 210 (iteration 5, revision 8): Social and Promotions only for a person's ask a service relays, read in its body
      const social = (s: DatedSource) => s.tab === "social" || s.tab === "promotions";
      // round 2: a body not here yet can't be judged; it's read, and the worker waits for it (the filter errs towards reading)
      const judged = sources.filter((s) => (s.automated || social(s)) && (s.bodyState === "full" || s.bodyUnavailable));
      const texts = judged.length ? await store.aiSummaries.text(judged.map((s) => ({ messageId: s.id, limit: DATED_TEXT_CHARS }))) : new Map<number, string | null>();
      for (const s of sources) {
        const text = withoutQuotes(texts.get(s.id) ?? "");
        const relayed = !s.person && texts.has(s.id) && !!relayedAsk(s.subject, text, s.fromName || s.fromEmail.split("@")[0]!, readers.get(s.accountId) ?? "");
        if (social(s) && !relayed) continue;
        seen.push({ s, worth: !s.automated || relayed || (s.bodyState !== "full" && !s.bodyUnavailable) || hasTimeCue(text, s.subject) });
      }
    });
    // round 2: a later message from the sender or the conversation of one it reads ("Paid in full") may settle it: it's read too
    const oldest = new Map<string, number>();
    for (const { s, worth } of seen) if (worth) for (const key of [`t${s.threadId}`, `s${s.senderKey}`]) oldest.set(key, Math.min(oldest.get(key) ?? Infinity, s.date));
    const settles = (s: DatedSource) => [`t${s.threadId}`, `s${s.senderKey}`].some((key) => (oldest.get(key) ?? Infinity) < s.date);
    return seen.filter(({ s, worth }) => worth || settles(s)).slice(0, DATED_SCAN_MAX).map(({ s }) => s.id);
  }

  async scanOffer(): Promise<{ count: number; usd: number | null }> {
    const ids = await this.scanPicks(this.host.now());
    const ai = await this.host.forTask().catch(() => null);
    const price = ai && !ai.local ? priceOf(ai.model) : null;
    return { count: ids.length, usd: ai?.local ? 0 : price ? costAt(price, SCAN_TOKENS) * ids.length : null };
  }

  /** Once: the offer's answer (`scanAnswered`, written by the window that asked) ends it, so nothing is read twice. */
  async scan(): Promise<number> {
    if (!this.isActive || (await this.host.settings()).dated.scanAnswered) return 0;
    const now = this.host.now();
    const ids = await this.scanPicks(now);
    const queued = await this.host.store.dated.marks.queueScan(ids, now);
    this.wake();
    return queued;
  }

  status(): { blockedBy: { kind: AiErrorKind; message: string } | null } {
    return { blockedBy: this.paused };
  }

  /** Clear AI data: nothing in flight may bring back what was cleared. */
  async clear(): Promise<void> {
    this.generation.abort();
    this.generation = new AbortController();
    await this.host.store.dated.clear();
    this.host.changed();
  }
}

