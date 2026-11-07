import { foldedWithOffsets, tokenize, WORD_WITH_MARKS } from "../rules/evaluate";
import { parseSearch, type MessageTerm, type SearchQuery } from "./parse";

/**
 * Plan 158: why a result matched, in the words on its row. Reads a query the way the engines do (tokens folded as
 * unicode61 folds them, phrases adjacent, the word being typed as a prefix), and only marks: what the engines answered
 * stands whatever this finds.
 */
export interface MatchNeedle {
  words: readonly string[];
  /** the last word is still being typed */
  prefix: boolean;
}

export interface RowMatch {
  from: readonly MatchNeedle[];
  subject: readonly MatchNeedle[];
  /** what may be in a message's text: free text only */
  body: readonly MatchNeedle[];
  /** what the row must show for it to explain itself: each entry holds if one of its needles shows (plan 140's any-of groups) */
  shown: readonly (readonly MatchNeedle[])[];
}

function needleOf(term: MessageTerm): MatchNeedle | null {
  const words = tokenize(term.value);
  return words.length ? { words, prefix: term.prefix } : null;
}

/** A query's marks; null when nothing in it can be seen on a row (only is:, in:, has:, dates…). */
export function rowMatchOf(query: string | SearchQuery, now?: number): RowMatch | null {
  const q = typeof query === "string" ? parseSearch(query, now) : query;
  const from: MatchNeedle[] = [];
  const subject: MatchNeedle[] = [];
  const body: MatchNeedle[] = [];
  const shown: MatchNeedle[][] = [];
  const add = (term: MessageTerm): MatchNeedle | null => {
    if (term.negate) return null;
    const needle = needleOf(term);
    if (!needle) return null;
    if (term.field === "from" || term.field === "text") from.push(needle);
    if (term.field === "subject" || term.field === "text") subject.push(needle);
    if (term.field !== "text") return null;
    body.push(needle);
    return needle;
  };
  for (const term of q.terms) {
    const text = add(term);
    if (text) shown.push([text]);
  }
  for (const group of q.anyOf) {
    const texts = group.flatMap((term) => add(term) ?? []);
    if (texts.length) shown.push(texts);
  }
  return from.length || subject.length ? { from, subject, body, shown } : null;
}

export type MatchPart = { text: string; hit: boolean };

/** Where the needles lie in a text, in order, overlaps merged; the text must be NFC for the offsets to be its own. */
function ranges(text: string, needles: readonly MatchNeedle[]): [number, number][] {
  if (!needles.length || !text) return [];
  const { folded, at } = foldedWithOffsets(text);
  const words = [...folded.matchAll(new RegExp(WORD_WITH_MARKS.source, "gu"))].map((m) => ({ word: m[0], start: m.index }));
  const found: [number, number][] = [];
  for (const { words: wanted, prefix } of needles) {
    outer: for (let i = 0; i + wanted.length <= words.length; i++) {
      for (let j = 0; j < wanted.length; j++) {
        const word = words[i + j]!.word;
        if (prefix && j === wanted.length - 1 ? !word.startsWith(wanted[j]!) : word !== wanted[j]) continue outer;
      }
      const last = words[i + wanted.length - 1]!;
      found.push([at[words[i]!.start]!, at[last.start + (prefix ? wanted[wanted.length - 1]!.length : last.word.length)]!]);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

/** A text cut at its matches; null when there are none (the caller draws it as it was). */
export function matchParts(text: string, needles: readonly MatchNeedle[]): MatchPart[] | null {
  if (!needles.length) return null;
  const nfc = text.normalize("NFC");
  const found = ranges(nfc, needles);
  if (!found.length) return null;
  const parts: MatchPart[] = [];
  let at = 0;
  for (const [start, end] of found) {
    if (start > at) parts.push({ text: nfc.slice(at, start), hit: false });
    parts.push({ text: nfc.slice(start, end), hit: true });
    at = end;
  }
  if (at < nfc.length) parts.push({ text: nfc.slice(at), hit: false });
  return parts;
}

/** Does the row, as it stands, show why it's here? If not, its body holds it, and an excerpt can say so. */
export function rowExplains(match: RowMatch, fields: readonly string[]): boolean {
  const lines = fields.map((f) => f.normalize("NFC"));
  return match.shown.every((group) => group.some((needle) => lines.some((line) => ranges(line, [needle]).length > 0)));
}

const EXCERPT_CHARS = 180;
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|\n+/gu;

/** The sentence a match is in, long ones cut after it. Null when the text doesn't hold one. */
export function matchExcerpt(text: string, needles: readonly MatchNeedle[]): string | null {
  const nfc = text.normalize("NFC");
  const first = ranges(nfc, needles)[0];
  if (!first) return null;
  let start = 0;
  let end = nfc.length;
  for (const m of nfc.matchAll(SENTENCE_END)) {
    const after = m.index + m[0].length;
    if (after <= first[0]) start = after;
    else if (m.index >= first[1]) {
      end = m.index + m[0].trimEnd().length;
      break;
    }
  }
  // a match deep in a very long sentence keeps only what's near it, from a word's start
  const deep = first[1] - start > EXCERPT_CHARS / 2;
  if (deep) {
    const space = nfc.indexOf(" ", first[0] - EXCERPT_CHARS / 4);
    start = space >= 0 && space < first[0] ? space + 1 : first[0];
  }
  let tail = false;
  if (end - start > EXCERPT_CHARS) {
    const stop = nfc.lastIndexOf(" ", start + EXCERPT_CHARS);
    end = stop > first[1] ? stop : Math.max(first[1], start + EXCERPT_CHARS);
    tail = true;
  }
  return `${deep ? "…" : ""}${nfc.slice(start, end).replace(/\s+/g, " ").trim()}${tail ? "…" : ""}`;
}

/** A line cut so its first match stands at most `lead` characters in, from a word's start: a row shows only its beginning. */
export function matchFocus(text: string, needles: readonly MatchNeedle[], lead: number): string {
  const nfc = text.normalize("NFC");
  const first = ranges(nfc, needles)[0];
  if (!first || first[0] <= lead) return text;
  const space = nfc.indexOf(" ", first[0] - lead);
  return `…${nfc.slice(space >= 0 && space < first[0] ? space + 1 : first[0])}`;
}
