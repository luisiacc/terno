import { patternTemplate, type Condition, type FilterAction, type FilterRule } from "@terno/core";
import { getLocale, t, type TextKey } from "@terno/i18n";
import { conditionText } from "./rule-text";
import { listDate } from "./format";

/**
 * Plan 161: what a rule does, said from its own fields, so what AI built and what was asked can be compared (the model's
 * explanation said back the request, and hid a rule that didn't match it).
 */

type Names = { accountEmail: (id: number) => string; category: (id: number) => string; folder: (accountId: number, folder: string) => string };

function actionWords(a: FilterAction, names: Names): string {
  switch (a.type) {
    case "archive":
      return t("filters.say.archive");
    case "trash":
      return t("filters.say.trash");
    case "spam":
      return t("filters.say.spam");
    case "markRead":
      return t("filters.say.markRead");
    case "star":
      return t("filters.say.star");
    case "addCategory":
      return t("filters.say.category", { name: names.category(a.categoryId) });
    case "forward":
      return t("filters.say.forward", { to: a.to.map((x) => x.email).join(", ") });
    case "moveToFolder":
      return t("filters.say.folder", { folder: names.folder(a.accountId, a.folder) });
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase(getLocale()) + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

/** "Domain is “uber.com” and older than 7 days → archive and mark as read.": the builder's order, its rows then its Then */
export function describeRule(rule: FilterRule, names: Names): string {
  const locale = getLocale();
  const actions = new Intl.ListFormat(locale, { type: "conjunction" }).format(rule.actions.map((a) => actionWords(a, names)));
  const conditions = new Intl.ListFormat(locale, { type: rule.match === "any" ? "disjunction" : "conjunction" }).format(rule.conditions.map((c) => lowerFirst(conditionText(c, names.accountEmail))));
  return upperFirst(t("filters.say.rule", { actions, conditions }));
}

/** The fields that read who sent it ("Anywhere" reads the sender too). */
const SENDER_FIELDS: ReadonlySet<Condition["field"]> = new Set(["from", "fromDomain", "listId", "text"]);

/** What a request names, by what a rule would need for it: English and Spanish, as the AI box takes both. */
const ASKS: { want: RegExp; has: (rule: FilterRule) => boolean }[] = [
  { want: /\barchiv/i, has: (r) => r.actions.some((a) => a.type === "archive" || a.type === "moveToFolder") },
  { want: /\b(delete|trash|bin)\b|\bborr[ae]|\belimin|papelera/i, has: (r) => r.actions.some((a) => a.type === "trash") },
  { want: /\bspam\b/i, has: (r) => r.actions.some((a) => a.type === "spam") },
  { want: /\bas read\b|\bmark\w*\b.{0,20}\bread\b|\ble[ií]d[oa]s?\b/i, has: (r) => r.actions.some((a) => a.type === "markRead") },
  { want: /\bstar(red|s)?\b|\bdestac|\bestrella/i, has: (r) => r.actions.some((a) => a.type === "star") },
  {
    want: /\b(older|newer) than\b|\b(more|less) than (a|an|\d+) (days?|weeks?|months?|years?)\b|\b(a|\d+) (days?|weeks?|months?) old\b|\bm[aá]s (de|antigu)|\bmenos de \d|\bhace m[aá]s/i,
    has: (r) => r.conditions.some((c) => c.field === "ageDays"),
  },
  // a sender: an address, a domain, or "from …" (in Spanish "de" says too many things to read as one)
  { want: /@|\b[\w-]+\.(com|net|org|io|dev|app|co|es|mx|me)\b|\bfrom\b|\bde parte de\b|\benviad[oa]s? por\b/i, has: (r) => r.conditions.some((c) => SENDER_FIELDS.has(c.field) && c.field !== "text" && !c.negate) },
];
/** an action a request can name at all, so a rule that acts on a request naming none wasn't asked to */
const ANY_ACTION = /\barchiv|\b(delete|trash|bin|spam|read|star|label|tag|move|file|forward|put|categor)|\bborr[ae]|\belimin|papelera|le[ií]d|destac|estrella|etiquet|\bmuev|\bmover\b|reenv|\bpon(er|lo|la|los|las)?\b|categor/i;

/**
 * What a request can say that no rule can: whether mail was opened or read (rules see the mail, not what you did with
 * it). English and Spanish.
 */
const CANT_SAY = /\b(?:never|not|don['’]?t|didn['’]?t|haven['’]?t|hardly)\s+(?:ever\s+)?(?:open|opened|read)\b|\bun(?:opened|read)\b|\bnunca\s+(?:abr|le)\w*|\bsin\s+(?:abrir|leer)\b|\bno\s+(?:abr|le[oií])\w*/i;

/**
 * Plan 162 (after ai162-r03): the words of a request a built rule left out, quoted as the request says them, with no
 * model: an action, an age or a sender it names that the rule lacks, and what no rule can see ("never open"). A real
 * model turned "archive newsletters I never open" into "List matches .+" and nothing said "never open" was gone.
 */
export function ruleGaps(prompt: string, rule: FilterRule): { words: string[]; cantSay: boolean } {
  const words: string[] = [];
  const cant = CANT_SAY.exec(prompt);
  if (cant) words.push(cant[0].trim());
  for (const a of ASKS) {
    const m = a.want.exec(prompt);
    if (m && !a.has(rule) && !words.some((w) => w.includes(m[0].trim()))) words.push(m[0].trim());
  }
  return { words, cantSay: cant !== null };
}

/**
 * Plan 161: whether a built rule plainly misses its request, with no model asked: an action or an age or a sender the
 * request names that the rule lacks, what no rule can see, or a rule that acts when the request named nothing to do.
 * Calm by design: it says to check, not that it's wrong.
 */
export function ruleMisses(prompt: string, rule: FilterRule): boolean {
  if (!ANY_ACTION.test(prompt)) return true;
  return ruleGaps(prompt, rule).words.length > 0;
}

/** A rule's count from which applying it to mail already here asks once more (plan 162, after ai162-r03). */
export const BROAD_COUNT = 500;

/**
 * Plan 162 (after ai162-r03): a rule that takes in everything, or every mailing list's mail, by what it says (no model):
 * every condition of an "all" rule (or any of an "any" rule) is a pattern any value matches (".+", ".*"). Saving it is
 * never one click.
 */
export function broadRule(rule: Pick<FilterRule, "match" | "conditions">): boolean {
  const vacuous = (c: Condition) => c.field !== "hasAttachment" && c.field !== "account" && c.field !== "ageDays" && c.op === "matches" && !c.negate && matchesAnything(String(c.value));
  if (!rule.conditions.length) return true;
  return rule.match === "any" ? rule.conditions.some(vacuous) : rule.conditions.every(vacuous);
}

// --- the sender check (plan 161, the owner: "if we can do it without using AI, reliably, then yes") ---

/** top levels a domain in a sentence ends in: a word with a dot and one of these is a domain ("uber.com"), not "e.g." or "Node.js" */
const TLDS = new Set(["com", "net", "org", "io", "dev", "app", "co", "es", "mx", "me", "ai", "us", "uk", "de", "fr", "it", "nl", "pt", "br", "ar", "cl", "pe", "uy", "ve", "ec", "bo", "py", "cr", "gt", "do", "pr", "ca", "au", "nz", "ie", "ch", "at", "be", "se", "no", "dk", "fi", "pl", "eu", "jp", "in", "info", "biz", "edu", "gov", "gob", "tv", "news", "email", "shop", "store", "xyz", "tech", "studio", "page", "cloud", "online", "site"]);
const ADDRESS = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const DOMAIN = /(?<![\p{L}\p{N}._%+@-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,})(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/gu;
/** a sentence's words and the punctuation that ends a phrase */
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}&'’.@_+-]*[\p{L}\p{N}]|[\p{L}\p{N}]|[,;:!?()"“”«»]/gu;
/** what a sender is said after */
const FROM = new Set(["from", "de", "del"]);
/** skipped before a name: "from the …", "de mi …" */
const DETERMINER = new Set(["the", "my", "our", "your", "his", "her", "their", "a", "an", "el", "la", "los", "las", "lo", "mi", "mis", "tu", "tus", "su", "sus", "nuestro", "nuestra", "nuestros", "nuestras", "un", "una", "unos", "unas"]);
/** words that end a name, or say it was never one: connectives, time, quantity ("from now on", "de hace más de 30 días") */
const STOP = new Set([
  "and", "or", "but", "nor", "older", "newer", "than", "that", "which", "who", "with", "without", "in", "into", "to", "on", "at", "about", "before", "after", "since", "until", "more", "less", "over", "under", "if", "when", "unless", "except", "excluding", "not", "is", "are", "was", "were", "be", "been", "all", "any", "every", "each", "some", "now", "today", "yesterday", "tomorrow", "tonight", "last", "this", "these", "those", "next", "past", "ago", "earlier", "later", "recent", "recently", "old", "new", "day", "days", "week", "weeks", "month", "months", "year", "years", "hour", "hours", "weekend", "too", "also", "only", "just", "as", "so", "for", "by", "of",
  "y", "e", "o", "u", "ni", "pero", "con", "sin", "en", "a", "al", "para", "por", "que", "cuando", "si", "hace", "más", "mas", "menos", "antes", "después", "despues", "desde", "hasta", "excepto", "salvo", "no", "todo", "todos", "toda", "todas", "cada", "algún", "algunos", "hoy", "ayer", "mañana", "anoche", "este", "esta", "esto", "estos", "estas", "ese", "esa", "esos", "esas", "último", "últimos", "última", "últimas", "ultimo", "ultimos", "pasado", "pasados", "pasada", "pasadas", "próximo", "próxima", "proximo", "ahora", "adelante", "antiguos", "antiguas", "nuevo", "nuevos", "nueva", "nuevas", "día", "días", "dia", "dias", "semana", "semanas", "mes", "meses", "año", "años", "hora", "horas", "también", "solo", "sólo", "como",
]);
/** a month or a weekday is a date, never a sender ("from May 2024", "de mayo"), however someone in the mailbox is named (Codex review) */
const CALENDAR = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
  "ene", "abr", "ago", "dic", "lunes", "martes", "miércoles", "miercoles", "jueves", "viernes", "sábado", "sabado", "domingo",
]);
/** a phrase is at most this many words; at most this many phrases are looked up (the store's SENDER_PHRASES) */
const PHRASE_WORDS = 3;
const PHRASES = 4;

/**
 * What a sentence says about who sent the mail, with no model: the addresses and domains in it (`sure`), and the words
 * after "from", "de" or "del" that could be a sender's name (`phrases`, up to three words each), which count only once
 * the mailbox has them (`senders.named`). English and Spanish.
 */
export function sendersInSentence(sentence: string): { sure: string[]; phrases: string[] } {
  const sure: string[] = [];
  const add = (list: string[], x: string) => {
    if (!list.some((y) => y.toLowerCase() === x.toLowerCase())) list.push(x);
  };
  for (const m of sentence.matchAll(ADDRESS)) add(sure, m[0]);
  const rest = sentence.replace(ADDRESS, " ");
  for (const m of rest.matchAll(DOMAIN)) if (TLDS.has(m[1]!.toLowerCase())) add(sure, m[0]);
  const phrases: string[] = [];
  const tokens = [...sentence.matchAll(TOKEN)].map((m) => m[0]);
  for (let i = 0; i < tokens.length && phrases.length < PHRASES; i++) {
    if (!FROM.has(tokens[i]!.toLowerCase())) continue;
    let j = i + 1;
    while (j < tokens.length && DETERMINER.has(tokens[j]!.toLowerCase())) j++;
    const words: string[] = [];
    for (; j < tokens.length && words.length < PHRASE_WORDS; j++) {
      const w = tokens[j]!;
      const low = w.toLowerCase();
      // punctuation, another "from", a word of time or a connective, a number, an address or a domain: the name ends
      if (!/[\p{L}]/u.test(w) || FROM.has(low) || STOP.has(low) || CALENDAR.has(low) || /[@.]/.test(w)) break;
      words.push(w);
    }
    if (words.length) add(phrases, words.join(" "));
  }
  return { sure, phrases };
}

/** The senders a sentence names for certain: its addresses and domains, and the phrases the mailbox has (in its order). */
export interface SendersNamed {
  sure: string[];
  names: string[];
}

/**
 * Plan 161: what to say when the sentence names a sender and the rule doesn't look at one (no `from`, `fromDomain`,
 * `listId` or `text` condition, a "not" one included): the first sender it names, or null. An address or domain the rule
 * holds anywhere (a recipients condition) isn't a sender it forgot.
 */
export function senderNotLooked(conditions: readonly Condition[], named: SendersNamed | null): string | null {
  if (!named || conditions.some((c) => SENDER_FIELDS.has(c.field))) return null;
  const values = conditions.map((c) => String(c.value).toLowerCase());
  return named.sure.find((x) => !values.some((v) => v.includes(x.toLowerCase()))) ?? named.names[0] ?? null;
}

/** A condition's operator with its sense, as the operator menu holds both (plan 161: no separate "not" toggle). */
export type SensedOp = `${"" | "not:"}${string}`;
export function sensedOp(c: Condition): SensedOp {
  // an attachment condition can say "no" twice (a false value, and not): what it matches is the one sense
  if (c.field === "hasAttachment") return c.value !== Boolean(c.negate) ? "is" : "not:is";
  return `${c.negate ? "not:" : ""}${c.field === "account" ? "is" : c.op}`;
}
export function withSensedOp(c: Condition, value: SensedOp): Condition {
  const negate = value.startsWith("not:");
  const op = negate ? value.slice(4) : value;
  if (c.field === "hasAttachment") return { ...c, value: true, negate: negate || undefined };
  if (c.field === "account") return { ...c, negate: negate || undefined };
  return { ...c, op, negate: negate || undefined } as Condition;
}

// --- the action preview's rows (plan 161, pass 1: actions) ---

/** One row of a rule, said plainly: what it looks at, and what it asks of it (words, or the few terms it lists). */
export interface RuleRow {
  label: string;
  text: string;
  /** a pattern that's only a list of words: those words, each a chip */
  terms?: string[];
}

const FIELD = {
  from: "filters.field.from",
  fromDomain: "filters.field.fromDomain",
  subject: "filters.field.subject",
  body: "filters.field.body",
  text: "filters.field.text",
  opening: "filters.field.opening",
  recipients: "filters.field.recipients",
  listId: "filters.field.listIdShort",
  hasAttachment: "filters.field.hasAttachment",
  account: "filters.field.account",
  ageDays: "filters.field.ageDays",
} as const satisfies Record<Condition["field"], TextKey>;

const OP = {
  contains: ["filters.op.contains", "filters.op.notContains"],
  equals: ["filters.op.equals", "filters.op.notEquals"],
  startsWith: ["filters.op.startsWith", "filters.op.notStartsWith"],
  endsWith: ["filters.op.endsWith", "filters.op.notEndsWith"],
} as const satisfies Record<string, readonly [TextKey, TextKey]>;

/**
 * A pattern that's only alternatives of plain words ("shipped|delivery|en camino"), each word as written; anything
 * else a pattern can say (classes, anchors, repeats) is null, and reads as "matches a pattern", the text in Details.
 */
export function patternTerms(pattern: string): string[] | null {
  let body = pattern.trim();
  const group = /^\((?:\?:)?(.*)\)$/s.exec(body);
  if (group && !/[()]/.test(group[1]!)) body = group[1]!;
  if (!body) return null;
  const terms: string[] = [];
  for (const piece of body.split("|")) {
    // plan 162 (after ai162-r03): what a word list is written with still reads as words: a word's edges (\b) say nothing
    // more, a space is a space, and a letter class of one letter's accents ("env[ií]o") is the accented word
    const raw = piece.replace(/\\b/g, "").replace(/\\s[+*]?/g, " ").replace(/\[(\p{L}{2,3})\]/gu, (whole, letters: string) => (new Set([...letters].map((l) => l.normalize("NFD")[0]!.toLowerCase())).size === 1 ? ([...letters].find((l) => /[^\x00-\x7f]/.test(l)) ?? letters[0]!) : whole));
    // escapes of punctuation are the punctuation itself; any other special character is more than a word
    const plain = raw.replace(/\\[\\^$.*+?()[\]{}|/-]/g, "");
    if (/[\\^$.*+?()[\]{}]/.test(plain)) return null;
    const term = raw.replace(/\\([\\^$.*+?()[\]{}|/-])/g, "$1").trim();
    if (!term) return null;
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

/** Plan 161: a condition as a row of the preview's rule. */
export function ruleRow(c: Condition, accountEmail: (id: number) => string, now = Date.now()): RuleRow {
  const label = t(FIELD[c.field]);
  const not = Boolean(c.negate);
  // plan 162 (after ai162-r02): an age says the day it means, to check against the rows' dates ("…, before Sep 22")
  if (c.field === "ageDays" && c.op === "gt" && !not && Number(c.value) > 0) return { label, text: t("action.rule.before", { rule: upperFirst(conditionText(c, accountEmail)), date: listDate(now - Number(c.value) * 86_400_000, now) }) };
  if (c.field === "hasAttachment" || c.field === "account" || c.field === "ageDays") return { label, text: upperFirst(conditionText(c, accountEmail)) };
  if (c.field === "text") return { label, text: t(not ? "action.rule.noneOf" : "action.rule.anyOf", { count: 1 }), terms: [c.value] };
  if (c.op === "matches") {
    // plan 161, pass 3: a pattern every value matches says so ("Any mailing list"), not "matches a pattern"
    const breadth = patternBreadth(c.value);
    if (breadth) return { label, text: t(BREADTH[breadth][c.field === "listId" ? "list" : "other"][not ? 1 : 0]) };
    const terms = patternTerms(c.value);
    if (terms) return { label, text: t(not ? "action.rule.noneOf" : "action.rule.anyOf", { count: terms.length }), terms };
    const template = patternTemplate(c.value);
    if (template !== null) return { label, text: t(not ? "action.rule.notLike" : "action.rule.like", { template }) };
    return { label, text: t(not ? "action.rule.notPattern" : "action.rule.pattern") };
  }
  const op = Object.hasOwn(OP, c.op) ? OP[c.op as keyof typeof OP] : null;
  return { label, text: upperFirst(t("action.rule.value", { op: op ? t(op[not ? 1 : 0]) : c.op, value: c.value })) };
}

/**
 * Plan 161, pass 3: a pattern every value of one character or more matches (".", ".+"), and one every value matches,
 * an empty one too (".*", "^"): the row says it whole. A message with no List-Id is an empty one (`evaluate.ts`).
 */
const ANY_FILLED = new Set([".", ".+", "^.", "^.+", "(.+)", "(?:.+)"]);
const ANY_AT_ALL = new Set([".*", "^", "$", "^.*", ".*$", "^.*$", "(.*)", "(?:.*)"]);
export function patternBreadth(pattern: string): "filled" | "all" | null {
  const p = pattern.trim();
  return ANY_FILLED.has(p) ? "filled" : ANY_AT_ALL.has(p) ? "all" : null;
}
export const matchesAnything = (pattern: string): boolean => patternBreadth(pattern) !== null;

const BREADTH = {
  filled: { list: ["action.rule.anyList", "action.rule.noList"], other: ["action.rule.anything", "action.rule.empty"] },
  all: { list: ["action.rule.anyMail", "action.rule.nothing"], other: ["action.rule.everything", "action.rule.nothing"] },
} as const;

/** A condition that holds a pattern: what Details shows verbatim (one for anything says nothing more than its row). */
const hasPattern = (c: Condition): boolean => c.field !== "hasAttachment" && c.field !== "account" && c.field !== "ageDays" && c.op === "matches" && !matchesAnything(String(c.value));

/**
 * Details (plan 161, pass 2: "Exact pattern"): each condition with a pattern, by its field, the pattern verbatim (a
 * "not" said before it). The rows say everything else already.
 */
export function ruleDetails(conditions: readonly Condition[]): { field: string; negate: boolean; pattern: string }[] {
  return conditions.filter(hasPattern).map((c) => ({ field: t(FIELD[c.field]), negate: Boolean(c.negate), pattern: String(c.value) }));
}

/** Whether Details says more than the rows: a pattern shown as words, a template or "a pattern". */
export const hasDetails = (conditions: readonly Condition[]): boolean => conditions.some(hasPattern);
