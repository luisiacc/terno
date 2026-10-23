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
  /**
   * Calibrated identity share: the share of this sender's (list's, domain's)
   * threads the user filed in the category, divided by the category's
   * typical filing rate (positive-unlabeled correction: a user who files 30%
   * of everything files 30% of a sender that is entirely "theirs"). Unlike I
   * it doesn't depend on the category's size relative to the background.
   */
  identityShare: number;
  /** the same with the filed share at its 95% upper bound (Wilson): small or noisy histories aren't penalized */
  identityFit: number;
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
  /** sparse per category: groups of [slot, posW, posN, negW, negN, cached llr] (most features live in one or two) */
  c: Float64Array | null;
  /** model version the cached llrs belong to */
  v: number;
}

interface ScoringPlan {
  version: number;
  cats: CatState[];
  totals: Totals[];
  /** category slot → index in cats (-1: not scored) */
  index: Int32Array;
  /** per category: llr of a token it has never seen, before subtracting the token's background term */
  K: Float64Array;
  sums: Float64Array;
  ks: Int32Array;
}

interface Totals {
  inv: number;
  lnP: number;
  lnN: number;
  prior: number;
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
  /** cached typical filing rate, valid while version matches the model's */
  rate: { version: number; value: number } | null;
}

const IDENTITY_ORDER: readonly IdentityKind[] = ["sender", "list", "domain"];
const SNAPSHOT_MAGIC = 0x55434d34; // "UCM4"
/** floats per sparse group: slot, posW, posN, negW, negN, cached llr */
const G = 6;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const LN_SMOOTH = Math.log(0.1);
/** distinct filed senders before a domain counts as positive identity evidence */
export const DOMAIN_MIN_SENDERS = 3;
/** below this the PU correction would turn noise into certainty */
const MIN_LABEL_RATE = 0.2;
/** One-sided 95% Wilson upper bound of a binomial proportion. */
function wilsonUpper(k: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.6449;
  const p = k / n;
  const z2n = (z * z) / n;
  return Math.min(1, (p + z2n / 2 + z * Math.sqrt((p * (1 - p)) / n + z2n / (4 * n))) / (1 + z2n));
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clip = (x: number, m: number) => (x > m ? m : x < -m ? -m : x);

/** Offset of a category slot's group in a feature's sparse counts, or -1. */
function group(e: Entry, slot: number): number {
  const c = e.c;
  if (!c) return -1;
  for (let o = 0; o < c.length; o += G) if (c[o] === slot) return o;
  return -1;
}

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
  /** list and domain of each positive sender (to pick its identity key) */
  private readonly senderKeys = new Map<number, [number, number]>();
  /** bumped by every count change (invalidates cached filing rates) */
  private version = 0;
  private globalRate: { version: number; value: number } | null = null;
  private scoring: ScoringPlan | null = null;

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
      c = { id: categoryId, slot: this.nextSlot++, P: 0, N: 0, nPos: 0, nNeg: 0, senders: new Map(), domainSenders: new Map(), rate: null };
      this.cats.set(categoryId, c);
    }
    return c;
  }

  /** A deleted category stops scoring; its slot is never reused (a rebuild compacts). */
  dropCategory(categoryId: number): void {
    this.cats.delete(categoryId);
    this.version++;
  }

  private entry(hash: number): Entry {
    let e = this.entries.get(hash);
    if (!e) {
      e = { bg: 0, c: null, v: -1 };
      this.entries.set(hash, e);
    }
    return e;
  }

  private add(hash: number, slot: number, positive: boolean, w: number, n: number): void {
    if (hash === 0) return;
    const e = this.entry(hash);
    let o = group(e, slot);
    if (o < 0) {
      const len = e.c?.length ?? 0;
      const grown = new Float64Array(len + G);
      if (e.c) grown.set(e.c);
      grown[len] = slot;
      e.c = grown;
      o = len;
    }
    const c = e.c!;
    const at = o + (positive ? 1 : 3);
    c[at] = c[at]! + w;
    c[at + 1] = c[at + 1]! + n;
    if (c[o + 2] === 0 && c[o + 4] === 0) {
      // untrained back to nothing: drop the group (and the entry if nothing is left)
      if (c.length === G) e.c = null;
      else {
        const rest = new Float64Array(c.length - G);
        rest.set(c.subarray(0, o));
        rest.set(c.subarray(o + G), o);
        e.c = rest;
      }
      if (!e.c && e.bg <= 0) this.entries.delete(hash);
    }
  }

  /** sign −1 untrains exactly what sign +1 trained (same effective weight, same groups). */
  train(ex: TrainExample, sign: 1 | -1 = 1): void {
    const f = decodeFeatures(ex.features);
    if (f.v !== FEATURES_V) return;
    const c = this.cat(ex.categoryId);
    const w = this.effectiveWeight(ex) * sign;
    const positive = ex.label > 0;
    this.version++;
    if (positive) {
      c.P += w;
      c.nPos += sign;
      bump(c.senders, f.sender, sign);
      if (sign > 0) this.senderKeys.set(f.sender, [f.list, f.domain]);
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
    this.version++;
    this.forEachHash(f, (h) => (this.entry(h).bg += 1));
  }

  removeBackground(threadId: number): void {
    const features = this.bgThreads.get(threadId);
    if (!features) return;
    this.bgThreads.delete(threadId);
    this.bgTotal--;
    this.version++;
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
    if (e.c) for (let i = 0; i < e.c.length; i += G) n += e.c[i + 2]! + e.c[i + 4]!;
    return n;
  }

  /** How many training threads contain a feature (an in-memory document-frequency estimate). */
  support(hash: number): number {
    const e = this.entries.get(hash);
    if (!e) return 0;
    let n = e.bg;
    if (e.c) for (let i = 0; i < e.c.length; i += G) n += e.c[i + 2]! + e.c[i + 4]!;
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
    if (!c || !e) return 0;
    const o = group(e, c.slot);
    return o < 0 ? 0 : e.c![o + 2]!;
  }

  /** Filed and total threads of an identity key in this category (removals count triple). */
  private filed(e: Entry | undefined, slot: number): { k: number; n: number } {
    if (!e) return { k: 0, n: 0 };
    const o = group(e, slot);
    const k = o < 0 ? 0 : e.c![o + 2]!;
    const neg = o < 0 ? 0 : e.c![o + 4]!;
    return { k, n: k + 3 * neg + e.bg };
  }

  private filedRate(e: Entry | undefined, slot: number): number {
    const { k, n } = this.filed(e, slot);
    return n > 0 ? k / n : 0;
  }

  /** The key a thread's identity evidence comes from: sender, else list, else domain (support ≥ 3). */
  private identityEntry(sender: number, list: number, domain: number, slot: number): Entry | undefined {
    for (const h of [sender, list, domain]) {
      if (!h) continue;
      const e = this.entries.get(h);
      if (e && this.supportIn(e, slot) >= 3) return e;
    }
    return this.entries.get(sender);
  }

  private supportIn(e: Entry, slot: number): number {
    const o = group(e, slot);
    return e.bg + (o < 0 ? 0 : e.c![o + 2]! + e.c![o + 4]!);
  }

  /** Mean filed rate of a category's positives' identity keys (raw, cached per model version). */
  private rawRate(c: CatState): { rate: number; n: number } {
    if (c.rate?.version === this.version) return { rate: c.rate.value, n: c.nPos };
    let sum = 0;
    let n = 0;
    for (const [sender, count] of c.senders) {
      const [list, domain] = this.senderKeys.get(sender) ?? [0, 0];
      sum += count * this.filedRate(this.identityEntry(sender, list, domain, c.slot), c.slot);
      n += count;
    }
    const rate = n > 0 ? sum / n : 1;
    c.rate = { version: this.version, value: rate };
    return { rate, n };
  }

  /**
   * How diligently the user files, for the positive-unlabeled correction:
   * the larger of this category's rate and the user's rate over all
   * categories. A low rate in one category alone usually means selective
   * filing ("only business trips"), not laziness, and must not turn its
   * senders into certainties.
   */
  labelRate(categoryId: number): number {
    const c = this.cats.get(categoryId);
    if (!c || c.nPos === 0) return 1;
    if (this.globalRate?.version !== this.version) {
      let sum = 0;
      let n = 0;
      for (const other of this.cats.values()) {
        const r = this.rawRate(other);
        sum += r.rate * other.nPos;
        n += other.nPos;
      }
      this.globalRate = { version: this.version, value: n > 0 ? sum / n : 1 };
    }
    return Math.min(1, Math.max(MIN_LABEL_RATE, this.rawRate(c).rate, this.globalRate.value));
  }

  /**
   * Class totals with the positive-unlabeled correction: with a filing rate
   * c, the user's P positives stand for P/c real ones, and the missing
   * (1/c − 1)·nPos sit in the background counted as weak negatives.
   */
  private totals(c: CatState): Totals {
    const inv = 1 / this.labelRate(c.id);
    const P = c.P * inv;
    const N = c.N + this.alpha * Math.max(0, this.bgTotal - c.nPos * (inv - 1));
    return { inv, lnP: Math.log(P + 0.2), lnN: Math.log(N + 0.2), prior: Math.log((P + 1) / (N + 1)) };
  }

  /** Log-likelihood ratio and support of one feature for one category. */
  featureStats(hash: number, categoryId: number): { llr: number; support: number } {
    const c = this.cats.get(categoryId);
    if (!c) return { llr: 0, support: 0 };
    return this.stats(this.entries.get(hash), c.slot, this.totals(c));
  }

  private stats(e: Entry | undefined, slot: number, t: Totals): { llr: number; support: number } {
    if (!e) return { llr: 0, support: 0 };
    return this.statsAt(e, group(e, slot), t);
  }

  /** stats() for a known group offset (-1: no counts in this category). */
  private statsAt(e: Entry, o: number, t: Totals): { llr: number; support: number } {
    let a = 0;
    let posN = 0;
    let negW = 0;
    let n = e.bg;
    if (o >= 0) {
      const c = e.c!;
      a = c[o + 1]!;
      posN = c[o + 2]!;
      negW = c[o + 3]!;
      n += posN + c[o + 4]!;
    }
    // the feature's unfiled positives are in its background count: take them out
    const b = negW + this.alpha * Math.max(0, e.bg - posN * (t.inv - 1));
    return { llr: Math.log(a * t.inv + 0.1) - t.lnP - Math.log(b + 0.1) + t.lnN, support: n };
  }

  /** Per-version scoring setup (totals depend only on the model's counts), reused across calls. */
  private plan(categoryIds?: readonly number[]): ScoringPlan {
    if (!categoryIds && this.scoring?.version === this.version) return this.scoring;
    const cats = categoryIds ? categoryIds.map((id) => this.cats.get(id)).filter((c): c is CatState => !!c) : [...this.cats.values()];
    const totals = cats.map((c) => this.totals(c));
    const index = new Int32Array(this.nextSlot).fill(-1);
    cats.forEach((c, i) => (index[c.slot] = i));
    const plan: ScoringPlan = {
      version: this.version,
      cats,
      totals,
      index,
      K: Float64Array.from(totals, (t) => LN_SMOOTH - t.lnP + t.lnN),
      sums: new Float64Array(cats.length),
      ks: new Int32Array(cats.length),
    };
    if (!categoryIds) this.scoring = plan;
    return plan;
  }

  /** Scores every category (or the given ones) for one thread. */
  score(features: Uint32Array, categoryIds?: readonly number[]): CategoryScore[] {
    const f = decodeFeatures(features);
    if (f.v !== FEATURES_V) return [];
    const sender = this.entries.get(f.sender);
    const list = f.list ? this.entries.get(f.list) : undefined;
    const domain = f.domain ? this.entries.get(f.domain) : undefined;
    const tokens: Entry[] = [];
    const tokenL: number[] = [];
    for (const t of f.tokens) {
      const e = this.entries.get(t);
      if (!e) continue;
      tokens.push(e);
      tokenL.push(Math.log(this.alpha * e.bg + 0.1));
    }
    const intents: Entry[] = [];
    for (const t of f.intents) {
      const e = this.entries.get(t);
      if (e) intents.push(e);
    }
    const { cats, totals, index, K, sums, ks } = this.plan(categoryIds);
    const nc = cats.length;
    sums.fill(0);
    ks.fill(0);

    // Content: every token first as if the category had never seen it (K − L, arithmetic
    // only), then the few (token, category) pairs with examples are corrected in place.
    for (let j = 0; j < tokens.length; j++) {
      if (tokens[j]!.bg < 2) continue;
      const L = tokenL[j]!;
      for (let i = 0; i < nc; i++) {
        const v = K[i]! - L;
        sums[i] = sums[i]! + (v > 3 ? 3 : v < -3 ? -3 : v);
        ks[i] = ks[i]! + 1;
      }
    }
    for (let j = 0; j < tokens.length; j++) {
      const e = tokens[j]!;
      const c = e.c;
      if (!c) continue;
      for (let o = 0; o < c.length; o += G) {
        const i = index[c[o]!]!;
        if (i < 0) continue;
        if (e.bg >= 2) {
          const v = K[i]! - tokenL[j]!;
          sums[i] = sums[i]! - (v > 3 ? 3 : v < -3 ? -3 : v);
          ks[i] = ks[i]! - 1;
        }
        if (e.bg + c[o + 2]! + c[o + 4]! < 2) continue;
        // llrs only change with the model: cache them in the group, stamped with its version
        if (e.v !== this.version) {
          for (let x = G - 1; x < c.length; x += G) c[x] = NaN;
          e.v = this.version;
        }
        let llr = c[o + G - 1]!;
        if (llr !== llr) c[o + G - 1] = llr = this.statsAt(e, o, totals[i]!).llr;
        sums[i] = sums[i]! + (llr > 3 ? 3 : llr < -3 ? -3 : llr);
        ks[i] = ks[i]! + 1;
      }
    }

    const out: CategoryScore[] = [];
    for (let ci = 0; ci < nc; ci++) {
      const c = cats[ci]!;
      const t = totals[ci]!;
      const prior = t.prior;

      let I = 0;
      let identityShare = 0;
      let identityFit = 0;
      let identity: IdentityKind | null = null;
      let identitySupport = 0;
      for (let i = 0; i < 3; i++) {
        const e = i === 0 ? sender : i === 1 ? list : domain;
        if (!e) continue;
        const s = this.stats(e, c.slot, t);
        if (s.support >= 3) {
          // a domain vouches for a new sender only once several of its senders are filed here
          // (client companies yes; uber.com receipts don't make Uber's promotions invoices)
          if (i === 2 && s.llr > 0 && (c.domainSenders.get(f.domain)?.size ?? 0) < DOMAIN_MIN_SENDERS) break;
          I = clip(s.llr, 6);
          const { k, n } = this.filed(e, c.slot);
          const rate = this.labelRate(c.id);
          identityShare = Math.min(1, (n > 0 ? k / n : 0) / rate);
          identityFit = Math.min(1, wilsonUpper(k, n) / rate);
          identity = IDENTITY_ORDER[i]!;
          identitySupport = s.support;
          break;
        }
      }

      const C = ks[ci]! ? clip(sums[ci]! / Math.sqrt(ks[ci]!), 4) : 0;

      let nint = 0;
      for (const e of intents) {
        const s = this.stats(e, c.slot, t);
        if (s.support < 2) continue;
        nint += clip(s.llr, 3);
      }
      const Nint = clip(nint, 3);

      out.push({
        categoryId: c.id,
        p: sigmoid(prior + I + C + Nint),
        prior,
        I,
        identityShare,
        identityFit,
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

  /**
   * Exact binary image of the model (scores after a round trip are
   * identical): a JSON header, then little-endian sections that load as
   * zero-copy typed-array views.
   */
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
      senderKeys: [...this.senderKeys],
    });
    const n = this.entries.size;
    const lens = new Uint16Array(n);
    let i = 0;
    let nC = 0;
    for (const e of this.entries.values()) {
      const len = e.c ? e.c.length : 0;
      lens[i++] = len;
      nC += len;
    }
    let nWords = 0;
    for (const f of this.bgThreads.values()) nWords += f.length;
    const pad = (x: number) => (x + 7) & ~7;
    const layout = { header: 16, entries: 0, lens: 0, bg: 0, c: 0, bgIds: 0, bgLens: 0, bgWords: 0, end: 0 };
    layout.entries = pad(layout.header + header.length * 2);
    layout.lens = pad(layout.entries + n * 4);
    layout.bg = pad(layout.lens + n * 2);
    layout.c = layout.bg + n * 8;
    layout.bgIds = pad(layout.c + nC * 8);
    layout.bgLens = pad(layout.bgIds + this.bgThreads.size * 4);
    layout.bgWords = pad(layout.bgLens + this.bgThreads.size * 4);
    layout.end = pad(layout.bgWords + nWords * 4);
    const buf = new ArrayBuffer(layout.end);
    const dv = new DataView(buf);
    dv.setUint32(0, SNAPSHOT_MAGIC, true);
    dv.setUint32(4, header.length, true);
    dv.setUint32(8, n, true);
    dv.setUint32(12, nC, true);
    const chars = new Uint16Array(buf, layout.header, header.length);
    for (let k = 0; k < header.length; k++) chars[k] = header.charCodeAt(k);
    const hashes = new Uint32Array(buf, layout.entries, n);
    new Uint16Array(buf, layout.lens, n).set(lens);
    const bg = new Float64Array(buf, layout.bg, n);
    const c = new Float64Array(buf, layout.c, nC);
    i = 0;
    let off = 0;
    for (const [h, e] of this.entries) {
      hashes[i] = h;
      bg[i] = e.bg;
      if (lens[i]) c.set(e.c!.subarray(0, lens[i]), off);
      off += lens[i]!;
      i++;
    }
    const ids = new Uint32Array(buf, layout.bgIds, this.bgThreads.size);
    const bgLens = new Uint32Array(buf, layout.bgLens, this.bgThreads.size);
    const words = new Uint32Array(buf, layout.bgWords, nWords);
    i = 0;
    off = 0;
    for (const [id, f] of this.bgThreads) {
      ids[i] = id;
      bgLens[i++] = f.length;
      words.set(f, off);
      off += f.length;
    }
    // trailing counts so the reader can find the background sections
    const out = new Uint8Array(layout.end + 8);
    out.set(new Uint8Array(buf));
    new DataView(out.buffer).setUint32(layout.end, this.bgThreads.size, true);
    new DataView(out.buffer).setUint32(layout.end + 4, nWords, true);
    return out;
  }

  /** null when the bytes are not a snapshot of this feature version (or of another byte order). */
  static deserialize(bytes: Uint8Array): CategorizerModel | null {
    if (!LITTLE_ENDIAN || bytes.byteLength < 24) return null;
    // views need 8-byte alignment; a BLOB from SQLite owns its buffer at offset 0 (no copy)
    let copy = bytes;
    if (bytes.byteOffset % 8 !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
      copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
    }
    const buf = copy.buffer as ArrayBuffer;
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== SNAPSHOT_MAGIC) return null;
    const headerLen = dv.getUint32(4, true);
    const n = dv.getUint32(8, true);
    const nC = dv.getUint32(12, true);
    const bgCount = dv.getUint32(bytes.byteLength - 8, true);
    const nWords = dv.getUint32(bytes.byteLength - 4, true);
    const chars = new Uint16Array(buf, 16, headerLen);
    let json = "";
    for (let k = 0; k < headerLen; k += 4096) json += String.fromCharCode(...chars.subarray(k, Math.min(headerLen, k + 4096)));
    const header = JSON.parse(json) as {
      v: number;
      alpha: number;
      decayRef: number;
      nextSlot: number;
      bgTotal: number;
      cats: { id: number; slot: number; P: number; N: number; nPos: number; nNeg: number; senders: [number, number][]; domainSenders: [number, [number, number][]][] }[];
      names: [number, [number, number][]][];
      senderKeys: [number, [number, number]][];
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
        rate: null,
      });
    }
    for (const [name, d] of header.names) m.names.set(name, new Map(d));
    for (const [sender, keys] of header.senderKeys) m.senderKeys.set(sender, keys);
    const pad = (x: number) => (x + 7) & ~7;
    const entriesAt = pad(16 + headerLen * 2);
    const lensAt = pad(entriesAt + n * 4);
    const bgAt = pad(lensAt + n * 2);
    const cAt = bgAt + n * 8;
    const hashes = new Uint32Array(buf, entriesAt, n);
    const lens = new Uint16Array(buf, lensAt, n);
    const bg = new Float64Array(buf, bgAt, n);
    const c = new Float64Array(buf, cAt, nC);
    let off = 0;
    for (let k = 0; k < n; k++) {
      const len = lens[k]!;
      m.entries.set(hashes[k]!, { bg: bg[k]!, c: len ? c.subarray(off, off + len) : null, v: -1 });
      off += len;
    }
    const idsAt = pad(cAt + nC * 8);
    const bgLensAt = pad(idsAt + bgCount * 4);
    const wordsAt = pad(bgLensAt + bgCount * 4);
    const ids = new Uint32Array(buf, idsAt, bgCount);
    const bgLens = new Uint32Array(buf, bgLensAt, bgCount);
    const words = new Uint32Array(buf, wordsAt, nWords);
    off = 0;
    for (let k = 0; k < bgCount; k++) {
      m.bgThreads.set(ids[k]!, words.subarray(off, off + bgLens[k]!));
      off += bgLens[k]!;
    }
    return m;
  }
}
