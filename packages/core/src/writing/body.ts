/**
 * Plan 163: what someone wrote in the body when they press ⌘J, read on this machine. An instruction (words *about* the
 * email: "friday works for me, ask him to send the address") is written up; their own email with gaps in it ("the
 * address is [address from his last mail]") has only the gaps filled; their own email with nothing marked is expanded
 * into a suggestion beside it. Rules, never a model: the fast model is asked only when these can't tell (`unsure`, or
 * gaps only a reader of the sentence can call gaps).
 */

/** Where a gap is, in the text's characters (UTF-16, as `String.slice` counts). */
export interface BodyGap {
  from: number;
  to: number;
  text: string;
}

export type BodyKind = "empty" | "instruction" | "email" | "unsure";

export interface BodyRead {
  kind: BodyKind;
  /** gaps nobody needs to ask about: brackets with words, `{name}`, `<<x>>`, `XX`, `___` */
  gaps: BodyGap[];
  /** what may be a gap or may be punctuation (`…`, `??`, `TBD`, `xx`): only the fast model says */
  maybe: BodyGap[];
  /** which rule decided, for tests and the plan */
  rule: "empty" | "image" | "long" | "paragraphs" | "greeting" | "signoff" | "directive" | "gap" | "unsure";
}

/** What the composer does with a read: write from it, fill its gaps, expand it beside itself, or ask the fast model first. */
export type BodyAction = "oneTap" | "write" | "fill" | "expand" | "ask";

/** A press reads this much; past it, the text is an email and only its first stretch is searched for gaps. */
export const BODY_READ_MAX = 100_000;
/** The Sparkles' glance while typing reads this much. */
export const BODY_GLANCE_MAX = 20_000;
/** An instruction is at most what `ai.compose` takes as one (`WRITING_ONE_OFF_MAX`). */
const INSTRUCTION_MAX = 1000;

/** Accents off and lower case, for matching words in either language. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ─── gaps ──────────────────────────────────────────────────────────────────

const SQUARE = /\[([^[\]\n]{0,80})\](?!\()/g;
const DOUBLE_CURLY = /\{\{([^{}\n]{1,60})\}\}/g;
const CURLY = /(?<!\{)\{([^{}\n]{1,60})\}(?!\})/g;
/** bracketed words that are a writer's mark, never a hole */
const NOT_GAPS = new Set(["sic", "sic!", "citation needed", "emphasis added", "emphasis mine", "énfasis añadido"]);
const ANGLE = /<<([^<>\n]{1,60})>>/g;
const XS = /(?<![\p{L}\p{N}])[$€£]?X{2,}(?:[/:.,-]X{2,})*(?![\p{L}\p{N}]|-\p{L})/gu;
const UNDERSCORES = /_{3,}/g;
/** a task box: `- [ ]`, `* [x]`, `1. [ ]` at a line's start */
const TASK_BOX = /(?:^|\n)[ \t]*(?:[-*•]|\d+[.)])[ \t]+$/;

const MAYBE_ELLIPSIS = /(?<=^|[\s:])(?:…|\.{3})(?=\s|$)/g;
const MAYBE_QUESTIONS = /(?<![\p{L}\p{N}?])\?{2,}(?![\p{L}\p{N}?])/gu;
const MAYBE_TBD = /(?<![\p{L}\p{N}])(?:TBD|TBC)(?![\p{L}\p{N}])/gu;
const MAYBE_XX = /(?<![\p{L}\p{N}])x{2,}(?![\p{L}\p{N}])/gu;

function certainGaps(text: string): BodyGap[] {
  const out: BodyGap[] = [];
  const add = (from: number, to: number) => out.push({ from, to, text: text.slice(from, to) });
  for (const m of text.matchAll(SQUARE)) {
    const inside = m[1]!.trim();
    // a footnote's number, or a task box in a list
    if (/^\d+$/.test(inside) || NOT_GAPS.has(inside.toLowerCase())) continue;
    if (/^[ xX]?$/.test(m[1]!) && TASK_BOX.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    add(m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(DOUBLE_CURLY)) if (/\p{L}/u.test(m[1]!)) add(m.index, m.index + m[0].length);
  for (const m of text.matchAll(ANGLE)) if (/\p{L}/u.test(m[1]!)) add(m.index, m.index + m[0].length);
  // a bare `XX` may be the numeral twenty: only the model says (maybe)
  for (const m of text.matchAll(XS)) if (m[0] !== "XX") add(m.index, m.index + m[0].length);
  for (const m of text.matchAll(UNDERSCORES)) add(m.index, m.index + m[0].length);
  return dedupe(out);
}

function maybeGaps(text: string, certain: readonly BodyGap[]): BodyGap[] {
  const out: BodyGap[] = [];
  const lines = text.trimEnd();
  const lastLine = lines.slice(lines.lastIndexOf("\n") + 1);
  const lastLineAt = lines.length - lastLine.length;
  for (const re of [MAYBE_ELLIPSIS, MAYBE_QUESTIONS, MAYBE_TBD, MAYBE_XX, CURLY, XS]) {
    for (const m of text.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      // a single pair of braces holding a short name (`{address}`; never `{"a": 1}`), and a bare `XX`
      if (re === CURLY && !(/^[\p{L}\p{N}_-](?:[\p{L}\p{N} _-]*[\p{L}\p{N}_-])?$/u.test(m[1]!) && /\p{L}/u.test(m[1]!))) continue;
      if (re === XS && m[0] !== "XX") continue;
      // kisses on the last line ("Bea xx") are a sign-off, not a hole
      if (re === MAYBE_XX && from >= lastLineAt) continue;
      if (certain.some((g) => from < g.to && to > g.from)) continue;
      out.push({ from, to, text: m[0] });
    }
  }
  return dedupe(out);
}

/** In order, and no two overlapping (the first one found keeps its place). */
function dedupe(gaps: BodyGap[]): BodyGap[] {
  const sorted = [...gaps].sort((a, b) => a.from - b.from || b.to - a.to);
  const out: BodyGap[] = [];
  for (const g of sorted) if (!out.some((o) => g.from < o.to && g.to > o.from)) out.push(g);
  return out;
}

// ─── instruction or email ──────────────────────────────────────────────────

/** A greeting on the first line, followed by a name or punctuation, not by a sentence ("hey can you…" isn't one). */
const GREETING = /^(?:hi|hello|hey|dear|hiya|greetings|good (?:morning|afternoon|evening)|hola|buenas(?: tardes| noches)?|buenos dias|buen dia|estimad[oa]s?|querid[oa]s?|que tal)(?:[ \t]+[\p{L}.'-]+){0,3}[ \t]*(?:[,!:]|$)/u;
/** A sign-off on its own line near the end, alone or with a name after it. */
const SIGNOFF = /^(?:thanks|thank you|thx|many thanks|best|best regards|all the best|regards|kind regards|warm regards|warmly|cheers|sincerely|yours|love|take care|saludos|un saludo|saludos cordiales|un abrazo|abrazos|un beso|besos|atentamente|cordialmente|gracias|muchas gracias|mil gracias)[ \t]*[,.!]?(?:[ \t]+[\p{L}.'-]+){0,3}$/u;

/** An imperative to write or say something, at a sentence's start, and not to the reader ("tell me", "thank you"). */
/** A name as an object: "tell Tom", "ask Ana" (capitalised, as people type names; "tell tom" is lower case but a reply's to him) */
const NAME = String.raw`[\p{Lu}][\p{L}'-]+`;
/**
 * Plan 163, Codex review: only words to the assistant about someone else. A bare imperative ("Confirm the appointment",
 * "decline politely") can be said to the reader, so it decides nothing.
 */
const DIRECTIVE_EN = new RegExp(
  String.raw`(?:^|[\s,;(])(?:please +|pls +)?(?:(?:ask|tell|remind|thank) +(?:him|her|them|${NAME})\b|let +(?:him|her|them|${NAME}) +know\b|(?:say|reply|answer|respond|write back) +(?:that|yes|no)\b)`,
  "u",
);
/** "tell tom that…", lower case: a verb at the very start, then a word, then what to say */
const DIRECTIVE_EN_START = /^(?:please +|pls +)?(?:tell|ask|remind|thank) +(?!me\b|us\b|you\b|everyone\b)[\p{L}'-]+ +(?:that|to|if|whether|about|for|the|i|we|it's|its)\b/u;
/** Spanish, accents folded: the clitic says it's to someone else (dile, pregúntale…), or "di que", "responde que" */
const DIRECTIVE_ES = /(?:^|[\s,;(])(?:por favor +)?(?:dile|digale|diles|diganle|preguntale|preguntele|preguntales|pidele|pidale|pideles|avisale|avisales|contestale|contestales|respondele|respondeles|agradecele|agradeceles|recuerdale|recuerdales|escribele|escribeles|di que|responde que|contesta que|dile a|preguntale a)\b/u;
/** The reader's words: an instruction never has them, an email to them often does */
const READER = /\b(?:you|your|yours|you're|you'll|you've)\b|(?:^|[\s¿¡,])(?:tu|tus|te|usted|ustedes|puedes|podrias|podria|pudieras|me pasas|me mandas|me envias|me dices|sabes|tienes|quieres)\b/u;

function directive(text: string): boolean {
  const folded = fold(text);
  if (READER.test(folded)) return false;
  // the verbs in any case, a name only capitalised
  const verbs = text.replace(/\b(?:please|pls|ask|tell|remind|thank|let|know|say|reply|answer|respond|write|back|that|yes|no|him|her|them)\b/giu, (w) => w.toLowerCase());
  return DIRECTIVE_EN.test(verbs) || DIRECTIVE_EN_START.test(folded) || DIRECTIVE_ES.test(folded);
}

function greets(firstLine: string): boolean {
  return GREETING.test(fold(firstLine.trim()));
}

function signsOff(lines: readonly string[]): boolean {
  if (lines.length < 2) return false;
  // the last line, or the one before a name alone
  const tail = lines.slice(-2).map((l) => fold(l.trim()));
  return tail.some((l, i) => SIGNOFF.test(l) && (i === tail.length - 1 || /^[\p{L}.'-]+(?: [\p{L}.'-]+){0,2}$/u.test(tail[i + 1]!)));
}

/**
 * Reads the body. `images`: it holds one (it's never an instruction then: an image is the user's own email). `limit`: how
 * much is read (the button's glance reads less than a press).
 */
export function readBody(raw: string, o: { images?: boolean; limit?: number } = {}): BodyRead {
  const text = raw.length > (o.limit ?? BODY_READ_MAX) ? raw.slice(0, o.limit ?? BODY_READ_MAX) : raw;
  const trimmed = text.trim();
  if (!trimmed && !o.images) return { kind: "empty", gaps: [], maybe: [], rule: "empty" };
  const gaps = certainGaps(text);
  // a stray `…` beside gaps marked the certain way is punctuation: they've shown how they mark one
  const maybe = gaps.length ? [] : maybeGaps(text, gaps);
  const read = (kind: BodyKind, rule: BodyRead["rule"]): BodyRead => ({ kind, gaps, maybe, rule });
  if (o.images) return read("email", "image");
  if (raw.trim().length > INSTRUCTION_MAX) return read("email", "long");
  const paragraphs = trimmed.split(/\n[ \t]*\n/).filter((p) => p.trim());
  if (paragraphs.length >= 3) return read("email", "paragraphs");
  const lines = trimmed.split("\n").filter((l) => l.trim());
  if (greets(lines[0]!)) return read("email", "greeting");
  if (signsOff(lines)) return read("email", "signoff");
  if (directive(trimmed)) return read("instruction", "directive");
  if (gaps.length) return read("email", "gap");
  return read("unsure", "unsure");
}

/** What a read asks of the composer, before any model. */
export function bodyAction(read: BodyRead): BodyAction {
  switch (read.kind) {
    case "empty":
      return "oneTap";
    case "instruction":
      return "write";
    case "unsure":
      return "ask";
    case "email":
      return read.gaps.length ? "fill" : read.maybe.length ? "ask" : "expand";
  }
}

/** The fast model's answer, as the composer acts on it: unknown ids were refused before here. */
export interface BodyVerdict {
  kind: "instruction" | "email";
  /** indexes into `read.maybe` that are gaps */
  gaps: readonly number[];
}

/**
 * The read after the fast model (`verdict`), or without it (`null`: it failed, or couldn't be asked): unsure is then an
 * email, and a maybe-gap stays as typed. Rules the model can't override: what the rules called an email stays one.
 */
export function settleBody(read: BodyRead, verdict: BodyVerdict | null): { action: Exclude<BodyAction, "ask">; gaps: BodyGap[] } {
  const kind = read.kind === "unsure" ? (verdict?.kind ?? "email") : read.kind;
  if (kind === "empty") return { action: "oneTap", gaps: [] };
  if (kind === "instruction") return { action: "write", gaps: [] };
  const confirmed = verdict ? verdict.gaps.map((i) => read.maybe[i]).filter((g): g is BodyGap => g !== undefined) : [];
  const gaps = dedupe([...read.gaps, ...confirmed]);
  return { action: gaps.length ? "fill" : "expand", gaps };
}

/** The Sparkles' glance: lit when the body reads as an instruction or holds a gap marked the certain way. */
export function bodyReady(text: string, o: { images?: boolean } = {}): "write" | "fill" | null {
  const read = readBody(text, { ...o, limit: BODY_GLANCE_MAX });
  if (read.kind === "instruction") return "write";
  if (read.kind === "email" && read.gaps.length) return "fill";
  return null;
}
