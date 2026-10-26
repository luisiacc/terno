import { cleanFromName, type Address } from "@terno/core";
import type { ContactMessage } from "../autocomplete-source";
import type { Revision } from "../search";
import { packSnapshot, readSnapshot, sealSnapshot, type SectionReader, type SnapshotKind } from "../instant/snapshot";
import { sortSliced, type SliceClock } from "../instant/slices";
import { Bitset } from "./bitset";
import { CJK, fold } from "./fold";

/**
 * The recipient index (plan 18 §3): one contact per address seen in mail
 * headers, ranked by how often and how recently you wrote to them (above
 * people who only wrote to you), found by prefixes of their name words,
 * initials, address and domain. Everything lives in typed arrays and one
 * sorted token segment plus a small sorted delta, so a keystroke is a few
 * binary searches and a walk over typed arrays: no strings built, nothing
 * read from the database.
 */

export interface ContactHit {
  name: string;
  email: string;
}

export interface SuggestOptions {
  /** addresses already in the draft's fields (any case) */
  exclude?: Iterable<string>;
  /** the draft's account: its correspondents rank a little higher */
  accountId?: number;
  limit?: number;
}

export interface ContactCaps {
  maxBytes: number;
  maxContacts: number;
}

const MiB = 1024 * 1024;
export const DESKTOP_CONTACT_CAPS: ContactCaps = { maxBytes: 64 * MiB, maxContacts: 250_000 };
export const WEB_CONTACT_CAPS: ContactCaps = { maxBytes: 40 * MiB, maxContacts: 150_000 };

const DAY = 86_400_000;
/** half-life of a message's weight: recency and frequency in one number */
const HALF_LIFE = 120 * DAY;
const T0 = Date.UTC(2020, 0, 1);
const SENT_WEIGHT = 3;
const CO_RECIPIENT = 0.25;
const AUTOMATED_PENALTY = 0.1;
const CLASS_WEIGHT = [0, 0.3, 0.6, 1];
const WHOLE_TOKEN = 1.5;
const SAME_ACCOUNT = 1.25;
/**
 * People you wrote to rank above people who only wrote to you: their key is
 * scaled by 2^500 (exact for doubles), far above any other key (weights stay
 * within about 2^±160 for any date from 1970 on), so one comparison orders
 * the tier and the score.
 */
const TIER = 2 ** 500;
const MAX_TOKEN = 32;
const MAX_NAMES = 3;
const MAX_NAME_TOKENS = 12;
const DELTA_MAX = 4096;
const SHORT_CACHE = 32;
/** what a JS string costs beyond its characters (header, its slot in an array) */
const STRING_OVERHEAD = 32;
const MAP_ENTRY = 64;

const OWN = 1;
const AUTOMATED = 2;
const DEAD = 4;
/** a sender whose mail was marked as spam after it was counted (not suggested unless written to) */
const SPAM = 8;

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?|bounces?|bounce[-+.].*|noreply[-+.].*)$/;
const COMMON_DOMAINS = new Set(["gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "icloud", "me", "mac", "aol", "proton", "protonmail", "pm", "gmx", "mail", "zoho", "yandex", "fastmail", "hey", "qq", "163", "126", "naver", "web", "orange", "free", "libero"]);
const VALID = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const NAME_SPLIT = /[\s,.;:()[\]{}<>"|/\\_+\-–—·•]+/u;
const LOCAL_SPLIT = /[._+-]+/;
/** what separates the words of a query */
const TERM_SPLIT = /[\s,;<>"()'.+_-]+/;

/** An address as a key: trimmed, lowercased, `mailto:` and angle brackets dropped; null when it isn't one. */
export function normalizeEmail(email: string): string | null {
  let e = email.trim().replace(/^mailto:/i, "");
  if (e.startsWith("<") && e.endsWith(">")) e = e.slice(1, -1);
  e = e.toLowerCase();
  return e.length <= 320 && VALID.test(e) ? e : null;
}

/** A display name worth showing: unquoted, collapsed, not an address (and what other clients mangle undone: plan 32). */
export function cleanName(name: string, email: string): string {
  let n = cleanFromName(name).trim();
  if (n.length >= 2 && ((n.startsWith('"') && n.endsWith('"')) || (n.startsWith("'") && n.endsWith("'")))) n = n.slice(1, -1).trim();
  n = n.replace(/\s+/g, " ").slice(0, 200);
  const lower = n.toLowerCase();
  if (!n || n.includes("@") || lower === email || lower === email.slice(0, email.lastIndexOf("@"))) return "";
  return n;
}

/** "Patel, Arjun" reads as "Arjun Patel" (one comma: the directory format). */
function nameWords(name: string): string[] {
  const parts = name.split(",");
  const ordered = parts.length === 2 && parts[0]!.trim() && parts[1]!.trim() ? `${parts[1]} ${parts[0]}` : name;
  return fold(ordered.replace(/['’]/g, "")).split(NAME_SPLIT).filter(Boolean);
}

type Tokens = Map<string, number>;

function addToken(out: Tokens, t: string, cls: number): void {
  if (!t) return;
  const tok = t.length > MAX_TOKEN ? t.slice(0, MAX_TOKEN) : t;
  if ((out.get(tok) ?? 0) < cls) out.set(tok, cls);
}

/** A name's tokens: words (the first strongest), CJK suffixes, initials. */
export function nameTokens(name: string, out: Tokens = new Map()): Tokens {
  const words = nameWords(name).slice(0, MAX_NAME_TOKENS);
  words.forEach((w, i) => {
    addToken(out, w, i === 0 ? 3 : 2);
    // names written without spaces: every suffix is a place a given name can start
    if (CJK.test(w)) for (let s = 1; s < w.length && s < 8; s++) addToken(out, w.slice(s), 2);
  });
  if (words.length >= 2) addToken(out, words.slice(0, 4).map((w) => w[0]).join(""), 1);
  return out;
}

/** An address's tokens: the local part, its pieces, the domain's first label (unless a mail provider's). */
export function addressTokens(email: string, out: Tokens = new Map()): Tokens {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  addToken(out, local, 3);
  const pieces = local.split(LOCAL_SPLIT).filter(Boolean);
  for (let i = 1; i < pieces.length; i++) addToken(out, pieces[i]!, 2);
  const label = email.slice(at + 1).split(".")[0] ?? "";
  if (label && !COMMON_DOMAINS.has(label)) addToken(out, label, 1);
  return out;
}

export function contactTokens(email: string, names: readonly string[]): Tokens {
  const out = addressTokens(email);
  for (const n of names) nameTokens(n, out);
  return out;
}

/** Message weight: doubles every HALF_LIFE, so sums compare frequency and recency at once without rescaling. */
const weightAt = (t: number) => Math.pow(2, (Math.max(0, t) - T0) / HALF_LIFE);

/** A token's first character as a mask bit: a–z, a digit (26), anything else (27). */
function initialBit(code: number): number {
  return code >= 97 && code <= 122 ? 1 << (code - 97) : code >= 48 && code <= 57 ? 1 << 26 : 1 << 27;
}
const OTHER_BIT = 1 << 27;
const DIGIT_BIT = 1 << 26;

/** Bytes a string takes in V8 (one byte a character for Latin-1, two otherwise) plus its overhead. */
function stringBytes(s: string): number {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return s.length * 2 + STRING_OVERHEAD;
  return s.length + STRING_OVERHEAD;
}

/**
 * The sorted tokens. `chars` holds them encoded as bytes (encodeUnits: one
 * byte per UTF-16 unit below 0xFF, three otherwise), whose byte order is the
 * units' order and whose prefixes are the units' prefixes: comparisons work on
 * bytes, and folded tokens (mostly ASCII) take one byte a character.
 */
interface Segment {
  chars: Uint8Array;
  start: Uint32Array;
  len: Uint8Array;
  ids: Int32Array;
  cls: Uint8Array;
  count: number;
}

const EMPTY_SEGMENT: Segment = { chars: new Uint8Array(0), start: new Uint32Array(0), len: new Uint8Array(0), ids: new Int32Array(0), cls: new Uint8Array(0), count: 0 };

interface Delta {
  tok: string[];
  id: number[];
  cls: number[];
}

const emptyDelta = (): Delta => ({ tok: [], id: [], cls: [] });

/** A string in the segment's byte encoding. */
function encodeString(s: string): Uint8Array {
  const units = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i);
  return encodeUnits(units);
}

/** The main segment's entry i against encoded bytes, bytewise (= by UTF-16 units). */
function cmpEntry(seg: Segment, i: number, s: Uint8Array): number {
  const start = seg.start[i]!;
  const len = seg.len[i]!;
  const n = Math.min(len, s.length);
  for (let k = 0; k < n; k++) {
    const d = seg.chars[start + k]! - s[k]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return len === s.length ? 0 : len < s.length ? -1 : 1;
}

function entryHasPrefix(seg: Segment, i: number, prefix: Uint8Array): boolean {
  if (seg.len[i]! < prefix.length) return false;
  const start = seg.start[i]!;
  for (let k = 0; k < prefix.length; k++) if (seg.chars[start + k] !== prefix[k]) return false;
  return true;
}

/** [lo, hi) of the entries starting with `prefix` (encoded). */
function segmentRange(seg: Segment, prefix: Uint8Array): [number, number] {
  let lo = 0;
  let hi = seg.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmpEntry(seg, mid, prefix) < 0) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  hi = seg.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entryHasPrefix(seg, mid, prefix)) lo = mid + 1;
    else hi = mid;
  }
  return [from, lo];
}

function deltaRange(d: Delta, prefix: string): [number, number] {
  let lo = 0;
  let hi = d.tok.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (d.tok[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  hi = d.tok.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (d.tok[mid]!.startsWith(prefix)) lo = mid + 1;
    else hi = mid;
  }
  return [from, lo];
}

/** Code units as bytes: one per unit below 0xFF, else 0xFF and the unit's two bytes (half of UTF-16 for mail's mostly Latin text). */
function encodeUnits(units: Uint16Array): Uint8Array {
  let size = units.length;
  for (let i = 0; i < units.length; i++) if (units[i]! >= 0xff) size += 2;
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = 0; i < units.length; i++) {
    const c = units[i]!;
    if (c < 0xff) out[at++] = c;
    else {
      out[at++] = 0xff;
      out[at++] = c >> 8;
      out[at++] = c & 0xff;
    }
  }
  return out;
}

/** The encoded length of a string (encodeUnits). */
function encodedLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0xff) n += 2;
  return n;
}

/** Writes a string encoded at `at`; returns the bytes written. */
function writeEncoded(s: string, dst: Uint8Array, at: number): number {
  let k = at;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xff) dst[k++] = c;
    else {
      dst[k++] = 0xff;
      dst[k++] = c >> 8;
      dst[k++] = c & 0xff;
    }
  }
  return k - at;
}

async function decodeUnits(bytes: Uint8Array, count: number, clock: SliceClock): Promise<Uint16Array> {
  const out = new Uint16Array(count);
  let k = 0;
  for (let i = 0; i < bytes.length; ) {
    if (k >= count) throw new Error("snapshot characters overflow");
    const b = bytes[i]!;
    if (b !== 0xff) {
      out[k++] = b;
      i++;
    } else {
      if (i + 2 >= bytes.length) throw new Error("snapshot characters truncated");
      out[k++] = (bytes[i + 1]! << 8) | bytes[i + 2]!;
      i += 3;
    }
    if ((k & 262143) === 0) await clock.tick();
  }
  if (k !== count) throw new Error("snapshot characters misaligned");
  return out;
}

/** Strings as lengths and encoded bytes (see encodeUnits), in slices. */
async function packStrings(list: readonly string[], clock: SliceClock): Promise<{ lens: Uint32Array; bytes: Uint8Array }> {
  const lens = new Uint32Array(list.length);
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    lens[i] = s.length;
    total += encodedLength(s);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    at += writeEncoded(list[i]!, bytes, at);
    if ((i & 8191) === 0) await clock.tick();
  }
  return { lens, bytes };
}

async function unpackStrings(s: SectionReader, name: string, clock: SliceClock): Promise<string[]> {
  const lens = s.u32(`${name}.lens`);
  let total = 0;
  for (let i = 0; i < lens.length; i++) total += lens[i]!;
  const units = await decodeUnits(s.u8(`${name}.bytes`), total, clock);
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < lens.length; i++) {
    const end = at + lens[i]!;
    out.push(String.fromCharCode.apply(null, units.subarray(at, end) as unknown as number[]));
    at = end;
    if ((i & 4095) === 0) await clock.tick();
  }
  return out;
}

// format 4: names cleaned as plan 32 reads them (older snapshots rebuild once)
export const CONTACTS_SNAPSHOT: Omit<SnapshotKind, "identity"> = { tokenizer: 1, format: 4 };

export interface ContactIndexOptions {
  caps?: ContactCaps;
  /** clamps dates in the future (a broken Date header must not outrank everything forever) */
  now?: () => number;
}

let slowForTests = 0;
/** The perf suite's injected-regression twin for the build: busy work per applied message (ms). */
export function setContactsSlowdownForTests(ms: number): void {
  slowForTests = ms;
}

let scanForTests = false;
/** The perf suite's injected-regression twin: answers by tokenizing every contact (same results, linear cost). */
export function setContactsScanForTests(on: boolean): void {
  scanForTests = on;
}

/** The per-contact typed arrays, grown and compacted together. */
const F64 = ["sent", "recv", "last", "key", "best"] as const;
const F32 = ["nameW"] as const;
const U32 = ["accounts", "m3", "m2", "m1", "mw", "stamp"] as const;
const U8 = ["flags", "bcls"] as const;
const PER_CONTACT = F64.length * 8 + F32.length * 4 + U32.length * 4 + U8.length;

export class ContactIndex {
  private n = 0;
  private live = 0;
  private emails: string[] = [];
  private names: string[] = [];
  private readonly alts = new Map<number, { name: string; w: number }[]>();
  private sent = new Float64Array(0);
  private recv = new Float64Array(0);
  private last = new Float64Array(0);
  /** how much each contact's shown name was used (it only chooses names) */
  private nameW = new Float32Array(0);
  /** the ranking key without the query's own factors: tier × (3·sent + recv) × penalty */
  private key = new Float64Array(0);
  private best = new Float64Array(0);
  private accounts = new Uint32Array(0);
  /** first characters of a contact's tokens, by class (3, 2, 1) and of its one-character tokens */
  private m3 = new Uint32Array(0);
  private m2 = new Uint32Array(0);
  private m1 = new Uint32Array(0);
  private mw = new Uint32Array(0);
  private stamp = new Uint32Array(0);
  private flags = new Uint8Array(0);
  /** per query: the best class a contact matched through, +4 when a term was one of its whole tokens */
  private bcls = new Uint8Array(0);
  private byEmail = new Map<string, number>();
  private readonly accountBits = new Map<number, number>();
  private main: Segment = EMPTY_SEGMENT;
  /** a delta being merged into a new main segment (it answers until the swap) */
  private merging: Delta | null = null;
  private delta: Delta = emptyDelta();
  private deltaChars = 0;
  /** tokens collected while building, sorted once at the end */
  private bulk: Delta | null = null;
  private bulkChars = 0;
  private gen = 0;
  private own = new Set<string>();
  private readonly seen = new Bitset();
  /** bytes held in emails, names and alternates (kept as they change: allocatedBytes is O(1)) */
  private stringsHeld = 0;
  /** bumped by any score change: the short-query cache is valid for one version */
  private version = 0;
  private readonly shortCache = new Map<string, { version: number; ids: number[] }>();
  private frozen = false;
  readonly caps: ContactCaps;
  private readonly now: () => number;
  revision: Revision | null = null;
  /** applied since the last snapshot */
  changes = 0;

  constructor(o: ContactIndexOptions = {}) {
    this.caps = o.caps ?? DESKTOP_CONTACT_CAPS;
    this.now = o.now ?? (() => Date.now());
  }

  get size(): number {
    return this.live;
  }

  /** Contacts that were evicted, still holding ids. */
  get dead(): number {
    return this.n - this.live;
  }

  /** tokens waiting in the delta (tests: it stays near its merge threshold) */
  get deltaSize(): number {
    return this.delta.tok.length;
  }

  get building(): boolean {
    return this.bulk !== null;
  }

  /** Past the build's memory peak: known contacts keep counting, new addresses are skipped. */
  freeze(): void {
    this.frozen = true;
  }

  thaw(): void {
    this.frozen = false;
  }

  /** Every per-contact array at `capacity` (at least `n`), contents kept. */
  private resize(capacity: number): void {
    const self = this as unknown as Record<string, Float64Array | Float32Array | Uint32Array | Uint8Array>;
    for (const names of [F64, F32, U32, U8]) {
      for (const name of names) {
        const a = self[name]!;
        if (a.length === capacity) continue;
        const next = new (a.constructor as new (n: number) => typeof a)(capacity);
        next.set(a.length > capacity ? a.subarray(0, capacity) : a);
        self[name] = next;
      }
    }
  }

  /** Starts a build: tokens are collected unsorted and sorted once by finishBuild. */
  beginBuild(from: Revision): void {
    this.bulk = emptyDelta();
    this.bulkChars = 0;
    this.revision = from;
  }

  async finishBuild(clock: SliceClock): Promise<void> {
    const b = this.bulk;
    if (!b) return;
    const order = new Int32Array(b.tok.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    const sorted = await sortSliced(order, (x, y) => b.tok[x]! < b.tok[y]!, clock);
    const count = sorted.length;
    let total = 0;
    // sorted order reads the tokens at random (cache misses): a tick every few thousand
    for (let k = 0; k < count; k++) {
      total += encodedLength(b.tok[sorted[k]!]!);
      if ((k & 4095) === 0) await clock.tick();
    }
    const seg: Segment = { chars: new Uint8Array(total), start: new Uint32Array(count), len: new Uint8Array(count), ids: new Int32Array(count), cls: new Uint8Array(count), count };
    let at = 0;
    for (let k = 0; k < count; k++) {
      const x = sorted[k]!;
      seg.start[k] = at;
      const n = writeEncoded(b.tok[x]!, seg.chars, at);
      seg.len[k] = n;
      at += n;
      seg.ids[k] = b.id[x]!;
      seg.cls[k] = b.cls[x]!;
      if ((k & 4095) === 0) await clock.tick();
    }
    this.main = seg;
    this.bulk = null;
    this.bulkChars = 0;
    // the growth slack goes
    this.resize(Math.max(this.n, 16));
    this.version++;
  }

  /** The user's own addresses (accounts): never suggested unless typed in full. */
  setOwn(addresses: Iterable<string>): void {
    const next = new Set<string>();
    for (const a of addresses) {
      const e = normalizeEmail(a);
      if (e) next.add(e);
    }
    for (const e of next) {
      const id = this.byEmail.get(e);
      if (id !== undefined) this.flags[id]! |= OWN;
    }
    this.own = next;
    this.version++;
  }

  /** A bit per account, collision-free for the first 32 accounts seen (later ones get no boost). */
  private accountBit(accountId: number, assign: boolean): number {
    let b = this.accountBits.get(accountId);
    if (b === undefined) {
      if (!assign || this.accountBits.size >= 32) return 0;
      b = this.accountBits.size;
      this.accountBits.set(accountId, b);
    }
    return (1 << b) >>> 0;
  }

  /** Senders of mail marked as spam after it was counted: not suggested unless you've written to them. */
  markSpam(emails: Iterable<string>): void {
    for (const e of emails) {
      const n = normalizeEmail(e);
      const id = n === null ? undefined : this.byEmail.get(n);
      if (id !== undefined && !(this.flags[id]! & SPAM)) {
        this.flags[id]! |= SPAM;
        this.version++;
      }
    }
  }

  /** A message the store no longer has: its id may come back for another message (contributions stay). */
  forget(id: number): void {
    this.seen.clear(id);
  }

  /** Applies one message's headers once (an id served again is skipped). */
  add(m: ContactMessage): void {
    if (this.seen.has(m.id)) return;
    this.seen.set(m.id);
    this.changes++;
    if (slowForTests) for (const end = performance.now() + slowForTests; performance.now() < end; );
    if (m.spam || m.draft) return;
    const t = Math.min(m.date, this.now() + DAY);
    const w = weightAt(t);
    const bit = this.accountBit(m.accountId, true);
    if (m.sent) {
      // whoever sent it is one of us (an alias, an old address)
      const me = normalizeEmail(m.from.email);
      if (me) {
        const id = this.byEmail.get(me) ?? (this.frozen ? undefined : this.create(me, cleanName(m.from.name, me), 0));
        if (id !== undefined) this.flags[id]! |= OWN;
      }
      for (const list of [m.to, m.cc, m.bcc]) for (const a of list) this.touch(a, w, t, bit, true, 1);
    } else {
      // new mail from them that isn't spam: whatever was marked before, they write real mail too
      const from = normalizeEmail(m.from.email);
      const known = from === null ? undefined : this.byEmail.get(from);
      if (known !== undefined) this.flags[known]! &= ~SPAM;
      this.touch(m.from, w, t, bit, false, 1);
      for (const list of [m.to, m.cc]) for (const a of list) this.touch(a, w, t, bit, false, CO_RECIPIENT);
    }
  }

  private rekey(id: number): void {
    const base = (SENT_WEIGHT * this.sent[id]! + this.recv[id]!) * (this.flags[id]! & AUTOMATED ? AUTOMATED_PENALTY : 1);
    this.key[id] = this.sent[id]! > 0 ? base * TIER : base;
  }

  private touch(a: Address, w: number, t: number, bit: number, sent: boolean, share: number): void {
    const email = normalizeEmail(a.email);
    if (!email) return;
    const name = cleanName(a.name, email);
    let id = this.byEmail.get(email);
    if (id === undefined) {
      if (this.frozen) return;
      id = this.create(email, name, w);
    } else if (name) this.addName(id, name, w);
    if (sent) this.sent[id]! += w * share;
    else this.recv[id]! += w * share;
    if (t > this.last[id]!) this.last[id] = t;
    this.accounts[id]! |= bit;
    this.rekey(id);
    this.version++;
  }

  private create(email: string, name: string, w: number): number {
    const id = this.n++;
    if (this.n > this.sent.length) this.resize(Math.max(64, this.sent.length * 2));
    this.emails[id] = email;
    this.names[id] = name;
    this.nameW[id] = name ? w : 0;
    this.stringsHeld += stringBytes(email) + stringBytes(name);
    this.byEmail.set(email, id);
    this.live++;
    let flags = 0;
    if (this.own.has(email)) flags |= OWN;
    if (AUTOMATED_LOCAL.test(email.slice(0, email.lastIndexOf("@")))) flags |= AUTOMATED;
    this.flags[id] = flags;
    const tokens = addressTokens(email);
    if (name) nameTokens(name, tokens);
    this.indexTokens(id, tokens);
    return id;
  }

  /** Counts a name for a contact: the most used one is shown, up to two others stay searchable. */
  private addName(id: number, name: string, w: number): void {
    const shown = this.names[id]!;
    if (!shown) {
      this.stringsHeld += stringBytes(name) - stringBytes("");
      this.names[id] = name;
      this.nameW[id] = w;
      this.indexTokens(id, nameTokens(name));
      return;
    }
    const key = fold(name);
    if (key === fold(shown)) {
      this.nameW[id]! += w;
      return;
    }
    let alts = this.alts.get(id);
    const alt = alts?.find((a) => fold(a.name) === key);
    if (alt) {
      alt.w += w;
      // used more than the shown one: it becomes the shown one (both are indexed already)
      if (alt.w > this.nameW[id]!) {
        const shownW = this.nameW[id]!;
        this.names[id] = alt.name;
        this.nameW[id] = alt.w;
        alt.name = shown;
        alt.w = shownW;
      }
      return;
    }
    if ((alts?.length ?? 0) >= MAX_NAMES - 1) return;
    if (!alts) this.alts.set(id, (alts = []));
    alts.push({ name, w });
    this.stringsHeld += stringBytes(name) + MAP_ENTRY / 2;
    this.indexTokens(id, nameTokens(name));
  }

  private mask(id: number, tok: string, cls: number): void {
    const bit = initialBit(tok.charCodeAt(0));
    if (cls === 3) this.m3[id]! |= bit;
    else if (cls === 2) this.m2[id]! |= bit;
    else this.m1[id]! |= bit;
    if (tok.length === 1) this.mw[id]! |= bit;
  }

  private indexTokens(id: number, tokens: Tokens): void {
    for (const [tok, cls] of tokens) this.mask(id, tok, cls);
    if (this.bulk) {
      for (const [tok, cls] of tokens) {
        this.bulk.tok.push(tok);
        this.bulk.id.push(id);
        this.bulk.cls.push(cls);
        this.bulkChars += tok.length;
      }
      return;
    }
    const d = this.delta;
    for (const [tok, cls] of tokens) {
      let lo = 0;
      let hi = d.tok.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (d.tok[mid]! < tok) lo = mid + 1;
        else hi = mid;
      }
      d.tok.splice(lo, 0, tok);
      d.id.splice(lo, 0, id);
      d.cls.splice(lo, 0, cls);
      this.deltaChars += tok.length;
    }
  }

  /** The delta is large enough to be merged (the service does it in slices). */
  needsMerge(): boolean {
    return this.delta.tok.length >= DELTA_MAX && this.merging === null && this.bulk === null;
  }

  /** Merges the delta into a new main segment in slices; queries see the old one meanwhile. Dead contacts' tokens go. */
  async merge(clock: SliceClock): Promise<void> {
    if (this.merging || this.bulk) return;
    const taking = this.delta;
    const main = this.main;
    this.merging = taking;
    this.delta = emptyDelta();
    const takenChars = this.deltaChars;
    this.deltaChars = 0;
    try {
      const flags = this.flags;
      let count = 0;
      let total = 0;
      for (let i = 0; i < main.count; i++) {
        if (flags[main.ids[i]!]! & DEAD) continue;
        count++;
        total += main.len[i]!;
      }
      const encoded = taking.tok.map(encodeString);
      for (let j = 0; j < taking.tok.length; j++) {
        if (flags[taking.id[j]!]! & DEAD) continue;
        count++;
        total += encoded[j]!.length;
      }
      const out: Segment = { chars: new Uint8Array(total), start: new Uint32Array(count), len: new Uint8Array(count), ids: new Int32Array(count), cls: new Uint8Array(count), count };
      let i = 0;
      let j = 0;
      let k = 0;
      let at = 0;
      if (this.live === this.n) {
        // nobody evicted (the usual case): the main entries between two delta tokens are copied as blocks
        while (j <= taking.tok.length) {
          // the run of main entries up to (and with) those equal to the next delta token
          let r = main.count;
          if (j < taking.tok.length) {
            let lo = i;
            let hi = main.count;
            const e = encoded[j]!;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (cmpEntry(main, mid, e) <= 0) lo = mid + 1;
              else hi = mid;
            }
            r = lo;
          }
          if (r > i) {
            const from = main.start[i]!;
            const to = main.start[r - 1]! + main.len[r - 1]!;
            out.chars.set(main.chars.subarray(from, to), at);
            const shift = at - from;
            for (let x = i; x < r; x++) out.start[k + x - i] = main.start[x]! + shift;
            out.len.set(main.len.subarray(i, r), k);
            out.ids.set(main.ids.subarray(i, r), k);
            out.cls.set(main.cls.subarray(i, r), k);
            k += r - i;
            at += to - from;
            i = r;
          }
          if (j === taking.tok.length) break;
          const e = encoded[j]!;
          out.chars.set(e, at);
          out.start[k] = at;
          out.len[k] = e.length;
          out.ids[k] = taking.id[j]!;
          out.cls[k] = taking.cls[j]!;
          at += e.length;
          k++;
          j++;
          if ((j & 255) === 0) await clock.tick();
        }
        this.main = out;
        return;
      }
      while (i < main.count || j < taking.tok.length) {
        if (j >= taking.tok.length || (i < main.count && cmpEntry(main, i, encoded[j]!) <= 0)) {
          const id = main.ids[i]!;
          if (!(flags[id]! & DEAD)) {
            const from = main.start[i]!;
            const len = main.len[i]!;
            for (let c = 0; c < len; c++) out.chars[at + c] = main.chars[from + c]!;
            out.start[k] = at;
            out.len[k] = len;
            out.ids[k] = id;
            out.cls[k] = main.cls[i]!;
            at += len;
            k++;
          }
          i++;
        } else {
          const id = taking.id[j]!;
          if (!(flags[id]! & DEAD)) {
            const e = encoded[j]!;
            out.chars.set(e, at);
            out.start[k] = at;
            out.len[k] = e.length;
            out.ids[k] = id;
            out.cls[k] = taking.cls[j]!;
            at += e.length;
            k++;
          }
          j++;
        }
        if (((i + j) & 16383) === 0) await clock.tick();
      }
      this.main = out;
    } catch (error) {
      // the delta goes back: nothing is lost
      for (let x = 0; x < taking.tok.length; x++) this.indexTokens(taking.id[x]!, new Map([[taking.tok[x]!, taking.cls[x]!]]));
      void takenChars;
      throw error;
    } finally {
      this.merging = null;
    }
  }

  /** The best `limit` contacts for what is typed (none for nothing typed). */
  suggest(query: string, o: SuggestOptions = {}): ContactHit[] {
    const limit = Math.max(1, Math.min(o.limit ?? 6, 20));
    const q = fold(query.trim()).slice(0, 320);
    if (!q) return [];
    const exclude = new Set<string>();
    for (const e of o.exclude ?? []) {
      const n = normalizeEmail(e);
      if (n) exclude.add(n);
    }
    const at = q.indexOf("@");
    const emailPrefix = at >= 0 ? q.replace(/\s+/g, "") : null;
    // an address query: its local part (or the domain's first label) finds contacts, the whole prefix narrows them
    const raw = emailPrefix === null ? q.split(TERM_SPLIT) : at > 0 ? [emailPrefix.slice(0, emailPrefix.indexOf("@"))] : [emailPrefix.slice(1).split(".")[0]!];
    const terms = raw
      .filter(Boolean)
      .slice(0, 6)
      .map((t) => (t.length > MAX_TOKEN ? t.slice(0, MAX_TOKEN) : t));
    if (terms.length === 0) return [];
    const bit = o.accountId === undefined ? 0 : this.accountBit(o.accountId, false);
    if (scanForTests) return this.scan(terms, emailPrefix, exclude, bit, limit, q);
    // a 1–2 letter word matches a large share of everyone: its top contacts are kept until a score changes
    if (terms.length === 1 && terms[0]!.length <= 2 && emailPrefix === null) {
      const key = `${terms[0]}|${bit}`;
      let cached = this.shortCache.get(key);
      if (!cached || cached.version !== this.version) {
        cached = { version: this.version, ids: this.rank(terms, null, new Set(), bit, SHORT_CACHE, q) };
        this.shortCache.delete(key);
        this.shortCache.set(key, cached);
        if (this.shortCache.size > 256) this.shortCache.delete(this.shortCache.keys().next().value!);
      }
      const ids = cached.ids.filter((id) => !(this.flags[id]! & DEAD) && !exclude.has(this.emails[id]!));
      // complete when nothing was cut off, or enough is left after the exclusions
      if (ids.length >= limit || cached.ids.length < SHORT_CACHE) return ids.slice(0, limit).map((id) => this.hit(id));
    }
    return this.rank(terms, emailPrefix, exclude, bit, limit, q).map((id) => this.hit(id));
  }

  private hit(id: number): ContactHit {
    return { name: this.names[id]!, email: this.emails[id]! };
  }

  /** A candidate's score, matched through a token of class `cls`; `whole`: a term is one of its whole tokens. */
  private score(id: number, cls: number, whole: boolean, bit: number): number {
    let s = this.key[id]! * CLASS_WEIGHT[cls]!;
    if (whole) s *= WHOLE_TOKEN;
    if (bit && this.accounts[id]! & bit) s *= SAME_ACCOUNT;
    return s;
  }

  /** a ranks above b: score (the tier is in it), then newest, then id */
  private before(a: number, sa: number, b: number, sb: number): boolean {
    if (sa !== sb) return sa > sb;
    const la = this.last[a]!;
    const lb = this.last[b]!;
    if (la !== lb) return la > lb;
    return a < b;
  }

  /**
   * Every term must prefix one of a contact's tokens. Terms of one letter in
   * a query of several are checked against each contact's first-letter masks
   * (walking "l" would visit a sixth of the index); the others are walked
   * from the smallest range up, a generation stamp per contact recording how
   * many it matched (`base + k`). In the last walk most entries are rejected
   * by one multiplication against the worst kept score. Nothing is allocated
   * per candidate.
   */
  private rank(terms: string[], emailPrefix: string | null, exclude: Set<string>, bit: number, limit: number, typed: string): number[] {
    const masked: number[] = [];
    let walked = terms;
    if (terms.length > 1) {
      walked = [];
      for (const t of terms) {
        const b = t.length === 1 ? initialBit(t.charCodeAt(0)) : 0;
        // letters only: every digit shares one bit, so a digit is walked like any longer word
        if (b && b !== OTHER_BIT && b !== DIGIT_BIT) masked.push(b);
        else walked.push(t);
      }
      if (walked.length === 0) {
        walked = [terms[terms.length - 1]!];
        masked.pop();
      }
    }
    const W = walked.length;
    if (this.gen > 0xffff_0000) {
      this.stamp.fill(0);
      this.gen = 0;
    }
    const base = this.gen + 1;
    this.gen = base + W + 1;
    const matched = base + W;
    const done = base + W + 1;
    const ranges = walked.map((t) => {
      const bytes = encodeString(t);
      const m = segmentRange(this.main, bytes);
      const g = this.merging ? deltaRange(this.merging, t) : ([0, 0] as [number, number]);
      const d = deltaRange(this.delta, t);
      return { t, blen: bytes.length, m, g, d, size: m[1] - m[0] + g[1] - g[0] + d[1] - d[0] };
    });
    ranges.sort((x, y) => x.size - y.size);
    const top: number[] = [];
    const topScore: number[] = [];
    const { flags, stamp, bcls, key, m3, m2, m1, mw } = this;
    const boost = bit ? SAME_ACCOUNT : 1;
    let maskCls = 0;
    // the class and whole-token bonus the masked terms give a contact (0: a masked term doesn't match)
    const maskedClass = (id: number): number => {
      let cls = 0;
      let whole = 0;
      for (const b of masked) {
        const c = m3[id]! & b ? 3 : m2[id]! & b ? 2 : m1[id]! & b ? 1 : 0;
        if (!c) return 0;
        if (c > cls) cls = c;
        if (mw[id]! & b) whole = 4;
      }
      return cls | whole;
    };
    const consider = (id: number, b: number) => {
      const f = flags[id]!;
      if (f & DEAD) return;
      const email = this.emails[id]!;
      if (f & OWN && email !== typed) return;
      if (f & SPAM && !(this.sent[id]! > 0)) return;
      if (emailPrefix !== null && !email.startsWith(emailPrefix)) return;
      if (exclude.size && exclude.has(email)) return;
      const s = this.score(id, b & 3, (b & 4) !== 0, bit);
      if (stamp[id] === done) {
        // matched again through another token: keep the better
        if (s <= this.best[id]!) return;
        const at = top.indexOf(id);
        if (at >= 0) {
          top.splice(at, 1);
          topScore.splice(at, 1);
        }
      }
      stamp[id] = done;
      this.best[id] = s;
      if (top.length === limit && !this.before(id, s, top[limit - 1]!, topScore[limit - 1]!)) return;
      let k = top.length;
      if (k < limit) {
        top.push(id);
        topScore.push(s);
      } else k = limit - 1;
      while (k > 0 && this.before(id, s, top[k - 1]!, topScore[k - 1]!)) {
        top[k] = top[k - 1]!;
        topScore[k] = topScore[k - 1]!;
        k--;
      }
      top[k] = id;
      topScore[k] = s;
    };
    for (let k = 0; k < W; k++) {
      const r = ranges[k]!;
      const last = k === W - 1;
      const want = base + k;
      const tlen = r.t.length;
      const blen = r.blen;
      // `whole`: the entry is the term itself (main entries by encoded length, delta entries by string length)
      const visit = (id: number, cls: number, whole: boolean) => {
        // a stamp from an earlier query: this one starts at "matched no term"
        if (k === 0 && (stamp[id]! < base || stamp[id]! > done)) {
          stamp[id] = base;
          bcls[id] = 0;
        }
        const st = stamp[id]!;
        if (st === want) stamp[id] = want + 1;
        else if (st !== want + 1 && st !== done) return;
        // the best class over every term's matches, and whether some term was a whole token
        let b = Math.max(bcls[id]! & 3, cls) | (bcls[id]! & 4) | (whole ? 4 : 0);
        if (last && masked.length) {
          maskCls = maskedClass(id);
          if (!maskCls) return;
          b = Math.max(b & 3, maskCls & 3) | (b & 4) | (maskCls & 4);
        }
        const changed = b !== bcls[id];
        bcls[id] = b;
        if (!last) return;
        // most entries can't make the list: one multiplication against the worst kept score says so
        if (top.length === limit && stamp[id] !== done && key[id]! * CLASS_WEIGHT[b & 3]! * (b & 4 ? WHOLE_TOKEN : 1) * boost < topScore[limit - 1]!) return;
        if (changed || stamp[id] !== done) consider(id, b);
      };
      const m = this.main;
      const mIds = m.ids;
      const mCls = m.cls;
      const mLen = m.len;
      for (let i = r.m[0]; i < r.m[1]; i++) visit(mIds[i]!, mCls[i]!, mLen[i] === blen);
      const g = this.merging;
      if (g) for (let i = r.g[0]; i < r.g[1]; i++) visit(g.id[i]!, g.cls[i]!, g.tok[i]!.length === tlen);
      const d = this.delta;
      for (let i = r.d[0]; i < r.d[1]; i++) visit(d.id[i]!, d.cls[i]!, d.tok[i]!.length === tlen);
    }
    void matched;
    return top;
  }

  /** Every live contact tokenized now and tested: the slow, obviously right answer (oracle and injected twin). */
  private scan(terms: string[], emailPrefix: string | null, exclude: Set<string>, bit: number, limit: number, typed: string): ContactHit[] {
    const scored: { id: number; s: number }[] = [];
    for (let id = 0; id < this.n; id++) {
      const f = this.flags[id]!;
      if (f & DEAD) continue;
      const email = this.emails[id]!;
      if ((f & OWN && email !== typed) || exclude.has(email) || (f & SPAM && !(this.sent[id]! > 0))) continue;
      if (emailPrefix !== null && !email.startsWith(emailPrefix)) continue;
      const tokens = [...contactTokens(email, [this.names[id]!, ...(this.alts.get(id) ?? []).map((a) => a.name)].filter(Boolean))];
      if (!terms.every((t) => tokens.some(([tok]) => tok.startsWith(t)))) continue;
      // the best class among tokens any term matched, and the bonus when a term is a whole token
      let cls = 0;
      let whole = false;
      for (const [tok, c] of tokens) {
        if (!terms.some((t) => tok.startsWith(t))) continue;
        cls = Math.max(cls, c);
        whole ||= terms.includes(tok);
      }
      scored.push({ id, s: this.score(id, cls, whole, bit) });
    }
    scored.sort((a, b) => (this.before(a.id, a.s, b.id, b.s) ? -1 : 1));
    return scored.slice(0, limit).map((x) => this.hit(x.id));
  }

  /** Test oracle: the brute-force answer. */
  suggestByScan(query: string, o: SuggestOptions = {}): ContactHit[] {
    scanForTests = true;
    try {
      return this.suggest(query, o);
    } finally {
      scanForTests = false;
    }
  }

  /** Bytes held: typed arrays at capacity, strings as V8 stores them, map entries. O(1). */
  allocatedBytes(): number {
    let bytes = this.sent.length * PER_CONTACT;
    const m = this.main;
    bytes += m.chars.byteLength + m.start.byteLength + m.len.byteLength + m.ids.byteLength + m.cls.byteLength;
    bytes += this.deltaChars + this.bulkChars + (this.delta.tok.length + (this.bulk?.tok.length ?? 0)) * (STRING_OVERHEAD + 16);
    if (this.merging) bytes += this.merging.tok.length * (STRING_OVERHEAD + 24);
    bytes += this.stringsHeld + (this.emails.length + this.names.length) * 8;
    bytes += this.byEmail.size * MAP_ENTRY + this.seen.byteLength;
    return bytes;
  }

  overCaps(): boolean {
    return this.live > this.caps.maxContacts || this.allocatedBytes() > this.caps.maxBytes;
  }

  /** Over a cap: the lowest-ranked tenth (people who only wrote to you first) goes. Returns how many went. */
  async enforceCaps(clock: SliceClock): Promise<number> {
    if (!this.overCaps()) return 0;
    const ids: number[] = [];
    for (let id = 0; id < this.n; id++) if (!(this.flags[id]! & (DEAD | OWN))) ids.push(id);
    // lowest first
    const order = await sortSliced(Int32Array.from(ids), (a, b) => this.before(b, this.key[b]!, a, this.key[a]!), clock);
    const target = Math.max(Math.ceil(this.live * 0.1), this.live - this.caps.maxContacts);
    let evicted = 0;
    for (let k = 0; k < order.length && evicted < target; k++) {
      const id = order[k]!;
      this.flags[id]! |= DEAD;
      this.byEmail.delete(this.emails[id]!);
      this.stringsHeld -= stringBytes(this.emails[id]!) + stringBytes(this.names[id]!);
      this.emails[id] = "";
      this.names[id] = "";
      this.stringsHeld += 2 * stringBytes("");
      for (const a of this.alts.get(id) ?? []) this.stringsHeld -= stringBytes(a.name) + MAP_ENTRY / 2;
      this.alts.delete(id);
      this.live--;
      evicted++;
    }
    this.version++;
    return evicted;
  }

  /**
   * Gives evicted contacts' memory back: live contacts get dense ids and every
   * per-contact array and the token segment are rebuilt at their live size.
   * Built in slices beside the current arrays (queries keep answering from
   * them) and swapped in at once. The caller must not add() meanwhile.
   */
  async compact(clock: SliceClock): Promise<void> {
    if (this.live === this.n) return;
    await this.merge(clock);
    const n = this.n;
    const remap = new Int32Array(n).fill(-1);
    let live = 0;
    for (let id = 0; id < n; id++) if (!(this.flags[id]! & DEAD)) remap[id] = live++;
    const capacity = Math.max(live, 16);
    const self = this as unknown as Record<string, Float64Array | Float32Array | Uint32Array | Uint8Array>;
    const arrays: Record<string, Float64Array | Float32Array | Uint32Array | Uint8Array> = {};
    for (const names of [F64, F32, U32, U8]) {
      for (const name of names) {
        const src = self[name]!;
        const out = new (src.constructor as new (n: number) => typeof src)(capacity);
        for (let id = 0; id < n; id++) if (remap[id]! >= 0) out[remap[id]!] = src[id]!;
        arrays[name] = out;
      }
      await clock.tick();
    }
    const emails: string[] = Array.from({ length: live }, () => "");
    const names: string[] = Array.from({ length: live }, () => "");
    const alts = new Map<number, { name: string; w: number }[]>();
    const byEmail = new Map<string, number>();
    for (let id = 0; id < n; id++) {
      const to = remap[id]!;
      if (to < 0) continue;
      emails[to] = this.emails[id]!;
      names[to] = this.names[id]!;
      const a = this.alts.get(id);
      if (a) alts.set(to, a);
      byEmail.set(this.emails[id]!, to);
      if ((id & 8191) === 0) await clock.tick();
    }
    const m = this.main;
    const ids = new Int32Array(m.count);
    for (let i = 0; i < m.count; i++) {
      ids[i] = remap[m.ids[i]!]!;
      if ((i & 65535) === 0) await clock.tick();
    }
    // the swap: nothing below yields
    this.main = { ...m, ids };
    this.delta = { tok: this.delta.tok, id: this.delta.id.map((id) => remap[id]!), cls: this.delta.cls };
    for (const [name, a] of Object.entries(arrays)) self[name] = a;
    this.stamp.fill(0);
    this.gen = 0;
    this.emails = emails;
    this.names = names;
    this.alts.clear();
    for (const [k, v] of alts) this.alts.set(k, v);
    this.byEmail = byEmail;
    this.n = live;
    this.live = live;
    this.stringsHeld = 0;
    for (let id = 0; id < live; id++) this.stringsHeld += stringBytes(emails[id]!) + stringBytes(names[id]!);
    for (const a of alts.values()) for (const x of a) this.stringsHeld += stringBytes(x.name) + MAP_ENTRY / 2;
    this.shortCache.clear();
    this.version++;
  }

  /** The live contacts (ids compacted), their tokens and the applied messages, for the next start. */
  async snapshot(identity: string, clock: SliceClock): Promise<Uint8Array> {
    if (!this.revision) throw new Error("the contact index has no revision");
    const revision = this.revision;
    await this.merge(clock);
    // the service never adds while this runs (one loop does both); lookups may, and only read
    const remap = new Int32Array(this.n).fill(-1);
    let live = 0;
    for (let id = 0; id < this.n; id++) if (!(this.flags[id]! & DEAD)) remap[id] = live++;
    const pick = <T extends Float64Array | Float32Array | Uint32Array | Uint8Array>(src: T): T => {
      const out = new (src.constructor as new (n: number) => T)(live);
      for (let id = 0; id < this.n; id++) if (remap[id]! >= 0) out[remap[id]!] = src[id]!;
      return out;
    };
    const emails: string[] = [];
    const names: string[] = [];
    const altOwner: number[] = [];
    const altNames: string[] = [];
    const altW: number[] = [];
    for (let id = 0; id < this.n; id++) {
      if (remap[id]! < 0) continue;
      emails.push(this.emails[id]!);
      names.push(this.names[id]!);
      for (const a of this.alts.get(id) ?? []) {
        altOwner.push(remap[id]!);
        altNames.push(a.name);
        altW.push(a.w);
      }
      if ((id & 16383) === 0) await clock.tick();
    }
    // the main segment without dead contacts' entries, ids remapped; starts are implied by the lengths
    const m = this.main;
    let keep = 0;
    let total = 0;
    for (let i = 0; i < m.count; i++) {
      if (remap[m.ids[i]!]! < 0) continue;
      keep++;
      total += m.len[i]!;
    }
    const chars = new Uint8Array(total);
    const len = new Uint8Array(keep);
    const ids = new Int32Array(keep);
    const cls = new Uint8Array(keep);
    for (let i = 0, k = 0, at = 0; i < m.count; i++) {
      const to = remap[m.ids[i]!]!;
      if (to < 0) continue;
      chars.set(m.chars.subarray(m.start[i]!, m.start[i]! + m.len[i]!), at);
      len[k] = m.len[i]!;
      ids[k] = to;
      cls[k] = m.cls[i]!;
      at += m.len[i]!;
      k++;
      if ((i & 16383) === 0) await clock.tick();
    }
    // tokens that arrived during the merge: a small sorted list of their own
    const d = this.delta;
    const dKeep: number[] = [];
    for (let x = 0; x < d.tok.length; x++) if (remap[d.id[x]!]! >= 0) dKeep.push(x);
    const str = async (name: string, list: string[]) => {
      const p = await packStrings(list, clock);
      return { [`${name}.lens`]: p.lens, [`${name}.bytes`]: p.bytes };
    };
    const sections = {
      ...(await str("emails", emails)),
      ...(await str("names", names)),
      ...(await str("altNames", altNames)),
      ...(await str("dTok", dKeep.map((x) => d.tok[x]!))),
      nameW: pick(this.nameW),
      sent: pick(this.sent),
      recv: pick(this.recv),
      last: pick(this.last),
      accounts: pick(this.accounts),
      flags: pick(this.flags),
      altOwner: Uint32Array.from(altOwner),
      altW: Float64Array.from(altW),
      chars,
      len,
      ids,
      cls,
      dId: Int32Array.from(dKeep.map((x) => remap[d.id[x]!]!)),
      dCls: Uint8Array.from(dKeep.map((x) => d.cls[x]!)),
      seen: this.seen.words(),
      accountIds: Uint32Array.from(this.accountBits.keys()),
      accountBits: Uint32Array.from(this.accountBits.values()),
    };
    const changes = this.changes;
    const packed = await packSnapshot({ ...CONTACTS_SNAPSHOT, identity }, revision, { contacts: live, entries: keep, bytes: total }, sections, clock);
    this.changes = Math.max(0, this.changes - changes);
    return sealSnapshot(packed, clock);
  }

  /** Replaces this index with a snapshot's; false if it is damaged or of another kind. */
  async restore(bytes: Uint8Array, identity: string, clock: SliceClock): Promise<boolean> {
    const r = await readSnapshot(bytes, { ...CONTACTS_SNAPSHOT, identity }, clock);
    if (!r) return false;
    try {
      const s = r.sections;
      const emails = await unpackStrings(s, "emails", clock);
      const names = await unpackStrings(s, "names", clock);
      const n = emails.length;
      const sent = Float64Array.from(s.f64("sent"));
      const recv = Float64Array.from(s.f64("recv"));
      const last = Float64Array.from(s.f64("last"));
      const nameW = Float32Array.from(s.f32("nameW"));
      const accounts = Uint32Array.from(s.u32("accounts"));
      const flags = Uint8Array.from(s.u8("flags"));
      if (names.length !== n || [sent, recv, last, nameW, accounts, flags].some((a) => a.length !== n)) return false;
      const len = Uint8Array.from(s.u8("len"));
      const ids = Int32Array.from(s.i32("ids"));
      const cls = Uint8Array.from(s.u8("cls"));
      const entries = ids.length;
      if (len.length !== entries || cls.length !== entries) return false;
      let total = 0;
      for (let i = 0; i < entries; i++) {
        if (ids[i]! < 0 || ids[i]! >= n || cls[i]! < 1 || cls[i]! > 3 || len[i]! < 1 || len[i]! > MAX_TOKEN * 3) return false;
        total += len[i]!;
        if ((i & 65535) === 0) await clock.tick();
      }
      const chars = Uint8Array.from(s.u8("chars"));
      if (chars.length !== total) return false;
      const start = new Uint32Array(entries);
      for (let i = 0, at = 0; i < entries; i++) {
        start[i] = at;
        at += len[i]!;
        if ((i & 262143) === 0) await clock.tick();
      }
      const altOwner = s.u32("altOwner");
      const altNames = await unpackStrings(s, "altNames", clock);
      const altW = s.f64("altW");
      if (altNames.length !== altOwner.length || altW.length !== altOwner.length) return false;
      for (let i = 0; i < altOwner.length; i++) if (altOwner[i]! >= n) return false;
      const dTok = await unpackStrings(s, "dTok", clock);
      const dId = Array.from(s.i32("dId"));
      const dCls = Array.from(s.u8("dCls"));
      if (dTok.length !== dId.length || dCls.length !== dId.length || dId.some((id) => id < 0 || id >= n)) return false;
      const seen = s.u32("seen");
      const accountIds = s.u32("accountIds");
      const accountBits = s.u32("accountBits");
      if (accountIds.length !== accountBits.length || accountIds.length > 32) return false;
      // valid: replace everything
      this.n = n;
      this.live = n;
      this.emails = emails;
      this.names = names;
      this.sent = sent;
      this.recv = recv;
      this.last = last;
      this.nameW = nameW;
      this.accounts = accounts;
      this.flags = flags;
      const capacity = Math.max(n, 16);
      this.key = new Float64Array(capacity);
      this.best = new Float64Array(capacity);
      this.m3 = new Uint32Array(capacity);
      this.m2 = new Uint32Array(capacity);
      this.m1 = new Uint32Array(capacity);
      this.mw = new Uint32Array(capacity);
      this.stamp = new Uint32Array(capacity);
      this.bcls = new Uint8Array(capacity);
      this.resize(capacity);
      this.gen = 0;
      for (let id = 0; id < n; id++) {
        this.rekey(id);
        if ((id & 65535) === 0) await clock.tick();
      }
      this.main = { chars, start, len, ids, cls, count: entries };
      for (let i = 0; i < entries; i++) {
        const id = ids[i]!;
        const bit = initialBit(chars[start[i]!]!);
        const c = cls[i]!;
        if (c === 3) this.m3[id]! |= bit;
        else if (c === 2) this.m2[id]! |= bit;
        else this.m1[id]! |= bit;
        if (len[i] === 1) this.mw[id]! |= bit;
        if ((i & 65535) === 0) await clock.tick();
      }
      this.alts.clear();
      for (let i = 0; i < altOwner.length; i++) {
        let list = this.alts.get(altOwner[i]!);
        if (!list) this.alts.set(altOwner[i]!, (list = []));
        list.push({ name: altNames[i]!, w: altW[i]! });
      }
      this.byEmail = new Map();
      for (let id = 0; id < n; id++) {
        this.byEmail.set(emails[id]!, id);
        if ((id & 16383) === 0) await clock.tick();
      }
      this.stringsHeld = 0;
      for (let id = 0; id < n; id++) this.stringsHeld += stringBytes(emails[id]!) + stringBytes(names[id]!);
      for (const a of altNames) this.stringsHeld += stringBytes(a) + MAP_ENTRY / 2;
      this.merging = null;
      this.delta = { tok: dTok, id: dId, cls: dCls };
      this.deltaChars = dTok.reduce((a, t) => a + t.length, 0);
      for (let x = 0; x < dTok.length; x++) this.mask(dId[x]!, dTok[x]!, dCls[x]!);
      this.bulk = null;
      this.seen.load(seen);
      this.accountBits.clear();
      for (let i = 0; i < accountIds.length; i++) this.accountBits.set(accountIds[i]!, accountBits[i]!);
      this.revision = r.revision;
      this.changes = 0;
      this.version++;
      this.shortCache.clear();
      return true;
    } catch {
      return false;
    }
  }
}
