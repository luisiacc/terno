import { decodeFeatures, FEATURES_V, type HashedFeatures } from "./features";

/** Where a labeled example came from; the source decides its weight. */
export type ExampleSource = "user" | "suggestion" | "bulk" | "agent" | "removal" | "reject";

export const SOURCE_WEIGHT: Readonly<Record<ExampleSource, number>> = {
  user: 1,
  suggestion: 1,
  bulk: 0.5,
  agent: 0.5,
  removal: 3,
  reject: 1,
};

/** Seen-but-uncategorized mail is a weak (positive-unlabeled) negative; tuned in the offline eval. */
export const BACKGROUND_ALPHA = 0.1;
/** A bulk add teaches identity, but only this many examples per (category, sender) teach content. */
export const BULK_CONTENT_CAP = 50;

const DAY = 86_400_000;
const DECAY_HALF_LIFE_DAYS = 365;
const DECAY_FLOOR = 0.25;

export interface TrainExample {
  categoryId: number;
  label: 1 | -1;
  /** base weight (SOURCE_WEIGHT); decay is applied by the model */
  weight: number;
  at: number;
  /** tokens and intents train; false for bulk adds past BULK_CONTENT_CAP */
  content: boolean;
  features: Uint32Array;
}

export type IdentityKind = "sender" | "list" | "domain";

export interface CategoryScore {
  categoryId: number;
  p: number;
  prior: number;
  /** identity evidence (clipped llr of the most specific supported key) */
  I: number;
  /** content evidence (√k-normalized, clipped) */
  C: number;
  /** intent evidence (clipped) */
  Nint: number;
  identity: IdentityKind | null;
  identitySupport: number;
  /** distinct positive senders of the sender's domain in this category */
  domainSenders: number;
  positives: number;
  /** distinct senders among the positives */
  positiveSenders: number;
}

interface Entry {
  /** background (uncategorized) threads with this feature */
  bg: number;
  /** per category slot: [posW, posN, negW, negN] */
  c: Float64Array | null;
}

interface CatState {
  id: number;
  slot: number;
  P: number;
  N: number;
  nPos: number;
  nNeg: number;
  /** positive sender hash → examples */
  senders: Map<number, number>;
  /** domain hash → positive sender hash → examples */
  domainSenders: Map<number, Map<number, number>>;
}

const IDENTITY_ORDER: readonly IdentityKind[] = ["sender", "list", "domain"];
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clip = (x: number, m: number) => (x > m ? m : x < -m ? -m : x);

function bump(map: Map<number, number>, key: number, by: number): void {
  const v = (map.get(key) ?? 0) + by;
  if (v <= 0) map.delete(key);
  else map.set(key, v);
}

/**
 * One-vs-rest Naive Bayes per category over hashed features, with evidence
 * grouped (identity / content / intents), clipped per feature and per group,
 * and content normalized by √k. Plain multinomial NB was overconfident where
 * categories share vocabulary; grouping and clipping are what make p usable
 * as a precision-first threshold. Training is count updates; scoring is a
 * Map lookup per feature plus arithmetic per category.
 */
export class CategorizerModel {
  readonly alpha: number;
  /** decay reference: examples are weighted by their age at this time (fixed until the next rebuild) */
  readonly decayRef: number;
  private readonly entries = new Map<number, Entry>();
  private readonly cats = new Map<number, CatState>();
  private nextSlot = 0;
  private bgTotal = 0;
  private readonly bgThreads = new Map<number, Uint32Array>();
  /** full display-name hash of positive senders → their domain hashes */
  private readonly names = new Map<number, Map<number, number>>();

  constructor(options: { decayRef: number; alpha?: number }) {
    this.decayRef = options.decayRef;
    this.alpha = options.alpha ?? BACKGROUND_ALPHA;
  }

  get categoryIds(): number[] {
    return [...this.cats.keys()];
  }

  positives(categoryId: number): number {
    return this.cats.get(categoryId)?.nPos ?? 0;
  }

  get backgroundSize(): number {
    return this.bgTotal;
  }

  get featureCount(): number {
    return this.entries.size;
  }

  effectiveWeight(ex: Pick<TrainExample, "weight" | "at">): number {
    const ageDays = Math.max(0, (this.decayRef - ex.at) / DAY);
    return ex.weight * Math.max(DECAY_FLOOR, 0.5 ** (ageDays / DECAY_HALF_LIFE_DAYS));
  }

  private cat(categoryId: number): CatState {
    let c = this.cats.get(categoryId);
    if (!c) {
      c = { id: categoryId, slot: this.nextSlot++, P: 0, N: 0, nPos: 0, nNeg: 0, senders: new Map(), domainSenders: new Map() };
      this.cats.set(categoryId, c);
    }
    return c;
  }

  /** A deleted category stops scoring; its slot is never reused (a rebuild compacts). */
  dropCategory(categoryId: number): void {
    this.cats.delete(categoryId);
  }

  private entry(hash: number): Entry {
    let e = this.entries.get(hash);
    if (!e) {
      e = { bg: 0, c: null };
      this.entries.set(hash, e);
    }
    return e;
  }

  private add(hash: number, slot: number, positive: boolean, w: number, n: number): void {
    if (hash === 0) return;
    const e = this.entry(hash);
    const need = (slot + 1) * 4;
    if (!e.c || e.c.length < need) {
      const grown = new Float64Array(Math.max(need, (e.c?.length ?? 0) * 2, 8));
      if (e.c) grown.set(e.c);
      e.c = grown;
    }
    const o = slot * 4 + (positive ? 0 : 2);
    e.c[o] = e.c[o]! + w;
    e.c[o + 1] = e.c[o + 1]! + n;
  }

  /** sign −1 untrains exactly what sign +1 trained (same effective weight, same groups). */
  train(ex: TrainExample, sign: 1 | -1 = 1): void {
    const f = decodeFeatures(ex.features);
    if (f.v !== FEATURES_V) return;
    const c = this.cat(ex.categoryId);
    const w = this.effectiveWeight(ex) * sign;
    const positive = ex.label > 0;
    if (positive) {
      c.P += w;
      c.nPos += sign;
      bump(c.senders, f.sender, sign);
      if (f.domain) {
        let m = c.domainSenders.get(f.domain);
        if (!m) c.domainSenders.set(f.domain, (m = new Map()));
        bump(m, f.sender, sign);
        if (m.size === 0) c.domainSenders.delete(f.domain);
      }
      const name = f.names[0];
      if (name && f.rawDomain) {
        let m = this.names.get(name);
        if (!m) this.names.set(name, (m = new Map()));
        bump(m, f.rawDomain, sign);
        if (m.size === 0) this.names.delete(name);
      }
    } else {
      c.N += w;
      c.nNeg += sign;
    }
    this.add(f.sender, c.slot, positive, w, sign);
    this.add(f.list, c.slot, positive, w, sign);
    this.add(f.domain, c.slot, positive, w, sign);
    if (!ex.content) return;
    for (const t of f.tokens) this.add(t, c.slot, positive, w, sign);
    for (const t of f.intents) this.add(t, c.slot, positive, w, sign);
  }

  untrain(ex: TrainExample): void {
    this.train(ex, -1);
  }

  hasBackground(threadId: number): boolean {
    return this.bgThreads.has(threadId);
  }

  /** Counts an uncategorized, old-enough inbound thread as a weak negative for every category. */
  addBackground(threadId: number, features: Uint32Array): void {
    if (this.bgThreads.has(threadId)) return;
    const f = decodeFeatures(features);
    if (f.v !== FEATURES_V) return;
    this.bgThreads.set(threadId, features);
    this.bgTotal++;
    this.forEachHash(f, (h) => (this.entry(h).bg += 1));
  }

  removeBackground(threadId: number): void {
    const features = this.bgThreads.get(threadId);
    if (!features) return;
    this.bgThreads.delete(threadId);
    this.bgTotal--;
    this.forEachHash(decodeFeatures(features), (h) => {
      const e = this.entries.get(h);
      if (!e) return;
      e.bg -= 1;
      if (e.bg <= 0 && !e.c) this.entries.delete(h);
    });
  }

  private forEachHash(f: HashedFeatures, fn: (h: number) => void): void {
    if (f.sender) fn(f.sender);
    if (f.list) fn(f.list);
    if (f.domain) fn(f.domain);
    for (const t of f.tokens) fn(t);
    for (const t of f.intents) fn(t);
  }

  /** Display name of a trained sender reused from another domain (phishing look-alikes). */
  lookAlike(features: Uint32Array): boolean {
    const f = decodeFeatures(features);
    if (!f.rawDomain) return false;
    for (const n of f.names) {
      const domains = this.names.get(n);
      if (domains && !domains.has(f.rawDomain)) return true;
    }
    return false;
  }

  /** Examples and background threads from this sender, across all categories. */
  senderSupport(features: Uint32Array): number {
    const e = this.entries.get(decodeFeatures(features).sender);
    if (!e) return 0;
    let n = e.bg;
    if (e.c) for (let i = 0; i < e.c.length; i += 4) n += e.c[i + 1]! + e.c[i + 3]!;
    return n;
  }

  /** How many training threads contain a feature (an in-memory document-frequency estimate). */
  support(hash: number): number {
    const e = this.entries.get(hash);
    if (!e) return 0;
    let n = e.bg;
    if (e.c) for (let i = 0; i < e.c.length; i += 4) n += e.c[i + 1]! + e.c[i + 3]!;
    return n;
  }

  get trainingThreads(): number {
    let n = this.bgTotal;
    for (const c of this.cats.values()) n += c.nPos + c.nNeg;
    return n;
  }

  /** Positive examples of a category containing a feature. */
  positiveCount(hash: number, categoryId: number): number {
    const c = this.cats.get(categoryId);
    const e = this.entries.get(hash);
    if (!c || !e?.c || e.c.length < (c.slot + 1) * 4) return 0;
    return e.c[c.slot * 4 + 1]!;
  }

  private lnTotals(c: CatState): { lnP: number; lnN: number } {
    return { lnP: Math.log(c.P + 0.2), lnN: Math.log(c.N + this.alpha * this.bgTotal + 0.2) };
  }

  /** Log-likelihood ratio and support of one feature for one category. */
  featureStats(hash: number, categoryId: number): { llr: number; support: number } {
    const c = this.cats.get(categoryId);
    if (!c) return { llr: 0, support: 0 };
    const { lnP, lnN } = this.lnTotals(c);
    const e = this.entries.get(hash);
    return this.stats(e, c.slot, lnP, lnN);
  }

  private stats(e: Entry | undefined, slot: number, lnP: number, lnN: number): { llr: number; support: number } {
    if (!e) return { llr: 0, support: 0 };
    let a = 0;
    let negW = 0;
    let n = e.bg;
    const o = slot * 4;
    if (e.c && e.c.length > o) {
      a = e.c[o]!;
      negW = e.c[o + 2]!;
      n += e.c[o + 1]! + e.c[o + 3]!;
    }
    const b = negW + this.alpha * e.bg;
    return { llr: Math.log(a + 0.1) - lnP - Math.log(b + 0.1) + lnN, support: n };
  }

  /** Scores every category (or the given ones) for one thread. */
  score(features: Uint32Array, categoryIds?: readonly number[]): CategoryScore[] {
    const f = decodeFeatures(features);
    if (f.v !== FEATURES_V) return [];
    const sender = this.entries.get(f.sender);
    const list = f.list ? this.entries.get(f.list) : undefined;
    const domain = f.domain ? this.entries.get(f.domain) : undefined;
    const tokens: Entry[] = [];
    for (const t of f.tokens) {
      const e = this.entries.get(t);
      if (e) tokens.push(e);
    }
    const intents: Entry[] = [];
    for (const t of f.intents) {
      const e = this.entries.get(t);
      if (e) intents.push(e);
    }
    const out: CategoryScore[] = [];
    const cats = categoryIds ? categoryIds.map((id) => this.cats.get(id)).filter((c): c is CatState => !!c) : [...this.cats.values()];
    for (const c of cats) {
      const { lnP, lnN } = this.lnTotals(c);
      const prior = Math.log((c.P + 1) / (c.N + this.alpha * this.bgTotal + 1));

      let I = 0;
      let identity: IdentityKind | null = null;
      let identitySupport = 0;
      for (let i = 0; i < 3; i++) {
        const e = i === 0 ? sender : i === 1 ? list : domain;
        if (!e) continue;
        const s = this.stats(e, c.slot, lnP, lnN);
        if (s.support >= 3) {
          I = clip(s.llr, 6);
          identity = IDENTITY_ORDER[i]!;
          identitySupport = s.support;
          break;
        }
      }

      let sum = 0;
      let k = 0;
      for (const e of tokens) {
        const s = this.stats(e, c.slot, lnP, lnN);
        if (s.support < 2) continue;
        sum += clip(s.llr, 3);
        k++;
      }
      const C = k ? clip(sum / Math.sqrt(k), 4) : 0;

      let nint = 0;
      for (const e of intents) {
        const s = this.stats(e, c.slot, lnP, lnN);
        if (s.support < 2) continue;
        nint += clip(s.llr, 3);
      }
      const Nint = clip(nint, 3);

      out.push({
        categoryId: c.id,
        p: sigmoid(prior + I + C + Nint),
        prior,
        I,
        C,
        Nint,
        identity,
        identitySupport,
        domainSenders: f.domain ? (c.domainSenders.get(f.domain)?.size ?? 0) : 0,
        positives: c.nPos,
        positiveSenders: c.senders.size,
      });
    }
    return out;
  }

  // ───────────────────────────── snapshot ─────────────────────────────

  /** Exact binary image of the model (scores after a round trip are identical). */
  serialize(): Uint8Array {
    const header = JSON.stringify({
      v: FEATURES_V,
      alpha: this.alpha,
      decayRef: this.decayRef,
      nextSlot: this.nextSlot,
      bgTotal: this.bgTotal,
      cats: [...this.cats.values()].map((c) => ({
        id: c.id,
        slot: c.slot,
        P: c.P,
        N: c.N,
        nPos: c.nPos,
        nNeg: c.nNeg,
        senders: [...c.senders],
        domainSenders: [...c.domainSenders].map(([d, m]) => [d, [...m]]),
      })),
      names: [...this.names].map(([n, m]) => [n, [...m]]),
    });
    // UTF-16 code units: no TextEncoder in core's environment-agnostic globals
    let size = 8 + header.length * 2 + 4;
    for (const e of this.entries.values()) size += 4 + 8 + 2 + (e.c ? e.c.length * 8 : 0);
    size += 4;
    for (const f of this.bgThreads.values()) size += 8 + f.length * 4;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let o = 0;
    dv.setUint32(o, 0x55434d31); // "UCM1"
    dv.setUint32(o + 4, header.length);
    o += 8;
    for (let i = 0; i < header.length; i++, o += 2) dv.setUint16(o, header.charCodeAt(i));
    dv.setUint32(o, this.entries.size);
    o += 4;
    for (const [h, e] of this.entries) {
      dv.setUint32(o, h);
      dv.setFloat64(o + 4, e.bg);
      const len = e.c ? e.c.length : 0;
      dv.setUint16(o + 12, len);
      o += 14;
      for (let i = 0; i < len; i++, o += 8) dv.setFloat64(o, e.c![i]!);
    }
    dv.setUint32(o, this.bgThreads.size);
    o += 4;
    for (const [id, f] of this.bgThreads) {
      dv.setUint32(o, id);
      dv.setUint32(o + 4, f.length);
      o += 8;
      for (let i = 0; i < f.length; i++, o += 4) dv.setUint32(o, f[i]!);
    }
    return u8;
  }

  /** null when the bytes are not a snapshot of this feature version. */
  static deserialize(bytes: Uint8Array): CategorizerModel | null {
    if (bytes.byteLength < 8) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const dv = new DataView(copy.buffer);
    if (dv.getUint32(0) !== 0x55434d31) return null;
    const headerLen = dv.getUint32(4);
    let json = "";
    for (let i = 0; i < headerLen; i += 4096) {
      const end = Math.min(headerLen, i + 4096);
      const codes: number[] = [];
      for (let j = i; j < end; j++) codes.push(dv.getUint16(8 + j * 2));
      json += String.fromCharCode(...codes);
    }
    const header = JSON.parse(json) as {
      v: number;
      alpha: number;
      decayRef: number;
      nextSlot: number;
      bgTotal: number;
      cats: { id: number; slot: number; P: number; N: number; nPos: number; nNeg: number; senders: [number, number][]; domainSenders: [number, [number, number][]][] }[];
      names: [number, [number, number][]][];
    };
    if (header.v !== FEATURES_V) return null;
    const m = new CategorizerModel({ decayRef: header.decayRef, alpha: header.alpha });
    m.nextSlot = header.nextSlot;
    m.bgTotal = header.bgTotal;
    for (const c of header.cats) {
      m.cats.set(c.id, {
        id: c.id,
        slot: c.slot,
        P: c.P,
        N: c.N,
        nPos: c.nPos,
        nNeg: c.nNeg,
        senders: new Map(c.senders),
        domainSenders: new Map(c.domainSenders.map(([d, s]) => [d, new Map(s)])),
      });
    }
    for (const [n, d] of header.names) m.names.set(n, new Map(d));
    let o = 8 + headerLen * 2;
    const count = dv.getUint32(o);
    o += 4;
    for (let i = 0; i < count; i++) {
      const h = dv.getUint32(o);
      const bg = dv.getFloat64(o + 4);
      const len = dv.getUint16(o + 12);
      o += 14;
      let c: Float64Array | null = null;
      if (len) {
        c = new Float64Array(len);
        for (let j = 0; j < len; j++, o += 8) c[j] = dv.getFloat64(o);
      }
      m.entries.set(h, { bg, c });
    }
    const bgCount = dv.getUint32(o);
    o += 4;
    for (let i = 0; i < bgCount; i++) {
      const id = dv.getUint32(o);
      const len = dv.getUint32(o + 4);
      o += 8;
      // big-endian on disk; rebuild the native-endian array
      const f = new Uint32Array(len);
      for (let j = 0; j < len; j++) f[j] = dv.getUint32(o + j * 4);
      o += len * 4;
      m.bgThreads.set(id, f);
    }
    return m;
  }
}
