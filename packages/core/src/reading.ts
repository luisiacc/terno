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

const URL = /\b(?:https?:\/\/|www\.)\S+|<https?:\/\/[^>\s]*>/gi;
const HAS_WORD = /[\p{L}\p{N}]/u;
const FOOTER = [...new Set(Object.values(FOOTER_WORDS).flat().map(normalizeText))];
const FACT_PATTERNS = [AMOUNT, DAY_MONTH, MONTH_DAY, NUMERIC_DATE, SLASH_DATE, TIME];

const footerLine = (line: string) => {
  const folded = normalizeText(line);
  return FOOTER.some((phrase) => folded.includes(phrase));
};

/** what's left of a line once its links and its separators (·, |, —, ----) are out */
const wordsOf = (line: string) => line.replace(URL, " ").split(/\s+/).filter((w) => HAS_WORD.test(w));

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
  let run: { words: string[]; sentence: boolean } | null = null;
  let wraps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // a blank line or a footer line ends a paragraph: what's on either side isn't one sentence
    if (!line || footerLine(line)) {
      run = null;
      continue;
    }
    const bare = line.replace(URL, " ").trim();
    const words = wordsOf(bare);
    if (run && wraps) run.words.push(...words);
    else units.push((run = { words, sentence: false }));
    run.sentence = SENTENCE_END.test(bare);
    // a link's length says nothing: "View message: https://…" isn't wrapped prose
    wraps = bare.length >= WRAP_CHARS;
  }
  const kept = units.map((u) => u.words.join(" ")).join("\n");
  const facts = new Set<string>();
  for (const pattern of FACT_PATTERNS) for (const m of normalizeText(kept).matchAll(pattern)) facts.add(m[0].replace(/\s+/g, " ").trim());
  if (facts.size >= FACTS) return wordsIn(text);
  return units.reduce((n, u) => (u.words.length >= PROSE_WORDS || (u.sentence && u.words.length >= SENTENCE_WORDS) ? n + u.words.length : n), 0);
}
