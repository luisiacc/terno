/**
 * Plan 203: Settings' search. Pure: entries in, ranked results out, each with where its words matched (the ranges to
 * emphasize) and why it is a result when that isn't already on screen. No catalog, no DOM: the index resolves its
 * keys into these entries (components/settings/search-index.ts).
 */

/** A searchable setting, its text already in the current language. */
export interface FindEntry<T = unknown> {
  /** unique among the entries (an id, plus the account or category for a scoped one) */
  key: string;
  name: string;
  /** where it is: the section, the group's title, the account or category, a page; each weighted as it matches */
  place: readonly { text: string; weight: number }[];
  /** related words ("dark mode" for Mode), and in another language the English name and words */
  words: readonly string[];
  hint: string | null;
  data: T;
}

export type Range = readonly [start: number, end: number];

export type FindReason = { kind: "word"; word: string } | { kind: "hint"; text: string; ranges: Range[] };

export interface Found<T = unknown> {
  entry: FindEntry<T>;
  score: number;
  /** the matched words in the name, and in each crumb of the place */
  name: Range[];
  place: Range[][];
  /** null: the name or the place shows why */
  reason: FindReason | null;
}

export const FIND_LIMIT = 50;

/** what a word that matched where weighs */
const NAME = 4;
const NAME_START = 1;
const WORDS = 3;
const HINT = 1;
/** a match inside a word, not at its start, is worth a little less */
const INFIX = 0.5;
/** a query word this long also matches inside a word ("sync" in "resync") */
const INFIX_MIN = 3;

/**
 * Lower case without accents, and where each folded character came from, so a match maps back to the original text
 * ("Notificación" → "notificacion"; a character that folds to two, as "İ" does, maps both to itself).
 */
export function fold(text: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) from.push(i);
    folded += f;
    i += ch.length;
  }
  from.push(i);
  return { folded, from };
}

/** The query's words, folded. */
export function queryWords(query: string): string[] {
  return fold(query).folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

interface Hit {
  /** in the original text */
  range: Range;
  /** at a word's start (else inside one) */
  start: boolean;
}

/** Where a folded query word matches in a text: the first word it starts, else (long enough) anywhere inside one. */
function hit(text: string, word: string, folded = fold(text)): Hit | null {
  const f = folded.folded;
  let at = f.indexOf(word);
  let inside: number | null = null;
  while (at !== -1) {
    if (!isWordChar(f[at - 1])) return { range: [folded.from[at]!, folded.from[at + word.length]!], start: true };
    inside ??= at;
    at = f.indexOf(word, at + 1);
  }
  if (inside !== null && word.length >= INFIX_MIN) return { range: [folded.from[inside]!, folded.from[inside + word.length]!], start: false };
  return null;
}

/** One query word's best place in an entry. */
type WordMatch =
  | { field: "name"; hit: Hit; score: number }
  | { field: "place"; crumb: number; hit: Hit; score: number }
  | { field: "words"; word: string; score: number }
  | { field: "hint"; hit: Hit; score: number };

function bestMatch(entry: FindEntry, word: string): WordMatch | null {
  let best: WordMatch | null = null;
  const consider = (m: WordMatch) => {
    if (!best || m.score > best.score) best = m;
  };
  const weigh = (weight: number, h: Hit) => weight - (h.start ? 0 : INFIX);
  const n = hit(entry.name, word);
  if (n) consider({ field: "name", hit: n, score: weigh(NAME, n) + (n.start && n.range[0] === 0 ? NAME_START : 0) });
  entry.place.forEach((crumb, i) => {
    const h = hit(crumb.text, word);
    if (h) consider({ field: "place", crumb: i, hit: h, score: weigh(crumb.weight, h) });
  });
  for (const w of entry.words) {
    const h = hit(w, word);
    if (h) consider({ field: "words", word: w, score: weigh(WORDS, h) });
  }
  if (entry.hint) {
    const h = hit(entry.hint, word);
    if (h) consider({ field: "hint", hit: h, score: weigh(HINT, h) });
  }
  return best;
}

/** About this many characters of a description show around its first match. */
const EXCERPT = 72;
const LEAD = 24;

/** The description's words around its matches, cut at word boundaries, with ellipses where it was cut. */
export function excerpt(text: string, ranges: readonly Range[]): { text: string; ranges: Range[] } {
  if (text.length <= EXCERPT || ranges.length === 0) return { text, ranges: [...ranges] };
  const first = Math.min(...ranges.map((r) => r[0]));
  let start = Math.max(0, first - LEAD);
  // back to the start of the word it fell in
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (start < first && /\s/.test(text[start]!)) start++;
  let end = Math.min(text.length, start + EXCERPT);
  while (end < text.length && isWordChar(text[end])) end++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  const before = start > 0 ? "…" : "";
  const after = end < text.length ? "…" : "";
  const shift = before.length - start;
  return {
    text: `${before}${text.slice(start, end)}${after}`,
    ranges: ranges.filter((r) => r[0] >= start && r[1] <= end).map(([a, b]) => [a + shift, b + shift] as const),
  };
}

/** Ranges sorted and merged, so emphasis never nests. */
function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The entries every query word matches, best first (ties keep the entries' order, which is Settings' own), at most
 * FIND_LIMIT. An empty query finds nothing.
 */
export function findSettings<T>(entries: readonly FindEntry<T>[], query: string, limit = FIND_LIMIT): Found<T>[] {
  const words = [...new Set(queryWords(query))];
  if (words.length === 0) return [];
  const found: Found<T>[] = [];
  for (const entry of entries) {
    const matches: WordMatch[] = [];
    for (const word of words) {
      const m = bestMatch(entry, word);
      if (!m) break;
      matches.push(m);
    }
    if (matches.length < words.length) continue;
    const name: Range[] = [];
    const place: Range[][] = entry.place.map(() => []);
    const hint: Range[] = [];
    let related: string | null = null;
    for (const m of matches) {
      if (m.field === "name") name.push(m.hit.range);
      else if (m.field === "place") place[m.crumb]!.push(m.hit.range);
      else if (m.field === "hint") hint.push(m.hit.range);
      else related ??= m.word;
    }
    // the description wins over a related word: it says more
    let reason: FindReason | null = null;
    if (hint.length && entry.hint) reason = { kind: "hint", ...excerpt(entry.hint, merge(hint)) };
    else if (related !== null) reason = { kind: "word", word: related };
    found.push({ entry, score: matches.reduce((s, m) => s + m.score, 0), name: merge(name), place: place.map(merge), reason });
  }
  // a stable sort: equal scores keep Settings' order
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}
