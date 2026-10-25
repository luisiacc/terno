import type { SentText } from "../autocomplete-source";
import type { Revision } from "../search";
import { packSnapshot, readSnapshot, sealSnapshot, type SnapshotKind } from "../instant/snapshot";
import { readStrings } from "./strings";
import type { SliceClock } from "../instant/slices";
import { Bitset } from "./bitset";
import { fold } from "./fold";

/**
 * The body's ghost text (plan 18 §4): a small n-gram model of the user's own
 * sent mail. Contexts of up to three previous words map to their four most
 * frequent continuations (Space-Saving counts) in one fixed-size table of
 * typed arrays, so memory is bounded whatever the mailbox; greetings learn a
 * `<name>` slot filled with the draft's recipient. A suggestion examines only
 * the text right before the caret: its cost doesn't depend on the draft.
 */

export interface PhraseCaps {
  /** context slots (a power of two) */
  slots: number;
  /** distinct words */
  words: number;
}

export const DESKTOP_PHRASE_CAPS: PhraseCaps = { slots: 1 << 18, words: 60_000 };
export const WEB_PHRASE_CAPS: PhraseCaps = { slots: 1 << 17, words: 60_000 };

const K = 4;
const MAX_ORDER = 3;
const MAX_OWN_TEXT = 4096;
const MAX_WINDOW = 1000;
const MAX_TOKENS_OUT = 8;
const MIN_COUNT = 3;
const LOAD = 0.7;
const MAX_PROBE = 64;

// reserved word ids
const S = 0;
const NAME = 1;
const ME = 2;
const UNK = 3;
const END = 4;
const RESERVED = ["<s>", "<name>", "<me>", "<unk>", "</s>"];

const LANG_OTHER = 0;
const LANG_EN = 1;
const LANG_ES = 2;
const EN = new Set("the and you to is for that it of thanks please we be will have this with are can your on".split(" "));
const ES = new Set("el la que de y en los las por para con una un es gracias saludos hola nos te lo".split(" "));
const GREETINGS = new Set(["hi", "hello", "hey", "dear", "morning", "afternoon", "evening", "hola", "buenas", "buenos", "estimado", "estimada", "querido", "querida", "tal", "días", "dias", "tardes", "noches", "bonjour", "salut", "hallo", "ciao", "olá", "oi"]);
const PUNCT = new Set([",", ".", "!", "?", ";", ":"]);
const SENTENCE_END = new Set([".", "!", "?"]);

/** words, numbers (3:30, 1,000.50) and punctuation */
const TOKEN = /\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+(?:[.,:]\p{N}+)*|[.,!?;:]/gu;
/** where quoted mail starts: attribution lines and forward headers, in the languages mail clients write them in */
const ATTRIBUTION = /^(on\b.{0,300}\bwrote:?$|el\b.{0,300}\bescribi[oó]:?$|le\b.{0,300}\ba [ée]crit\s?:?$|am\b.{0,300}\bschrieb.{0,100}:$|-{2,}\s*(original message|mensaje original|forwarded message|mensaje reenviado|message d'origine)\s*-{2,}$|_{8,}$|(from|de|von|da):\s.*(@|\[mailto).*$|sent from my .+$|enviado desde mi .+$)/i;

/** What the user wrote in a sent message: no quote, no forwarded part, no signature, at most 4 KB. */
export function ownText(body: string): string {
  const lines = body.slice(0, 64 * 1024).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    const t = line.trim();
    if (line === "-- " || t === "--") break;
    if (ATTRIBUTION.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
    size += line.length + 1;
    if (size >= MAX_OWN_TEXT) break;
  }
  return out.join("\n").slice(0, MAX_OWN_TEXT);
}

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** en / es / other from stopword hits (at least two, and more than the other language's). */
export function detectLanguage(text: string): number {
  let en = 0;
  let es = 0;
  for (const w of tokenize(text.slice(-2000))) {
    const l = w.toLowerCase();
    if (EN.has(l)) en++;
    else if (ES.has(l)) es++;
  }
  if (en >= 2 && en > es) return LANG_EN;
  if (es >= 2 && es > en) return LANG_ES;
  return LANG_OTHER;
}

const firstName = (name: string) => fold(name.trim().split(/[\s,]+/)[0] ?? "");

/** Two independent 32-bit hashes of a context (order, word ids, language when it starts a sentence). */
function hashContext(ids: readonly number[], from: number, to: number, lang: number): [number, number] {
  let h1 = 0x811c9dc5 ^ (to - from);
  let h2 = 0x9e3779b9 ^ ((to - from) * 0x85ebca6b);
  for (let i = from; i < to; i++) {
    const v = ids[i]!;
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 ^ (v + 0x7f4a7c15), 0xc2b2ae35);
    h2 ^= h2 >>> 13;
  }
  if (ids[from] === S) {
    h1 = Math.imul(h1 ^ (lang + 0x51), 0x01000193);
    h2 = Math.imul(h2 ^ (lang + 0x3c6ef372), 0xc2b2ae35);
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 16;
  return [h1 >>> 0 || 1, h2 >>> 0];
}

export interface PhraseSuggestInput {
  /** the text right before the caret (only its end is read) */
  before: string;
  /** first names of the draft's recipients (the first fills a learned greeting) */
  names?: readonly string[];
  /** the sender's name (fills a learned sign-off) */
  me?: string;
}

export const PHRASES_SNAPSHOT: Omit<SnapshotKind, "identity"> = { tokenizer: 1, format: 1 };

interface Table {
  k1: Uint32Array;
  k2: Uint32Array;
  tot: Uint32Array;
  nid: Uint32Array;
  ncnt: Uint32Array;
  /** Space-Saving's error: the count a continuation inherited when it replaced another (count − err is guaranteed) */
  nerr: Uint16Array;
  used: number;
}

function newTable(slots: number): Table {
  return { k1: new Uint32Array(slots), k2: new Uint32Array(slots), tot: new Uint32Array(slots), nid: new Uint32Array(slots * K), ncnt: new Uint32Array(slots * K), nerr: new Uint16Array(slots * K), used: 0 };
}

let unboundedForTests = false;
/** The perf suite's injected-regression twin for suggestions: reads all of `before`, not just its end. */
export function setPhrasesUnboundedForTests(on: boolean): void {
  unboundedForTests = on;
}

let slowForTests = 0;
/** The perf suite's injected-regression twin: busy work per learned message (ms). */
export function setPhrasesSlowdownForTests(ms: number): void {
  slowForTests = ms;
}

export class PhraseModel {
  private table: Table;
  private readonly vocab = new Map<string, number>();
  private words: string[] = [...RESERVED];
  /** how each word is written mid-sentence: lowercase, Capitalized, UPPER, otherwise (then `mixed`) */
  private lower = new Uint32Array(64);
  private cap = new Uint32Array(64);
  private upper = new Uint32Array(64);
  private other = new Uint32Array(64);
  private readonly mixed = new Map<number, string>();
  private wordChars = 0;
  private readonly langs = new Uint32Array(3);
  private readonly learned = new Bitset();
  readonly caps: PhraseCaps;
  revision: Revision | null = null;
  changes = 0;
  messages = 0;

  constructor(caps: PhraseCaps = DESKTOP_PHRASE_CAPS) {
    this.caps = caps;
    this.table = newTable(caps.slots);
    for (let i = 0; i < RESERVED.length; i++) this.vocab.set(RESERVED[i]!, i);
  }

  hasLearned(id: number): boolean {
    return this.learned.has(id);
  }

  /** Full: pruning is due (the service runs it in slices). */
  needsPrune(): boolean {
    return this.table.used > this.caps.slots * LOAD;
  }

  private wordId(word: string, add: boolean): number {
    const key = word.toLowerCase();
    let id = this.vocab.get(key);
    if (id !== undefined) return id;
    if (!add || this.words.length >= this.caps.words + RESERVED.length) return UNK;
    id = this.words.length;
    this.words.push(key);
    this.vocab.set(key, id);
    this.wordChars += key.length;
    if (id >= this.lower.length) {
      const grow = (a: Uint32Array) => {
        const b = new Uint32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.lower = grow(this.lower);
      this.cap = grow(this.cap);
      this.upper = grow(this.upper);
      this.other = grow(this.other);
    }
    return id;
  }

  private countForm(id: number, word: string): void {
    if (id < RESERVED.length) return;
    const lower = word.toLowerCase();
    if (word === lower) this.lower[id]!++;
    else if (word === word.toUpperCase() && word.length > 1) this.upper[id]!++;
    else if (word[0] === word[0]!.toUpperCase() && word.slice(1) === lower.slice(1)) this.cap[id]!++;
    else {
      this.other[id]!++;
      if (!this.mixed.has(id)) this.mixed.set(id, word);
    }
  }

  /** How a word is written when it isn't starting a sentence. */
  private surface(id: number): string {
    const w = this.words[id]!;
    const lo = this.lower[id]!;
    const ca = this.cap[id]!;
    const up = this.upper[id]!;
    const ot = this.other[id]!;
    if (ot > lo && ot > ca && ot > up) return this.mixed.get(id) ?? w;
    if (up > lo && up > ca) return w.toUpperCase();
    if (ca > lo) return w[0]!.toUpperCase() + w.slice(1);
    return w;
  }

  private find(t: Table, h1: number, h2: number, insert: boolean): number {
    const mask = t.k1.length - 1;
    let i = (h1 ^ Math.imul(h2, 0x27d4eb2d)) & mask;
    for (let p = 0; p < MAX_PROBE; p++, i = (i + 1) & mask) {
      const k = t.k1[i]!;
      if (k === 0) {
        if (!insert) return -1;
        t.k1[i] = h1;
        t.k2[i] = h2;
        t.used++;
        return i;
      }
      if (k === h1 && t.k2[i] === h2) return i;
    }
    return -1;
  }

  private observe(h1: number, h2: number, next: number): void {
    const t = this.table;
    const slot = this.find(t, h1, h2, true);
    if (slot < 0) return;
    t.tot[slot]!++;
    const base = slot * K;
    let empty = -1;
    let min = 0;
    for (let j = 0; j < K; j++) {
      const c = t.ncnt[base + j]!;
      if (c === 0) {
        if (empty < 0) empty = j;
        continue;
      }
      if (t.nid[base + j] === next) {
        t.ncnt[base + j] = c + 1;
        return;
      }
      if (t.ncnt[base + min] === 0 || c < t.ncnt[base + min]!) min = j;
    }
    if (empty >= 0) {
      t.nid[base + empty] = next;
      t.ncnt[base + empty] = 1;
      t.nerr[base + empty] = 0;
      return;
    }
    // Space-Saving: the newcomer takes the smallest slot, with its count plus one (that count is its error)
    t.nid[base + min] = next;
    t.nerr[base + min] = Math.min(0xffff, t.ncnt[base + min]!);
    t.ncnt[base + min]!++;
  }

  /** Learns one sent message once. */
  learn(m: SentText): void {
    if (this.learned.has(m.id)) return;
    this.learned.set(m.id);
    this.changes++;
    this.messages++;
    if (slowForTests) for (const end = performance.now() + slowForTests; performance.now() < end; );
    const text = ownText(m.text);
    if (!text.trim()) return;
    const lang = detectLanguage(text);
    this.langs[lang]!++;
    const recipients = new Set(m.to.map((a) => firstName(a.name)).filter((n) => n.length > 1));
    const me = firstName(m.fromName);
    const lines = text.split("\n");
    // a sign-off's name: the sender's first name in the last three lines with text
    let signoffFrom = lines.length;
    for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 3; i--) {
      if (lines[i]!.trim()) {
        seen++;
        signoffFrom = i;
      }
    }
    const ids: number[] = [];
    for (let li = 0; li < lines.length; li++) {
      const tokens = tokenize(lines[li]!);
      if (tokens.length === 0) continue;
      ids.length = 0;
      ids.push(S);
      for (let ti = 0; ti < tokens.length; ti++) {
        const tok = tokens[ti]!;
        const prev = ids[ids.length - 1]!;
        let id: number;
        // folding only where a name can be: after a greeting, in the sign-off
        if (prev !== S && prev >= RESERVED.length && recipients.size && GREETINGS.has(this.words[prev]!) && recipients.has(fold(tok))) id = NAME;
        else if (li >= signoffFrom && me.length > 1 && fold(tok) === me) id = ME;
        else {
          id = this.wordId(tok, true);
          if (prev !== S) this.countForm(id, tok);
        }
        ids.push(id);
        this.learnAt(ids, lang);
        if (SENTENCE_END.has(tok)) {
          ids.push(END);
          this.learnAt(ids, lang);
          ids.length = 0;
          ids.push(S);
        }
      }
      if (ids.length > 1) {
        ids.push(END);
        this.learnAt(ids, lang);
      }
    }
  }

  /** The last id of `ids` as the continuation of each context of order 1..3 before it. */
  private learnAt(ids: number[], lang: number): void {
    const i = ids.length - 1;
    const next = ids[i]!;
    if (next === UNK) return;
    for (let order = 1; order <= MAX_ORDER && i - order >= 0; order++) {
      if (ids[i - order] === UNK) break;
      const [h1, h2] = hashContext(ids, i - order, i, lang);
      this.observe(h1, h2, next);
    }
  }

  /** Halves every count and drops contexts left with fewer than two observations, in slices (bounded memory, and recency). */
  async prune(clock: SliceClock): Promise<void> {
    const old = this.table;
    const next = newTable(this.caps.slots);
    for (let i = 0; i < old.k1.length; i++) {
      if (old.k1[i] === 0) continue;
      const tot = old.tot[i]! >>> 1;
      if (tot >= 2) {
        const slot = this.find(next, old.k1[i]!, old.k2[i]!, true);
        if (slot >= 0) {
          next.tot[slot] = tot;
          for (let j = 0; j < K; j++) {
            next.nid[slot * K + j] = old.nid[i * K + j]!;
            next.ncnt[slot * K + j] = old.ncnt[i * K + j]! >>> 1;
            next.nerr[slot * K + j] = old.nerr[i * K + j]! >>> 1;
          }
        }
      }
      if ((i & 8191) === 0) await clock.tick();
    }
    this.table = next;
  }

  private dominantLanguage(): number {
    const [o, en, es] = this.langs;
    return en! >= es! && en! >= o! ? LANG_EN : es! >= o! ? LANG_ES : LANG_OTHER;
  }

  /** The best continuation of `ids` (optionally starting with `partial`), or null when not confident. */
  private next(ids: readonly number[], partial: string, first: boolean, lang: number, expand: (id: number) => string | null): number | null {
    const t = this.table;
    const p = fold(partial);
    for (let order = Math.min(MAX_ORDER, ids.length); order >= 1; order--) {
      const from = ids.length - order;
      // order 1 only right after the start of a sentence, or for the first word
      if (order === 1 && !first && ids[from] !== S) break;
      let unknown = false;
      for (let i = from; i < ids.length; i++) if (ids[i] === UNK) unknown = true;
      if (unknown) continue;
      const [h1, h2] = hashContext(ids, from, ids.length, lang);
      const slot = this.find(t, h1, h2, false);
      if (slot < 0) continue;
      const total = t.tot[slot]!;
      let best = -1;
      let bestCount = 0;
      let matching = 0;
      for (let j = 0; j < K; j++) {
        const estimate = t.ncnt[slot * K + j]!;
        if (estimate === 0) continue;
        // what is guaranteed to have been seen, not the inherited estimate
        const c = estimate - Math.min(estimate, t.nerr[slot * K + j]!);
        const id = t.nid[slot * K + j]!;
        if (p) {
          // a learned name slot matches when the draft's name starts with what is typed
          const w = id === NAME || id === ME ? expand(id) : id < RESERVED.length ? null : this.words[id]!;
          if (w === null || !fold(w).startsWith(p)) continue;
        }
        matching += estimate;
        if (c > bestCount) {
          bestCount = c;
          best = id;
        }
      }
      if (best < 0) {
        if (total >= MIN_COUNT * 2) return null;
        continue;
      }
      const prob = bestCount / total;
      const ok = bestCount >= MIN_COUNT && (first ? (p ? bestCount / matching >= 0.6 && prob >= 0.1 : prob >= 0.35) : prob >= 0.5);
      if (ok) return best;
      // a well-observed specific context that is unsure: shorter contexts would only be more sure by knowing less
      if (total >= MIN_COUNT * 2) return null;
    }
    return null;
  }

  /** Ghost text for the caret after `before`, or null. */
  suggest(input: PhraseSuggestInput): string | null {
    const window = unboundedForTests ? input.before : input.before.slice(-MAX_WINDOW);
    const line = window.slice(window.lastIndexOf("\n") + 1);
    // the sentence being written: after the last sentence end on this line
    let start = 0;
    const ends = /[.!?]["')\]]*\s+/g;
    for (let m = ends.exec(line); m; m = ends.exec(line)) start = m.index + m[0].length;
    const sentence = line.slice(start);
    if (!sentence.trim()) return null;
    const tokens = tokenize(sentence);
    if (tokens.length === 0) return null;
    const endsInSpace = /\s$/.test(sentence);
    let partial = "";
    const lastTok = tokens[tokens.length - 1]!;
    if (!endsInSpace && !PUNCT.has(lastTok) && sentence.endsWith(lastTok)) partial = tokens.pop()!;
    const names = (input.names ?? []).map((n) => n.trim()).filter(Boolean);
    const recipients = new Set(names.map(firstName));
    const me = input.me ? firstName(input.me) : "";
    const lang = detectLanguage(window) || this.dominantLanguage();
    const ids: number[] = [S];
    for (const tok of tokens) {
      const prev = ids[ids.length - 1]!;
      const f = fold(tok);
      if (prev >= RESERVED.length && GREETINGS.has(this.words[prev]!) && recipients.has(f)) ids.push(NAME);
      else if (me && f === me) ids.push(ME);
      else ids.push(this.wordId(tok, false));
    }
    const expand = (id: number) => (id === NAME ? (names[0]?.split(/\s+/)[0] ?? null) : id === ME ? (input.me?.trim().split(/\s+/)[0] ?? null) : null);
    let out = "";
    let pending = partial;
    let ended = false;
    /** where the output could end gracefully (after punctuation) */
    let lastBreak = -1;
    for (let n = 0; n < MAX_TOKENS_OUT; n++) {
      const first = n === 0;
      const id = this.next(ids, pending, first, lang, expand);
      if (id === END) ended = true;
      if (id === null || id === END || id === S || id === UNK) break;
      let text: string;
      if (id === NAME || id === ME) {
        const name = expand(id);
        if (!name) break;
        text = name;
      } else {
        text = this.surface(id);
        if (ids[ids.length - 1] === S) text = text[0]!.toUpperCase() + text.slice(1);
      }
      if (pending) {
        // only the rest of the word being typed (what was typed stays as typed)
        if (fold(text).length !== text.length && fold(text.slice(0, pending.length)) !== fold(pending)) break;
        out += text.slice(pending.length);
        pending = "";
      } else {
        const space = !PUNCT.has(text) && (n > 0 || !endsInSpace);
        out += (space ? " " : "") + text;
      }
      ids.push(id);
      if (PUNCT.has(text)) lastBreak = out.length;
      if (SENTENCE_END.has(text)) {
        ended = true;
        break;
      }
    }
    // cut off mid-phrase by the length cap: end at the last comma rather than on a dangling word
    if (!ended && ids.length - tokens.length - 1 >= MAX_TOKENS_OUT && lastBreak > 0) out = out.slice(0, lastBreak);
    return out.trim().length >= 2 && out.length >= 3 ? out : null;
  }

  allocatedBytes(): number {
    const t = this.table;
    return t.k1.byteLength + t.k2.byteLength + t.tot.byteLength + t.nid.byteLength + t.ncnt.byteLength + t.nerr.byteLength + this.lower.byteLength * 4 + this.wordChars * 2 + this.words.length * 40 + this.vocab.size * 64 + this.mixed.size * 80 + this.learned.byteLength;
  }

  async snapshot(identity: string, clock: SliceClock): Promise<Uint8Array> {
    if (!this.revision) throw new Error("the phrase model has no revision");
    const t = this.table;
    const mixedIds = [...this.mixed.keys()];
    const n = this.words.length;
    const changes = this.changes;
    const packed = await packSnapshot(
      { ...PHRASES_SNAPSHOT, identity },
      this.revision,
      { slots: t.k1.length, used: t.used, messages: this.messages },
      {
        words: { strings: this.words },
        lower: this.lower.slice(0, n),
        cap: this.cap.slice(0, n),
        upper: this.upper.slice(0, n),
        other: this.other.slice(0, n),
        mixedIds: Uint32Array.from(mixedIds),
        mixed: { strings: mixedIds.map((id) => this.mixed.get(id)!) },
        langs: this.langs.slice(),
        k1: t.k1,
        k2: t.k2,
        tot: t.tot,
        nid: t.nid,
        ncnt: t.ncnt,
        nerr: t.nerr,
        learned: this.learned.words(),
      },
      clock,
    );
    this.changes = Math.max(0, this.changes - changes);
    return sealSnapshot(packed, clock);
  }

  async restore(bytes: Uint8Array, identity: string, clock: SliceClock): Promise<boolean> {
    const r = await readSnapshot(bytes, { ...PHRASES_SNAPSHOT, identity }, clock);
    if (!r) return false;
    try {
      const s = r.sections;
      const slots = this.caps.slots;
      const k1 = s.u32("k1");
      if (k1.length !== slots) return false;
      const words = await readStrings(s, "words", clock);
      if (words.length < RESERVED.length || words.length > this.caps.words + RESERVED.length || RESERVED.some((w, i) => words[i] !== w)) return false;
      const n = words.length;
      const counts = ["lower", "cap", "upper", "other"].map((name) => s.u32(name));
      if (counts.some((c) => c.length !== n)) return false;
      const table: Table = { k1: Uint32Array.from(k1), k2: Uint32Array.from(s.u32("k2")), tot: Uint32Array.from(s.u32("tot")), nid: Uint32Array.from(s.u32("nid")), ncnt: Uint32Array.from(s.u32("ncnt")), nerr: Uint16Array.from(s.u16("nerr")), used: 0 };
      if (table.k2.length !== slots || table.tot.length !== slots || table.nid.length !== slots * K || table.ncnt.length !== slots * K || table.nerr.length !== slots * K) return false;
      for (let i = 0; i < slots; i++) {
        if (table.k1[i] !== 0) table.used++;
        if ((i & 65535) === 0) await clock.tick();
      }
      for (let i = 0; i < table.nid.length; i++) if (table.ncnt[i] !== 0 && table.nid[i]! >= n) return false;
      const size = Math.max(64, n);
      const widen = (a: Uint32Array): Uint32Array<ArrayBuffer> => {
        const b = new Uint32Array(size);
        b.set(a);
        return b;
      };
      const mixedIds = s.u32("mixedIds");
      const mixed = await readStrings(s, "mixed", clock);
      if (mixed.length !== mixedIds.length) return false;
      const langs = s.u32("langs");
      if (langs.length !== 3) return false;
      this.table = table;
      this.words = words;
      this.vocab.clear();
      this.wordChars = 0;
      for (let i = 0; i < n; i++) {
        this.vocab.set(words[i]!, i);
        this.wordChars += words[i]!.length;
      }
      this.lower = widen(counts[0]!);
      this.cap = widen(counts[1]!);
      this.upper = widen(counts[2]!);
      this.other = widen(counts[3]!);
      this.mixed.clear();
      for (let i = 0; i < mixedIds.length; i++) this.mixed.set(mixedIds[i]!, mixed[i]!);
      this.langs.set(langs);
      this.learned.load(s.u32("learned"));
      this.revision = r.revision;
      this.messages = Number(r.meta.messages ?? 0);
      this.changes = 0;
      return true;
    } catch {
      return false;
    }
  }
}
