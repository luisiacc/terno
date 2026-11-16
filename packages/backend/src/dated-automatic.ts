import { lapsesUnlessRenewed } from "@terno/core";
import { contextOf, namesItem, namesSpecifically, norm, otherAmounts, otherIds, otherMonths, sentencesOf, sentencesWith, type Sentences } from "./dated-evidence";

/**
 * Plan 210 (iteration 5, revision 1; the owner: "for things that are auto-renewed like a plan or an invoice that was paid
 * already, those things should not even be on the feed, nobody cares"). Replaces iteration 4's `routineAutoBill` and v15's
 * priced renewal: a pay, a renewal or an expiry is no item when its own words say, affirmatively and on no condition, that
 * this plan, subscription or membership renews by itself, that this bill is charged by itself, or that this invoice is paid
 * ("will renew automatically on December 1", "AutoPay is on: we'll charge your Visa on the due date", "Invoice 2231 has
 * been paid in full"). Its own words: a sentence in its quote's paragraph, or one that names it ("your bill", "the due
 * date", its amount, its plan's name) and nothing else (another invoice's number or amount); never a footer about others.
 * Anything that still needs the reader vetoes it: a negation ("is not paid automatically"), auto-renew off, a lapse unless
 * renewed, a failed charge, an invalid or expired card, a balance still owed, a trial that asks them to decide, or a
 * request to pay it. Pure, en and es; read as `norm` reads them.
 */

const AUTOMATIC = new RegExp(
  [
    // a renewal by itself
    String.raw`renew\w* (?:\S+ ){0,2}automatically|automatically renew\w*|auto ?renew\w* (?:is )?(?:on|enabled|active|turned on)|automatic renewal (?:is )?(?:on|enabled|active|turned on)`,
    String.raw`se renuev\w* automaticamente|se renovar\w* automaticamente|renovacion automatica (?:esta )?(?:activa|activada|encendida)`,
    // a charge by itself (iteration 4's AutoPay, "billed to Visa ending 4417")
    String.raw`auto ?pay (?:is )?(?:on|enabled|active|set up)|(?:we ll|we will|will) automatically (?:charge|debit|deduct|draft|bill)|(?:we ll|we will|will) (?:charge|debit|deduct|draft|bill) (?:it |this |the (?:amount|balance|total|payment|renewal) )?(?:to |from )?(?:your|the) (?:visa|mastercard|amex|card|credit card|debit card|account|bank account|checking|savings|payment method|card on file)`,
    String.raw`(?:be )?(?:charged|debited|deducted|drafted|paid|billed) automatically|(?:billed|charged) (?:automatically )?to (?:your |the )?(?:visa|mastercard|amex|card|credit card|debit card|card on file|account|payment method)|automatic (?:payment|charge|debit)s? (?:is |are )?(?:on|set up|scheduled|enabled)`,
    String.raw`se (?:cargara|cobrara|debitara|domiciliara)\w* automaticamente|(?:tienes|tiene) (?:la )?domiciliacion|domiciliacion (?:activa|activada)|cargo automatico|pago automatico (?:activo|activado)|se (?:cargara|cobrara) a (?:tu|su) (?:tarjeta|cuenta)`,
  ].join("|"),
  "u",
);
/** paid: this invoice, settled ("paid in full", "has been paid", "payment received") */
const PAID = /\b(?:paid in full|(?:has|have) been paid|was paid|is (?:now )?paid|status paid|payment (?:was |has been )?(?:received|processed|completed?|successful)|(?:we ve |we have )?received your payment|thank you for your payment|(?:ya )?(?:esta|fue|ha sido) pagad[ao]|pagad[ao] (?:en su totalidad|por completo)|pago (?:recibido|realizado|procesado|completado)|(?:recibimos|hemos recibido) (?:tu|su) pago|gracias por (?:tu|su) pago)\b/u;
const BY_ITSELF = new RegExp(`\\b(?:${AUTOMATIC.source})\\b`, "u");
/** a sentence that goes on about the one before it ("It has been paid in full.", "Ya está pagada.") */
const ANAPHOR = /^(?:it|this|that|which|ya|esta|este|fue|ha sido)\b/u;
/** a sentence that offers, conditions or charges something else is no affirmation ("If you have automatic renewal turned on…", "Set up AutoPay so…", "We will charge a $25 late fee") */
const NOT_AFFIRMED = /\b(?:if|unless|should|in case|otherwise|whether|set up|sign up|enroll|turn on|activate|fees?|penalty|penalties|interest|finance charges?|si|salvo|a menos que|en caso|activa|domicilia|inscribete|recargos?|multas?|penalizacion\w*|comision\w*|intereses)\b/u;
const NEGATED = /\b(?:not|no|never|won t|will not|isn t|aren t|wasn t|haven t|hasn t|nunca|aun no|todavia no)\b/u;

/** what still needs the reader */
const NEEDS_READER = new RegExp(
  [
    // a failed charge
    String.raw`declined|failed|unable|couldn t|could not|didn t go through|did not go through|unsuccessful|rechaz\w*|no pudimos|no se pudo|fall(?:o|aron|ido|ida)`,
    // auto-renew off, not paid automatically
    String.raw`auto ?renew\w* (?:is )?(?:off|disabled|turned off)|automatic renewal (?:is )?(?:off|disabled|turned off)|not (?:be )?(?:renewed|paid|charged|billed) automatically|not enrolled in auto ?pay|(?:renovacion automatica|domiciliacion) (?:esta )?(?:desactivada|apagada)|no se (?:renovara|cobrara|cargara) automaticamente|no (?:esta|estas) (?:inscrito|domiciliad\w*)`,
    // an invalid or expired card
    String.raw`(?:card|tarjeta)(?: \S+){0,4} (?:has )?(?:expired|expires|is expiring|invalid|no longer valid|vencid\w*|caducad\w*|vence|no es valida)|update (?:your )?(?:card|payment (?:method|details|information|info)|billing)|actualiza\w* (?:tu |el |la |su )?(?:tarjeta|metodo de pago|forma de pago|datos de pago)`,
    // a balance still owed
    String.raw`remaining balance|balance (?:remaining|outstanding|still due|of \S+ remains)|(?:balance|amount) (?:\S+ ){0,3}remains|outstanding|still owe|partial(?:ly)? (?:payment|paid)|past due|overdue|saldo (?:pendiente|restante|vencido)|pago parcial|adeudo|queda(?:n)? (?:un saldo|por pagar)`,
    // a trial the reader decides on
    String.raw`trial|prueba gratuita|periodo de prueba|tu prueba`,
  ].join("|"),
  "u",
);
/** a request to pay it, in its own words */
const ASKS_TO_PAY = /\b(?:please pay|pay (?:it |the \w+ |your \w+ )?(?:by|before|online|now)|you can pay|make (?:a|your) payment|favor de pagar|paga\w* (?:antes|en linea|ahora)|realiza (?:tu|el) pago)\b/u;
/** words that point to the item they're in ("on the due date", "your bill", "this plan") */
const DEICTIC = /\b(?:the due date|this (?:bill|invoice|statement|payment|amount|premium|plan|subscription|membership|renewal)|your (?:bill|invoice|statement|premium|balance|plan|subscription|membership|renewal|workspace)|the (?:amount|balance|total|premium|renewal)(?: due)?|fecha (?:limite|de pago|de vencimiento)|(?:tu|su|este|esta) (?:factura|recibo|estado de cuenta|plan|suscripcion|membresia|cuota|prima|renovacion)|el (?:importe|saldo|total))\b/u;

export interface ItemWords {
  kind: string;
  text: string;
  quote: string;
}

/**
 * Whether the item needs nothing of the reader (above). `tied`: the mail's paragraphs tied to it (`checkDates`' `tiedWords`),
 * `paragraphs` and `subject` the mail's own, `from` the sender's name (in all their mail, so it names nothing).
 */
export function handledItself(item: ItemWords, mail: { subject: string; paragraphs: Sentences; tied: string; from?: string }): boolean {
  if (item.kind !== "pay" && item.kind !== "renew" && item.kind !== "expire") return false;
  const quote = norm(item.quote);
  const own = mail.paragraphs.find((p) => quote && p.read.includes(quote));
  const sentences = [...sentencesOf(mail.tied), ...sentencesOf(mail.subject)];
  // the item as its own sentence says it: an invoice's number and amount there too ("Invoice 2240 ($300) is due Nov 30")
  const self = { text: item.text, quote: `${item.quote}\n${contextOf(item.quote, sentencesOf(mail.tied))}` };
  const another = (s: string) => otherIds(self, s) || otherAmounts(self, s);
  const ofItem = (s: { said: string; read: string }) => !another(s.said) && (!!own?.read.includes(s.read) || namesItem(self, s.said, mail.from) || DEICTIC.test(s.read));
  // what still needs the reader, said of this item or of none in particular
  if (sentences.some((s) => !another(s.said) && NEEDS_READER.test(s.read)) || lapsesUnlessRenewed(mail.tied)) return false;
  // a request to pay it: in its own sentence, or one that names it (a neighbour's "please pay by then" is another invoice's)
  const mine = norm(self.quote);
  if (sentences.some((s) => ASKS_TO_PAY.test(s.read) && !another(s.said) && (mine.includes(s.read) || namesItem(self, s.said, mail.from)))) return false;
  // plan 210 (iteration 5's code review, point 1): paid is this invoice's only on words that pick it out: its own sentence,
  // the one right after it going on about it ("It has been paid in full"), or one with its number, amount or a word of its
  // own; never "your invoice" alone ("Your October invoice has been paid in full. Your November invoice for $300 is due…")
  const quoted = new Set(sentencesWith(item.quote, sentences));
  const paidOf = (s: { said: string; read: string }, n: number) => quoted.has(n) || (quoted.has(n - 1) && ANAPHOR.test(s.read)) || namesSpecifically(self, s.said, mail.from);
  const affirmed = (s: { read: string }, re: RegExp) => {
    const m = re.exec(s.read);
    return !!m && !NEGATED.test(s.read.slice(0, m.index).trim().split(" ").slice(-4).join(" "));
  };
  return sentences.some((s, n) => {
    // another period's bill, by its month, is another bill
    if (!ofItem(s) || otherMonths(self, s.said) || NOT_AFFIRMED.test(s.read)) return false;
    return affirmed(s, BY_ITSELF) || (affirmed(s, PAID) && paidOf(s, n));
  });
}
