import { FOOTER_WORDS } from "@terno/i18n";
import { normalizeText } from "./text";
import { AMOUNT, DAY_MONTH, MONTH_DAY, NUMERIC_DATE, SLASH_DATE, TIME } from "./text-facts";

/** Words as whitespace splits them: everything a person or a template wrote. */
export const wordsIn = (text: string): number => (text.match(/\S+/g) ?? []).length;

/** A line with this many words, once its wrapped lines are joined, is prose; shorter is a heading, a name, a button. */
const PROSE_WORDS = 12;
/** a shorter line is prose when it's a sentence: this many words and a full stop ("Rollback complete, EU is healthy.") */
const SENTENCE_WORDS = 4;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;
/** a line this long probably goes on in the next one: plain text wrapped at 72 or 78 columns */
const WRAP_CHARS = 50;
/** this many amounts, dates or times say something in short lines: an itemized bill, a schedule */
const FACTS = 3;

/** a link, without the punctuation that ends the sentence it's in */
const URL = /\b(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,;:!?)\]'"”’]|<https?:\/\/[^>\s]*>/gi;
const HAS_WORD = /[\p{L}\p{N}]/u;
const fold = (text: string) => normalizeText(text).replace(/[‘’]/g, "'");
const FOOTER = [...new Set(Object.values(FOOTER_WORDS).flat().map(fold))];
const FACT_PATTERNS = [AMOUNT, DAY_MONTH, MONTH_DAY, NUMERIC_DATE, SLASH_DATE, TIME];

/** A line's amounts, dates and times: where two readings overlap ("24 Nov 12:30" is no "Nov 12"), the first one wins. */
function factsIn(line: string): string[] {
  const folded = normalizeText(line);
  const spans = FACT_PATTERNS.flatMap((pattern) => [...folded.matchAll(pattern)].map((m) => ({ at: m.index, end: m.index + m[0].length, text: m[0].replace(/\s+/g, " ") })));
  spans.sort((a, b) => a.at - b.at || b.end - a.end);
  const kept: string[] = [];
  let end = 0;
  for (const s of spans) {
    if (s.at < end) continue;
    kept.push(s.text);
    end = s.end;
  }
  return kept;
}

/** what's left of a line, its links already out, once its separators (·, |, —, ----) are out */
const wordsOf = (line: string) => line.split(/\s+/).filter((w) => HAS_WORD.test(w));

/**
 * Plan 269: how much of a message a person reads, for mail a machine sent. Prose counts; the template around it doesn't:
 * links, buttons, headings, a name-and-title card, label rows and footer lines. A message with three or more amounts,
 * dates or times in it says more than its sentences, and text with no lines can't be told apart: both count whole, as
 * `wordsIn` does.
 */
export function readingWords(text: string): number {
  // one line is HTML-only mail as stored (its blocks flattened) or a one-line note: no way to tell template from prose
  if (!text.includes("\n")) return wordsIn(text);
  const units: { words: string[]; sentence: boolean }[] = [];
  const facts = new Set<string>();
  let run: { words: string[]; sentence: boolean } | null = null;
  let wraps = false;
  for (const raw of text.split(/\r?\n/)) {
    // a link's words aren't the line's: an address with "unsubscribe" in it doesn't make a sentence fine print
    const line = raw.replace(URL, " ").trim();
    // a blank line or a footer line ends a paragraph: what's on either side isn't one sentence
    if (!line || FOOTER.some((phrase) => fold(line).includes(phrase))) {
      run = null;
      continue;
    }
    for (const fact of factsIn(line)) facts.add(fact);
    const words = wordsOf(line);
    if (run && wraps) run.words.push(...words);
    else units.push((run = { words, sentence: false }));
    run.sentence = SENTENCE_END.test(line);
    // a line that ends a sentence is no wrapped line: "View incident" under it is a button, not its end
    wraps = line.length >= WRAP_CHARS && !run.sentence;
  }
  if (facts.size >= FACTS) return wordsIn(text);
  return units.reduce((n, u) => (u.words.length >= PROSE_WORDS || (u.sentence && u.words.length >= SENTENCE_WORDS) ? n + u.words.length : n), 0);
}
