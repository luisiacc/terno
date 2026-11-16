import { AiError, DATED_PROMPT_VERSION, DATED_SUBJECT_CHARS, DATED_TEXT_CHARS, costAt, datedBudget, fitDates, priceOf, type AiTasks, type DatedResult } from "@terno/ai";
import { addressKey, canLapse, lapsesUnlessRenewed, localDay, needsPresence, saysNoReplyNeeded, DATED_ITEMS_MAX, DATED_KINDS, DATED_OPEN_SHOWN, followupDue, validFollowupDate, type FollowupRow, DATED_SCAN_DAYS, DATED_SCAN_MAX, datedOver, dayKeyOf, datedTiming, dayEnd, hasTimeCue, normalizeText, withoutQuotes, type AiErrorKind, type DatedKind, type DatedRow } from "@terno/core";
import { captureError } from "@terno/core/diag";
import type { AppSettings } from "@terno/core/rpc";
import { DEFAULT_LOCALE, isLocaleId, L, type LocaleId } from "@terno/i18n";
import { readNothingAsked, type DatedMark, type DatedSource, type DatedWrite, type MailStore } from "@terno/store";
import { DailyLimitError, MonthlyLimitError } from "./ai-limiter";
import { UI_LOCALE_KEY } from "./forwarding";
import { bareDayAhead, contextOf, insideQuotes, type Sentences, namesApart, namesItem, negatedReceipt, norm, otherAmounts, otherIds, paragraphsOf, plainEvidence, replacesPlainly, sameObject, sameThing, saysReplaced, saysWhen, sentencesOf, settlesKind } from "./dated-evidence";
import { untrustedSenders, withoutUntrusted } from "./suspicious-sender";

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
const TWO_A_DAY: ReadonlySet<string> = new Set(["respond", "event", "delivery"]);

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
 * (`senderIsPerson`, never a list, bulk or no-reply address), and the reader addressed in To or named where the mail asks.
 * The seventh panel round: never one the mail addresses by name to another of its recipients ("Oren, could you send me the
 * contract?" to Oren and the reader), unless it names the reader there too. `said` is the mail as `norm` reads it, `text` as
 * it was written; `others` the other recipients' names, never an address.
 */
function askAllowed(quote: string, said: string, text: string, o: { sender?: { person: boolean }; reader?: { name: string; addressed: "to" | "cc" | "none" }; others?: readonly string[] }): boolean {
  if (!o.sender?.person || !o.reader || toAnother(quote, text, o.reader.name, o.others)) return false;
  if (o.reader.addressed === "to") return true;
  const q = norm(quote);
  const at = said.indexOf(q);
  const where = ` ${at < 0 ? q : said.slice(Math.max(0, at - NAMED_BEFORE_CHARS), at + q.length)} `;
  return nameWords(o.reader.name).some((w) => where.includes(` ${w} `));
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
 */
const COURTESY_IF = /\b(?:if (?:something|anything)(?: s| is)? (?:in the way|comes up)|si algo te lo impide|si surge algo|when(?:ever)? you(?: re| are)? (?:come|coming|visit|visiting|next in|in town|back|around|passing through|pass through|over here|here)|if you(?: re| are)? ever (?:in|around|back|over|passing|here)|next time you(?: re| are)? (?:in|around|here|over|back)|if you (?:ever )?need (?:anything|something|a hand|help)|cuando (?:vengas|vengan|pases|pasen|estes|esten|andes|regreses|vuelvas)|si (?:vienes|pasas|andas|estas por)|la proxima vez que (?:vengas|pases|estes)|si (?:necesitas|ocupas) (?:algo|cualquier cosa|ayuda))\b/u;
const LET_KNOW = /\b(?:let (?:me|us) know|tell me|dimelo|give (?:me|us) a (?:shout|call|ring|heads up)|drop (?:me|us) a line|avisa(?:me|nos)|me avisas|nos avisas|dime|escribe(?:me|nos)|llama(?:me|nos))\b/u;
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
export function courtesyOnly(sentence: string): boolean {
  if (/[?¿]/u.test(sentence)) return false;
  const read = norm(sentence);
  return COURTESY_IF.test(read) && LET_KNOW.test(read) && !ASKS_MORE.test(read.replace(COURTESY_IF, " ").replace(LET_KNOW, " ")) && sentence.split(/[.,;:!\n]/u).every((clause) => noticeOnly(norm(clause)));
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
 * Plan 210 (iteration 3): the sender saying what they can do, with nothing to answer ("Can you set that up? I can prep the
 * usage story": the request is the reader's, the offer is no ask), unlike an offer that waits on the reader's yes ("…just
 * let me know"). Haiku took Nina's 1 in 1 after v13 named concrete offers as asks.
 */
function selfOffer(sentences: string, paragraph: string): boolean {
  return !/[?¿]/u.test(sentences) && OFFERS.test(norm(sentences)) && !LET_KNOW.test(norm(paragraph));
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
 * The seventh panel round (revision 7): an ask, or the request it turns into with a day, never asks the reader to send a
 * password, a one-time code, an account, card or routing number, or an ID (en, es), whatever the model made of it: read
 * on its words and its quote. Pure.
 */
export function asksForSecrets(item: { text: string; quote: string }): boolean {
  return ASKS_FOR_SECRETS.test(`${item.text}\n${item.quote}`.normalize("NFD").replace(/\p{M}/gu, ""));
}

type Move = Omit<DatedResult["moved"][number], "text" | "textEvidence"> & Partial<Pick<DatedResult["moved"][number], "text" | "textEvidence">>;

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
 * A promise's new day from its person's mail (the second panel round), and (plan 210, iteration 2) its time: the move's own
 * (already in the reader's zone, as every move's), else, for a promise with a stated time, its clock as it was, on the new
 * day (Codex code review: never its words' clock read again on a day already converted); and, when that mail came after its
 * day was over, the day it had (`brokenDueAt`: its row keeps saying "You said Tue 10 (missed)").
 */
function movedPromise(p: { dueAt?: number; dated?: boolean; timed?: boolean }, day: string, time: string | null, arrivedAt: number): { dueAt: number; timed: boolean; brokenDueAt: number | null } {
  const due = followupDue({ kind: "promise", sentAt: arrivedAt, due: day, nudgeAfterDays: 0 });
  const broken = p.dated && p.dueAt !== undefined && dayEnd(dayKeyOf(p.dueAt)) <= arrivedAt ? p.dueAt : null;
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
export function checkDates(result: { items: readonly (Omit<DatedResult["items"][number], "kind"> & { kind: string })[]; settled: DatedResult["settled"]; moved?: readonly Move[]; replaced?: DatedResult["replaced"] }, input: { text: string; subject: string; arrivedAt: number; open: ReadonlyMap<string, DatedRow>; promises?: ReadonlyMap<string, Pick<FollowupRow, "id" | "revision"> & Partial<Pick<FollowupRow, "text" | "dueAt" | "dated" | "timed">>>; fromScan: boolean; now: number; sender?: { person: boolean }; reader?: { name: string; addressed: "to" | "cc" | "none" }; others?: readonly string[]; threadId?: number; senderKey?: string; from?: string; paysInThread?: number }): { rows: DatedWrite[]; settled: { id: number; revision: number }[]; moved: { id: number; dueDay: string; dueAt: number; timed: boolean; actAt: number; text?: string }[]; movedPromises: { id: number; revision: number; dueAt: number; timed: boolean; brokenDueAt: number | null }[]; replaced: { id: number; revision: number; item: number }[]; asked: boolean } {
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
    // plan 210 (iteration 3, revision 5): paid is paid, narrowly. A receipt said not to have happened settles no bill; one
    // naming another amount settles it only as its own sender's receipt in its own conversation, the one open bill there
    // (counted in the store: Diego's card read as its $1,105.00 minimum, paid with "Recibimos tu pago por $8,432.17")
    if (!move && row.kind === "pay" && negatedReceipt(`${evidence}\n${context}`)) return false;
    const receipt = !move && row.kind === "pay" && input.threadId !== undefined && row.threadId === input.threadId && row.senderKey === input.senderKey && input.paysInThread === 1 && settlesKind("pay", `${evidence}\n${context}`);
    if (otherAmounts(row, context) && !receipt) return false;
    const named = [...input.open.values()].filter((r) => namesItem(r, context, input.from));
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
  const settled = result.settled.flatMap((s) => {
    const row = input.open.get(s.label);
    return row && tiedTo(row, s.evidence, null) ? [{ id: row.id, revision: row.revision }] : [];
  });
  // after the panel: a new day for an open item, quoted, from this message's own day; one it settles isn't moved
  const settledIds = new Set(settled.map((s) => s.id));
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
    const request = { kind: "respond" as const, text: newWords(m) ?? row.text, quote: m.evidence, due: m.due, time: m.time };
    // revision 7: a request for credentials or an ID neither becomes one nor answers the ask, which stays as it was; nor
    // does one the mail addresses to another of its recipients (the seventh panel round)
    if (refused(request)) continue;
    settled.push({ id: row.id, revision: row.revision });
    settledIds.add(row.id);
    answered.push(request);
  }
  const moved = (result.moved ?? []).flatMap((m) => {
    const row = input.open.get(m.label);
    if (!row || row.kind === "ask" || settledIds.has(row.id) || !tiedTo(row, m.evidence, { due: m.due, timeOnly: m.due === row.dueDay && !!m.time })) return [];
    const timing = datedTiming({ kind: row.kind, due: m.due, time: m.time, arrivedAt: input.arrivedAt });
    // the fourth panel round (revision 5): a new moment on the same day moves it too ("the game is moved earlier to 8:00");
    // the same day with no time keeps the item's own; an untimed item's 9:00 is a default, so "at 9:00" gives it a time
    const changed = timing && (timing.dueDay !== row.dueDay || (timing.timed && (!row.timed || timing.dueAt !== row.dueAt)));
    if (!changed) return [];
    const text = newWords(m);
    return [{ id: row.id, kind: row.kind, dueDay: timing.dueDay, dueAt: timing.dueAt, timed: timing.timed, actAt: timing.actAt, ...(text ? { text } : {}) }];
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
  const promiseMove = (m: Pick<Move, "label" | "due" | "time" | "evidence">) => {
    const p = input.promises?.get(m.label);
    if (!p || !tiedTo(null, m.evidence, { due: m.due, timeOnly: false })) return [];
    if (offered.length > 1) {
      const context = contextOf(m.evidence, sentences);
      const named = offered.filter((o) => namesItem(o, context, input.from));
      const mine = offered.find((o) => o.id === p.id)!;
      if (!named.some((o) => o.id === p.id) || !namesApart(mine, named, context, input.from)) return [];
    }
    const day = validFollowupDate(m.due, input.arrivedAt);
    return day ? [{ p, day, time: m.time ?? null, evidence: m.evidence }] : [];
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
    const request = result.items.find((i) => (i.kind === "respond" || i.kind === "ask") && !!i.due && sameObject(i.text, p.text!) && !saysReplaced(contextOf(i.quote, paragraphs)));
    return request ? promiseMove({ label, due: request.due!, time: request.time, evidence: request.quote }) : [];
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
    const sameDay = result.items.filter((i) => (i.kind === "respond" || (i.kind === "ask" && !!i.due)) && i.due === m.day);
    const naming = sameDay.filter((i) => sameObject(i.text, words));
    if (naming.length) for (const i of naming) promised.add(i);
    else if (sameDay.some((i) => saysReplaced(`${contextOf(i.quote, paragraphs)}\n${contextOf(m.evidence, paragraphs)}`))) replaced.add(m);
  }
  // plan 210 (iteration 3, point 7): a person's offer that waits on the reader's yes is an ask, never a request with a day
  const candidates = [...answered, ...result.items].filter((i) => !refused(i) && !promised.has(i)).map((i) => (i.kind === "respond" && input.sender?.person && offerOnly(`${i.quote}\n${contextOf(i.quote, sentences)}`, contextOf(i.quote, paragraphs)) ? { ...i, kind: "ask", due: null, time: null } : i));
  // the eval: a person's request with a day is the `respond`, never also an undated ask beside it for the same thing; an ask
  // about something else stays (plan 210, the Codex review of iteration 1, revision 3)
  const requests = candidates.filter((i) => (i.kind === "respond" || datedAsk(i)) && quoted(i.quote));
  const requested = (ask: { text: string; quote: string }) => requests.some((r) => sameThing(r, ask));
  // the fourth panel read: a person who says no answer is needed ("No need to reply now") asks nothing
  const noReply = saysNoReplyNeeded(input.text);
  // plan 210 (iteration 3, point 7): an automated sender's mail that cancels the reader's appointment may ask them to book again
  const cancelled = [...input.open.values()].some((r) => r.kind === "event" && settledIds.has(r.id)) || CANCELLED.test(norm(input.text));
  const rebooks = (ask: { quote: string }) => cancelled && input.reader?.addressed === "to" && REBOOK.test(norm(contextOf(ask.quote, sentences)));
  let asked = false;
  for (const item of candidates) {
    if (!KINDS.has(item.kind) || !item.text.trim() || !quoted(item.quote)) continue;
    // an ask is never a dated kind's substitute: one with a day is a request with a day, if it's an ask at all
    if (item.kind === "ask" && item.due && !datedAsk(item)) continue;
    const kind = (item.kind === "ask" && item.due ? "respond" : item.kind) as DatedKind;
    // plan 210 (iteration 3): an offer is its own question, never hidden by a request about the same papers
    const around = `${item.quote}\n${contextOf(item.quote, sentences)}`;
    if (kind === "ask" && ((requested(item) && !offerOnly(around, contextOf(item.quote, paragraphs))) || noReply || onlyTells(item.quote) || onlyTells(contextOf(item.quote, sentences)) || courtesyOnly(around) || selfOffer(around, contextOf(item.quote, paragraphs)) || !(askAllowed(item.quote, said, input.text, input) || rebooks(item)))) continue;
    // plan 210 (the Codex code review of iteration 2): a request of the reader, kept below or not (a day already past or
    // over in a scan, a duplicate, past the bound): never "nothing asked"
    if (kind === "ask" || kind === "respond") asked = true;
    // plan 210 (iteration 3, revision 11): a deadline's bare day of the month read into the past is the next one
    const due = item.due && (kind === "respond" || kind === "pay") ? bareDayAhead(item.due, contextOf(item.quote, paragraphs), dayKeyOf(input.arrivedAt)) : item.due;
    const timing = datedTiming({ kind, due, time: item.time, arrivedAt: input.arrivedAt });
    if (!timing) continue;
    // the 14-day check keeps nothing already over (§6)
    if (input.fromScan && timing.dated && dayEnd(timing.dueDay) <= input.now) continue;
    // the bound, after a request past it is still known
    if (rows.length >= DATED_ITEMS_MAX) continue;
    const key = itemKey(kind, timing);
    if (movedKeys.has(key)) continue;
    if (rows.some((r) => itemKey(r.kind, r) === key && (!TWO_A_DAY.has(kind) || sameThing(r, item)))) continue;
    // plan 210 (iteration 3, revision 11): facts from the mail's words around the quote (its paragraph, bounded), never the item's
    const words = `${contextOf(item.quote, paragraphs).slice(0, FACT_WORDS_MAX)}\n${item.quote}`;
    rows.push({ kind, item: rows.length, text: item.text.trim(), quote: item.quote.trim(), ...timing, ...(shownEarly(kind, item, words, said, input) ? { early: true } : {}), ...(canLapse(kind) && lapsesUnlessRenewed(words) ? { lapses: true } : {}) });
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
  const movedPromises = promiseMoves.filter((m) => !replaced.has(m) && !gone.has(m.p.id)).map(({ p, day, time }) => ({ id: p.id, revision: p.revision, ...movedPromise(p, day, time, input.arrivedAt) }));
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
  private leaving: { messageId: number; threadId: number; senderKey: string; date: number; open: readonly number[]; stop: AbortController } | null = null;

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
    if (!src || src.spam || src.trash || src.threadSpam || src.threadId !== leaving.threadId) return leaving.stop.abort();
    // Codex code review: the open items it carries are material too; one whose conversation went to Spam stops it
    if (!leaving.open.length) return;
    const still = new Set((await store.dated.openFor({ threadId: leaving.threadId, senderKey: leaving.senderKey, before: leaving.date, limit: DATED_OPEN_SHOWN })).map((r) => r.id));
    if (leaving.open.some((id) => !still.has(id))) leaving.stop.abort();
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
    const over = (await store.dated.active()).filter((r) => datedOver(r, now));
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
    // after the fourth panel round: a sender named like a security desk is read for nothing (no item, settlement or move),
    // unless you've written to them (Codex's second pass)
    if ((await untrustedSenders([src.fromEmail], (keys) => store.dated.written(keys))).size) return drop();
    if (heldSenders.has(src.senderKey)) return { hold: src.senderKey };
    // what came before it went on is read only with the check's yes
    if (mark.source === "live" && settings.dated.enabledAt !== null && src.date < settings.dated.enabledAt) return drop();
    // revision 5: what could settle an open item is read before any cost filter
    const open = await store.dated.openFor({ threadId: src.threadId, senderKey: src.senderKey, before: src.date, limit: DATED_OPEN_SHOWN });
    if (!open.length && (src.tab === "social" || src.tab === "promotions")) return drop();
    if (src.bodyState !== "full" && !src.bodyUnavailable) return { hold: src.senderKey };
    const { text, whole } = await this.text(src);
    // a cost filter, not a judgment (§3): a person's mail is read whatever its words
    if (!open.length && src.automated && !hasTimeCue(text, src.subject)) return drop();
    if (!text.trim() && !src.subject.trim()) return drop();
    const asked = this.host.begin(`dated:${mark.messageId}`, "dated-worker");
    const stop = new AbortController();
    this.leaving = { messageId: src.id, threadId: src.threadId, senderKey: src.senderKey, date: src.date, open: open.map((r) => r.id), stop };
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
      const reader = { name: (await store.accounts.get(src.accountId))?.displayName ?? "", addressed: src.readerIn };
      // the seventh panel round: the mail's other recipients, by name, for an ask addressed to one of them ("Oren, could you…")
      const own = new Set((await store.accounts.list()).map((a) => addressKey(a.email)));
      const others = [...src.to, ...src.cc].filter((p) => !own.has(addressKey(p.email))).map(nameOf);
      // the third panel round: "a person" as the ask's local check reads it (a role address you never wrote to isn't one)
      const input = fitDates({ text, subject: src.subject, from: { name: src.fromName || src.fromEmail.split("@")[0]!, automated: src.automated || !src.person }, reader, to: src.to.map(nameOf), cc: src.cc.map(nameOf), receivedAt: inWords(src.date, language), zone: readerZone(), open: [...[...labels].map(([label, r]) => ({ label, kind: r.kind as DatedKind | "promise", text: r.text, due: r.dated ? r.dueDay : null, time: r.timed ? clockOf(r.dueAt) : null })), ...[...promises].map(([label, p]) => ({ label, kind: "promise" as const, text: p.text, due: p.dated ? dayKeyOf(p.dueAt) : null }))], language, outputTokens: budget.outputTokens }, budget.promptChars);
      // a change of provider or key, the setting, Spam meanwhile: each stops it, at the provider too
      const signal = AbortSignal.any([generation.signal, asked.signal, stop.signal]);
      if (signal.aborted) return await drop();
      const result = await ai.readDates(input, signal);
      if (signal.aborted) throw new AiError(L("errors.ai.cancelled"), "cancelled");
      const fromScan = mark.source === "scan";
      const now = this.host.now();
      // only what was really sent, after fitting to the window, may be named back (Codex review)
      const sent = new Set(input.open.map((o) => o.label));
      // plan 210 (iteration 3, revision 5): a receipt's one bill is counted in the store, never among the labels sent; read
      // only when the model settled something
      const paysInThread = result.settled.length ? (await store.dated.ofThread(src.threadId)).filter((r) => r.kind === "pay").length : 0;
      const checked = checkDates(result, { text, subject: src.subject, arrivedAt: src.date, open: new Map([...labels].filter(([l]) => sent.has(l))), promises: new Map([...promises].filter(([l]) => sent.has(l))), fromScan, now, sender: { person: src.person }, reader, others, threadId: src.threadId, senderKey: src.senderKey, from: input.from.name, paysInThread });
      // plan 210 (iteration 2, the Codex code review): "nothing asked" only of a message the model saw all of (never one cut
      // to the window or the reader's limit, nor a subject past what's sent), and in which the checks found no request at all
      const readWhole = whole && text.length <= DATED_TEXT_CHARS && input.text === text && src.subject.length <= DATED_SUBJECT_CHARS;
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
      return "next";
    } catch (error) {
      // Spam or Trash meanwhile: never asked about again; an open item gone to Spam: asked again without it
      if (stop.signal.aborted) {
        const now = await store.dated.source(src.id);
        if (now && !now.spam && !now.trash && !now.threadSpam && now.threadId === src.threadId) {
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

  private async failed(mark: DatedMark, error: unknown): Promise<"next" | "stop"> {
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
        await store.dated.marks.consume(mark.messageId);
        return "next";
      case "rate_limited":
      case "unavailable":
      case "timeout": {
        const tries = (this.attempts.get(mark.messageId) ?? 0) + 1;
        if (tries >= MAX_ATTEMPTS) {
          this.attempts.delete(mark.messageId);
          await store.dated.marks.consume(mark.messageId);
        } else this.attempts.set(mark.messageId, tries);
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
    return [...(await withoutUntrusted(rows, (keys) => dated.written(keys)))];
  }

  // ─── §6: the one-time check ──────────────────────────────────────────────

  /**
   * Codex code review: the check's messages are those the reader would ask about, chosen before its bound: newest first,
   * not Spam, Trash, Promotions or Social, and automated mail only with a time cue. Walked in the backend's slices.
   */
  private async scanPicks(now: number): Promise<number[]> {
    const { store } = this.host;
    const walked = await store.dated.scanCandidates(now - DATED_SCAN_DAYS * 86_400_000, SCAN_WALK);
    // newest first: whether each is worth reading by itself, and who and where it's from
    const seen: { s: DatedSource; worth: boolean }[] = [];
    await this.host.runBudgeted(walked, async (chunk) => {
      const sources = (await Promise.all(chunk.map((id) => store.dated.source(id)))).filter((s): s is DatedSource => !!s && !s.spam && !s.trash && !s.threadSpam && !s.draft && !s.sent && !s.own && s.tab !== "social" && s.tab !== "promotions");
      // round 2: a body not here yet can't be judged; it's read, and the worker waits for it (the filter errs towards reading)
      const judged = sources.filter((s) => s.automated && (s.bodyState === "full" || s.bodyUnavailable));
      const texts = judged.length ? await store.aiSummaries.text(judged.map((s) => ({ messageId: s.id, limit: DATED_TEXT_CHARS }))) : new Map<number, string | null>();
      for (const s of sources) seen.push({ s, worth: !s.automated || (s.bodyState !== "full" && !s.bodyUnavailable) || hasTimeCue(withoutQuotes(texts.get(s.id) ?? ""), s.subject) });
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

