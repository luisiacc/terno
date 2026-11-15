import { hasTimeCue, normalizeText } from "@terno/core";

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

/**
 * The words that name a thing in some text: four letters or more and not in `STOP`, or a number of three characters or more
 * that isn't a year ("$54", "2231"). `names: false` leaves out a capitalized word past the first, a name, so two requests to
 * Mariana aren't one thing because both say "Mariana".
 */
export function namingWords(text: string, o: { names: boolean } = { names: true }): Set<string> {
  const out = new Set<string>();
  text.split(/[^\p{L}\p{M}\p{N}$€£]+/u).filter(Boolean).forEach((raw, i) => {
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

/**
 * Whether some words name the item: a word of its text or quote in them ("the electricity bill", "invoice 2231"). The
 * sender's own name ("Brightline", in every mail they send) says who, not which of their things: it's left out.
 */
export function namesItem(item: { text: string; quote: string }, words: string, from = ""): boolean {
  const sender = namingWords(from);
  return shares(new Set([...namingWords(`${item.text}\n${item.quote}`)].filter((w) => !sender.has(w))), namingWords(words));
}

/**
 * Revision 3: two items of one kind on one day, from one mail, are the same thing when they quote the same sentence or their
 * words name the same thing ("Send the revised budget", "Answer Mariana about the budget"); "send the deck Friday" and "sign
 * the form Friday" are two.
 */
export function sameThing(a: { text: string; quote: string }, b: { text: string; quote: string }, sentences: Sentences): boolean {
  const at = new Set(sentencesWith(a.quote, sentences));
  if (sentencesWith(b.quote, sentences).some((i) => at.has(i))) return true;
  const qa = norm(a.quote);
  const qb = norm(b.quote);
  if (qa && qb && (qa.includes(qb) || qb.includes(qa))) return true;
  return shares(namingWords(a.text, { names: false }), namingWords(b.text, { names: false }));
}

// a sentence that tells the app what to do with what it holds: a label, its open items, an assistant, "ignore the above",
// "mark … as done" (en, es), read as `norm` reads it
const TO_THE_APP = new RegExp(
  [
    String.raw`\b[op]\d{1,2}\b`,
    String.raw`\bopen (?:items?|tasks?)\b`,
    String.raw`\b(?:assistants?|chatbots?|llms?|language models?|asistentes?)\b`,
    String.raw`\bai\b`,
    String.raw`\bignor\w* (?:\S+ ){0,3}?(?:previous|prior|above|earlier|instructions?|instrucciones|anteriores)\b`,
    String.raw`\b(?:mark|set|treat|flag|close|clear|consider) (?:\S+ ){0,6}?as (?:done|settled|paid|complete|completed|resolved|closed|finished|handled)\b`,
    String.raw`\b(?:marca|marcar|marque|marquen|considera|considerar|da|dar|den) (?:\S+ ){0,6}?(?:como|por) (?:hech|pagad|resuelt|complet|cerrad|terminad|atendid)\w*`,
    String.raw`\b(?:reschedule|move|push|postpone|cancel) (?:all|every|each|any) (?:\S+ ){0,3}?(?:items?|tasks?|deadlines?|reminders?|appointments?|meetings?|events?|visits?)\b`,
    String.raw`\b(?:pasa|mueve|cambia|reprograma|cancela)\w* (?:todas?|todos|cada) (?:\S+ ){0,4}?(?:tareas|pendientes|fechas|citas|recordatorios|plazos)\b`,
  ].join("|"),
  "u",
);

/** Whether some words talk to the app about what it holds instead of saying what happened. */
export function talksToTheApp(words: string): boolean {
  return TO_THE_APP.test(norm(words));
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

/** Whether some words say what settles an item of a kind, of the reader's own: "Payment received" a bill, "cancelled" a booking. */
export function settlesKind(kind: string, words: string): boolean {
  const read = norm(words);
  return (SETTLES[kind]?.test(read) ?? false) && !BLANKET.test(read);
}

/** A move's evidence says the new day or time, in its paragraph ("Friday at the latest works", "now at 8:00", "meets Monday the 16th… before then"). */
export function saysWhen(evidence: string, paragraph: string): boolean {
  return hasTimeCue(evidence) || hasTimeCue(paragraph);
}
