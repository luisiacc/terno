import { detectWritingLanguage } from "./language";
import { normalizeText } from "../text";
import type { SentMail, WrittenMail } from "./types";

/**
 * Plan 133 §2: what the user wrote in a sent message. Unlike the phrase model's `ownText`, this doesn't stop at the
 * attribution line, because an answer written below a quoted question is the most useful text in the mail.
 */

const MAX_BODY = 64 * 1024;

/** a line that introduces a quote: only a quote if `>` lines follow it */
const ATTRIBUTION = /^(on\b.{0,300}\bwrote:?|el\b.{0,300}\bescribi[oó]:?|le\b.{0,300}\ba [ée]crit\s?:?|am\b.{0,300}\bschrieb.{0,100}:)$/i;
/** everything after one of these is someone else's mail, quoted without `>` */
const QUOTED_BLOCK = /^(-{2,}\s*(original message|mensaje original|forwarded message|mensaje reenviado|message d'origine)\s*-{2,}|_{8,})$/i;
const OUTLOOK_FROM = /^(from|de|von|da):\s.*(@|\[mailto).*$/i;
const OUTLOOK_NEXT = /^(sent|enviado|date|fecha|to|para|subject|asunto):\s/i;
const DEVICE_LINE = /^(sent from|enviado desde|get outlook for)\b.{0,60}$/i;

const CLOSING_WORDS = "thanks|thank you|thx|ty|many thanks|best|all the best|best regards|kind regards|warm regards|regards|warmly|cheers|sincerely|yours|love|lots of love|hugs|take care|talk soon|ttyl|speak soon|see you|xo+|x+|saludos|un saludo|muchos saludos|cordiales saludos|reciba un cordial saludo|reciban un cordial saludo|un cordial saludo|atentamente|cordialmente|un abrazo|abrazos|un beso|besos|gracias|muchas gracias|nos vemos|hablamos";
const CLOSING = new RegExp(`^(?:${CLOSING_WORDS})(?:\\s+\\S+){0,2}[\\s.,!~-]*$`, "iu");
const GREETING_WORDS = /^(hi+|hiya|hello|hey+a?|dear|good (?:morning|afternoon|evening)|morning|afternoon|evening|hola+|buenas(?: tardes| noches)?|buenos d[ií]as|estimad[oa]s?|apreciad[oa]s?|querid[oa]s?|bonjour|salut|hallo|ciao|ol[aá]|oi)\b/iu;
const GROUP = /^(all|team|everyone|everybody|there|folks|guys|y'all|todos|todas|equipo|a todos|a todas)$/iu;
const TITLES = /^(sr\.?|sra\.?|srta\.?|dr\.?|dra\.?|lic\.?|don|doña|mr\.?|mrs\.?|ms\.?|prof\.?)$/iu;
/** a first line of one of these isn't someone's name */
const NOT_A_NAME = /^(yes|no|ok|okay|sure|yep|nope|thanks|hmm|right|great|perfect|s[ií]|claro|vale|bueno|perfecto|gracias)$/iu;

const flatten = (line: string) => line.trim().replace(/\s+/g, " ");

function firstPass(body: string): string[] {
  const lines = body.slice(0, MAX_BODY).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inSignature = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.startsWith(">")) {
      inSignature = false;
      continue;
    }
    if (ATTRIBUTION.test(t)) {
      let next = i + 1;
      while (next < lines.length && lines[next]!.trim() === "") next++;
      // no `>` below it: the original follows unmarked (a plain-text rendering of a blockquote), so it's not theirs
      if (next >= lines.length || !lines[next]!.trim().startsWith(">")) break;
      continue;
    }
    if (QUOTED_BLOCK.test(t)) break;
    if (OUTLOOK_FROM.test(t) && OUTLOOK_NEXT.test(lines[i + 1]?.trim() ?? "")) break;
    if (line === "-- " || t === "--") {
      inSignature = true;
      continue;
    }
    if (inSignature || DEVICE_LINE.test(t)) continue;
    out.push(line.trimEnd());
  }
  return out;
}

const dropTrailingBlank = (lines: string[]) => {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return end === lines.length ? lines : lines.slice(0, end);
};

/** The account's exact signature, only as a suffix: the same words in a sentence are the user's. */
function stripSignature(lines: string[], signature: string | null | undefined): string[] {
  const sig = (signature ?? "").split(/\r?\n/).map(flatten).filter(Boolean);
  const kept = dropTrailingBlank(lines);
  if (sig.length === 0) return kept;
  const nonBlank: number[] = [];
  for (let i = kept.length - 1; i >= 0 && nonBlank.length < sig.length; i--) if (kept[i]!.trim()) nonBlank.unshift(i);
  if (nonBlank.length < sig.length) return kept;
  if (!sig.every((s, i) => flatten(kept[nonBlank[i]!]!) === s)) return kept;
  return dropTrailingBlank(kept.slice(0, nonBlank[0]!));
}

/** A closing or a bare name repeats as well ("B xx", "Tom Reed"), and those are habits, not boilerplate. */
const isBoilerplate = (line: string) => line.split(" ").length >= 3 && !CLOSING.test(line);

/** Lines that keep ending this account's mail (a role, a phone, a slogan), to take off along with the signature. */
export function repeatedTrailers(bodies: readonly string[], signature?: string | null): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    const lines = stripSignature(firstPass(body), signature).map(flatten).filter(Boolean);
    // the last line of a one-liner is the message itself
    if (lines.length < 2) continue;
    for (const line of new Set(lines.slice(-3))) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const needed = Math.max(5, Math.ceil(bodies.length * 0.3));
  const out = new Set<string>();
  for (const [line, n] of counts) if (n >= needed && isBoilerplate(line)) out.add(line);
  return out;
}

/**
 * The same count as `repeatedTrailers`, one message at a time over its `writtenText`, so a learner in slices needn't
 * hold every body to know what repeats.
 */
export class TrailerCounter {
  private readonly counts = new Map<string, number>();
  private bodies = 0;

  add(written: string): void {
    this.bodies++;
    const lines = written.split("\n").map(flatten).filter(Boolean);
    if (lines.length < 2) return;
    for (const line of new Set(lines.slice(-3))) this.counts.set(line, (this.counts.get(line) ?? 0) + 1);
  }

  trailers(): ReadonlySet<string> {
    const needed = Math.max(5, Math.ceil(this.bodies * 0.3));
    const out = new Set<string>();
    for (const [line, n] of this.counts) if (n >= needed && isBoilerplate(line)) out.add(line);
    return out;
  }
}

export interface ExtractContext {
  signature?: string | null;
  trailers?: ReadonlySet<string>;
}

function takeTrailers(lines: string[], trailers: ReadonlySet<string> | undefined): string[] {
  if (trailers?.size) while (lines.length > 0 && trailers.has(flatten(lines[lines.length - 1]!))) lines = dropTrailingBlank(lines.slice(0, -1));
  return lines;
}

export function writtenText(body: string, context: ExtractContext = {}): string {
  return takeTrailers(stripSignature(firstPass(body), context.signature), context.trailers).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** `writtenText`'s last step, for text already through the rest of it. */
export const withoutTrailers = (text: string, trailers: ReadonlySet<string>): string => takeTrailers(text.split("\n"), trailers).join("\n").trim();

/** `Hi Tom,` → `Hi {name},`. Titles stay: `Estimado Sr. García:` says something `Estimado {name}:` wouldn't. */
export function normalizeGreeting(text: string, toNames: readonly string[] = []): string | null {
  const first = text.split("\n").find((l) => l.trim())?.trim();
  if (!first) return null;
  const names = toNames.map(normalizeText);
  const isName = (w: string) => names.includes(normalizeText(w.replace(/[.,!:;]+$/, "")));
  const greeting = GREETING_WORDS.exec(first);
  if (greeting) {
    const word = greeting[1]!;
    const rest = first.slice(word.length);
    const stop = /[,!:;—–]|\s-\s|\.(?=\s|$)/u.exec(rest.replace(/\b(sr|sra|srta|dr|dra|lic|mr|mrs|ms|prof)\./giu, "$1\u0000"));
    const head = (stop ? rest.slice(0, stop.index) : rest).trim();
    const punctuation = stop ? stop[0].trim() : "";
    const words = head ? head.split(/\s+/) : [];
    // no punctuation and many words: only a known name lets us say where the greeting ends
    if (!stop && words.length > 0 && !isName(words[0]!)) return word;
    if (words.length > 4) return word;
    if (words.length === 0) return `${word}${punctuation}`;
    if (GROUP.test(head)) return `${word} ${head}${punctuation}`;
    const titles: string[] = [];
    for (const w of words) {
      if (!TITLES.test(w)) break;
      titles.push(w);
    }
    return `${[word, ...titles, nameSlot(words[titles.length] ?? "")].join(" ")}${punctuation}`;
  }
  // "IVY!! omg yes": the recipient's own name, shouted or not, opening a line that goes on
  const called = /^(\p{L}[\p{L}'’-]*)([!,:]+)/u.exec(first);
  if (called && isName(called[1]!)) return `${nameSlot(called[1]!)}${called[2]}`;
  const bare = /^(\p{L}[\p{L}'’-]*(?: \p{L}[\p{L}'’-]*)?)\s*([,:]|\s-)$/u.exec(first);
  if (bare && !NOT_A_NAME.test(bare[1]!) && !CLOSING.test(first)) {
    const named = isName(bare[1]!.split(" ")[0]!);
    if (named || /^\p{Lu}/u.test(bare[1]!)) return `${nameSlot(bare[1]!)}${bare[2]!.trim()}`;
  }
  return null;
}

/** Someone who types `hi tom,` types it for Wes too: the case of a name is part of the habit. */
const nameSlot = (typed: string) => (/^\p{Lu}{2,}$/u.test(typed) ? "{NAME IN CAPITALS}" : /^\p{Ll}/u.test(typed) ? "{name in lowercase}" : "{name}");

const SELF_MARK = /^[-–—~]\s*(\p{L}{1,14})\.?$/u;

/**
 * How a message ends, as typed: `Best,\nTom`, `-m`, `Rodri`. Not normalized like a greeting: the sender's own name is
 * theirs to use, and `-m` vs `-milo` vs `Milo Trask` is exactly the habit. A one-line message is the message.
 */
export function normalizeSignOff(text: string, selfNames: readonly string[] = []): string | null {
  const lines = text.split("\n").map(flatten).filter(Boolean);
  if (lines.length < 2) return null;
  const self = new Set(selfNames.flatMap((n) => normalizeText(n).split(/\s+/)));
  const isSelf = (line: string) => {
    const bare = normalizeText(line.replace(/[.,!]+$/, ""));
    return bare.split(/\s+/).every((w) => self.has(w)) || (bare.length === 1 && [...self].some((w) => w.startsWith(bare)));
  };
  const last = lines[lines.length - 1]!;
  const prev = lines[lines.length - 2]!;
  const mark = SELF_MARK.exec(last);
  if (mark && (isSelf(mark[1]!) || mark[1]!.length <= 2)) return last;
  if (isSelf(last)) return lines.length > 2 && CLOSING.test(prev) ? `${prev}\n${last}` : last;
  // "Love you lots,\nB xx": the name is in the closing's kiss
  if (lines.length > 2 && CLOSING.test(prev) && /^\p{L}{1,14}\s+x+$/iu.test(last) && isSelf(last.split(/\s+/)[0]!)) return `${prev}\n${last}`;
  return CLOSING.test(last) ? last : null;
}

export const countWords = (text: string): number => text.match(/\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+(?:[.,:]\p{N}+)*/gu)?.length ?? 0;

export interface CorpusContext {
  signature?: string | null;
  /** the sender's name, for sign-offs */
  selfNames?: readonly string[];
  /** a recipient's name tokens, for greetings */
  namesOf?: (address: string) => readonly string[];
}

/** A message and the text the user wrote in it, as the rest of the pipeline reads it. */
export function reduceMail(m: Omit<SentMail, "body">, text: string, context: CorpusContext = {}): WrittenMail {
  const toNames = context.namesOf ? m.to.flatMap((a) => context.namesOf!(a)) : [];
  return {
    id: m.id,
    to: m.to,
    cc: m.cc,
    at: m.at,
    isReply: m.isReply,
    bulk: m.bulk ?? false,
    fromModel: m.fromModel ?? false,
    text,
    words: countWords(text),
    greeting: normalizeGreeting(text, toNames),
    signOff: normalizeSignOff(text, context.selfNames),
    language: detectWritingLanguage(text),
  };
}

/** One account's sent mail, reduced. The trailers are measured on all of it, so call it per account. */
export function readCorpus(mails: readonly SentMail[], context: CorpusContext = {}): WrittenMail[] {
  const trailers = repeatedTrailers(mails.map((m) => m.body), context.signature);
  return mails.map((m) => reduceMail(m, writtenText(m.body, { signature: context.signature, trailers }), context));
}
