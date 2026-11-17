/**
 * Plan 210 (iteration 5, revision 9): the stake is what happens if the reader doesn't act, said as a condition. Round 13's
 * reviewers read "(parcel removed from plan)", "(policy ends Dec 1 at 12:01 AM)" and "(flagged to your manager)" as things
 * that had already happened; the mail said each would happen only if the reader didn't act. So, before the cut, each clause
 * of an item's bracket that says what happens is held to the mail's own sentences that say it: it stays when it states an
 * amount or a percentage, when it carries its condition ("or the parcel leaves the plan", "if unpaid", "after Thu") and the
 * mail says it, or when the mail says it as a plain fact ("certification expires Dec 10"); else it goes, the action and the
 * amount kept. Pure, en and es.
 */

/** Accents off, lower case, words joined by single spaces (as the backend's `norm` reads a mail). */
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}$€£%]+/gu, " ").trim();

/** The kinds whose bracket is a stake (a pay, a renewal, an expiry, a request); an alert's, an event's and a delivery's are details. */
const STAKED: ReadonlySet<string> = new Set(["pay", "renew", "expire", "respond"]);

/** What happens, en and es: the words a stake's clause states (never what already happened: "declined", "failed"). */
export const CONSEQUENCE =
  /\b(?:held|hold|holds|withheld|paus\w*|suspen\w*|disabl\w*|clos(?:e|es|ed|ing)|lock\w*|laps\w*|expir\w*|cancel\w*|fees?|costs?|charged?|penalt\w*|interest|lose|loses|lost|loss|flagged|flag|report\w*|reporta\w*|remov\w*|end|ends|ended|switch\w*|shown|showing|show|releas\w*|cut off|stops?|stopped|terminat\w*|delet\w*|leaves?|dropped|fines?|citation|waitlist|retenid\w*|retien\w*|bloque\w*|vence\w*|caduc\w*|recargos?|multas?|penaliz\w*|interes\w*|cuesta\w*|pierde\w*|perder\w*|cobr\w*|cargos?|libera\w*|corte|suspend\w*|elimin\w*|termin\w*|cierra\w*|cerrad\w*|tarifa)\b/u;
/** a bare "no hotel room", "sin habitación": what the reader would be left without */
const WITHOUT = /^(?:no|sin)\s+\p{L}/u;
/** the conditions a clause may carry: "or" only where it starts the clause ("or the parcel leaves", never "card or bank account") */
const CLAUSE_CONDITION =
  /^(?:or|o)\b|\b(?:if|unless|otherwise|or else|after|later|late|overdue|until|avoid|to keep|missing|unpaid|si|si no|a menos que|de lo contrario|despues|tras|mas tarde|hasta que|evitar?|para conservar|para no|faltantes?|lo que falte|sin pagar)\b/u;
/** a mail sentence that says something happens only on a condition */
const SENTENCE_CONDITION =
  /\b(?:if|unless|otherwise|or else|or (?:your|the|we|it|you|they)|missed|missing|fail(?:s|ure)? to|not (?:received|paid|submitted|returned|renewed)|don t hear|do not hear|after (?:that|the|this|then|which)|late|overdue|anything|avoid|to keep|keep your|si|si no|a menos que|de lo contrario|o (?:se|tu|su|el|la|perder\w*)|despues|tras|en caso de|falta de|lo que falte|faltantes?|evita\w*|para no|para conservar|para mantener)\b/u;
const NEGATION = /\b(?:not|no|never|won t|will not|isn t|aren t|don t|doesn t|without|nunca|sin|ni)\b/u;
/**
 * The claims ledger's second batch: a sentence about the reader not acting: "otherwise", "after the cutoff", "to keep your
 * coverage", "if payment is not received", "No form = no hotel room" (en, es). Any "if" is not one ("If you have any
 * questions, call us").
 */
const FAILURE =
  /\b(?:otherwise|or else|unless|fail(?:s|ure)? to|missed|overdue|late|after (?:the|that|this|which) (?:cutoff|deadline|date|day)|to keep|keep your|or (?:your|the|we|it|you|they)|not (?:received|paid|submitted|returned|renewed|registered|completed)|don t hear|do not hear|de lo contrario|a menos que|si no|despues del? (?:cierre|plazo|limite)|para (?:conservar|mantener|no perder)|en caso de no|falta de)\b|\b(?:if|si)\b(?: \S+){0,8} (?:not|no|never|don t|doesn t|nunca)\b|^(?:no|sin) \p{L}+ (?:no|sin)\b/u;
/**
 * "to keep your coverage without a lapse": a "without" right before the consequence, in a sentence that says what keeping it
 * takes, says what keeping it avoids, never a denial of the lapse. Its code review: only that construction ("but your
 * coverage will not lapse if you pay late" still denies it).
 */
const KEEP = /\b(?:to keep|keep your|para (?:conservar|mantener))\b/u;
const WITHOUT_A = /\b(?:without|sin)(?: (?:a|an|any|un|una|ningun|ninguna))?$/u;
const keptWithout = (before: string, sentence: string) => WITHOUT_A.test(before) && KEEP.test(sentence);
/**
 * Its code review: a failure sentence that points back to the item's own deadline ("otherwise", "after the cutoff", "No
 * form = no hotel room" is read by naming), so the sentence before it may name the item.
 */
// (round two: and a reply not given, "if we don't hear from you"; what's still missing, "anything missing", "lo que falte")
const BACK = /\b(?:otherwise|or else|after (?:the|that|this|which) (?:cutoff|deadline|date|day)|(?:don t|do not|doesn t) hear|no (?:reply|response|answer)|anything (?:missing|left)|de lo contrario|si no (?:lo|la|los|las)|despues del? (?:cierre|plazo|limite)|lo que falte|sin respuesta|no (?:recibimos|tenemos) (?:respuesta|noticias))\b/u;
/** "para no perder tu dominio", "so as not to lose": a negation that states the condition, not a denial */
const NOT_TO = /\b(?:para no|para que no|so as not to|in order not to|to not|to avoid)$/u;
const MONEY = /[$€£]\s?\d|\d[\d.,]*\s?(?:€|£|%|\b(?:usd|eur|mxn|gbp|cad)\b)|\d\s?%/iu;

// words that name nothing a stake is about
const FILLER = new Set("the your you this that with from into will would have been they them their after before then when what which until about also only more than para pero como esta este todo todos tienes tiene sera seran despues antes hasta".split(" "));
const content = (words: string) => words.split(" ").filter((w) => w.length >= 4 && !FILLER.has(w));
/**
 * A word's root for matching a paraphrase ("deploys" and "deployments", "shown" and "showing", "removed" and "remove"); a
 * Spanish stem that changes is read as one ("pierden" and "perder", "cuesta" and "costar").
 */
const root = (w: string) => w.replace(/^pierd/u, "perd").replace(/^cuest/u, "cost").replace(/^renuev/u, "renov").slice(0, Math.max(3, Math.min(5, w.length - 1)));

/**
 * The claims ledger's second batch: what an "or" clause's consequence happens to, its own words ("coverage", "December
 * reimbursement run", "hotel room", "full time status funding"): beyond its condition, its consequence's word and its
 * numbers. An "if" clause's words are its condition's ("if no reply"), none.
 */
const OR_CLAUSE = /^(?:or|o)\b/u;
const objectOf = (read: string) => (!OR_CLAUSE.test(read) ? [] : content(read)).filter((w) => !/^\d+$/u.test(w) && !CONSEQUENCE.test(w) && !CLAUSE_CONDITION.test(w)).map(root);

/**
 * Whether the mail says, in substance, what a conditional clause says happens (the model's "or lose full-time status and
 * funding" for the mail's "to keep full-time status and funding", its "or coverage lapses Dec 1" for "to keep your coverage
 * without a lapse"): one sentence about the reader not acting (`FAILURE`) names every word of its object, and its numbers are
 * the mail's. The consequence's own verb may be the mail's opposite ("keep", "lose") or another ("lapses", "will end").
 * Its code review: that sentence is about not doing this item (`action`, the item's words outside its brackets, roots): it
 * names one of them beyond the object ("register", "reports", "No form = …"), or points back ("otherwise", "after the
 * cutoff") from a sentence that does. "If you have not booked a hotel room, contact the travel desk" beside "Complete the
 * registration form" is another failure.
 */
function objectNamed(read: string, sentences: readonly string[], action: readonly string[]): boolean {
  const object = objectOf(read);
  if (!object.length || !numbersIn(read).every((n) => sentences.some((s) => s.split(" ").includes(n)))) return false;
  return sentences.some((s, k) => FAILURE.test(s) && aboutItem(sentences, k, action, object) && object.every((o) => names(s.split(" "), o)));
}

const names = (ws: readonly string[], r: string) => ws.some((w) => root(w).startsWith(r) || w.startsWith(r));
/**
 * Its code review: whether sentence `k` is about not doing this item: it names the item's own words (`action`) beyond the
 * stake's (`stake`, never a tie: "hotel room" in "your hotel room will be released"), or points back (`BACK`) from a
 * sentence that does. Round two: on every path a conditional stake holds by.
 */
function aboutItem(sentences: readonly string[], k: number, action: readonly string[], stake: readonly string[]): boolean {
  const mine = action.filter((a) => !stake.includes(a));
  const says = (s: string | undefined) => !!s && mine.some((a) => names(s.split(" "), a));
  return says(sentences[k]) || (BACK.test(sentences[k] ?? "") && says(sentences[k - 1]));
}

/**
 * An action's words in both languages, by its verb's root (round two: "Pagar la prima" on an English mail's "If payment is
 * not received"): a mail and its item may be in two.
 */
const SAME_ACTION: readonly (readonly string[])[] = [
  ["pay", "paga", "pago", "pague"],
  ["regis", "inscr"],
  ["submi", "envi", "entre", "mand"],
  ["send", "envi", "mand"],
  ["renew", "renov"],
  ["compl", "llen", "fill"],
  ["sign", "firm"],
  ["retur", "devol", "regre"],
  ["uploa", "subi", "sube", "carg"],
  ["book", "reser"],
  ["confi"],
  ["reply", "respo", "conte", "answe"],
  ["updat", "actua"],
];

/** The item's own words (its action and what it's on), outside its brackets, as roots: its verb (in both languages) and its naming words. */
function actionOf(text: string): string[] {
  const words = plain(text.replace(/\([^)]*\)/gu, " "));
  const verb = words.split(" ")[0] ?? "";
  const same = verb.length >= 3 ? (SAME_ACTION.find((g) => g.some((r) => root(verb).startsWith(r) || r.startsWith(root(verb)))) ?? []) : [];
  return [...new Set([...(verb.length >= 3 ? [root(verb)] : []), ...same, ...content(words).map(root)])];
}

/** The mail's sentences, as `plain` reads them. */
const sentencesOf = (mail: string) => mail.split(/(?<=[.!?;])\s+|\n+/u).map(plain).filter(Boolean);

/**
 * Whether a clause of a bracket holds as the mail says it (above). `conditioned`: an earlier clause of its bracket gave the
 * condition ("if unpaid, policy ends Dec 1").
 */
function clauseHolds(clause: string, sentences: readonly string[], conditioned: boolean, action: readonly string[]): boolean {
  const read = plain(clause);
  if (!read || MONEY.test(clause)) return true;
  const said = CONSEQUENCE.exec(read);
  const without = WITHOUT.test(read);
  // the claims ledger's second batch: a condition's consequence in words of its own ("or procurement treats it as a new
  // evaluation", "or no hotel room") holds when the mail says it in substance; a bare condition ("if unpaid") or a detail as before
  if (!said && !without) return !objectOf(read).length || objectNamed(read, sentences, action);
  // the mail's sentences that say this consequence: its word's root, and another word of the clause when it has one; a clause
  // that carries its condition may say it in other words ("or the parcel leaves the plan" for "will remove the parcel"): a
  // sentence that says something happens to what it names
  const conditional = conditioned || CLAUSE_CONDITION.test(read);
  const anchors = said ? [root(said[0])] : content(read.replace(/^(?:no|sin)\s+/u, "")).map(root);
  const others = content(read).map(root).filter((r) => !anchors.includes(r));
  const has = (ws: readonly string[], r: string) => ws.some((w) => root(w).startsWith(r) || w.startsWith(r));
  // round two: a conditional stake's sentence is about not doing this item, on every path (`aboutItem`)
  const stake = [...anchors, ...others];
  const tied = (k: number) => !conditional || aboutItem(sentences, k, action, stake);
  const support = sentences.filter((s, k) => {
    if (!tied(k)) return false;
    const ws = s.split(" ");
    let at = ws.findIndex((w) => anchors.some((a) => root(w).startsWith(a) || w.startsWith(a)));
    if (at < 0 && conditional && said && others.some((o) => has(ws, o))) at = ws.findIndex((w) => CONSEQUENCE.test(w));
    if (at < 0 || (others.length && !others.some((o) => has(ws, o)))) return false;
    // "we won't suspend it", "no late fee": a mail that denies it doesn't say it ("para no perder" states its condition)
    const before = ws.slice(Math.max(0, at - 3), at).join(" ");
    return without || !NEGATION.test(before) || NOT_TO.test(before) || keptWithout(before, s);
  });
  // said as a condition: the mail says this consequence, or (an English mail read for a Spanish reader says it in other
  // words) one sentence says something happens on a condition with the clause's own numbers ("ends Dec 1": a "1"), and the
  // mail never denies it. Iteration 5's code review (point 5): never on any condition in the mail ("If you have any
  // questions, call us" is no "or policy ends Dec 1")
  // (with the sentence after it: "…will end at 12:01 a.m. on December 1" is read as two)
  // the claims ledger's second batch: or the mail says it in substance, its object named where it says what not acting does
  if (conditional) return support.length > 0 || ((sentences.some((s, k) => tied(k) && SENTENCE_CONDITION.test(s) && CONSEQUENCE.test(s) && numbersIn(read).every((n) => `${s} ${sentences[k + 1] ?? ""}`.split(" ").includes(n))) || objectNamed(read, sentences, action)) && !denied(anchors, sentences));
  return support.length > 0 && support.every((s) => !SENTENCE_CONDITION.test(s));
}

/** a clause's own numbers, as `plain` reads them ("dec 1" is "1"; "12 01 am" is "12" and "01") */
const numbersIn = (read: string) => read.split(" ").filter((w) => /^\d+$/u.test(w));

/** Whether the mail denies a consequence ("there is no late fee", "we won't suspend it"). */
function denied(anchors: readonly string[], sentences: readonly string[]): boolean {
  return sentences.some((s) => {
    const ws = s.split(" ");
    const at = ws.findIndex((w) => anchors.some((a) => root(w).startsWith(a) || w.startsWith(a)));
    if (at < 0) return false;
    const before = ws.slice(Math.max(0, at - 3), at).join(" ");
    return NEGATION.test(before) && !NOT_TO.test(before) && !keptWithout(before, s);
  });
}

/** A bracket's clauses, apart: "(card declined; deploys pause Mon)" is two; "$1,186.40" and "Dec 1, 2026" are one. */
const CLAUSES = /\s*(?:;|,(?!\s?\d))\s*/u;

/**
 * Revision 9: an item's text with each stake clause of its brackets held to the mail (`clauseHolds`); a bracket left with
 * none goes whole. Only a pay, a renewal, an expiry or a request's (`kind`; a move gives its item's). `mail`: the subject and
 * the text. Text with no bracket comes back as it is.
 */
export function heldStake(kind: string, text: string, mail: string): string {
  if (!STAKED.has(kind) || !text.includes("(")) return text;
  const sentences = sentencesOf(mail);
  const action = actionOf(text);
  let out = "";
  let depth = 0;
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" && depth++ === 0) {
      open = i;
      continue;
    }
    if (c === ")" && depth > 0 && --depth === 0) {
      const inside = text.slice(open + 1, i);
      const parts = inside.split(CLAUSES);
      const seps = inside.match(new RegExp(CLAUSES.source, "gu")) ?? [];
      // a condition said in an earlier clause holds for those after it
      const held = parts.map((p, j) => clauseHolds(p, sentences, parts.slice(0, j).some((q) => CLAUSE_CONDITION.test(plain(q))), action));
      const kept = parts.flatMap((p, j) => (held[j] ? [`${j ? seps[j - 1] : ""}${p}`] : []));
      // a condition left without what happens says nothing ("(si no)", "(or)"): the bracket goes whole
      // (the claims ledger's second batch: one that names what happens in words of its own says it: "or no hotel room")
      const said = parts.some((p, j) => held[j] && (MONEY.test(p) || !CLAUSE_CONDITION.test(plain(p)) || CONSEQUENCE.test(plain(p)) || objectOf(plain(p)).length > 0));
      if (kept.length && said) out += `(${kept.join("").replace(/^\s*[;,]\s*/u, "")})`;
      else out = out.replace(/\s+$/u, "");
      continue;
    }
    if (depth === 0) out += c;
  }
  // a bracket never closed is left as the model wrote it
  if (depth > 0) out += text.slice(open);
  return out.replace(/\s{2,}/gu, " ").replace(/\s+([,.;:])/gu, "$1").trim() || text;
}

/** What starts a condition after a consequence: "…ends Dec 1 if unpaid", "…se libera, si no renuevas". */
const CONDITION_START = /^(?:if|unless|otherwise|or|after|until|si|a menos que|de lo contrario|o|despues|tras|en caso)\b/u;

/**
 * Revision 9: where a cut that keeps `kept` would leave a consequence without its condition: the index in `kept` of the
 * clause that says what happens, when `rest` (what the cut drops) starts with its condition; -1 otherwise. "The parcel
 * leaves the plan…" from "…the parcel leaves the plan if it's missed" is the first; "Pay the bill…" from "Pay the bill, or
 * the parcel leaves the plan" isn't.
 */
export function orphanedConsequence(kept: string, rest: string): number {
  if (!CONDITION_START.test(plain(rest))) return -1;
  const start = Math.max(...[",", ";", ":", "(", ". ", "—", "–"].map((c) => kept.lastIndexOf(c))) + 1;
  const clause = kept.slice(start);
  const at = clause.search(new RegExp(CONSEQUENCE.source, "iu"));
  return at < 0 || !CONSEQUENCE.test(plain(clause)) ? -1 : start;
}
