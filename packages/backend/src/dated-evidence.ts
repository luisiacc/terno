import { normalizeText, saysClock, saysDay } from "@terno/core";

/**
 * Plan 210, the Codex review of iteration 1 (revisions 2 and 3): what ties the reader's words to one obligation. A quote that's
 * in the mail proves only that the mail says it; these say which thing it's about: the sentence it's in, the words that name
 * a thing (never the day, a greeting or a verb any request has), and whether the sentence talks to the app instead of the
 * reader. Pure, en and es.
 */

/**
 * Normalized, as a person retyping it would: a quote must really be in the mail. Punctuation is left out (the eval: a
 * model joins two lines with a period, "Amount due: $84.20. Please pay by…"); the words, their order and the digits stay.
 */
export const norm = (text: string) => normalizeText(text).toLowerCase().replace(/[^\p{L}\p{N}$€£%]+/gu, " ").trim();

/** The mail's sentences, as written and as `norm` reads them: a decimal point or an "a.m." inside a line doesn't end one. */
export type Sentences = readonly { said: string; read: string }[];
export function sentencesOf(text: string): Sentences {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((said) => ({ said: said.trim(), read: norm(said) }))
    .filter((s) => s.read);
}

/** The mail's paragraphs, the same way: where a "before then" finds its day ("meets Monday the 16th. Could you get them to me before then?"). */
export function paragraphsOf(text: string): Sentences {
  return text
    .split(/\n\s*\n/u)
    .map((said) => ({ said: said.trim(), read: norm(said) }))
    .filter((s) => s.read);
}

/** Which of the mail's sentences a quote is in: the one it's inside, or the ones inside it (a quote across two). */
export function sentencesWith(quote: string, sentences: Sentences): number[] {
  const q = norm(quote);
  if (!q) return [];
  return sentences.flatMap((s, i) => (s.read.includes(q) || q.includes(s.read) ? [i] : []));
}

/** The words around a quote, as written: its sentences, or the quote itself when none holds it (the subject, a quote joined). */
export function contextOf(quote: string, sentences: Sentences): string {
  const at = sentencesWith(quote, sentences);
  return at.length ? at.map((i) => sentences[i]!.said).join(" ") : quote;
}

// what never names a thing: function words, greetings, the verbs any request has, and days (a date is in both by chance)
const STOP = new Set(
  (
    "about after again also already before being been both could dear does from have hello here just more much need needs only other " +
    "please regards should since some still than thank thanks that their them then there these they this those what when where which " +
    "while will with would your yours youre " +
    "send sign submit return reply answer confirm bring fill enter upload complete make take give share know tell sure call " +
    "today tomorrow tonight week weekend month year morning afternoon evening noon days " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october " +
    "november december " +
    "para pero como esta este esto estos estas gracias hola saludos favor puedes podrias sobre desde hasta cuando donde porque todo " +
    "todos tambien ahora antes despues tienes tiene necesito quiero nuestro nuestra usted ustedes " +
    "enviar envia enviame mandar mandame firmar responder confirmar traer llenar subir completar entregar llamar decir " +
    "manana semana tarde noche lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio " +
    "agosto septiembre octubre noviembre diciembre"
  ).split(" "),
);

/** "receipts" and "receipt" are one word; a short one keeps its end */
const stem = (w: string) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);

// Plan 210 (iteration 3, revision 5): a currency amount, read whole before the words are split ("$8,432.17", "US$29",
// "MX$450", "€5.862,00", "1.105,00 €", "29 USD"), or a number grouped in thousands with cents ("8,432.17") alone
const NUMBER = String.raw`\d{1,3}(?:[,.  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const AMOUNT = new RegExp(
  [
    String.raw`(?:\b[A-Z]{2,3})?[$€£]\s?(?:${NUMBER})(?:\s?[A-Z]{3}\b)?`,
    String.raw`(?<![\p{L}\p{N}.,])(?:${NUMBER})\s?(?:[€£$]|(?:USD|EUR|MXN|GBP|CAD|AUD|pesos|d[oó]lares|dollars|euros)\b)`,
    String.raw`(?<![\p{L}\p{N}.,$€£])(?:\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:\.\d{3})+,\d{2})(?![\p{N}])`,
  ].join("|"),
  "gu",
);
/** An amount as one token, its value whatever the separators ("$8,432.17" and "8.432,17 €" are "¤8432.17", "$1,105.00" "¤1105"). */
function amountToken(raw: string): string {
  const digits = raw.replace(/[^\d.,]/gu, "");
  // the last separator is the decimal point when one or two digits follow it, else every separator groups thousands
  const last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  const decimal = last >= 0 && /^\d{1,2}$/u.test(digits.slice(last + 1));
  const whole = (decimal ? digits.slice(0, last) : digits).replace(/[.,]/gu, "");
  const cents = decimal ? digits.slice(last + 1).padEnd(2, "0") : "00";
  return `¤${Number(whole)}${cents === "00" ? "" : `.${cents}`}`;
}

/**
 * The amounts some text states, each as one token (`amountToken`). Plan 210 (the second morning, Margaret's water bill): a
 * zero ("Balance remaining: $0.00", "Saldo: $0.00") names no bill or payment, so it's never another amount than the item's.
 */
export function amountsOf(text: string): Set<string> {
  return new Set([...text.matchAll(AMOUNT)].map((m) => amountToken(m[0])).filter((a) => a !== "¤0"));
}

/**
 * The words that name a thing in some text: four letters or more and not in `STOP`, a currency amount whole ("¤8432.17",
 * never "432" and "17": plan 210, iteration 3), or another number of three characters or more that isn't a year ("2231").
 * `names: false` leaves out a capitalized word past the first, a name, so two requests to Mariana aren't one thing because
 * both say "Mariana".
 */
export function namingWords(text: string, o: { names: boolean } = { names: true }): Set<string> {
  const out = amountsOf(text);
  text.replace(AMOUNT, " ").split(/[^\p{L}\p{M}\p{N}$€£]+/u).filter(Boolean).forEach((raw, i) => {
    const w = normalizeText(raw).replace(/[^\p{L}\p{N}$€£]/gu, "");
    if (!w) return;
    if (/\d/.test(w)) {
      if (w.replace(/[$€£]/g, "").length >= 3 && !/^(?:19|20)\d\d$/.test(w)) out.add(w);
      return;
    }
    if (w.length < 4 || STOP.has(w)) return;
    if (!o.names && i > 0 && /^\p{Lu}/u.test(raw)) return;
    out.add(stem(w));
  });
  return out;
}

const shares = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].some((w) => b.has(w));
/** an identifier: a number of three digits or more that isn't an amount (`amountsOf`'s are whole) or a year ("invoice 1001", "order BD-55018") */
const idsOf = (words: ReadonlySet<string>) => new Set([...words].filter((w) => /^\d+$/.test(w)));
/** the words of an item that can name it: its text's and quote's, without the sender's own name (in every mail they send) */
const itemWords = (item: { text: string; quote: string }, from: string) => {
  const sender = namingWords(from);
  return new Set([...namingWords(`${item.text}\n${item.quote}`)].filter((w) => !sender.has(w)));
};

/**
 * Whether some words name the item: a word of its text or quote in them ("the electricity bill", "invoice 2231"). The
 * sender's own name ("Brightline", in every mail they send) says who, not which of their things: it's left out.
 */
export function namesItem(item: { text: string; quote: string }, words: string, from = ""): boolean {
  return shares(itemWords(item, from), namingWords(words));
}

/**
 * Plan 210 (iteration 5's code review): the nouns any bill, plan or deadline has ("invoice", "payment", "the due date"): a
 * shared one says nothing about which. Stemmed as `namingWords` reads them.
 */
const GENERIC = new Set(
  (
    "invoice bill statement payment balance amount total account premium plan subscription membership renewal date deadline " +
    "minimum order full paid factura recibo cuenta saldo importe monto cuota prima plazo fecha vencimiento suscripcion " +
    "membresia renovacion pedido pago pagada pagado"
  ).split(" "),
);

/**
 * Plan 210 (iteration 5's code review, points 1 and 3): words that name this item apart from any other of its kind: an
 * identifier or an amount of its own, or a word of its that isn't a generic noun ("Northwind's invoice 2231", "the lease",
 * "The Lighthouse Keeper's Daughter"), never "your invoice" or "the due date" alone. The sender's name is no one's word.
 */
export function namesSpecifically(item: { text: string; quote: string }, words: string, from = ""): boolean {
  const said = namingWords(words);
  return [...itemWords(item, from)].some((w) => said.has(w) && !GENERIC.has(w));
}

/**
 * Plan 210 (iteration 5's code review, point 3): words that name something the item's own words don't, beyond the generic
 * nouns ("The lease renewal closes Friday" beside a report due that day; never "Payment due date:" beside a balance).
 */
export function namesOtherThan(item: { text: string; quote: string }, words: string, from = ""): boolean {
  const mine = itemWords(item, from);
  const sender = namingWords(from);
  return [...namingWords(words)].some((w) => !mine.has(w) && !sender.has(w) && !GENERIC.has(w));
}

/** The months some words name, en and es ("October", "oct", "octubre"), as numbers. */
const MONTH_WORDS: [RegExp, number][] = [
  [/^(?:jan(?:uary)?|enero|ene)$/u, 1], [/^(?:feb(?:ruary)?|febrero)$/u, 2], [/^(?:march|marzo)$/u, 3], [/^(?:april|abril|abr)$/u, 4],
  [/^mayo$/u, 5], [/^(?:june|junio)$/u, 6], [/^(?:july|julio)$/u, 7], [/^(?:august|agosto|aug)$/u, 8],
  [/^(?:sept?(?:ember)?|septiembre|setiembre)$/u, 9], [/^(?:oct(?:ober)?|octubre)$/u, 10], [/^(?:nov(?:ember)?|noviembre)$/u, 11], [/^(?:dec(?:ember)?|diciembre|dic)$/u, 12],
];
const monthsOf = (words: string) => new Set(norm(words).split(" ").flatMap((w) => MONTH_WORDS.filter(([re]) => re.test(w)).map(([, n]) => n)));

/**
 * Plan 210 (iteration 5's code review, point 1): words that name a month the item's own words don't ("Your October invoice
 * has been paid" beside November's), about another period's bill.
 */
export function otherMonths(item: { text: string; quote: string }, words: string): boolean {
  const mine = monthsOf(`${item.text}\n${item.quote}`);
  return [...monthsOf(words)].some((m) => !mine.has(m));
}

/** a day beside a month ("December 31", "Dec 4", "31st", "el 1 de diciembre"), as `norm` reads it; a year ("2026") is none */
const DAY_NUMBER = /^\d{1,2}(?:st|nd|rd|th)?$/u;
/** The months some words name as a period, not a date's ("the November electricity invoice", "la factura de diciembre"). */
function periodsOf(words: string): Set<number> {
  const ws = norm(words).split(" ");
  const out = new Set<number>();
  ws.forEach((w, i) => {
    const month = MONTH_WORDS.find(([re]) => re.test(w))?.[1];
    if (!month) return;
    const before = ws[i - 1] ?? "";
    const dated = DAY_NUMBER.test(ws[i + 1] ?? "") || DAY_NUMBER.test(before) || ((before === "of" || before === "de") && DAY_NUMBER.test(ws[i - 2] ?? ""));
    if (!dated) out.add(month);
  });
  return out;
}

/**
 * The Codex code review of round 14's faults: words that name a period the item's words don't ("Pay the December electricity
 * invoice" beside "Pay the November electricity invoice") are another period's bill, when the item names a month at all. A
 * month said as a date's ("expires Friday, December 4") is a day, not a period: the domain's renewal and its expiry stay one.
 */
export function otherPeriod(item: { text: string; quote: string }, words: string): boolean {
  const mine = monthsOf(`${item.text}\n${item.quote}`);
  return mine.size > 0 && [...periodsOf(words)].some((m) => !mine.has(m));
}

/**
 * The Codex code review of v11 (point 2): words that give an identifier the item doesn't have, and none it has ("Payment
 * received for invoice 1001" against invoice 1002), are about something else.
 */
export function otherIds(item: { text: string; quote: string }, words: string): boolean {
  const mine = idsOf(namingWords(`${item.text}\n${item.quote}`));
  const said = idsOf(namingWords(words));
  return mine.size > 0 && said.size > 0 && !shares(mine, said);
}

/**
 * The Codex code review of the second morning (point 1): words whose only amount is a zero ("Balance remaining: $0.00"),
 * which `amountsOf` leaves out, so `otherAmounts` has nothing of theirs to hold against the item's.
 */
export function zeroOnly(words: string): boolean {
  const said = [...words.matchAll(AMOUNT)];
  return said.length > 0 && said.every((m) => amountToken(m[0]) === "¤0");
}

/**
 * The Codex code review of the second morning (point 1): a zero balance names no bill, so it settles one only by the mail it's
 * in: no identifier the bill doesn't have ("Invoice 1002 … Balance remaining: $0.00" against invoice 1001), and the bill's own
 * amount or identifier stated (the City's receipt says "$58.71" beside its zero), never only another's ("Invoice: $64.58").
 * A bill that states neither has nothing to check: the other checks decide. `mail`: its subject and text.
 */
export function zeroNamesItem(item: { text: string; quote: string }, mail: string): boolean {
  const own = namingWords(`${item.text}\n${item.quote}`);
  const [amounts, ids] = [amountsOf(`${item.text}\n${item.quote}`), idsOf(own)];
  if (otherIds(item, mail)) return false;
  if (!amounts.size && !ids.size) return true;
  const said = namingWords(mail);
  return shares(amounts, said) || shares(ids, idsOf(said));
}

/**
 * Plan 210 (iteration 3, revision 5): words that state an amount the item doesn't, and none it does ("we received your
 * payment of $61.00" against a bill of $54.20), are about another payment, unless they're its receipt (`checkDates`).
 */
export function otherAmounts(item: { text: string; quote: string }, words: string): boolean {
  const mine = amountsOf(`${item.text}\n${item.quote}`);
  const said = amountsOf(words);
  return mine.size > 0 && said.size > 0 && !shares(mine, said);
}

/**
 * The Codex code review of v11 (point 2): when some words name open items, they settle or move one only when they name it
 * apart from every other they name: a word or an identifier the other lacks ("invoice 1001", "vs the Bobcats"), or its own
 * day and not the other's ("Thursday's class (November 19)"). "Payment received for your invoice" with two invoices open
 * settles neither.
 */
export function namesApart<T extends { id: number; text: string; quote: string; dueDay: string }>(item: T, named: readonly T[], words: string, from = ""): boolean {
  const said = namingWords(words);
  const mine = new Set([...itemWords(item, from)].filter((w) => said.has(w)));
  return named.every((o) => {
    if (o.id === item.id) return true;
    const theirs = itemWords(o, from);
    if ([...mine].some((w) => !theirs.has(w))) return true;
    if (item.dueDay === o.dueDay) return false;
    // a weekday names this week's and next's alike: then its date does ("Thursday's class (November 19)")
    return (saysDay(words, item.dueDay) && !saysDay(words, o.dueDay)) || (saysDay(words, item.dueDay, { weekdays: false }) && !saysDay(words, o.dueDay, { weekdays: false }));
  });
}

/**
 * Revision 3, and the Codex code review of v11 (point 4): two of the app's texts name the same thing when the words that name
 * one are all among the other's ("Send the revised budget", "Answer Mariana about the budget"), never on one shared noun
 * ("Sign the vendor contract", "Sign the employment contract" are two) and never with different identifiers. Names aside.
 */
export function sameObject(a: string, b: string): boolean {
  const wa = namingWords(a, { names: false });
  const wb = namingWords(b, { names: false });
  const [ia, ib] = [idsOf(wa), idsOf(wb)];
  if (ia.size && ib.size) return shares(ia, ib);
  if (!wa.size || !wb.size) return false;
  return [...wa].every((w) => wb.has(w)) || [...wb].every((w) => wa.has(w));
}

/**
 * Two items of one kind on one day, from one mail, are the same thing when one quote holds the other (the model quoted one
 * request twice) or their words name the same object (`sameObject`); one sentence alone is not enough ("send the deck and
 * sign the form by Friday" asks two things).
 */
export function sameThing(a: { text: string; quote: string }, b: { text: string; quote: string }): boolean {
  const qa = norm(a.quote);
  const qb = norm(b.quote);
  if (qa.split(" ").length >= 3 && qb.split(" ").length >= 3 && (qa.includes(qb) || qb.includes(qa))) return !idsDiffer(a.text, b.text);
  return sameObject(a.text, b.text);
}
const idsDiffer = (a: string, b: string) => {
  const [ia, ib] = [idsOf(namingWords(a)), idsOf(namingWords(b))];
  return ia.size > 0 && ib.size > 0 && !shares(ia, ib);
};

// The Codex code review of v11 (point 8): words addressed to a model, never a mention of one ("The AI workshop is cancelled"):
// "Assistant: …", "Note for the AI assistant: …", "«Asistente: …»", "if you are an AI…"
const AGENT = String.raw`(?:(?:ai|ia|email|e-mail)\s+)?(?:assistants?|asistentes?|chatbots?|bots?|llms?|language models?|modelos? de lenguaje|ai|ia)`;
const ADDRESSED = new RegExp(
  [
    String.raw`(?:^|[.;!?\n"“«(]\s*)(?:(?:note|message|instructions?|reminder|nota|mensaje|instrucciones|recordatorio)\s+(?:to|for|para|al?)\s+(?:\S+\s+){0,3}?)?(?:dear\s+|hey\s+|hi\s+|attention\s+|hola\s+|atencion\s+)?${AGENT}\s*[:,]`,
    String.raw`\b(?:note|message|instructions?|nota|mensaje|instrucciones)\s+(?:to|for|para)\s+(?:the\s+|any\s+|all\s+|el\s+|los\s+)?${AGENT}\b`,
    String.raw`\b(?:if you are|you are|si eres|eres)\s+(?:an?\s+|un\s+|una\s+)?${AGENT}\b`,
  ].join("|"),
  "mu",
);

// a sentence that tells the app what to do with what it holds: a label, its open items, "ignore the above", "mark … as done"
// (en, es), read as `norm` reads it
const TO_THE_APP = new RegExp(
  [
    String.raw`\b[op]\d{1,2}\b`,
    String.raw`\bopen (?:items?|tasks?)\b`,
    String.raw`\bignor\w* (?:\S+ ){0,3}?(?:previous|prior|above|earlier|instructions?|instrucciones|anteriores)\b`,
    String.raw`\b(?:mark|set|treat|flag|close|clear|consider) (?:\S+ ){0,6}?as (?:done|settled|paid|complete|completed|resolved|closed|finished|handled)\b`,
    String.raw`\b(?:marca|marcar|marque|marquen|considera|considerar|da|dar|den) (?:\S+ ){0,6}?(?:como|por) (?:hech|pagad|resuelt|complet|cerrad|terminad|atendid)\w*`,
    String.raw`\b(?:reschedule|move|push|postpone|cancel) (?:all|every|each|any) (?:\S+ ){0,3}?(?:items?|tasks?|deadlines?|reminders?|appointments?|meetings?|events?|visits?)\b`,
    String.raw`\b(?:pasa|mueve|cambia|reprograma|cancela)\w* (?:todas?|todos|cada) (?:\S+ ){0,4}?(?:tareas|pendientes|fechas|citas|recordatorios|plazos)\b`,
  ].join("|"),
  "u",
);

/** Whether some words talk to the app (or a model) about what it holds instead of saying what happened. */
export function talksToTheApp(words: string): boolean {
  return TO_THE_APP.test(norm(words)) || ADDRESSED.test(words.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
}

/** A settlement's or a move's evidence: two words at least, never in a sentence that talks to the app. */
export function plainEvidence(evidence: string, context: string): boolean {
  return norm(evidence).split(" ").length >= 2 && !talksToTheApp(context) && !talksToTheApp(evidence);
}

// what settles each kind, said plainly (en, es): a receipt, a renewal or a cancellation, a new card, a cancelled booking
const SETTLES: Partial<Record<string, RegExp>> = {
  pay: /\b(?:payment (?:was |has been )?(?:received|confirmed|processed|successful|complete)|received your payment|thank you for your payment|pago (?:recibido|confirmado|realizado|procesado)|(?:recibimos|hemos recibido) (?:tu|su) pago|gracias por (?:tu|su) pago)\b/u,
  renew: /\b(?:renewed|has been renewed|cancel\w*|renovad\w*|se renovo)\b/u,
  expire: /\b(?:renewed|updated|replaced|new card|renovad\w*|actualizad\w*|nueva tarjeta)\b/u,
  event: /\b(?:cancel\w*|reschedul\w*|reprogramad\w*)\b/u,
};
// "all accounts are paid", "every appointment is cancelled": said of everyone, it settles nobody's one thing
const BLANKET = /\b(?:all|every|everyone|everything|any|todos|todas|cada|cualquier)\b/u;

// plan 210 (iteration 3, revision 5): a receipt said not to have happened, in the three words before it ("we have not
// received your payment", "we haven't received", "no hemos recibido tu pago", "aún no recibimos tu pago"), as `norm` reads it
const NOT_YET = /\b(?:not|never|t|no|nunca|aun|todavia)\b/u;

/** Plan 210 (iteration 3): whether some words deny a receipt ("we have not received your payment"): no bill is paid by them. */
export function negatedReceipt(words: string): boolean {
  const read = norm(words);
  return [...read.matchAll(new RegExp(SETTLES.pay!.source, "gu"))].some((m) => NOT_YET.test(read.slice(0, m.index).trim().split(" ").slice(-3).join(" ")));
}

// plan 210 (round 16's code review): the payer's own word that it's paid (en, es), as `norm` reads it: "just venmo'd you",
// "paid you back", "sent you the $48.20", "ya te pagué", "te transferí", "te mandé"
const PAID = /\b(?:paid|venmo d|venmoed|zelled|zelle d|transferred|wired|sent (?:you|it|over|the|your|\$)|pague|pagado|pagada|transferi|deposite|(?:te|le|les) (?:mande|envie))\b/u;
// in the four words before it, said not to have happened, or only to come, or only if or when: "I have not paid", "haven't",
// "will have paid", "if I paid", "todavía no te pagué", "cuando te pague", "quieres que te mande"
const UNPAID = /\b(?:not|never|t|no|nunca|aun|todavia|will|ll|going|gonna|if|once|when|unless|should|would|could|need|needs|have to|si|cuando|que|hasta)\b/u;

/** Plan 210 (round 16's code review): whether your own words say you've paid (never "I have not paid", "I'll pay"). */
export function paidSaid(words: string): boolean {
  const read = norm(words);
  return [...read.matchAll(new RegExp(PAID.source, "gu"))].some((m) => !UNPAID.test(read.slice(0, m.index).trim().split(" ").slice(-4).join(" ")));
}

/** Whether some words say what settles an item of a kind, of the reader's own: "Payment received" a bill, "cancelled" a booking. */
export function settlesKind(kind: string, words: string): boolean {
  const read = norm(words);
  return (SETTLES[kind]?.test(read) ?? false) && !BLANKET.test(read) && !(kind === "pay" && negatedReceipt(words));
}

// Plan 210 (iteration 3, revision 11): a bare day of the month in a deadline clause ("books close on the 20th", "by the 20th",
// "antes del 20", "vence el 20"), never one a month names ("October 20", "the 20th of October", "20 de octubre"), a date
// written in figures or a time ("20/11", "20:00", "the 20th at 5 PM" keeps its day)
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|ene|abr|ago|dic|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
const BARE_DAY = new RegExp(
  String.raw`\b(by|due(?: on| by)?|clos(?:e|es|ing)(?: on)?|until|no later than|deadline(?: is)?|before|venc\w*(?: el)?|cierra\w*(?: el)?|cierre(?: el)?|a mas tardar(?: el)?|hasta el|antes del?|para el|limite(?: el)?)\s+(?:the\s+|el\s+|dia\s+)?(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:of\s+|de\s+)?(?:${MONTHS})\b)(?!\s*[:/.-]\d)(?!\s*(?:[ap]\.?\s?m\b|h\b|hrs?\b|horas?\b))`,
  "gu",
);
const plainWords = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const dayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/**
 * Plan 210 (iteration 3, revision 11): a deadline's day of the month read into the past, from words that give only that day
 * in a deadline clause, is the next one: Priya's "October books close on the 20th. Please add receipts by then", in a mail
 * of November 9, is November 20, never October 20 (which the checks would drop as over). A day "before" the bare day ("antes
 * del 20" read as the 19th) rolls with it. Anything else, or a day not past, is left as it came. `said`: the words around
 * the item's quote (its paragraph); `arrived`: the mail's own day, YYYY-MM-DD.
 */
export function bareDayAhead(due: string, said: string, arrived: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(due);
  const a = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(arrived);
  if (!d || !a || due >= arrived) return due;
  const day = Number(d[3]);
  for (const m of plainWords(said).matchAll(BARE_DAY)) {
    const n = Number(m[2]);
    const before = /^(?:before|antes)/u.test(m[1]!);
    if (n < 1 || n > 31 || (n !== day && !(before && n - 1 === day))) continue;
    // the next n on or after the mail's day, in a month that has it
    for (let k = 0; k < 3; k++) {
      const y = Number(a[1]);
      const mo = Number(a[2]) - 1 + (Number(a[3]) > n ? 1 : 0) + k;
      const at = dayOf(y, mo, n);
      if (Number(at.slice(8)) !== n) continue;
      const out = n === day ? at : dayOf(y, mo, n - 1);
      if (out >= arrived) return out;
    }
  }
  return due;
}

/**
 * The Codex code review of v11 (point 3): a move's evidence, in its paragraph, says the day it moves to ("Friday at the latest
 * works", "moved to the 24th", "meets Monday the 16th… before then", a day either side for "before" and another zone), or,
 * for the time alone on the item's own day, a clock time ("now at 8:00"). Never a word that only goes with dates
 * ("appointment", "payment"), as the reading filter's cues do.
 */
export function saysWhen(evidence: string, paragraph: string, to: { due: string; timeOnly: boolean }, arrivedAt: number): boolean {
  const words = `${evidence}\n${paragraph}`;
  return saysDay(words, to.due, { slack: 1, arrivedAt }) || (to.timeOnly && saysClock(words));
}

// The Codex code review of v11 (point 5): words that put one thing in another's place (en, es)
const REPLACES = /\b(?:skip|instead|rather than|in place of|in its place|forget (?:about )?|never mind|scrap|no longer need|don'?t need|en (?:lugar|vez) de|olvid\w*|ya no (?:hace falta|necesito|es necesari\w*)|no hace falta|dejemos|deja de lado)\b/u;

/** Whether some words say a thing replaces another ("skip the piecemeal version: send me the full draft", "olvidemos…"). */
export function saysReplaced(words: string): boolean {
  return REPLACES.test(norm(words));
}

// plan 210 (iteration 3, revision 4): "don't skip it", "let's not skip", "no lo olvides"; anywhere before it in its clause
const NOT_REPLACED = /^(?:not|never|t|no|ni|nunca)$/u;
const REPLACES_HERE = new RegExp(`^(?:${REPLACES.source})`, "u");
// a clause ends at a sentence's end, a line, a semicolon, a colon or a dash (never a comma: "don't, please, skip it")
const CLAUSE_END = /(?<=[.!?;:])\s+|\n+|\s[-–—]\s|[–—]/u;

/**
 * Plan 210 (iteration 3, revision 4): some words of the mail say a thing replaces another, and aren't denied ("Let's skip
 * the piecemeal version"; never "don't skip the methods section" nor "no olvides el marco teórico"). The code review of
 * iteration 3: read in the mail, where the words are, so a denial before the model's quote counts ("Don't skip the methods
 * section; please send the full draft" quoted as "skip the methods section"): each replacing word in the quote, wherever
 * the quote is, has no denial before it in its clause. Words the mail doesn't hold replace nothing. The code review's second
 * round: a denial reaches across whatever stands between ("Don't, under any circumstances, skip…", "no, de verdad, olvides…"),
 * so any denial earlier in the clause makes it ambiguous, and an ambiguous replacement replaces nothing.
 */
export function replacesPlainly(evidence: string, text: string): boolean {
  const q = norm(evidence).split(" ");
  const words = text.split(CLAUSE_END).flatMap((said, clause) => {
    const read = norm(said);
    return read ? read.split(" ").map((word) => ({ word, clause })) : [];
  });
  const at = words.flatMap((_, i) => (q[0] && q.every((w, j) => words[i + j]?.word === w) ? [i] : []));
  return (
    at.length > 0 &&
    at.every((start) => {
      const end = start + q.length;
      const replacing = words.slice(start, end).flatMap((_, k) => (REPLACES_HERE.test(words.slice(start + k, end).map((w) => w.word).join(" ")) ? [start + k] : []));
      return replacing.length > 0 && replacing.every((k) => !words.slice(0, k).some((w) => w.clause === words[k]!.clause && NOT_REPLACED.test(w.word)));
    })
  );
}

/** Whether some words are inside quotation marks in their paragraph of the mail (someone else's words, retold): “…”, "…", «…». */
export function insideQuotes(words: string, text: string): boolean {
  const flat = (t: string) => t.replace(/\s+/gu, " ").toLowerCase();
  const w = flat(words).trim();
  const paragraph = text.split(/\n\s*\n/u).map(flat).find((p) => p.includes(w));
  if (!w || !paragraph) return false;
  const before = paragraph.slice(0, paragraph.indexOf(w));
  const count = (c: string) => before.split(c).length - 1;
  return count('"') % 2 === 1 || count("“") > count("”") || count("«") > count("»");
}

/**
 * Plan 210 (iteration 4, the Codex review's revision 5): an item's quote the mail doesn't hold, verbatim, is the mail's only
 * when one span of it, and only one, says both what the quote names (every naming word of it: the action or the object) and
 * the item's day: the subject, or one sentence of the text, never joined across the two (Priya's Pagewise renewal, quoted
 * "renews on November 18, 2026" from the subject's "renews on November 18" and a body line's "November 18, 2026"). That
 * span, as written, is then the quote, and every ordinary check reads it. Null: none or several (ambiguous), a quote with no
 * naming word (a date alone), or an item with no day. Never for a settlement's, a move's or a replacement's evidence.
 */
export function quoteSpan(quote: string, due: string | null, subject: string, sentences: Sentences, arrivedAt: number): string | null {
  const named = namingWords(quote);
  if (!due || !named.size) return null;
  const spans = [subject.trim(), ...sentences.map((s) => s.said)].filter(Boolean);
  const holding = spans.filter((s) => {
    const words = namingWords(s);
    return [...named].every((w) => words.has(w)) && saysDay(s, due, { slack: 1, arrivedAt });
  });
  return new Set(holding.map(norm)).size === 1 ? holding[0]! : null;
}

/**
 * Plan 210 (iteration 4's code review): prompt v14's "a security notice … stays an alert" turned the panel's phishing into
 * alerts (Theo's "channel will be PERMANENTLY TERMINATED in 24 hours unless you verify your identity", Priya's "Failure to
 * validate within 12 hours will result in your account being suspended"). Prompt v15 makes them no item; this is the local
 * backstop, en and es: a sentence that asks to verify, validate or confirm an account, a password or an identity, to sign in
 * or to click, or that threatens a loss (deleted, suspended, terminated, blocked) still to come, within a count of hours.
 * A genuine provider's alert reports what happened ("we froze your card after a $412.18 charge") and gives a day when it
 * gives one ("by 1:00 PM on Wednesday"), never hours to comply.
 */
const WITHIN_HOURS = /\b\d{1,2} ?(?:hours?|hrs?|horas?)\b|\b\d{1,2}h\b/u;
const DEMANDS = /\b(?:verif\w*|valid[ae]\w*|revalid\w*|authenticat\w*|autentic\w*|sign ?in|log ?in|click|(?:confirm|update|re ?enter|reset) (?:your |the )?(?:account|identity|password|credentials|login|details|information)|confirm\w* (?:tu|su|tus|sus) (?:identidad|cuenta|datos|credenciales|contrasena)|inici\w* sesion|(?:haz|da|de|hacer|dar) clic)\b/u;
const LOSS = /\b(?:delet\w*|suspen\w*|terminat\w*|deactivat\w*|disabl\w*|lock\w*|block\w*|clos(?:ed|ure)|lose access|loss of|elimin\w*|borra\w*|desactiv\w*|bloque\w*|cerrad\w*|cierre|perder\w*|retenid\w*)\b/u;
const STILL_TO_COME = /\b(?:will|unless|failure|fail to|if you don t|if you do not|if not|or else|otherwise|si no|de lo contrario|a menos que|sera|seran|quedara|quedaran|se (?:eliminar|suspender|bloquear|cerrar)\w*)\b/u;
export function scamPressure(text: string): boolean {
  return sentencesOf(text).some(({ read }) => WITHIN_HOURS.test(read) && (DEMANDS.test(read) || (LOSS.test(read) && STILL_TO_COME.test(read))));
}

// Plan 210 (iteration 5, V2): an event's start in its own quote, for a model that gave none (round 13: Theo's all-hands,
// "Monday Nov 16, 2026 · 4pm – 5pm (Pacific Time)", came back with no time on v15 3 times in 5 on Luna, never on v14)
const CLOCK_12 = /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?\s?m\b\.?/giu;
const CLOCK_24 = /\b(\d{1,2}):(\d{2})\b(?!\s?[ap]\.?\s?m\b)(\s?(?:h|hrs?|horas?)\b(?!\s+(?:de|del)\b))?/giu;
/** what ends a range: "4pm – 5pm", "10:00 to 11:00", "de 9:00 a 11:00" */
const RANGE_END = /^\s*(?:[–—-]|to|until|till|a|hasta)\s*$/iu;
/** a zone the quote names that reads one way, and where */
const QUOTE_ZONES: Readonly<Record<string, string>> = {
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", mountain: "America/Denver",
  ct: "America/Chicago", cdt: "America/Chicago", central: "America/Chicago",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York",
  cet: "Europe/Paris", cest: "Europe/Paris", gmt: "UTC", utc: "UTC",
};
/** a word that names a zone: an abbreviation, a region's time, "hora de…" */
const ZONE_WORD = /\b(?:[A-Z]{1,4}T|UTC|GMT|Pacific|Mountain|Central|Eastern|Atlantic|hora (?:de|del))\b/u;

/**
 * The one time an event's quote says it starts, on the clock it names: "4pm – 5pm (Pacific Time)" is 16:00 Pacific, "at
 * 7:30 PM" 19:30 with no zone (the reader's), "19:00 h" 19:00. Null when it says none, two, a bare "7:00" (morning or
 * evening?), or a zone that reads two ways ("CST", "IST") or isn't a region's ("hora de Lima").
 */
export function startClock(quote: string): { time: string; zone: string | null } | null {
  const found: { at: number; end: number; h: number; m: number }[] = [];
  for (const c of quote.matchAll(CLOCK_12)) {
    const h = Number(c[1]);
    if (h < 1 || h > 12) return null;
    found.push({ at: c.index, end: c.index + c[0].length, h: (h % 12) + (c[3]!.toLowerCase() === "p" ? 12 : 0), m: Number(c[2] ?? 0) });
  }
  for (const c of quote.matchAll(CLOCK_24)) {
    if (found.some((f) => c.index >= f.at && c.index < f.end)) continue;
    const h = Number(c[1]);
    const m = Number(c[2]);
    if (h > 23 || m > 59) return null;
    // "7:00" alone could be morning or evening; "07:00", "19:00" or "7:00 h" says which
    if (h < 13 && !c[1]!.startsWith("0") && !c[3]) return null;
    found.push({ at: c.index, end: c.index + c[0].length, h, m });
  }
  found.sort((a, b) => a.at - b.at);
  // a window is no start: "between 12 and 2 PM", "12–2 PM" (its start said with no clock of its own), "entre las 9:00 y las 14:00"
  if (/\b(?:between|entre|window|ventana)\b/iu.test(quote) || found.some((f) => /(?<![:\d])\b\d{1,2}\s*(?:[–—-]|to|a|and|y)\s*$/iu.test(quote.slice(0, f.at)))) return null;
  // a range's end is no second start
  const starts = found.filter((f, i) => i === 0 || !RANGE_END.test(quote.slice(found[i - 1]!.end, f.at)));
  if (starts.length !== 1) return null;
  const s = starts[0]!;
  const named = ZONE_WORD.exec(quote.slice(found.at(-1)!.end));
  const zone = named ? (QUOTE_ZONES[named[0].toLowerCase()] ?? null) : null;
  if (named && !zone) return null;
  return { time: `${String(s.h).padStart(2, "0")}:${String(s.m).padStart(2, "0")}`, zone };
}
