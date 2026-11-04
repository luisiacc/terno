import { normalizeText } from "../text";

/**
 * Plan 133 §6.7: after generation, local and free. A number, date, amount, address or URL in the draft that's in none
 * of the authorized sources is flagged. It flags and never rewrites.
 */

export interface SpecificsSources {
  /** instruction, draft, thread, messages to this person, custom instructions, signature, recipients */
  texts: readonly string[];
  /** YYYY-MM-DD */
  today: string;
}

export interface SpecificFinding {
  kind: "number" | "amount" | "date" | "url" | "address";
  /** as written in the draft */
  text: string;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, enero: 1, ene: 1,
  february: 2, feb: 2, febrero: 2,
  march: 3, mar: 3, marzo: 3,
  april: 4, apr: 4, abril: 4, abr: 4,
  may: 5, mayo: 5,
  june: 6, jun: 6, junio: 6,
  july: 7, jul: 7, julio: 7,
  august: 8, aug: 8, agosto: 8, ago: 8,
  september: 9, sep: 9, sept: 9, septiembre: 9,
  october: 10, oct: 10, octubre: 10,
  november: 11, nov: 11, noviembre: 11,
  december: 12, dec: 12, diciembre: 12, dic: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAYS: Record<string, number> = {
  sunday: 0, domingo: 0,
  monday: 1, lunes: 1,
  tuesday: 2, martes: 2,
  wednesday: 3, miercoles: 3,
  thursday: 4, jueves: 4,
  friday: 5, viernes: 5,
  saturday: 6, sabado: 6,
};
const WEEKDAY_RE = Object.keys(WEEKDAYS).join("|");

const URL = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const CURRENCY = "[$€£]|usd|eur|gbp|mxn|euros?|dollars?|d[oó]lares|pesos?";
const AMOUNT = new RegExp(`(?:(?:${CURRENCY})\\s?\\d[\\d.,]*|\\d[\\d.,]*\\s?(?:${CURRENCY})(?![\\p{L}]))`, "giu");
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(?:de\\s+|of\\s+)?)(${MONTH_RE})\\b\\.?`, "giu");
const MONTH_DAY = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "giu");
const NUMERIC_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const WEEKDAY = new RegExp(`\\b(${WEEKDAY_RE})\\b`, "giu");
const NUMBER = /\d+(?:[.,:]\d+)*/g;
const PLACEHOLDER = /\[[^\]\n]*\]/g;
const LIST_MARK = /^\s*\d+[.)]\s/gm;

/** 4,200 / 4.200 / 4200 are one number; 3.5 stays 3.5; a trailing period isn't part of it. */
function canonicalNumber(raw: string): string {
  const t = raw.replace(/[.,:]+$/, "");
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) return t.replace(/[.,]/g, "");
  return t.replace(",", ".");
}

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(NUMBER) ?? []) {
    const n = canonicalNumber(raw);
    out.add(n);
    // "3:30 pm" or "2026.10.20" cover "3" and "30": a time mentioned is a number mentioned
    for (const piece of n.split(/[.:]/)) out.add(String(Number(piece)));
    out.add(String(Number(n)));
  }
  return out;
}

const dayKey = (month: number, day: number) => `${month}-${day}`;

function datesIn(lower: string): Set<string> {
  const out = new Set<string>();
  for (const m of lower.matchAll(DAY_MONTH)) out.add(dayKey(MONTHS[m[2]!.toLowerCase()]!, Number(m[1])));
  for (const m of lower.matchAll(MONTH_DAY)) out.add(dayKey(MONTHS[m[1]!.toLowerCase()]!, Number(m[2])));
  for (const m of lower.matchAll(NUMERIC_DATE)) out.add(dayKey(Number(m[2]), Number(m[3])));
  return out;
}

const addDays = (today: string, n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000);

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[.,;:!?)]+$/, "").replace(/\/$/, "");
}

/** What the sources let the draft say, with "tomorrow" turned into the date it means. */
function authorized(sources: SpecificsSources) {
  const all = sources.texts.join("\n");
  const lower = normalizeText(all);
  const numbers = numbersIn(all);
  const dates = datesIn(lower);
  const weekdays = new Set<number>();
  for (const m of lower.matchAll(WEEKDAY)) weekdays.add(WEEKDAYS[m[1]!]!);
  const addIso = (d: Date) => {
    dates.add(dayKey(d.getUTCMonth() + 1, d.getUTCDate()));
    weekdays.add(d.getUTCDay());
    numbers.add(String(d.getUTCDate()));
  };
  addIso(addDays(sources.today, 0));
  if (/\b(tomorrow|manana)\b/u.test(lower)) addIso(addDays(sources.today, 1));
  if (/\b(yesterday|ayer)\b/u.test(lower)) addIso(addDays(sources.today, -1));
  return {
    numbers,
    dates,
    weekdays,
    urls: new Set((all.match(URL) ?? []).map(normalizeUrl)),
    addresses: new Set((all.match(ADDRESS) ?? []).map((a) => a.toLowerCase())),
  };
}

export function checkSpecifics(draft: string, sources: SpecificsSources): SpecificFinding[] {
  const known = authorized(sources);
  const findings: SpecificFinding[] = [];
  const seen = new Set<string>();
  const flag = (kind: SpecificFinding["kind"], text: string) => {
    const key = `${kind}:${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, text: text.trim() });
  };
  // a placeholder is the model asking, not stating; a list's "1." isn't a number anyone said
  let rest = draft.replace(PLACEHOLDER, " ").replace(LIST_MARK, " ");

  const blank = (match: string) => " ".repeat(match.length);
  rest = rest.replace(URL, (m) => {
    if (!known.urls.has(normalizeUrl(m))) flag("url", m.replace(/[.,;:!?)]+$/, ""));
    return blank(m);
  });
  rest = rest.replace(ADDRESS, (m) => {
    if (!known.addresses.has(m.toLowerCase())) flag("address", m);
    return blank(m);
  });
  rest = rest.replace(AMOUNT, (m) => {
    const n = m.match(NUMBER)?.[0];
    if (n && !known.numbers.has(canonicalNumber(n))) flag("amount", m.replace(/[.,]+$/, ""));
    return blank(m);
  });
  // dates compare whole, so "19 March" isn't let through by a "19" somewhere else
  const dateMatch = (m: string, month: number, day: number) => {
    if (!known.dates.has(dayKey(month, day))) flag("date", m.replace(/[.,]+$/, ""));
    return blank(m);
  };
  rest = rest.replace(DAY_MONTH, (m, d: string, mon: string) => dateMatch(m, MONTHS[mon.toLowerCase()]!, Number(d)));
  rest = rest.replace(MONTH_DAY, (m, mon: string, d: string) => dateMatch(m, MONTHS[mon.toLowerCase()]!, Number(d)));
  rest = rest.replace(NUMERIC_DATE, (m, _y: string, mo: string, d: string) => dateMatch(m, Number(mo), Number(d)));
  // accents off, only to read the name of the day
  for (const m of rest.matchAll(new RegExp(`\\b(${WEEKDAY_RE}|miércoles|sábado)\\b`, "giu"))) {
    if (!known.weekdays.has(WEEKDAYS[normalizeText(m[1]!)]!)) flag("date", m[1]!);
  }
  for (const raw of rest.match(NUMBER) ?? []) {
    const n = canonicalNumber(raw);
    if (!known.numbers.has(n) && !known.numbers.has(String(Number(n)))) flag("number", raw.replace(/[.,:]+$/, ""));
  }
  return findings;
}

/** A `[placeholder]`, for the composer to select first (§6.7). */
export function findPlaceholders(draft: string): string[] {
  return draft.match(PLACEHOLDER) ?? [];
}
