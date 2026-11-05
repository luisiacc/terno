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

/** The sentences of what was said: a greeting or a sign-off isn't one, and would make everyone look terse. */
function bodySentences(m: WrittenMail): string[] {
  const lines = m.text.split("\n").filter((l) => l.trim());
  const from = m.greeting ? 1 : 0;
  const to = lines.length - (m.signOff ? m.signOff.split("\n").length : 0);
  return sentences(lines.slice(from, Math.max(from, to)).join("\n"));
}

/** What habits need of one message: worked out once, then summed cheaply for every scope the message belongs to. */
export interface MailFeatures {
  words: number;
  sentenceLengths: number[];
  greeting: string | null;
  signOff: string | null;
  signature: string | null;
  exclamation: boolean;
  emoji: boolean;
  bullets: boolean;
  lowercase: boolean;
  language: string;
  isReply: boolean;
  oneToOne: boolean;
}

export function mailFeatures(m: WrittenMail): MailFeatures {
  return {
    words: m.words,
    sentenceLengths: bodySentences(m).map(countWords),
    greeting: m.greeting,
    signOff: m.signOff,
    signature: m.signature ?? null,
    exclamation: m.text.includes("!") || m.text.includes("¡"),
    emoji: EMOJI.test(m.text),
    bullets: BULLET.test(m.text),
    lowercase: startsLowercase(m.text),
    language: m.language,
    isReply: m.isReply,
    oneToOne: m.to.length + m.cc.length === 1,
  };
}

/** A generator for the same reason as `phraseSteps`: an account's window is thousands of messages, summed many ways. */
export function* habitsSteps(features: readonly MailFeatures[]): Generator<void, Habits, void> {
  const total = features.length;
  const words = features.map((m) => m.words).sort((a, b) => a - b);
  yield;
  const count = (test: (m: MailFeatures) => boolean) => {
    let n = 0;
    for (const m of features) if (test(m)) n++;
    return n;
  };
  const sentenceWords = median(features.flatMap((m) => m.sentenceLengths));
  yield;
  const greetings = tally(features.map((m) => m.greeting), total);
  const noGreeting = ratio(total - count((m) => !!m.greeting), total);
  yield;
  const signOffs = tally(features.map((m) => m.signOff), total);
  const noSignOff = ratio(total - count((m) => !!m.signOff), total);
  const signatures = tally(features.map((m) => m.signature), total);
  const noSignature = ratio(total - count((m) => !!m.signature), total);
  yield;
  const exclamation = ratio(count((m) => m.exclamation), total);
  const emoji = ratio(count((m) => m.emoji), total);
  const bullets = ratio(count((m) => m.bullets), total);
  const lowercase = ratio(count((m) => m.lowercase), total);
  yield;
  const languages = tally(features.map((m) => m.language || null), total);
  yield;
  return {
    messages: total,
    words: { median: percentile(words, 0.5), p80: percentile(words, 0.8) },
    sentenceWords,
    greetings,
    noGreeting,
    signOffs,
    noSignOff,
    signatures,
    noSignature,
    exclamation,
    emoji,
    bullets,
    lowercase,
    languages,
    replies: ratio(count((m) => m.isReply), total),
    oneToOne: ratio(count((m) => m.oneToOne), total),
  };
}

export function habitsOf(features: readonly MailFeatures[]): Habits {
  const steps = habitsSteps(features);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export const computeHabits = (mails: readonly WrittenMail[]): Habits => habitsOf(mails.map(mailFeatures));

function mergeShares(parts: readonly { habits: Habits; pick: (h: Habits) => readonly Share[] }[], total: number): Share[] {
  const counts = new Map<string, number>();
  for (const { habits, pick } of parts) for (const s of pick(habits)) counts.set(s.text, (counts.get(s.text) ?? 0) + s.share * habits.messages);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TOP)
    .map(([text, n]) => ({ text, share: ratio(n, total) }));
}

/**
 * "You" from the accounts' profiles, with no message read again: rates and shares weighted by volume, lengths a
 * weighted median of the accounts' medians. An estimate, and enough: the experiment found this level matters only
 * where an account has none of its own.
 */
export function mergeHabits(list: readonly Habits[]): Habits {
  const total = list.reduce((n, h) => n + h.messages, 0);
  const weighted = (pick: (h: Habits) => number) => (total === 0 ? 0 : Math.round((list.reduce((n, h) => n + pick(h) * h.messages, 0) / total) * 100) / 100);
  const weightedMedian = (pick: (h: Habits) => number) => {
    const sorted = [...list].sort((a, b) => pick(a) - pick(b));
    let seen = 0;
    for (const h of sorted) {
      seen += h.messages;
      if (seen * 2 >= total) return pick(h);
    }
    return 0;
  };
  const shares = (pick: (h: Habits) => readonly Share[]) => mergeShares(list.map((habits) => ({ habits, pick })), total);
  return {
    messages: total,
    words: { median: weightedMedian((h) => h.words.median), p80: weightedMedian((h) => h.words.p80) },
    sentenceWords: weightedMedian((h) => h.sentenceWords),
    greetings: shares((h) => h.greetings),
    noGreeting: weighted((h) => h.noGreeting),
    signOffs: shares((h) => h.signOffs),
    noSignOff: weighted((h) => h.noSignOff),
    exclamation: weighted((h) => h.exclamation),
    emoji: weighted((h) => h.emoji),
    bullets: weighted((h) => h.bullets),
    lowercase: weighted((h) => h.lowercase),
    languages: shares((h) => h.languages),
    replies: weighted((h) => h.replies),
    oneToOne: weighted((h) => h.oneToOne),
  };
}

/** "Thank you for", "de la calle": a sequence that starts or stops on one of these isn't a phrase, it's a fragment. */
const FUNCTION_WORDS = new Set("a an the and or but so of to for in on at by from with as if that this these those is are was were be i you he she we they it my your his her our their me him them de del la las el los lo le les un una unos unas y o e u pero que en por para con a al se su sus mi mis tu tus te nos es son no ni como más".split(" "));
const isFragment = (phrase: string) => {
  const words = phrase.toLowerCase().split(" ");
  return FUNCTION_WORDS.has(words[0]!) || FUNCTION_WORDS.has(words[words.length - 1]!);
};

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

/** Past this many qualifying sequences, only the likeliest are compared with each other (that step is quadratic). */
const MAX_FOUND = 1000;
/** How much of a sweep over what was counted runs between two looks at the clock: a corpus can qualify tens of thousands. */
const SWEEP_SLICE = 64;

interface Found {
  key: string;
  messages: number;
  n: number;
  forms: Map<string, number>;
}

/** Negative when `a` is likelier than `b`: the most used, weighing longer ones up, then by key so a tie is stable. */
const byUse = (a: Found, b: Found) => b.messages * b.n - a.messages * a.n || (a.key < b.key ? -1 : 1);

/** Holds the `MAX_FOUND` likeliest, with the least likely on top: a binary heap, so nothing ever sorts the lot. */
function offerFound(heap: Found[], entry: Found): void {
  if (heap.length === MAX_FOUND) {
    if (byUse(entry, heap[0]!) >= 0) return;
    heap[0] = entry;
    for (let at = 0; ; ) {
      const left = at * 2 + 1;
      const right = left + 1;
      let least = at;
      if (left < heap.length && byUse(heap[left]!, heap[least]!) > 0) least = left;
      if (right < heap.length && byUse(heap[right]!, heap[least]!) > 0) least = right;
      if (least === at) return;
      [heap[at], heap[least]] = [heap[least]!, heap[at]!];
      at = least;
    }
  }
  heap.push(entry);
  for (let at = heap.length - 1; at > 0; ) {
    const parent = (at - 1) >> 1;
    if (byUse(heap[at]!, heap[parent]!) <= 0) return;
    [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
    at = parent;
  }
}

/**
 * Word sequences of 3 to 8 in at least 3 messages to at least 2 recipients, with no digits (§2). Repetition across
 * recipients is what makes them safe: a private detail rarely recurs across unrelated people. Grown from what already
 * qualifies (each n only extends an (n-1) that made it), so a large corpus doesn't count every sequence in it.
 *
 * A generator: it yields at each message and comparison so a backend in slices can look at its clock.
 */
export function* phraseSteps(mails: readonly WrittenMail[]): Generator<void, string[], void> {
  const runs: { recipients: readonly string[]; runs: string[][] }[] = [];
  for (const m of mails) {
    let left = MAX_WORDS_READ;
    const kept: string[][] = [];
    for (const run of phraseRuns(m.text)) {
      if (left <= 0) break;
      kept.push(run.slice(0, left));
      left -= run.length;
    }
    runs.push({ recipients: m.to, runs: kept });
    yield;
  }
  const found: Found[] = [];
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
      yield;
    }
    const next = new Set<string>();
    let swept = 0;
    for (const [key, gram] of grams) {
      if (++swept % SWEEP_SLICE === 0) yield;
      if (gram.messages < MIN_MESSAGES || gram.recipients.size < MIN_RECIPIENTS) continue;
      next.add(key);
      offerFound(found, { key, messages: gram.messages, n, forms: gram.forms });
    }
    if (next.size === 0) break;
    survivors = next;
    yield;
  }
  const all: { key: string; messages: number; text: string }[] = [];
  for (const f of found.sort(byUse)) {
    all.push({ key: f.key, messages: f.messages, text: [...f.forms].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0] });
    if (all.length % SWEEP_SLICE === 0) yield;
  }
  // a part of a longer phrase, used no more often than the whole, says nothing the whole doesn't
  const kept: string[] = [];
  for (const f of all) {
    if (!isFragment(f.text) && !all.some((o) => o.key !== f.key && o.messages >= f.messages && !isFragment(o.text) && ` ${o.key} `.includes(` ${f.key} `))) kept.push(f.text);
    yield;
  }
  return kept.slice(0, MAX_PHRASES);
}

export function stockPhrases(mails: readonly WrittenMail[]): string[] {
  const steps = phraseSteps(mails);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** "You" from the accounts' phrases: the ones in most accounts, then the most used. */
export function mergePhrases(lists: readonly (readonly string[])[]): string[] {
  const seen = new Map<string, { text: string; lists: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    for (const text of list) {
      const key = text.toLowerCase();
      const entry = seen.get(key);
      if (entry) entry.lists++;
      else seen.set(key, { text, lists: 1, order: order++ });
    }
  }
  return [...seen.values()].sort((a, b) => b.lists - a.lists || a.order - b.order).slice(0, MAX_PHRASES).map((e) => e.text);
}
