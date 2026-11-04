import type { Habits, Share, WrittenMail } from "./types";
import { countWords } from "./extract";

/** Plan 133 §2. Counted on everything, before any de-duplication: fifty "Thanks!" are the evidence someone is terse. */

const TOP = 3;
const EMOJI = /\p{Extended_Pictographic}/u;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+\S/m;

const percentile = (sorted: readonly number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
const median = (values: readonly number[]) => percentile([...values].sort((a, b) => a - b), 0.5);
const ratio = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100) / 100);

function tally(values: readonly (string | null)[], total: number, top = TOP): Share[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top)
    .map(([text, n]) => ({ text, share: ratio(n, total) }));
}

const sentences = (text: string) => text.split(/(?<=[.!?…])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);

/** Most of its sentences start with a lowercase letter, leaving out what's quoted from names and greetings. */
function startsLowercase(text: string): boolean {
  let lower = 0;
  let upper = 0;
  for (const s of sentences(text)) {
    const letter = /\p{L}/u.exec(s)?.[0];
    if (!letter) continue;
    if (letter === letter.toLowerCase() && letter !== letter.toUpperCase()) lower++;
    else if (letter !== letter.toLowerCase()) upper++;
  }
  return lower > 0 && lower >= upper;
}

export function computeHabits(mails: readonly WrittenMail[]): Habits {
  const total = mails.length;
  const words = mails.map((m) => m.words).sort((a, b) => a - b);
  const sentenceLengths = mails.flatMap((m) => {
    const parts = sentences(m.text);
    return parts.length > 1 ? parts.map(countWords) : [];
  });
  const hasGreeting = mails.filter((m) => m.greeting).length;
  const hasSignOff = mails.filter((m) => m.signOff).length;
  return {
    messages: total,
    words: { median: percentile(words, 0.5), p80: percentile(words, 0.8) },
    sentenceWords: median(sentenceLengths),
    greetings: tally(mails.map((m) => m.greeting), total),
    noGreeting: ratio(total - hasGreeting, total),
    signOffs: tally(mails.map((m) => m.signOff), total),
    noSignOff: ratio(total - hasSignOff, total),
    exclamation: ratio(mails.filter((m) => m.text.includes("!") || m.text.includes("¡")).length, total),
    emoji: ratio(mails.filter((m) => EMOJI.test(m.text)).length, total),
    bullets: ratio(mails.filter((m) => BULLET.test(m.text)).length, total),
    lowercase: ratio(mails.filter((m) => startsLowercase(m.text)).length, total),
    languages: tally(mails.map((m) => m.language || null), total),
    replies: ratio(mails.filter((m) => m.isReply).length, total),
    oneToOne: ratio(mails.filter((m) => m.to.length + m.cc.length === 1).length, total),
  };
}

const MIN_N = 3;
const MAX_N = 8;
const MIN_MESSAGES = 3;
const MIN_RECIPIENTS = 2;
const MAX_WORDS_READ = 400;
const MAX_PHRASES = 20;

interface Gram {
  /** the casing seen most, by message */
  forms: Map<string, number>;
  messages: number;
  recipients: Set<string>;
}

/** Words of one sentence, with no digits and no addresses: a phrase never crosses a sentence, or holds a number. */
function phraseRuns(text: string): string[][] {
  const runs: string[][] = [];
  for (const sentence of text.slice(0, 8000).split(/[.!?…;:\n()]+/u)) {
    let run: string[] = [];
    for (const raw of sentence.trim().split(/\s+/)) {
      const word = raw.replace(/^[,"'“”‘’¿¡-]+|[,"'“”‘’-]+$/gu, "");
      if (word && /^\p{L}[\p{L}\p{M}'’-]*$/u.test(word)) {
        run.push(word);
      } else {
        if (run.length >= MIN_N) runs.push(run);
        run = [];
      }
    }
    if (run.length >= MIN_N) runs.push(run);
  }
  return runs;
}

/**
 * Word sequences of 3 to 8 in at least 3 messages to at least 2 recipients, with no digits (§2). Repetition across
 * recipients is what makes them safe: a private detail rarely recurs across unrelated people. Grown from what already
 * qualifies (each n only extends an (n-1) that made it), so a large corpus doesn't count every sequence in it.
 */
export function stockPhrases(mails: readonly WrittenMail[]): string[] {
  const runs = mails.map((m) => {
    let left = MAX_WORDS_READ;
    const kept: string[][] = [];
    for (const run of phraseRuns(m.text)) {
      if (left <= 0) break;
      kept.push(run.slice(0, left));
      left -= run.length;
    }
    return { recipients: m.to, runs: kept };
  });
  const found = new Map<string, { text: string; messages: number; n: number }>();
  let survivors: Set<string> | null = null;
  for (let n = MIN_N; n <= MAX_N; n++) {
    const grams = new Map<string, Gram>();
    for (const mail of runs) {
      const seen = new Map<string, string>();
      for (const run of mail.runs) {
        for (let i = 0; i + n <= run.length; i++) {
          const words = run.slice(i, i + n);
          const key = words.join(" ").toLowerCase();
          if (survivors && !survivors.has(key.slice(0, key.lastIndexOf(" ")))) continue;
          if (!seen.has(key)) seen.set(key, words.join(" "));
        }
      }
      for (const [key, form] of seen) {
        let gram = grams.get(key);
        if (!gram) grams.set(key, (gram = { forms: new Map(), messages: 0, recipients: new Set() }));
        gram.messages++;
        gram.forms.set(form, (gram.forms.get(form) ?? 0) + 1);
        for (const r of mail.recipients) gram.recipients.add(r);
      }
    }
    const next = new Set<string>();
    for (const [key, gram] of grams) {
      if (gram.messages < MIN_MESSAGES || gram.recipients.size < MIN_RECIPIENTS) continue;
      next.add(key);
      const text = [...gram.forms].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
      found.set(key, { text, messages: gram.messages, n });
    }
    if (next.size === 0) break;
    survivors = next;
  }
  // a part of a longer phrase, used no more often than the whole, says nothing the whole doesn't
  const kept = [...found].filter(([key, f]) => ![...found].some(([other, o]) => other !== key && o.messages >= f.messages && ` ${other} `.includes(` ${key} `)));
  return kept
    .sort((a, b) => b[1].messages * b[1].n - a[1].messages * a[1].n || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_PHRASES)
    .map(([, f]) => f.text);
}
