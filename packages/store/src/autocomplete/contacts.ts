import type { Address } from "@terno/core";
import type { ContactMessage } from "../autocomplete-source";
import type { Revision } from "../search";
import { packSnapshot, readSnapshot, sealSnapshot, type SnapshotKind } from "../instant/snapshot";
import { sortSliced, type SliceClock } from "../instant/slices";
import { Bitset } from "./bitset";
import { readStrings } from "./strings";
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
const MAX_TOKEN = 32;
const MAX_NAMES = 3;
const DELTA_MAX = 4096;
const SHORT_CACHE = 32;
/** bytes a JS string costs beyond its characters (header, slot in its array) */
const STRING_OVERHEAD = 40;
/** a Map entry */
const MAP_ENTRY = 64;

const OWN = 1;
const AUTOMATED = 2;
const DEAD = 4;
/** a sender whose mail was marked as spam after it was counted (not suggested unless written to) */
const SPAM = 8;
const MAX_NAME_TOKENS = 12;

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

/** A display name worth showing: unquoted, collapsed, not an address. */
export function cleanName(name: string, email: string): string {
  let n = name.trim();
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
  const words = nameWords(name);
  words.slice(0, MAX_NAME_TOKENS).forEach((w, i) => {
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
const weightAt = (t: number) => Math.pow(2, (t - T0) / HALF_LIFE);

/** Growable typed arrays. */
function grow<T extends Float64Array | Uint32Array | Uint8Array | Int32Array>(a: T, n: number): T {
  if (n <= a.length) return a;
  const next = new (a.constructor as new (n: number) => T)(Math.max(n, a.length * 2, 64));
  next.set(a);
  return next;
}

interface Segment {
  chars: Uint16Array;
  start: Uint32Array;
  len: Uint8Array;
  ids: Int32Array;
  cls: Uint8Array;
  count: number;
}

const EMPTY_SEGMENT: Segment = { chars: new Uint16Array(0), start: new Uint32Array(0), len: new Uint8Array(0), ids: new Int32Array(0), cls: new Uint8Array(0), count: 0 };

interface Delta {
  tok: string[];
  id: number[];
  cls: number[];
}

const emptyDelta = (): Delta => ({ tok: [], id: [], cls: [] });

/** The main segment's entry i against s, by UTF-16 code units. */
function cmpEntry(seg: Segment, i: number, s: string): number {
  const start = seg.start[i]!;
  const len = seg.len[i]!;
  const n = Math.min(len, s.length);
  for (let k = 0; k < n; k++) {
    const d = seg.chars[start + k]! - s.charCodeAt(k);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return len === s.length ? 0 : len < s.length ? -1 : 1;
}

function entryHasPrefix(seg: Segment, i: number, prefix: string): boolean {
  if (seg.len[i]! < prefix.length) return false;
  const start = seg.start[i]!;
  for (let k = 0; k < prefix.length; k++) if (seg.chars[start + k] !== prefix.charCodeAt(k)) return false;
  return true;
}

/** [lo, hi) of the entries starting with `prefix`. */
function segmentRange(seg: Segment, prefix: string): [number, number] {
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

export const CONTACTS_SNAPSHOT: Omit<SnapshotKind, "identity"> = { tokenizer: 1, format: 1 };

export interface ContactIndexOptions {
  caps?: ContactCaps;
  /** clamps dates in the future (a broken Date header must not outrank everything forever) */
  now?: () => number;
}

let scanForTests = false;
/** The perf suite's injected-regression twin: answers by tokenizing every contact (same results, linear cost). */
export function setContactsScanForTests(on: boolean): void {
  scanForTests = on;
}

export class ContactIndex {
  private n = 0;
  private live = 0;
  private emails: string[] = [];
  private names: string[] = [];
  private nameW = new Float64Array(0);
  private readonly alts = new Map<number, { name: string; w: number }[]>();
  private sent = new Float64Array(0);
  private recv = new Float64Array(0);
  private last = new Float64Array(0);
  private count = new Uint32Array(0);
  private accounts = new Uint32Array(0);
  private flags = new Uint8Array(0);
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
  private stamp = new Uint32Array(0);
  private best = new Float64Array(0);
  /** per query: the best class a contact matched through, +4 when a term was one of its whole tokens */
  private bcls = new Uint8Array(0);
  private gen = 0;
  private own = new Set<string>();
  private readonly seen = new Bitset();
  /** characters held in emails, names and alternates (kept as they change: allocatedBytes is O(1)) */
  private stringChars = 0;
  private altCount = 0;
  /** bumped by any score change: the short-query cache is valid for one version */
  private version = 0;
  private readonly shortCache = new Map<string, { version: number; ids: number[] }>();
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

  private frozen = false;

  /** Past the build's memory peak: known contacts keep counting, new addresses are skipped. */
  freeze(): void {
    this.frozen = true;
  }

  thaw(): void {
    this.frozen = false;
  }

  get building(): boolean {
    return this.bulk !== null;
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
    this.main = await packSegment(
      sorted.length,
      (k) => b.tok[sorted[k]!]!.length,
      (k, dst, at) => writeString(b.tok[sorted[k]!]!, dst, at),
      (k) => b.id[sorted[k]!]!,
      (k) => b.cls[sorted[k]!]!,
      clock,
    );
    this.bulk = null;
    this.bulkChars = 0;
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
    if (m.spam || m.draft) return;
    const t = Math.min(m.date, this.now() + DAY);
    const w = weightAt(t);
    const bit = this.accountBit(m.accountId, true);
    if (m.sent) {
      // whoever sent it is one of us (an alias, an old address)
      const me = normalizeEmail(m.from.email);
      if (me) {
        const id = this.byEmail.get(me) ?? this.create(me, cleanName(m.from.name, me), 0);
        this.flags[id]! |= OWN;
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
    this.count[id]!++;
    this.accounts[id]! |= bit;
    this.version++;
  }

  private create(email: string, name: string, w: number): number {
    const id = this.n++;
    const n = this.n;
    this.sent = grow(this.sent, n);
    this.recv = grow(this.recv, n);
    this.last = grow(this.last, n);
    this.count = grow(this.count, n);
    this.accounts = grow(this.accounts, n);
    this.flags = grow(this.flags, n);
    this.nameW = grow(this.nameW, n);
    this.stamp = grow(this.stamp, n);
    this.best = grow(this.best, n);
    this.bcls = grow(this.bcls, n);
    this.emails[id] = email;
    this.names[id] = name;
    this.nameW[id] = name ? w : 0;
    this.stringChars += email.length + name.length;
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
      this.names[id] = name;
      this.nameW[id] = w;
      this.stringChars += name.length;
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
    this.altCount++;
    this.stringChars += name.length;
    this.indexTokens(id, nameTokens(name));
  }

  private indexTokens(id: number, tokens: Tokens): void {
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
      // the merged order: main entries as i >= 0, delta entries as -(j + 1)
      const order = new Int32Array(main.count + taking.tok.length);
      let i = 0;
      let j = 0;
      let k = 0;
      while (i < main.count || j < taking.tok.length) {
        if (j >= taking.tok.length || (i < main.count && cmpEntry(main, i, taking.tok[j]!) <= 0)) {
          if (!(this.flags[main.ids[i]!]! & DEAD)) order[k++] = i;
          i++;
        } else {
          if (!(this.flags[taking.id[j]!]! & DEAD)) order[k++] = -(j + 1);
          j++;
        }
        if (((i + j) & 4095) === 0) await clock.tick();
      }
      this.main = await packSegment(
        k,
        (x) => (order[x]! < 0 ? taking.tok[-order[x]! - 1]!.length : main.len[order[x]!]!),
        (x, dst, at) => {
          const o = order[x]!;
          if (o < 0) return writeString(taking.tok[-o - 1]!, dst, at);
          dst.set(main.chars.subarray(main.start[o]!, main.start[o]! + main.len[o]!), at);
          return main.len[o]!;
        },
        (x) => (order[x]! < 0 ? taking.id[-order[x]! - 1]! : main.ids[order[x]!]!),
        (x) => (order[x]! < 0 ? taking.cls[-order[x]! - 1]! : main.cls[order[x]!]!),
        clock,
      );
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

  /** A candidate's score, matched through a token of class `cls`; `whole`: the term is that whole token. */
  private score(id: number, cls: number, whole: boolean, bit: number): number {
    let s = (SENT_WEIGHT * this.sent[id]! + this.recv[id]!) * CLASS_WEIGHT[cls]!;
    if (whole) s *= WHOLE_TOKEN;
    if (bit && this.accounts[id]! & bit) s *= SAME_ACCOUNT;
    if (this.flags[id]! & AUTOMATED) s *= AUTOMATED_PENALTY;
    return s;
  }

  /** a ranks above b: sent-to first, then score, newest, id */
  private before(a: number, sa: number, b: number, sb: number): boolean {
    const ta = this.sent[a]! > 0;
    const tb = this.sent[b]! > 0;
    if (ta !== tb) return ta;
    if (sa !== sb) return sa > sb;
    const la = this.last[a]!;
    const lb = this.last[b]!;
    if (la !== lb) return la > lb;
    return a < b;
  }

  /**
   * Every term must prefix one of a contact's tokens. Terms are walked from
   * the smallest range up; a generation stamp per contact records how many
   * terms it has matched (`base + k`), so nothing is allocated per candidate.
   */
  private rank(terms: string[], emailPrefix: string | null, exclude: Set<string>, bit: number, limit: number, typed: string): number[] {
    const T = terms.length;
    if (this.gen > 0xffff_0000) {
      this.stamp.fill(0);
      this.gen = 0;
    }
    const base = this.gen + 1;
    this.gen = base + T + 1;
    const matched = base + T;
    const done = base + T + 1;
    const ranges = terms.map((t) => {
      const m = segmentRange(this.main, t);
      const g = this.merging ? deltaRange(this.merging, t) : ([0, 0] as [number, number]);
      const d = deltaRange(this.delta, t);
      return { t, m, g, d, size: m[1] - m[0] + g[1] - g[0] + d[1] - d[0] };
    });
    ranges.sort((x, y) => x.size - y.size);
    const top: number[] = [];
    const topScore: number[] = [];
    const flags = this.flags;
    const stamp = this.stamp;
    const bcls = this.bcls;
    const consider = (id: number) => {
      const st = stamp[id]!;
      if (st !== matched && st !== done) return;
      const f = flags[id]!;
      if (f & DEAD) return;
      const email = this.emails[id]!;
      if (f & OWN && email !== typed) return;
      if (f & SPAM && !(this.sent[id]! > 0)) return;
      if (emailPrefix !== null && !email.startsWith(emailPrefix)) return;
      if (exclude.size && exclude.has(email)) return;
      const s = this.score(id, bcls[id]! & 3, (bcls[id]! & 4) !== 0, bit);
      if (st === done) {
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
    for (let k = 0; k < T; k++) {
      const r = ranges[k]!;
      const last = k === T - 1;
      const want = base + k;
      const visit = (id: number, cls: number, len: number) => {
        // a stamp from an earlier query: this one starts at "matched no term"
        if (k === 0 && (stamp[id]! < base || stamp[id]! > done)) {
          stamp[id] = base;
          bcls[id] = 0;
        }
        const st = stamp[id]!;
        if (st === want) stamp[id] = want + 1;
        else if (st !== want + 1 && st !== done) return;
        // the best class over every term's matches, and whether some term was a whole token
        const b = Math.max(bcls[id]! & 3, cls) | (bcls[id]! & 4) | (len === r.t.length ? 4 : 0);
        const changed = b !== bcls[id];
        bcls[id] = b;
        if (last && (changed || stamp[id] !== done)) consider(id);
      };
      const m = this.main;
      for (let i = r.m[0]; i < r.m[1]; i++) visit(m.ids[i]!, m.cls[i]!, m.len[i]!);
      const g = this.merging;
      if (g) for (let i = r.g[0]; i < r.g[1]; i++) visit(g.id[i]!, g.cls[i]!, g.tok[i]!.length);
      const d = this.delta;
      for (let i = r.d[0]; i < r.d[1]; i++) visit(d.id[i]!, d.cls[i]!, d.tok[i]!.length);
    }
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

  /** Test oracle: the brute-force answer (terms in the order rank() walks them must not matter for single-term queries). */
  suggestByScan(query: string, o: SuggestOptions = {}): ContactHit[] {
    scanForTests = true;
    try {
      return this.suggest(query, o);
    } finally {
      scanForTests = false;
    }
  }

  /** Bytes held: typed arrays at capacity, strings at 2 bytes a char plus a header, map entries. O(1). */
  allocatedBytes(): number {
    let bytes = this.sent.byteLength + this.recv.byteLength + this.last.byteLength + this.count.byteLength + this.accounts.byteLength + this.flags.byteLength + this.nameW.byteLength + this.stamp.byteLength + this.best.byteLength + this.bcls.byteLength;
    const m = this.main;
    bytes += m.chars.byteLength + m.start.byteLength + m.len.byteLength + m.ids.byteLength + m.cls.byteLength;
    bytes += (this.deltaChars + this.bulkChars) * 2 + (this.delta.tok.length + (this.bulk?.tok.length ?? 0)) * (STRING_OVERHEAD + 16);
    if (this.merging) bytes += this.merging.tok.length * (STRING_OVERHEAD + 24);
    bytes += this.stringChars * 2 + (this.emails.length + this.names.length + this.altCount) * STRING_OVERHEAD;
    bytes += (this.byEmail.size + this.alts.size) * MAP_ENTRY + this.seen.byteLength;
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
    const scores = new Float64Array(this.n);
    for (const id of ids) scores[id] = this.score(id, 3, false, 0);
    // lowest first
    const order = await sortSliced(Int32Array.from(ids), (a, b) => this.before(b, scores[b]!, a, scores[a]!), clock);
    const target = Math.max(Math.ceil(this.live * 0.1), this.live - this.caps.maxContacts);
    let evicted = 0;
    for (let k = 0; k < order.length && evicted < target; k++) {
      const id = order[k]!;
      this.flags[id]! |= DEAD;
      this.byEmail.delete(this.emails[id]!);
      this.stringChars -= this.emails[id]!.length + this.names[id]!.length;
      this.emails[id] = "";
      this.names[id] = "";
      for (const a of this.alts.get(id) ?? []) this.stringChars -= a.name.length;
      this.altCount -= this.alts.get(id)?.length ?? 0;
      this.alts.delete(id);
      this.live--;
      evicted++;
    }
    this.version++;
    return evicted;
  }

  /** Contacts that were evicted, still holding ids. */
  get dead(): number {
    return this.n - this.live;
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
    const pick = <T extends Float64Array | Uint32Array | Uint8Array>(src: T): T => {
      const out = new (src.constructor as new (n: number) => T)(Math.max(live, 64));
      for (let id = 0; id < n; id++) if (remap[id]! >= 0) out[remap[id]!] = src[id]!;
      return out;
    };
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
    const sent = pick(this.sent);
    const recv = pick(this.recv);
    const last = pick(this.last);
    const count = pick(this.count);
    const accounts = pick(this.accounts);
    const flags = pick(this.flags);
    const nameW = pick(this.nameW);
    // the swap: nothing below yields
    this.main = { ...m, ids };
    this.delta = { tok: this.delta.tok, id: this.delta.id.map((id) => remap[id]!), cls: this.delta.cls };
    this.emails = emails;
    this.names = names;
    this.alts.clear();
    for (const [k, v] of alts) this.alts.set(k, v);
    this.byEmail = byEmail;
    this.sent = sent;
    this.recv = recv;
    this.last = last;
    this.count = count;
    this.accounts = accounts;
    this.flags = flags;
    this.nameW = nameW;
    this.stamp = new Uint32Array(Math.max(live, 64));
    this.best = new Float64Array(Math.max(live, 64));
    this.bcls = new Uint8Array(Math.max(live, 64));
    this.gen = 0;
    this.n = live;
    this.live = live;
    this.shortCache.clear();
    this.version++;
  }

  /** The live contacts (ids compacted), their tokens and the applied messages, for the next start. */
  async snapshot(identity: string, clock: SliceClock): Promise<Uint8Array> {
    if (!this.revision) throw new Error("the contact index has no revision");
    const revision = this.revision;
    await this.merge(clock);
    // a write may land while this yields: everything below is read in one go per array (no await in between that
    // could interleave an add) except the packing, which copies these new arrays
    const remap = new Int32Array(this.n).fill(-1);
    let live = 0;
    for (let id = 0; id < this.n; id++) if (!(this.flags[id]! & DEAD)) remap[id] = live++;
    const pick = <T extends Float64Array | Uint32Array | Uint8Array>(src: T): T => {
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
    }
    const m = this.main;
    const keep: number[] = [];
    let total = 0;
    for (let i = 0; i < m.count; i++) {
      if (remap[m.ids[i]!]! < 0) continue;
      keep.push(i);
      total += m.len[i]!;
    }
    const chars = new Uint16Array(total);
    const start = new Uint32Array(keep.length);
    const len = new Uint8Array(keep.length);
    const ids = new Int32Array(keep.length);
    const cls = new Uint8Array(keep.length);
    let at = 0;
    for (let k = 0; k < keep.length; k++) {
      const i = keep[k]!;
      chars.set(m.chars.subarray(m.start[i]!, m.start[i]! + m.len[i]!), at);
      start[k] = at;
      len[k] = m.len[i]!;
      ids[k] = remap[m.ids[i]!]!;
      cls[k] = m.cls[i]!;
      at += m.len[i]!;
    }
    // tokens that arrived during the merge: a small sorted list of their own
    const d = this.delta;
    const dKeep: number[] = [];
    for (let x = 0; x < d.tok.length; x++) if (remap[d.id[x]!]! >= 0) dKeep.push(x);
    const sections = {
      emails: { strings: emails },
      names: { strings: names },
      nameW: pick(this.nameW),
      sent: pick(this.sent),
      recv: pick(this.recv),
      last: pick(this.last),
      count: pick(this.count),
      accounts: pick(this.accounts),
      flags: pick(this.flags),
      altOwner: Uint32Array.from(altOwner),
      altNames: { strings: altNames },
      altW: Float64Array.from(altW),
      chars,
      start,
      len,
      ids,
      cls,
      dTok: { strings: dKeep.map((x) => d.tok[x]!) },
      dId: Int32Array.from(dKeep.map((x) => remap[d.id[x]!]!)),
      dCls: Uint8Array.from(dKeep.map((x) => d.cls[x]!)),
      seen: this.seen.words(),
      accountIds: Uint32Array.from(this.accountBits.keys()),
      accountBits: Uint32Array.from(this.accountBits.values()),
    };
    const changes = this.changes;
    const packed = await packSnapshot({ ...CONTACTS_SNAPSHOT, identity }, revision, { contacts: live, entries: keep.length }, sections, clock);
    this.changes = Math.max(0, this.changes - changes);
    return sealSnapshot(packed, clock);
  }

  /** Replaces this index with a snapshot's; false if it is damaged or of another kind. */
  async restore(bytes: Uint8Array, identity: string, clock: SliceClock): Promise<boolean> {
    const r = await readSnapshot(bytes, { ...CONTACTS_SNAPSHOT, identity }, clock);
    if (!r) return false;
    try {
      const s = r.sections;
      const emails = await readStrings(s, "emails", clock);
      const names = await readStrings(s, "names", clock);
      const n = emails.length;
      const sent = Float64Array.from(s.f64("sent"));
      const recv = Float64Array.from(s.f64("recv"));
      const last = Float64Array.from(s.f64("last"));
      const nameW = Float64Array.from(s.f64("nameW"));
      const count = Uint32Array.from(s.u32("count"));
      const accounts = Uint32Array.from(s.u32("accounts"));
      const flags = Uint8Array.from(s.u8("flags"));
      if (names.length !== n || [sent, recv, last, nameW, count, accounts, flags].some((a) => a.length !== n)) return false;
      const main: Segment = { chars: Uint16Array.from(s.u16("chars")), start: Uint32Array.from(s.u32("start")), len: Uint8Array.from(s.u8("len")), ids: Int32Array.from(s.i32("ids")), cls: Uint8Array.from(s.u8("cls")), count: 0 };
      main.count = main.ids.length;
      if (main.start.length !== main.count || main.len.length !== main.count || main.cls.length !== main.count) return false;
      for (let i = 0; i < main.count; i++) {
        if (main.ids[i]! < 0 || main.ids[i]! >= n || main.start[i]! + main.len[i]! > main.chars.length || main.cls[i]! > 3) return false;
        if ((i & 65535) === 0) await clock.tick();
      }
      const altOwner = s.u32("altOwner");
      const altNames = await readStrings(s, "altNames", clock);
      const altW = s.f64("altW");
      if (altNames.length !== altOwner.length || altW.length !== altOwner.length) return false;
      for (let i = 0; i < altOwner.length; i++) if (altOwner[i]! >= n) return false;
      const dTok = await readStrings(s, "dTok", clock);
      const dId = Array.from(s.i32("dId"));
      const dCls = Array.from(s.u8("dCls"));
      if (dTok.length !== dId.length || dCls.length !== dId.length || dId.some((id) => id < 0 || id >= n)) return false;
      const seen = s.u32("seen");
      const accountIds = s.u32("accountIds");
      const accountBits = s.u32("accountBits");
      if (accountIds.length !== accountBits.length || accountIds.length > 32) return false;
      this.n = n;
      this.live = n;
      this.emails = emails;
      this.names = names;
      this.sent = sent;
      this.recv = recv;
      this.last = last;
      this.nameW = nameW;
      this.count = count;
      this.accounts = accounts;
      this.flags = flags;
      this.stamp = new Uint32Array(n);
      this.best = new Float64Array(n);
      this.bcls = new Uint8Array(n);
      this.gen = 0;
      this.alts.clear();
      this.altCount = altOwner.length;
      this.stringChars = 0;
      for (let id = 0; id < n; id++) this.stringChars += emails[id]!.length + names[id]!.length;
      for (let i = 0; i < altOwner.length; i++) {
        let list = this.alts.get(altOwner[i]!);
        if (!list) this.alts.set(altOwner[i]!, (list = []));
        list.push({ name: altNames[i]!, w: altW[i]! });
        this.stringChars += altNames[i]!.length;
      }
      this.byEmail.clear();
      for (let id = 0; id < n; id++) {
        this.byEmail.set(emails[id]!, id);
        if ((id & 16383) === 0) await clock.tick();
      }
      this.main = main;
      this.merging = null;
      this.delta = { tok: dTok, id: dId, cls: dCls };
      this.deltaChars = dTok.reduce((a, t) => a + t.length, 0);
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

function writeString(s: string, dst: Uint16Array, at: number): number {
  for (let c = 0; c < s.length; c++) dst[at + c] = s.charCodeAt(c);
  return s.length;
}

/** A sorted segment from `count` entries given in order. */
async function packSegment(count: number, lenOf: (k: number) => number, write: (k: number, dst: Uint16Array, at: number) => number, id: (k: number) => number, cls: (k: number) => number, clock: SliceClock): Promise<Segment> {
  let total = 0;
  for (let k = 0; k < count; k++) {
    total += lenOf(k);
    if ((k & 16383) === 0) await clock.tick();
  }
  const chars = new Uint16Array(total);
  const start = new Uint32Array(count);
  const len = new Uint8Array(count);
  const ids = new Int32Array(count);
  const classes = new Uint8Array(count);
  let at = 0;
  for (let k = 0; k < count; k++) {
    start[k] = at;
    len[k] = write(k, chars, at);
    at += len[k]!;
    ids[k] = id(k);
    classes[k] = cls(k);
    if ((k & 4095) === 0) await clock.tick();
  }
  return { chars, start, len, ids, cls: classes, count };
}
