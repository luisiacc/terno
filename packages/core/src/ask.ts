import { tokenize } from "./rules/evaluate";
import { isFullEmail, parseDate, type MessageTerm, type SearchQuery } from "./search/parse";
import type { ResolvedSearch } from "./search/resolve";
import type { AiProviderId } from "./ai";

/**
 * Plan 141: Ask your mail. What a question becomes (a plan the model writes, validated into a structured search, never
 * a query string) and what a conversation keeps.
 */

export const ASK_QUESTION_MAX = 1000;
/** one to six terms a query, at most 3 queries (plan §2), and everything has a length (revision 11) */
export const ASK_QUERIES_MAX = 3;
export const ASK_TERMS_MAX = 6;
export const ASK_TERM_MAX = 100;
export const ASK_GROUPS_MAX = 3;
export const ASK_GROUP_TERMS_MAX = 8;
export const ASK_CONVERSATIONS_MAX = 100;
export const ASK_TURNS_MAX = 20;
export const ASK_TITLE_MAX = 200;
export const ASK_ANSWER_MAX = 8000;
export const ASK_SOURCES_MAX = 30;
export const ASK_SOURCE_HEADER_MAX = 300;
/** what the plan keeps: enough for Ask again and Search older mail, however a model writes */
export const ASK_QUERIES_JSON_MAX = 8000;

export const ASK_TURN_STATUSES = ["answered", "partial", "not_found", "failed", "stopped"] as const;
export type AskTurnStatus = (typeof ASK_TURN_STATUSES)[number];

/** What the planning model returns for one search. Each field is validated on its own; a bad one goes, the rest stay. */
export interface AskPlanQuery {
  /** all of them, on one message */
  terms: string[];
  /** each group needs one of its words: synonyms and other languages (plan 140) */
  anyOf?: string[][];
  from?: string;
  to?: string;
  subject?: string;
  /** YYYY-MM-DD */
  after?: string;
  before?: string;
  hasAttachment?: boolean;
}

/** A source as it's kept: enough to show it even if the mail goes. */
export interface AskSourceRef {
  messageId: number;
  threadId: number;
  accountId: number;
  fromName: string;
  fromEmail: string;
  subject: string;
  date: number;
}

export interface AskCheck {
  /** citations to a message that isn't there were dropped, or a claim has none */
  unlinked: boolean;
  /** a specific in the answer that no source holds: said, never hidden */
  unsupported: string[];
}

export interface AskTurn {
  id: number;
  conversationId: number;
  kind: "question" | "command";
  question: string;
  answer: string | null;
  status: AskTurnStatus;
  sources: AskSourceRef[];
  queries: AskPlanQuery[];
  model: string | null;
  provider: string | null;
  createdAt: number;
  checks: AskCheck;
}

export interface AskConversationSummary {
  id: number;
  title: string;
  /** beyond the first question */
  followUps: number;
  createdAt: number;
  updatedAt: number;
}

/** Where a question goes, in words the user knows. */
export interface AskDestination {
  provider: AiProviderId;
  /** the server's name when it's a kind with many */
  label: string;
}

/** What a source is now, and the thread it's in: a merge moves it. */
export type AskSourceView = { state: "ok" | "spam" | "trash"; threadId: number } | { state: "gone" };

/** Whether older mail can be asked for: `since`, how far back this Mac goes. */
export type AskOlderOffer = { kind: "none" } | { kind: "downloading" } | { kind: "offline"; since: number } | { kind: "offer"; since: number };

export type AiAskResult =
  /** plan 143: it's something to do, not a question: nothing ran, and the preview comes next */
  | { status: "command" }
  /** `turn` null: its conversation was deleted or cleared while it ran */
  | { status: "done"; turn: AskTurn | null; incomplete: boolean; older: AskOlderOffer; olderFound?: number; olderPartial?: boolean }
  | { status: "failed"; turn: AskTurn | null; error: { kind: import("./ai").AiErrorKind; message: string; i18n?: import("./rpc/envelope").I18nRef }; older: AskOlderOffer };

/** An answer as it streams: `text` to append; `phase`, what's underway; `older`, a fetch's progress. */
export interface AiAskEvent {
  requestId: string;
  text?: string;
  phase?: "searching";
  older?: { done: number; total: number };
}

const clip = (value: string, max: number) => value.trim().slice(0, max);

function term(field: MessageTerm["field"], raw: unknown): MessageTerm | null {
  if (typeof raw !== "string") return null;
  const value = clip(raw, ASK_TERM_MAX);
  if (tokenize(value).length === 0) return null;
  return { field, value, phrase: /\s/.test(value), negate: false, prefix: false };
}

/** A person or an address: an address is that one, a name is a word of the header. */
function person(field: "from" | "to", raw: unknown): MessageTerm | null {
  const t = term(field, raw);
  if (!t || !isFullEmail(t.value)) return t;
  return { ...t, value: t.value.toLowerCase(), field: field === "from" ? "from" : "address" };
}

/**
 * One planned search as a structured query: nothing a model writes is parsed, so a value can't add an operator or leave
 * All Mail (revision 4). Null: no field survived. Only `all`: Spam and Trash are never looked in by asking.
 */
export function buildAskSearch(plan: AskPlanQuery, now: number): ResolvedSearch | null {
  const query: SearchQuery = { terms: [], anyOf: [], accounts: [], categories: [], excludeAccounts: [], excludeCategories: [], view: "all" };
  for (const raw of (Array.isArray(plan.terms) ? plan.terms : []).slice(0, ASK_TERMS_MAX)) {
    const t = term("text", raw);
    if (t) query.terms.push(t);
  }
  for (const group of (Array.isArray(plan.anyOf) ? plan.anyOf : []).slice(0, ASK_GROUPS_MAX)) {
    const kept = (Array.isArray(group) ? group : []).slice(0, ASK_GROUP_TERMS_MAX).flatMap((raw) => term("text", raw) ?? []);
    // search's own rule: a group holds two or more; one is a plain term
    if (kept.length === 1) query.terms.push(kept[0]!);
    else if (kept.length > 1) query.anyOf.push(kept);
  }
  const from = person("from", plan.from);
  if (from) query.terms.push(from);
  const to = person("to", plan.to);
  if (to) query.terms.push(to);
  const subject = term("subject", plan.subject);
  if (subject) query.terms.push(subject);
  if (plan.hasAttachment === true) query.hasAttachment = true;
  const day = (raw: unknown) => (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDate(raw, now) : undefined);
  const after = day(plan.after);
  if (after !== undefined && after <= now) query.after = after;
  const before = day(plan.before);
  if (before !== undefined) query.before = before;
  if (!query.terms.length && !query.anyOf.length && query.hasAttachment === undefined && query.after === undefined && query.before === undefined) return null;
  return { query, view: "all", accountIds: null, excludeAccountIds: [], categoryIds: [], excludeCategoryIds: [], impossible: false, key: JSON.stringify(["ask", plan]) };
}

/** What a passage looks for: the words a message must hold, not who sent it. */
export function askQueryWords(search: ResolvedSearch): string[] {
  return [...search.query.terms.filter((t) => t.field === "text"), ...search.query.anyOf.flat().filter((t) => t.field === "text")].map((t) => t.value);
}

/** The parts of a plan a server search can use, with what validation dropped gone. */
export function validAskQueries(plans: readonly AskPlanQuery[], now: number): { plan: AskPlanQuery; search: ResolvedSearch }[] {
  return plans.slice(0, ASK_QUERIES_MAX).flatMap((plan) => {
    const search = buildAskSearch(plan, now);
    return search ? [{ plan, search }] : [];
  });
}

/**
 * Citations in a finished answer, for the reader: `[m3]`, in order of first appearance, and the text with each replaced
 * by its number among the sources. A label the material didn't have is dropped and said (the check's `unlinked`).
 */
export function resolveCitations(text: string, labels: ReadonlyMap<string, number>): { text: string; cited: number[]; dropped: number } {
  const cited: number[] = [];
  let dropped = 0;
  const out = text
    .replace(/\s*\[(m\d+)\]/g, (_, label: string) => {
      const at = labels.get(label);
      if (at === undefined) {
        dropped++;
        return "";
      }
      if (!cited.includes(at)) cited.push(at);
      return ` [${cited.indexOf(at) + 1}]`;
    })
    .trim();
  return { text: out, cited, dropped };
}

/** One sentence of an answer, as written (its trailing space included, so the parts join back to the answer). */
export interface AnswerSentence {
  text: string;
  /** says something about the mail: more than two words, and not a lead-in ending in ":" */
  claim: boolean;
  /** holds a citation (one after its full stop is still its own) */
  linked: boolean;
}

/**
 * The answer speaking of itself, not of the mail: what it looked at or didn't find ("I only looked at part of your mail",
 * "None of these says what the problem was"). Nothing to cite, so never marked. English and Spanish.
 */
const CAVEAT = /^i (?:only )?(?:looked|searched|checked|read|saw)\b|^i (?:couldn['’]t|could not|can['’]t|cannot|didn['’]t|did not|don['’]t|do not) (?:find|see)\b|^i found no\b|(?<!\p{L})(?:none of (?:these|them|those|the (?:messages|mails?|emails?))|no (?:message|mail|email)s? (?:says|said|mentions?)|there (?:may|might|could) be more(?! than)|ninguno de (?:estos|ellos|los)|ningún (?:mensaje|correo)|no (?:encontré|encuentro|veo)|solo (?:miré|revisé|busqué|vi)|puede haber más(?! de))(?!\p{L})/iu;

/**
 * Plan 162 (after ai162-r03): an answer as its sentences, split where a sentence ends (after its citations, so "… March.
 * [1] Notice…" gives "… March. [1] " its own) or at a line break. The reader marks a claim with no citation, and says so
 * only then; the backend's check counts the same claims.
 */
export function answerSentences(text: string): AnswerSentence[] {
  const parts: string[] = [];
  let start = 0;
  // a citation with no stop before it still ends its sentence when the next one starts ("… payment [1] Isabella …")
  for (const m of text.matchAll(/[.!?…]+(?:\s*\[\d+\])*(?:\s+|$)|\n+|(?<=\[\d+\])\s+(?=[\p{Lu}¿¡])/gu)) {
    const end = m.index + m[0].length;
    parts.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts.map((part) => {
    const words = part.replace(/\[\d+\]/g, " ").trim();
    return { text: part, claim: tokenize(words).length > 2 && !words.endsWith(":") && !CAVEAT.test(words), linked: /\[\d+\]/.test(part) };
  });
}

/** A claim is a sentence: one with no citation is what "parts of this aren't linked" means. */
export function hasUnlinkedSentence(text: string): boolean {
  return answerSentences(text).some((s) => s.claim && !s.linked);
}

/** First names folded for comparing: "Ísabella" and "isabella" are one. */
const foldName = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Plan 162 (after ai162-r03): one first name that is several people among an answer's sources, when the question or the
 * answer uses it and the answer doesn't name each in full ("Isabella" for Isabella Álvarez, Rivera and Cruz). From the senders' names, no model: the answer
 * may have run them together, and the reader should know.
 */
export function sameNamePeople(sources: readonly Pick<AskSourceRef, "fromName">[], question: string, answer = ""): { name: string; people: string[] }[] {
  const said = `${question} ${answer}`;
  // an answer that names each of them in full already tells them apart
  const told = (people: string[]) => people.every((p) => foldName(answer).includes(foldName(p)));
  const byFirst = new Map<string, { name: string; people: string[] }>();
  for (const s of sources) {
    const full = s.fromName.trim().replace(/\s+/g, " ");
    const first = full.split(" ")[0];
    if (!first || !full.includes(" ")) continue;
    const key = foldName(first);
    const group = byFirst.get(key) ?? { name: first, people: [] };
    if (!group.people.some((p) => foldName(p) === foldName(full))) group.people.push(full);
    byFirst.set(key, group);
  }
  const words = new Set(foldName(said).split(/[^\p{L}\p{N}]+/u));
  return [...byFirst.entries()].filter(([key, g]) => g.people.length > 1 && words.has(key) && !told(g.people)).map(([, g]) => g);
}

/** A number whatever way it's written: 120,50 and 120.50 and 120.5 are one amount. */
const foldNumber = (n: string): string => {
  const dot = n.replace(",", ".");
  return dot.includes(".") ? dot.replace(/\.?0+$/, "") : dot;
};

/** What a machine sum was given that no source holds: a true total of made-up amounts is still made up. */
export function askOperandsMissing(operands: readonly string[], sources: readonly string[]): string[] {
  const source = sources.join("\n");
  // 0.001 is a decimal here, where a thousands reading would lose it
  const held = new Set([...numbersIn(source), ...(source.match(/\d+[.,]\d+/g) ?? [])].map(foldNumber));
  return operands.filter((n) => !held.has(foldNumber(n)));
}

/** The answer without its citations, to copy. */
export const answerWithoutCitations = (text: string): string => text.replace(/\s*\[\d+\]/g, "").trim();

/**
 * Plan 141 revision 6: every specific in the answer that no source holds. Stricter than a draft's check: a whole date
 * counts with its year, digits count exactly (leading zeros too), brackets are looked in, and nothing is exempt, since a
 * wrong door code is the failure that matters.
 */
export function askSpecifics(answer: string, sources: readonly string[]): string[] {
  // a citation is a label or a source's number: a longer bracketed number is what it says
  const clean = answer.replace(/\[m\d+\]|\[\d{1,2}\]/g, " ");
  const said = new Set<string>();
  const source = sources.join("\n");
  const sourceNumbers = new Set(numbersIn(source));
  // a date with no year stands for that day in any year
  const sourceDates = new Set(datesIn(source).flatMap((d) => [d, d.split("-").slice(-2).join("-")]));
  const out: string[] = [];
  const miss = (value: string) => {
    if (said.has(value)) return;
    said.add(value);
    out.push(value);
  };
  const dates = datesIn(clean);
  for (const d of dates) if (!sourceDates.has(d)) miss(displayDate(d));
  // the digits of a whole date were decided above: they aren't also a number
  const withoutDates = stripDates(clean);
  for (const n of numbersIn(withoutDates)) if (!sourceNumbers.has(n)) miss(n);
  const lowered = source.toLowerCase();
  for (const url of clean.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) ?? []) if (!lowered.includes(url.replace(/[.,;:!?]+$/, "").toLowerCase())) miss(url.replace(/[.,;:!?]+$/, ""));
  for (const mail of clean.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) if (!lowered.includes(mail.toLowerCase())) miss(mail);
  return out;
}

const MONTHS: Record<string, number> = { january: 1, jan: 1, enero: 1, ene: 1, february: 2, feb: 2, febrero: 2, march: 3, mar: 3, marzo: 3, april: 4, apr: 4, abril: 4, abr: 4, may: 5, mayo: 5, june: 6, jun: 6, junio: 6, july: 7, jul: 7, julio: 7, august: 8, aug: 8, agosto: 8, ago: 8, september: 9, sep: 9, sept: 9, septiembre: 9, october: 10, oct: 10, octubre: 10, november: 11, nov: 11, noviembre: 11, december: 12, dec: 12, diciembre: 12, dic: 12 };
const MONTH_WORD = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WRITTEN_DATE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+de)?\\s+(${MONTH_WORD})\\.?(?:,?\\s+(?:de\\s+|del\\s+)?(\\d{4}))?\\b|\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "giu");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const SLASH_DATE = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g;

/** Comparable form: `Y-M-D`, or `M-D` when the text gives no year. A slash date reads both ways, so each is compared. */
function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WRITTEN_DATE)) {
    const month = MONTHS[(m[2] ?? m[4])!.toLowerCase()]!;
    const dayOf = Number(m[1] ?? m[5]);
    const year = m[3] ?? m[6];
    out.push(year ? `${year}-${month}-${dayOf}` : `${month}-${dayOf}`);
  }
  for (const m of text.matchAll(ISO_DATE)) out.push(`${m[1]}-${Number(m[2])}-${Number(m[3])}`);
  for (const m of text.matchAll(SLASH_DATE)) out.push(`${m[3]}-${Number(m[1])}-${Number(m[2])}`, `${m[3]}-${Number(m[2])}-${Number(m[1])}`);
  return out;
}

const displayDate = (comparable: string) => comparable;
const stripDates = (text: string) => text.replace(WRITTEN_DATE, " ").replace(ISO_DATE, " ").replace(SLASH_DATE, " ");

/** Runs of digits exactly as written (0421 isn't 421), with thousands separators gone so 1,200 is 1200. */
function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?/g) ?? []).map((n) => n.replace(/[.,](?=\d{3}(?:\D|$))/g, ""));
}
