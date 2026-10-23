import { isFullEmail, normalizeText, tokenize, type MessageTerm, type ResolvedSearch, type View } from "@unica/core";
import {
  RevisionError,
  sameRevision,
  StaleCursorError,
  type CachedSearchEngine,
  type IndexBatch,
  type IndexChange,
  type Revision,
  type SearchCursor,
  type SearchIdsPage,
  type SearchMessageDoc,
  type SearchRequest,
  type SearchThreadDoc,
} from "../search";
import { andInto, andNotInto, clearBit, copyWords, has, orInto, popcount, scanBits, setBit, words } from "./bits";
import { SliceClock, sortSliced, type SliceOptions } from "./slices";
import { copySliced, packSnapshot, readSnapshot, sealSnapshot, type Section } from "./snapshot";

/**
 * InstantSearchEngine: the in-memory search index (plan 03 §4), exact for
 * every operator the FTS5 planner supports.
 *
 * - Docs are messages in dense slots. A message that changes gets a new slot
 *   (the old one becomes a tombstone); compaction rebuilds without them.
 * - Postings: an immutable CSR base (doc slots + a field mask per posting)
 *   for the slots indexed at build time, and a per-term delta for later ones.
 *   One dictionary serves every field; field operators filter on the mask.
 * - A packed forward index (varint term ids per field) verifies phrases and
 *   multi-token values inside one field, and rebuilds the index without
 *   tokenizing again.
 * - Threads keep their search state in typed arrays and a recency order
 *   (lastDate DESC, id DESC) that a change repositions in place.
 * - A query is a bitset of candidate messages (same-message semantics) and a
 *   walk over threads newest-first that stops after limit + 1, or, for few
 *   candidates, a dedup of the candidates' threads into a top-k buffer.
 */

const FIELDS = 4; // subject, from, to, body: bit i = 1 << i
const FIELD_BITS: Record<MessageTerm["field"], number> = { text: 15, subject: 1, from: 2, to: 4 };

const T_EXISTS = 1;
const T_INBOX = 2;
const T_SENT = 4;
const T_TRASH = 8;
const T_SPAM = 16;
const T_STARRED = 32;
const T_UNREAD = 64;

/** the oracle's VIEW_TEST as (flags & mask) === value */
const VIEW_FLAGS: Record<View, [number, number]> = {
  inbox: [T_INBOX, T_INBOX],
  starred: [T_STARRED | T_TRASH | T_SPAM, T_STARRED],
  sent: [T_SENT | T_TRASH | T_SPAM, T_SENT],
  archive: [T_INBOX | T_TRASH | T_SPAM, 0],
  spam: [T_SPAM | T_TRASH, T_SPAM],
  trash: [T_TRASH, T_TRASH],
  all: [T_TRASH | T_SPAM, 0],
};

/** Bumped whenever tokenize() changes what it emits: snapshots of another tokenizer are discarded. */
export const TOKENIZER_VERSION = 1;
/** Bumped whenever the snapshot's sections change meaning. */
export const INDEX_FORMAT = 1;

/**
 * The exact phrase doclist of another engine (FTS5): ids of messages where
 * the term's tokens are adjacent inside one column of its field, the last one
 * as a prefix when `term.prefix`. It must answer at the engine's revision: the
 * store calls it inside the same unit of work as the query.
 */
export type PhraseSource = (term: MessageTerm) => Iterable<number>;

export interface InstantEngineOptions extends SliceOptions {
  phrases?: PhraseSource;
  /** what a snapshot must have been written for (database schema, store kind); mismatches are not restored */
  identity?: string;
  /** candidates from which a query walks threads instead of deduplicating candidates */
  walkThreshold?: number;
  /** phrase verifications that may fail before the exact phrase doclist is asked for */
  phraseBudget?: number;
}

/** The engine can't answer at that revision (building, behind, or discarded): the store falls back. */
export class IndexNotCurrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexNotCurrentError";
  }
}

interface ThreadFilter {
  mask: number;
  value: number;
  accounts: ReadonlySet<number> | null;
  excludeAccounts: ReadonlySet<number> | null;
  inCats: Uint32Array[];
  outCats: Uint32Array[];
}

interface Phrase {
  term: MessageTerm;
  /** term id per position; -1 = the prefix position (members), -2 = a token no message has */
  want: Int32Array;
  members: Uint8Array | null;
  bits: number;
}

/** A single token checked per doc from the forward index instead of materializing its (dense) doc set. */
interface TokenCheck {
  token: string;
  prefix: boolean;
  /** term ids that satisfy it */
  members: Uint8Array;
  bits: number;
}

interface Attr {
  sender: number;
  notSenders: number[];
  att: number;
  before: number;
  after: number;
}

interface Plan {
  mode: "threads" | "exclude" | "messages";
  filter: ThreadFilter;
  /** messages: candidate docs (alive, negatives removed); exclude: docs whose threads are excluded */
  set: Uint32Array;
  attr: Attr | null;
  phrases: Phrase[];
  /** dense positive tokens, checked per doc while walking */
  lazy: TokenCheck[];
  /** an attribute-only query over every message */
  everyDoc: boolean;
}

const OVER_BUDGET = Symbol("over budget");
const OVER_WALK = Symbol("over walk");
/** threads a walk may pass before deduplicating the candidates is cheaper */
const WALK_VISITS = 3000;
const EMPTY: readonly number[] = [];

function grown<T extends Float64Array | Int32Array | Uint32Array | Uint8Array>(a: T, length: number, fill?: number): T {
  const b = new (a.constructor as new (n: number) => T)(length);
  b.set(a.length > length ? (a.subarray(0, length) as T) : a);
  if (fill !== undefined) b.fill(fill, a.length);
  return b;
}

/** a copy of a (large) typed array, in slices */
async function sliceCopy<T extends Uint8Array | Uint32Array>(src: T, clock: SliceClock): Promise<T> {
  const out = new (src.constructor as new (n: number) => T)(src.length);
  const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  await copySliced(bytes, 0, new Uint8Array(src.buffer, src.byteOffset, src.byteLength), clock);
  return out;
}

function lowerBound(sorted: readonly string[], s: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (sorted[m]! < s) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export class InstantSearchEngine implements CachedSearchEngine {
  readonly id = "instant";
  private readonly o: InstantEngineOptions;
  private state: "building" | "ready" | "stale" | "disabled" = "building";
  private rev: Revision | null = null;
  private busy = false;
  /** postings are maintained per doc (after the build) */
  private indexed = false;

  // dictionary
  private terms: string[] = [];
  private termIds = new Map<string, number>();
  private termChars = 0;
  private baseSorted: string[] = [];
  private baseSortedIds = new Int32Array(0);
  private deltaSorted: string[] = [];
  private deltaSortedIds: number[] = [];

  // postings
  private baseN = 0;
  private baseTerms = 0;
  private baseOff = new Uint32Array(1);
  private baseDocs = new Uint32Array(0);
  private baseMask = new Uint8Array(0);
  private delta = new Map<number, number[]>();
  private deltaEntries = 0;

  // docs
  private n = 0;
  private dead = 0;
  private docCap = 0;
  private docMsg = new Float64Array(0);
  private docThread = new Int32Array(0);
  private docDate = new Float64Array(0);
  private docAtt = new Uint8Array(0);
  private docFrom = new Int32Array(0);
  private docNext = new Int32Array(0);
  private docFwd = new Uint32Array(1);
  private alive = new Uint32Array(0);
  private fwd = new Uint8Array(0);
  private fwdLen = 0;
  private msgToDoc = new Map<number, number>();
  private senders: string[] = [];
  private senderIds = new Map<string, number>();
  private senderChars = 0;

  // threads
  private tCount = 0;
  private tCap = 0;
  private thrId = new Float64Array(0);
  private thrDate = new Float64Array(0);
  private thrFlags = new Uint8Array(0);
  private thrAccount = new Float64Array(0);
  private thrHead = new Int32Array(0);
  private thrCats: (readonly number[])[] = [];
  private seen = new Uint32Array(0);
  private gen = 0;
  private cats = new Map<number, Uint32Array>();
  private threadIdx = new Map<number, number>();
  private order = new Int32Array(0);
  private orderLen = 0;

  // scratch
  private cache = new Map<string, Uint32Array>();
  private tokens = new Int32Array(256);
  private masks = new Uint8Array(1024);
  private touched: number[] = [];

  /** what the last query did (tests, perf reports) */
  lastStrategy = "";

  constructor(options: InstantEngineOptions = {}) {
    this.o = options;
  }

  // ───────────────────────────── status ─────────────────────────────

  get revision(): Revision | null {
    return this.rev;
  }

  status(): { revision: Revision | null; state: "building" | "ready" | "stale" | "disabled"; allocatedBytes: number } {
    return { revision: this.rev, state: this.state, allocatedBytes: this.allocatedBytes() };
  }

  /** current at `at`: answers exactly what the store holds at that revision */
  currentAt(at: Revision): boolean {
    return this.state === "ready" && sameRevision(this.rev, at);
  }

  /** Bytes held: buffers at capacity, dictionary, deltas, maps and caches (estimated for JS objects). */
  allocatedBytes(): number {
    const typed = [
      this.baseSortedIds, this.baseOff, this.baseDocs, this.baseMask, this.docMsg, this.docThread, this.docDate, this.docAtt, this.docFrom,
      this.docNext, this.docFwd, this.alive, this.fwd, this.thrId, this.thrDate, this.thrFlags, this.thrAccount, this.thrHead, this.seen,
      this.order, this.tokens, this.masks,
    ].reduce((s, a) => s + a.byteLength, 0);
    let cached = 0;
    for (const s of this.cache.values()) cached += s.byteLength;
    for (const s of this.cats.values()) cached += s.byteLength;
    let catLists = 0;
    for (let t = 0; t < this.tCount; t++) catLists += this.thrCats[t]!.length * 8;
    const strings = (this.termChars + this.senderChars) * 2 + (this.terms.length + this.senders.length) * 32;
    const maps = (this.termIds.size + this.senderIds.size + this.msgToDoc.size + this.threadIdx.size) * 40 + this.delta.size * 64;
    const arrays = (this.baseSorted.length + this.deltaSorted.length + this.deltaSortedIds.length + this.terms.length + this.senders.length) * 8;
    return typed + cached + catLists + strings + maps + arrays + this.deltaEntries * 16 + this.tCount * 16;
  }

  /** tombstones and delta docs worth folding into a new base */
  needsCompaction(): boolean {
    const loose = this.dead + (this.n - this.baseN);
    return this.indexed && loose >= 2000 && loose > 0.15 * (this.n - this.dead);
  }

  /** counts for reports */
  stats(): { messages: number; tombstones: number; deltaDocs: number; threads: number; terms: number; postings: number; forwardBytes: number } {
    return {
      messages: this.n - this.dead,
      tombstones: this.dead,
      deltaDocs: this.n - this.baseN,
      threads: this.orderLen,
      terms: this.terms.length,
      postings: this.baseDocs.length + this.deltaEntries,
      forwardBytes: this.fwdLen,
    };
  }

  private clock(): SliceClock {
    return new SliceClock(this.o);
  }

  private enter(what: string): void {
    if (this.busy) throw new Error(`instant search: ${what} while another operation runs`);
    if (this.state === "disabled") throw new Error(`instant search: ${what} on a discarded index`);
    this.busy = true;
  }

  /** Forgets cached term sets (cold-keystroke measurements, memory pressure). */
  dropCaches(): void {
    this.cache.clear();
  }

  /** Gives up the index (memory pressure, failure): it never answers again. */
  disable(): void {
    this.state = "disabled";
    this.rev = null;
    this.cache.clear();
  }

  // ───────────────────────────── build ─────────────────────────────

  /** Starts an empty build at `from` (the feed's retained start). */
  beginBuild(from: Revision): void {
    if (this.n || this.tCount || this.indexed) throw new Error("instant search: beginBuild on a used engine");
    this.rev = from;
    this.state = "building";
  }

  async loadMessages(docs: readonly SearchMessageDoc[]): Promise<void> {
    if (this.indexed || this.state !== "building") throw new Error("instant search: loadMessages outside a build");
    this.enter("loadMessages");
    try {
      const clock = this.clock();
      for (const doc of docs) {
        if (this.msgToDoc.has(doc.messageId)) this.removeDoc(doc.messageId);
        this.appendDoc(doc, [tokenize(doc.subject), tokenize(doc.fromText), tokenize(doc.recipients), tokenize(doc.body)]);
        await clock.tick();
      }
    } finally {
      this.busy = false;
    }
  }

  loadThreads(docs: readonly SearchThreadDoc[]): void {
    if (this.indexed || this.state !== "building") throw new Error("instant search: loadThreads outside a build");
    for (const doc of docs) this.upsertThread(doc);
  }

  /** Builds the postings, dictionary order and thread order; the engine is then current at its build revision. */
  async finishBuild(): Promise<void> {
    if (this.indexed || this.state !== "building") throw new Error("instant search: finishBuild outside a build");
    this.enter("finishBuild");
    try {
      const clock = this.clock();
      const terms = this.terms;
      const ids = await sortSliced(Int32Array.from(terms.keys()), (a, b) => terms[a]! < terms[b]!, clock);
      this.baseSortedIds = ids;
      this.baseSorted = Array.from(ids, (i) => terms[i]!);
      await this.buildPostings(clock);
      // the forward index grew by half each time: give back the slack
      if (this.fwd.length > this.fwdLen * 1.1) this.fwd = await sliceCopy(this.fwd.subarray(0, Math.ceil(this.fwdLen * 1.05)), clock);
      const exists: number[] = [];
      for (let t = 0; t < this.tCount; t++) if (this.thrFlags[t]! & T_EXISTS) exists.push(t);
      const date = this.thrDate;
      const tid = this.thrId;
      const sorted = await sortSliced(Int32Array.from(exists), (a, b) => date[a]! > date[b]! || (date[a] === date[b] && tid[a]! > tid[b]!), clock);
      this.order = grown(sorted, Math.max(this.tCap, sorted.length));
      this.orderLen = sorted.length;
      this.indexed = true;
      this.state = "ready";
    } finally {
      this.busy = false;
    }
  }

  /** The CSR base over every alive doc, from the forward index (two passes, in slices). */
  private async buildPostings(clock: SliceClock): Promise<void> {
    const V = this.terms.length;
    this.ensureMasks(V);
    const counts = new Uint32Array(V + 1);
    const masks = this.masks;
    const touched = this.touched;
    for (let d = 0; d < this.n; d++) {
      if (!has(this.alive, d)) continue;
      this.distinctTerms(d);
      for (const id of touched) {
        counts[id + 1]!++;
        masks[id] = 0;
      }
      if ((d & 63) === 0) await clock.tick();
    }
    for (let t = 0; t < V; t++) counts[t + 1]! += counts[t]!;
    const off = counts;
    const pos = off.slice(0, V);
    const docs = new Uint32Array(off[V]!);
    const mask = new Uint8Array(off[V]!);
    for (let d = 0; d < this.n; d++) {
      if (!has(this.alive, d)) continue;
      this.distinctTerms(d);
      for (const id of touched) {
        const p = pos[id]!++;
        docs[p] = d;
        mask[p] = masks[id]!;
        masks[id] = 0;
      }
      if ((d & 63) === 0) await clock.tick();
    }
    this.baseOff = off;
    this.baseDocs = docs;
    this.baseMask = mask;
    this.baseN = this.n;
    this.baseTerms = V;
    this.delta.clear();
    this.deltaEntries = 0;
    this.deltaSorted = [];
    this.deltaSortedIds = [];
    this.cache.clear();
  }

  /** Decodes doc d's forward index into this.touched (distinct term ids) with their field masks in this.masks. */
  private distinctTerms(d: number): void {
    const touched = this.touched;
    touched.length = 0;
    const masks = this.masks;
    const f = this.fwd;
    let p = this.docFwd[d]!;
    const end = this.docFwd[d + 1]!;
    let field = 0;
    while (p < end) {
      let v = 0;
      let shift = 0;
      let b: number;
      do {
        b = f[p++]!;
        v |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      if (v === 0) {
        field++;
        continue;
      }
      const id = v - 1;
      if (masks[id] === 0) touched.push(id);
      masks[id]! |= 1 << field;
    }
  }

  // ───────────────────────────── storage ─────────────────────────────

  private ensureMasks(n: number): void {
    if (this.masks.length < n) this.masks = grown(this.masks, Math.max(n, this.masks.length * 2));
  }

  private ensureDocs(extra: number): void {
    const need = this.n + extra;
    if (need <= this.docCap) return;
    const cap = Math.max(1024, Math.ceil(need * 1.5));
    this.docMsg = grown(this.docMsg, cap);
    this.docThread = grown(this.docThread, cap);
    this.docDate = grown(this.docDate, cap);
    this.docAtt = grown(this.docAtt, cap);
    this.docFrom = grown(this.docFrom, cap);
    this.docNext = grown(this.docNext, cap);
    this.docFwd = grown(this.docFwd, cap + 1);
    this.alive = grown(this.alive, words(cap));
    this.docCap = cap;
    this.cache.clear();
  }

  private ensureFwd(extra: number): void {
    const need = this.fwdLen + extra;
    if (need > this.fwd.length) this.fwd = grown(this.fwd, Math.max(need, Math.ceil(this.fwd.length * 1.5), 1 << 16));
  }

  private ensureThreads(extra: number): void {
    const need = this.tCount + extra;
    if (need <= this.tCap) return;
    const cap = Math.max(1024, Math.ceil(need * 1.5));
    this.thrId = grown(this.thrId, cap);
    this.thrDate = grown(this.thrDate, cap);
    this.thrFlags = grown(this.thrFlags, cap);
    this.thrAccount = grown(this.thrAccount, cap);
    this.thrHead = grown(this.thrHead, cap, -1);
    this.seen = grown(this.seen, cap);
    this.order = grown(this.order, cap);
    for (const [c, s] of this.cats) this.cats.set(c, grown(s, words(cap)));
    this.tCap = cap;
  }

  private intern(tok: string): number {
    let id = this.termIds.get(tok);
    if (id !== undefined) return id;
    // V8 slices tokens of 13+ chars out of the text they came from: a copy keeps the dictionary from pinning bodies
    if (tok.length >= 13) tok = JSON.parse(JSON.stringify(tok)) as string;
    id = this.terms.length;
    this.terms.push(tok);
    this.termIds.set(tok, id);
    this.termChars += tok.length;
    if (this.indexed) {
      const at = lowerBound(this.deltaSorted, tok);
      this.deltaSorted.splice(at, 0, tok);
      this.deltaSortedIds.splice(at, 0, id);
    }
    return id;
  }

  private sender(email: string): number {
    let id = this.senderIds.get(email);
    if (id === undefined) {
      id = this.senders.length;
      this.senders.push(email);
      this.senderIds.set(email, id);
      this.senderChars += email.length;
    }
    return id;
  }

  private threadSlot(threadId: number): number {
    let t = this.threadIdx.get(threadId);
    if (t !== undefined) return t;
    this.ensureThreads(1);
    t = this.tCount++;
    this.thrId[t] = threadId;
    this.thrDate[t] = 0;
    this.thrFlags[t] = 0;
    this.thrAccount[t] = 0;
    this.thrHead[t] = -1;
    this.thrCats[t] = EMPTY;
    this.threadIdx.set(threadId, t);
    return t;
  }

  /** Appends a doc with its tokens per field (subject, from, to, body). */
  private appendDoc(doc: { messageId: number; threadId: number; date: number; hasAttachments: boolean; fromEmail: string }, fields: readonly (readonly string[])[]): number {
    this.ensureDocs(1);
    let need = FIELDS;
    for (const f of fields) need += f.length * 5;
    this.ensureFwd(need);
    const d = this.n++;
    const out = this.fwd;
    const touched = this.touched;
    touched.length = 0;
    let p = this.fwdLen;
    for (let f = 0; f < FIELDS; f++) {
      for (const tok of fields[f]!) {
        const id = this.intern(tok);
        if (this.indexed) {
          this.ensureMasks(id + 1);
          if (this.masks[id] === 0) touched.push(id);
          this.masks[id]! |= 1 << f;
        }
        let v = id + 1;
        while (v >= 0x80) {
          out[p++] = (v & 0x7f) | 0x80;
          v >>>= 7;
        }
        out[p++] = v;
      }
      out[p++] = 0;
    }
    this.fwdLen = p;
    this.docFwd[d + 1] = p;
    this.docMsg[d] = doc.messageId;
    this.docDate[d] = doc.date;
    this.docAtt[d] = doc.hasAttachments ? 1 : 0;
    this.docFrom[d] = this.sender(doc.fromEmail);
    const t = this.threadSlot(doc.threadId);
    this.docThread[d] = t;
    this.docNext[d] = this.thrHead[t]!;
    this.thrHead[t] = d;
    setBit(this.alive, d);
    this.msgToDoc.set(doc.messageId, d);
    if (this.indexed) {
      for (const id of touched) {
        let list = this.delta.get(id);
        if (!list) this.delta.set(id, (list = []));
        list.push(d, this.masks[id]!);
        this.masks[id] = 0;
        this.deltaEntries++;
      }
      // cached term sets don't know the new doc
      this.cache.clear();
    }
    return d;
  }

  private removeDoc(messageId: number): void {
    const d = this.msgToDoc.get(messageId);
    if (d === undefined) return;
    clearBit(this.alive, d);
    this.msgToDoc.delete(messageId);
    this.dead++;
  }

  private before(a: number, b: number): boolean {
    const da = this.thrDate[a]!;
    const db = this.thrDate[b]!;
    return da > db || (da === db && this.thrId[a]! > this.thrId[b]!);
  }

  /** first order position whose thread is not newer than (date, id) */
  private orderPos(date: number, id: number, inclusive: boolean): number {
    const order = this.order;
    let lo = 0;
    let hi = this.orderLen;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      const t = order[m]!;
      const dt = this.thrDate[t]!;
      if (dt > date || (dt === date && (inclusive ? this.thrId[t]! >= id : this.thrId[t]! > id))) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  private orderInsert(t: number): void {
    const at = this.orderPos(this.thrDate[t]!, this.thrId[t]!, false);
    this.order.copyWithin(at + 1, at, this.orderLen);
    this.order[at] = t;
    this.orderLen++;
  }

  private orderRemove(t: number): void {
    const at = this.orderPos(this.thrDate[t]!, this.thrId[t]!, false);
    if (this.order[at] !== t) throw new Error("instant search: thread order out of sync");
    this.order.copyWithin(at, at + 1, this.orderLen);
    this.orderLen--;
  }

  private setCats(t: number, ids: readonly number[]): void {
    for (const c of this.thrCats[t]!) clearBit(this.cats.get(c)!, t);
    for (const c of ids) {
      let s = this.cats.get(c);
      if (!s) this.cats.set(c, (s = new Uint32Array(words(this.tCap))));
      setBit(s, t);
    }
    this.thrCats[t] = ids.length ? [...ids] : EMPTY;
  }

  private upsertThread(doc: SearchThreadDoc): void {
    const t = this.threadSlot(doc.threadId);
    // flags and categories change in place; only a new date moves the thread in the order
    const exists = (this.thrFlags[t]! & T_EXISTS) !== 0;
    const move = this.indexed && (!exists || this.thrDate[t] !== doc.lastDate);
    if (move && exists) this.orderRemove(t);
    this.thrDate[t] = doc.lastDate;
    this.thrAccount[t] = doc.accountId;
    this.thrFlags[t] =
      T_EXISTS |
      (doc.inInbox ? T_INBOX : 0) |
      (doc.hasSent ? T_SENT : 0) |
      (doc.inTrash ? T_TRASH : 0) |
      (doc.inSpam ? T_SPAM : 0) |
      (doc.isStarred ? T_STARRED : 0) |
      (doc.unreadCount > 0 ? T_UNREAD : 0);
    this.setCats(t, doc.categoryIds);
    if (move) this.orderInsert(t);
  }

  private removeThread(threadId: number): void {
    const t = this.threadIdx.get(threadId);
    if (t === undefined || !(this.thrFlags[t]! & T_EXISTS)) return;
    if (this.indexed) this.orderRemove(t);
    this.thrFlags[t] = 0;
    this.setCats(t, EMPTY);
  }

  // ───────────────────────────── updates ─────────────────────────────

  /**
   * Applies one committed batch (absolute projections). Duplicates are
   * ignored; a gap or another epoch is refused (RevisionError) and the caller
   * rebuilds. The revision advances only once the whole batch applied; a
   * failure part-way discards the index.
   */
  async apply(batch: IndexBatch): Promise<void> {
    const rev = this.rev;
    if (!this.indexed || !rev) throw new IndexNotCurrentError("instant search: apply before the build finished");
    if (batch.from.epoch !== rev.epoch || batch.to.epoch !== rev.epoch) throw new RevisionError("epoch", "the batch belongs to another database");
    if (batch.to.seq <= rev.seq) return;
    if (batch.from.seq !== rev.seq) throw new RevisionError("gap", `the index is at ${rev.seq}, the batch starts at ${batch.from.seq}`);
    this.enter("apply");
    this.state = "stale";
    try {
      const clock = this.clock();
      for (const change of batch.changes) {
        this.applyChange(change);
        await clock.tick();
      }
      this.rev = batch.to;
      this.state = "ready";
    } catch (error) {
      this.disable();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private applyChange(c: IndexChange): void {
    switch (c.kind) {
      case "upsertMessage": {
        const doc = c.doc;
        this.removeDoc(doc.messageId);
        this.appendDoc(doc, [tokenize(doc.subject), tokenize(doc.fromText), tokenize(doc.recipients), tokenize(doc.body)]);
        break;
      }
      case "removeMessage":
        this.removeDoc(c.messageId);
        break;
      case "upsertThread":
        this.upsertThread(c.doc);
        break;
      case "removeThread":
        this.removeThread(c.threadId);
        break;
    }
  }

  /**
   * A new engine with the same content and revision, without tombstones or
   * delta: alive docs are re-encoded from the forward index (no tokenizing).
   * Built in slices; this engine must not be mutated meanwhile (it may answer).
   */
  async compacted(): Promise<InstantSearchEngine> {
    if (!this.indexed || !this.rev) throw new IndexNotCurrentError("instant search: compaction before the build finished");
    this.enter("compaction");
    try {
      const next = new InstantSearchEngine(this.o);
      next.beginBuild(this.rev);
      const clock = this.clock();
      const fields: string[][] = [[], [], [], []];
      // room for what is alive, so the copy doesn't grow (and copy) its buffers on the way
      next.ensureDocs(this.n - this.dead);
      next.ensureFwd(this.fwdLen);
      // in slot order: any order serves, and sorting would block
      for (let d = 0; d < this.n; d++) {
        if (!has(this.alive, d)) continue;
        for (const f of fields) f.length = 0;
        const f = this.fwd;
        let p = this.docFwd[d]!;
        const end = this.docFwd[d + 1]!;
        let field = 0;
        while (p < end) {
          let v = 0;
          let shift = 0;
          let b: number;
          do {
            b = f[p++]!;
            v |= (b & 0x7f) << shift;
            shift += 7;
          } while (b & 0x80);
          if (v === 0) field++;
          else fields[field]!.push(this.terms[v - 1]!);
        }
        const t = this.docThread[d]!;
        next.appendDoc(
          { messageId: this.docMsg[d]!, threadId: this.thrId[t]!, date: this.docDate[d]!, hasAttachments: this.docAtt[d] === 1, fromEmail: this.senders[this.docFrom[d]!]! },
          fields,
        );
        await clock.tick();
      }
      for (let i = 0; i < this.orderLen; i++) {
        next.upsertThread(this.threadDoc(this.order[i]!));
        if ((i & 1023) === 0) await clock.tick();
      }
      await next.finishBuild();
      return next;
    } finally {
      this.busy = false;
    }
  }

  private threadDoc(t: number): SearchThreadDoc {
    const f = this.thrFlags[t]!;
    return {
      threadId: this.thrId[t]!,
      accountId: this.thrAccount[t]!,
      lastDate: this.thrDate[t]!,
      inInbox: (f & T_INBOX) !== 0,
      hasSent: (f & T_SENT) !== 0,
      inTrash: (f & T_TRASH) !== 0,
      inSpam: (f & T_SPAM) !== 0,
      isStarred: (f & T_STARRED) !== 0,
      unreadCount: f & T_UNREAD ? 1 : 0,
      categoryIds: this.thrCats[t]!,
    };
  }

  // ───────────────────────────── queries ─────────────────────────────

  async query(req: SearchRequest, at: Revision): Promise<SearchIdsPage> {
    return this.search(req, at);
  }

  /**
   * Synchronous so the store can capture its revision, query and hydrate
   * without any other task interleaving.
   */
  search(req: SearchRequest, at: Revision): SearchIdsPage {
    if (!this.currentAt(at)) throw new IndexNotCurrentError(`instant search is not at revision ${at.epoch}:${at.seq}`);
    const c = req.cursor;
    if (c) {
      if (c.queryKey !== req.search.key) throw new StaleCursorError("query");
      if (c.revision.epoch !== at.epoch) throw new StaleCursorError("epoch");
      if (c.revision.seq !== at.seq) throw new StaleCursorError("revision");
    }
    const k = req.limit + 1;
    const plan = this.plan(req.search);
    let strategy: string;
    let threads: number[];
    if (!plan) {
      strategy = "instant:empty";
      threads = [];
    } else {
      const walk = plan.mode !== "messages" || plan.everyDoc || plan.lazy.length > 0 || popcount(plan.set) >= (this.o.walkThreshold ?? 2000);
      strategy = walk ? "instant:walk" : "instant:docs";
      const canFallBack = plan.phrases.length > 0 && this.o.phrases !== undefined;
      let r = walk ? this.walk(plan, c, k, canFallBack) : this.sparse(plan, c, k, canFallBack);
      if (r === OVER_WALK) {
        // the candidates sit in old or filtered-out threads: dedup them instead of passing every newer thread
        strategy = "instant:docs";
        this.materialize(plan);
        r = this.sparse(plan, c, k, canFallBack);
      }
      if (r === OVER_BUDGET) {
        // frequent words that are rarely adjacent: ask the exact phrase doclist instead of verifying candidates
        for (const ph of plan.phrases) andInto(plan.set, this.sourceSet(ph.term));
        plan.phrases = [];
        this.materialize(plan);
        const rewalk = popcount(plan.set) >= (this.o.walkThreshold ?? 2000);
        strategy = `${rewalk ? "instant:walk" : "instant:docs"}+phrases`;
        r = rewalk ? this.walk(plan, c, k, false) : this.sparse(plan, c, k, false);
        if (r === OVER_WALK) r = this.sparse(plan, c, k, false);
        if (typeof r === "symbol") throw new Error("unreachable");
      }
      threads = r;
    }
    this.lastStrategy = strategy;
    const hasMore = threads.length > req.limit;
    const kept = hasMore ? threads.slice(0, req.limit) : threads;
    const last = kept[kept.length - 1];
    const nextCursor: SearchCursor | null =
      hasMore && last !== undefined ? { revision: at, queryKey: req.search.key, lastDate: this.thrDate[last]!, id: this.thrId[last]! } : null;
    return { threadIds: kept.map((t) => this.thrId[t]!), nextCursor, revision: at, strategy };
  }

  private threadFilter(r: ResolvedSearch): ThreadFilter | null {
    let [mask, value] = VIEW_FLAGS[r.view];
    mask |= T_EXISTS;
    value |= T_EXISTS;
    const need = (bit: number, on: boolean) => {
      if (mask & bit && ((value & bit) !== 0) !== on) return false;
      mask |= bit;
      if (on) value |= bit;
      return true;
    };
    const q = r.query;
    if (q.unread !== undefined && !need(T_UNREAD, q.unread)) return null;
    if (q.starred !== undefined && !need(T_STARRED, q.starred)) return null;
    const inCats: Uint32Array[] = [];
    for (const c of r.categoryIds) {
      const s = this.cats.get(c);
      if (!s) return null;
      inCats.push(s);
    }
    const outCats: Uint32Array[] = [];
    for (const c of r.excludeCategoryIds) {
      const s = this.cats.get(c);
      if (s) outCats.push(s);
    }
    return {
      mask,
      value,
      accounts: r.accountIds ? new Set(r.accountIds) : null,
      excludeAccounts: r.excludeAccountIds.length ? new Set(r.excludeAccountIds) : null,
      inCats,
      outCats,
    };
  }

  private threadOk(f: ThreadFilter, t: number): boolean {
    if ((this.thrFlags[t]! & f.mask) !== f.value) return false;
    if (f.accounts && !f.accounts.has(this.thrAccount[t]!)) return false;
    if (f.excludeAccounts && f.excludeAccounts.has(this.thrAccount[t]!)) return false;
    for (const s of f.inCats) if (!has(s, t)) return false;
    for (const s of f.outCats) if (has(s, t)) return false;
    return true;
  }

  /** The query as message and thread predicates (same rules as the FTS5 planner and the oracle); null: nothing can match. */
  private plan(r: ResolvedSearch): Plan | null {
    if (r.impossible) return null;
    const q = r.query;
    const filter = this.threadFilter(r);
    if (!filter) return null;
    let sender: string | null = null;
    const notSenders: number[] = [];
    let hasEmailTerm = false;
    const positive: MessageTerm[] = [];
    const negative: MessageTerm[] = [];
    for (const term of q.terms) {
      if (term.field === "from" && isFullEmail(term.value)) {
        hasEmailTerm = true;
        const email = normalizeText(term.value);
        if (term.negate) {
          const id = this.senderIds.get(email);
          if (id !== undefined) notSenders.push(id);
        } else if (sender === null) sender = email;
        else if (sender !== email) return null; // a message has a single sender
        continue;
      }
      if (tokenize(term.value).length === 0) continue;
      (term.negate ? negative : positive).push(term);
    }
    const hasMessagePredicate = positive.length > 0 || hasEmailTerm || q.hasAttachment !== undefined || q.before !== undefined || q.after !== undefined;
    if (!hasMessagePredicate) {
      if (negative.length === 0) return { mode: "threads", filter, set: this.alive, attr: null, phrases: [], lazy: [], everyDoc: false };
      // purely negative: whole threads with a matching message are excluded
      const set = new Uint32Array(this.alive.length);
      for (const term of negative) orInto(set, this.exactSet(term));
      return { mode: "exclude", filter, set, attr: null, phrases: [], lazy: [], everyDoc: false };
    }
    const senderId = sender === null ? -1 : (this.senderIds.get(sender) ?? -2);
    if (senderId === -2) return null;
    const attr: Attr | null =
      sender !== null || notSenders.length || q.hasAttachment !== undefined || q.before !== undefined || q.after !== undefined
        ? { sender: senderId, notSenders, att: q.hasAttachment === undefined ? -1 : q.hasAttachment ? 1 : 0, before: q.before ?? Infinity, after: q.after ?? -Infinity }
        : null;
    let set: Uint32Array | null = null;
    const phrases: Phrase[] = [];
    const lazy: TokenCheck[] = [];
    for (const term of positive) {
      const check = this.denseCheck(term);
      if (check) {
        lazy.push(check);
        continue;
      }
      const e = this.termSet(term);
      set = set ? andInto(set, e.set) : e.set;
      if (e.phrase) phrases.push(e.phrase);
    }
    if (!set && lazy.length) set = copyWords(this.alive);
    let everyDoc = false;
    if (set) andInto(set, this.alive);
    else if (senderId >= 0) set = andInto(copyWords(this.senderSet(senderId)), this.alive);
    else if (attr && q.before !== undefined) set = this.attrSet(attr); // old mail: a walk would pass every newer thread first
    else {
      set = copyWords(this.alive);
      everyDoc = true;
    }
    for (const term of negative) andNotInto(set, this.exactSet(term));
    return { mode: "messages", filter, set, attr, phrases, lazy, everyDoc };
  }

  /**
   * The first keystrokes: a one- or two-letter prefix whose postings cover a
   * large part of the mailbox. A newest-first walk meets a match within a few
   * docs, so checking docs costs far less than building its set (hundreds of
   * thousands of postings). Longer tokens build their (cached) sets.
   */
  private denseCheck(term: MessageTerm): TokenCheck | null {
    const toks = tokenize(term.value);
    if (toks.length !== 1 || !term.prefix || toks[0]!.length > 2) return null;
    const tok = toks[0]!;
    const bits = FIELD_BITS[term.field];
    if (this.cache.has(`${bits}${term.prefix ? "*" : "="}${tok}`)) return null;
    let postings = 0;
    const count = (id: number) => {
      if (id < this.baseTerms) postings += this.baseOff[id + 1]! - this.baseOff[id]!;
      postings += (this.delta.get(id)?.length ?? 0) / 2;
    };
    this.prefixTerms(tok, count);
    if (postings < (this.n - this.dead) / 3) return null;
    const members = new Uint8Array(this.terms.length);
    this.prefixTerms(tok, (id) => void (members[id] = 1));
    return { token: tok, prefix: true, members, bits };
  }

  /** Every check has a member term in its fields in doc d. */
  private tokensAt(d: number, checks: TokenCheck[]): boolean {
    const all = (1 << checks.length) - 1;
    let met = 0;
    const f = this.fwd;
    let p = this.docFwd[d]!;
    const end = this.docFwd[d + 1]!;
    let field = 0;
    while (p < end) {
      let v = 0;
      let shift = 0;
      let b: number;
      do {
        b = f[p++]!;
        v |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      if (v === 0) {
        field++;
        continue;
      }
      const bit = 1 << field;
      for (let i = 0; i < checks.length; i++) {
        const c = checks[i]!;
        if (c.bits & bit && c.members[v - 1] === 1) met |= 1 << i;
      }
      if (met === all) return true;
    }
    return false;
  }

  /** Alive docs passing the attribute predicates. */
  private attrSet(attr: Attr): Uint32Array {
    const set = new Uint32Array(this.alive.length);
    for (let d = 0; d < this.n; d++) if (this.attrOk(attr, d)) setBit(set, d);
    return andInto(set, this.alive);
  }

  /** Turns what a walk checks per doc into candidate sets (before deduplicating candidates). */
  private materialize(plan: Plan): void {
    for (const c of plan.lazy) andInto(plan.set, this.tokenSet(c.token, c.bits, c.prefix));
    plan.lazy = [];
    if (plan.everyDoc && plan.attr) andInto(plan.set, this.attrSet(plan.attr));
    plan.everyDoc = false;
  }

  /** Docs holding every token of the term in its field (a superset for phrases, which come with their verifier). */
  private termSet(term: MessageTerm): { set: Uint32Array; phrase: Phrase | null } {
    const toks = tokenize(term.value);
    const bits = FIELD_BITS[term.field];
    let set: Uint32Array | null = null;
    for (let i = 0; i < toks.length; i++) {
      const s = this.tokenSet(toks[i]!, bits, term.prefix && i === toks.length - 1);
      set = set ? andInto(set, s) : copyWords(s);
    }
    if (toks.length < 2) return { set: set!, phrase: null };
    const want = new Int32Array(toks.length);
    let members: Uint8Array | null = null;
    for (let i = 0; i < toks.length; i++) {
      if (term.prefix && i === toks.length - 1) {
        want[i] = -1;
        members = new Uint8Array(this.terms.length);
        this.prefixTerms(toks[i]!, (id) => void (members![id] = 1));
      } else want[i] = this.termIds.get(toks[i]!) ?? -2;
    }
    return { set: set!, phrase: { term, want, members, bits } };
  }

  /** Exact docs matching a term (negations): verified, or the phrase doclist when there are many candidates. */
  private exactSet(term: MessageTerm): Uint32Array {
    const { set, phrase } = this.termSet(term);
    andInto(set, this.alive);
    if (!phrase) return set;
    if (this.o.phrases && popcount(set) > (this.o.phraseBudget ?? 512)) return andInto(this.sourceSet(term), this.alive);
    scanBits(set, (d) => {
      if (!this.phraseAt(d, phrase)) clearBit(set, d);
    });
    return set;
  }

  private sourceSet(term: MessageTerm): Uint32Array {
    const set = new Uint32Array(this.alive.length);
    for (const id of this.o.phrases!(term)) {
      const d = this.msgToDoc.get(id);
      if (d !== undefined) setBit(set, d);
    }
    return set;
  }

  /** Docs with the token (or a term starting with it) in the given fields. Cached; never mutate the result. */
  private tokenSet(tok: string, bits: number, prefix: boolean): Uint32Array {
    const key = `${bits}${prefix ? "*" : "="}${tok}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const out = new Uint32Array(this.alive.length);
    if (prefix) this.prefixTerms(tok, (id) => this.orPostings(id, bits, out));
    else {
      const id = this.termIds.get(tok);
      if (id !== undefined) this.orPostings(id, bits, out);
    }
    this.cache.set(key, out);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  /** Docs from one sender (cached like term sets). */
  private senderSet(sender: number): Uint32Array {
    const key = `@${sender}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = new Uint32Array(this.alive.length);
    const from = this.docFrom;
    for (let d = 0; d < this.n; d++) if (from[d] === sender) setBit(out, d);
    this.cache.set(key, out);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  private prefixTerms(prefix: string, fn: (id: number) => void): void {
    for (let i = lowerBound(this.baseSorted, prefix); i < this.baseSorted.length && this.baseSorted[i]!.startsWith(prefix); i++) fn(this.baseSortedIds[i]!);
    for (let i = lowerBound(this.deltaSorted, prefix); i < this.deltaSorted.length && this.deltaSorted[i]!.startsWith(prefix); i++) fn(this.deltaSortedIds[i]!);
  }

  private orPostings(id: number, bits: number, out: Uint32Array): void {
    if (id < this.baseTerms) {
      const docs = this.baseDocs;
      const mask = this.baseMask;
      const end = this.baseOff[id + 1]!;
      if (bits === 15) {
        for (let p = this.baseOff[id]!; p < end; p++) {
          const d = docs[p]!;
          out[d >>> 5]! |= 1 << (d & 31);
        }
      } else {
        for (let p = this.baseOff[id]!; p < end; p++) {
          if (mask[p]! & bits) {
            const d = docs[p]!;
            out[d >>> 5]! |= 1 << (d & 31);
          }
        }
      }
    }
    const list = this.delta.get(id);
    if (list) {
      for (let i = 0; i < list.length; i += 2) {
        if (list[i + 1]! & bits) {
          const d = list[i]!;
          out[d >>> 5]! |= 1 << (d & 31);
        }
      }
    }
  }

  /** The phrase's tokens adjacent inside one of its fields of doc d. */
  private phraseAt(d: number, ph: Phrase): boolean {
    const want = ph.want;
    const w = want.length;
    for (let i = 0; i < w; i++) if (want[i] === -2) return false;
    const f = this.fwd;
    let p = this.docFwd[d]!;
    const end = this.docFwd[d + 1]!;
    let field = 0;
    let len = 0;
    let toks = this.tokens;
    while (p < end) {
      let v = 0;
      let shift = 0;
      let b: number;
      do {
        b = f[p++]!;
        v |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      if (v !== 0) {
        if (ph.bits & (1 << field)) {
          if (len === toks.length) this.tokens = toks = grown(toks, toks.length * 2);
          toks[len++] = v - 1;
        }
        continue;
      }
      if (len >= w) {
        outer: for (let s = 0; s + w <= len; s++) {
          for (let j = 0; j < w; j++) {
            const x = want[j]!;
            const t = toks[s + j]!;
            if (x === -1 ? ph.members![t] !== 1 : x !== t) continue outer;
          }
          return true;
        }
      }
      field++;
      len = 0;
    }
    return false;
  }

  private attrOk(a: Attr, d: number): boolean {
    const from = this.docFrom[d]!;
    if (a.sender >= 0 && from !== a.sender) return false;
    for (const x of a.notSenders) if (from === x) return false;
    if (a.att >= 0 && this.docAtt[d] !== a.att) return false;
    const date = this.docDate[d]!;
    return date < a.before && date >= a.after;
  }

  /** Threads newest-first from the cursor; stops after k matches. */
  private walk(plan: Plan, cursor: SearchCursor | undefined, k: number, budgeted: boolean): number[] | typeof OVER_BUDGET | typeof OVER_WALK {
    const { filter, set, attr, phrases, mode } = plan;
    const order = this.order;
    const head = this.thrHead;
    const next = this.docNext;
    const alive = this.alive;
    const budget = this.o.phraseBudget ?? 512;
    let fails = 0;
    const out: number[] = [];
    const start = cursor ? this.orderPos(cursor.lastDate, cursor.id, true) : 0;
    const dedup = mode === "messages";
    const lazy = plan.lazy;
    let visits = 0;
    for (let i = start; i < this.orderLen && out.length < k; i++) {
      const t = order[i]!;
      if (!this.threadOk(filter, t)) continue;
      if (dedup && ++visits > WALK_VISITS) return OVER_WALK;
      if (mode === "threads") {
        out.push(t);
        continue;
      }
      if (mode === "exclude") {
        let excluded = false;
        for (let d = head[t]!; d >= 0; d = next[d]!) {
          if (has(set, d)) {
            excluded = true;
            break;
          }
        }
        if (!excluded) out.push(t);
        continue;
      }
      for (let d = head[t]!; d >= 0; d = next[d]!) {
        if (!has(set, d) || !has(alive, d)) continue;
        if (attr && !this.attrOk(attr, d)) continue;
        if (lazy.length && !this.tokensAt(d, lazy)) continue;
        let ok = true;
        for (const ph of phrases) {
          if (!this.phraseAt(d, ph)) {
            ok = false;
            if (budgeted && ++fails > budget) return OVER_BUDGET;
            break;
          }
        }
        if (ok) {
          out.push(t);
          break;
        }
      }
    }
    return out;
  }

  /** Few candidates: dedup their threads into the k newest after the cursor. */
  private sparse(plan: Plan, cursor: SearchCursor | undefined, k: number, budgeted: boolean): number[] | typeof OVER_BUDGET {
    const { filter, set, attr, phrases } = plan;
    if (++this.gen === 0xffffffff) {
      this.seen.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    const seen = this.seen;
    const date = this.thrDate;
    const tid = this.thrId;
    const budget = this.o.phraseBudget ?? 512;
    let fails = 0;
    let over = false;
    // best first
    const top: number[] = [];
    scanBits(set, (d) => {
      const t = this.docThread[d]!;
      if (seen[t] === gen) return;
      if (!this.threadOk(filter, t) || (cursor && (date[t]! > cursor.lastDate || (date[t] === cursor.lastDate && tid[t]! >= cursor.id)))) {
        seen[t] = gen;
        return;
      }
      if (top.length === k && !this.before(t, top[k - 1]!)) {
        seen[t] = gen;
        return;
      }
      if (attr && !this.attrOk(attr, d)) return;
      for (const ph of phrases) {
        if (!this.phraseAt(d, ph)) {
          if (budgeted && ++fails > budget) {
            over = true;
            return true;
          }
          return;
        }
      }
      seen[t] = gen;
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (this.before(top[m]!, t)) lo = m + 1;
        else hi = m;
      }
      top.splice(lo, 0, t);
      if (top.length > k) top.pop();
    });
    return over ? OVER_BUDGET : top;
  }

  // ───────────────────────────── snapshots ─────────────────────────────

  /**
   * The whole index as one buffer: a header with the revision, identity and
   * versions, the typed arrays as they are (tombstones and delta included)
   * and a checksum over all of it. Copies in slices (queries keep running,
   * changes wait), then checksums the copy in slices.
   */
  async snapshot(): Promise<Uint8Array> {
    if (!this.indexed || !this.rev || this.state !== "ready") throw new IndexNotCurrentError("instant search: snapshot of an index that isn't current");
    this.enter("snapshot");
    let packed: Uint8Array;
    const clock = this.clock();
    try {
      const deltaTerms = new Uint32Array(this.delta.size);
      const deltaOff = new Uint32Array(this.delta.size + 1);
      const deltaPairs = new Uint32Array(this.deltaEntries * 2);
      let i = 0;
      let p = 0;
      for (const [id, list] of this.delta) {
        deltaTerms[i] = id;
        deltaPairs.set(list, p);
        p += list.length;
        deltaOff[++i] = p;
      }
      const catOff = new Uint32Array(this.tCount + 1);
      let total = 0;
      for (let t = 0; t < this.tCount; t++) catOff[t + 1] = total += this.thrCats[t]!.length;
      const catIds = new Float64Array(total);
      for (let t = 0, at = 0; t < this.tCount; t++) for (const c of this.thrCats[t]!) catIds[at++] = c;
      const n = this.n;
      const T = this.tCount;
      const sections: Record<string, Section> = {
        terms: { strings: this.terms },
        senders: { strings: this.senders },
        baseSortedIds: this.baseSortedIds,
        deltaSortedIds: Int32Array.from(this.deltaSortedIds),
        baseOff: this.baseOff,
        baseDocs: this.baseDocs,
        baseMask: this.baseMask,
        deltaTerms,
        deltaOff,
        deltaPairs,
        docMsg: this.docMsg.subarray(0, n),
        docThread: this.docThread.subarray(0, n),
        docDate: this.docDate.subarray(0, n),
        docAtt: this.docAtt.subarray(0, n),
        docFrom: this.docFrom.subarray(0, n),
        docNext: this.docNext.subarray(0, n),
        docFwd: this.docFwd.subarray(0, n + 1),
        alive: this.alive.subarray(0, words(n)),
        fwd: this.fwd.subarray(0, this.fwdLen),
        thrId: this.thrId.subarray(0, T),
        thrDate: this.thrDate.subarray(0, T),
        thrFlags: this.thrFlags.subarray(0, T),
        thrAccount: this.thrAccount.subarray(0, T),
        thrHead: this.thrHead.subarray(0, T),
        order: this.order.subarray(0, this.orderLen),
        catOff,
        catIds,
      };
      const meta = { n, dead: this.dead, baseN: this.baseN, baseTerms: this.baseTerms, tCount: T, orderLen: this.orderLen };
      // in slices: nothing may change the index meanwhile (busy), queries still run
      packed = await packSnapshot(this.header(), this.rev, meta, sections, clock);
    } finally {
      this.busy = false;
    }
    // a copy: the index may change while it is sealed
    return sealSnapshot(packed, clock);
  }

  private header(): { tokenizer: number; format: number; identity: string } {
    return { tokenizer: TOKENIZER_VERSION, format: INDEX_FORMAT, identity: this.o.identity ?? "" };
  }

  /**
   * Restores a snapshot into this (unused) engine; with `adopt` the engine
   * keeps and mutates `bytes` (the caller must not reuse them). False when it is corrupt,
   * truncated or written for another tokenizer, format or identity: the
   * caller rebuilds. A restored engine is current at the snapshot's revision
   * only; the caller replays the feed to the head before using it.
   */
  async restore(bytes: Uint8Array, adopt = false): Promise<boolean> {
    if (this.n || this.tCount || this.indexed) throw new Error("instant search: restore into a used engine");
    this.enter("restore");
    try {
      // the index lives in the buffer it restores from: adopt it (a file just read) or work on a copy
      const own = adopt ? bytes : await sliceCopy(bytes, this.clock());
      const snap = await readSnapshot(own, this.header(), this.clock());
      if (!snap) return false;
      const { revision, meta, sections: s } = snap;
      const num = (k: string) => (typeof meta[k] === "number" && Number.isInteger(meta[k]) && (meta[k] as number) >= 0 ? (meta[k] as number) : NaN);
      const n = num("n");
      const T = num("tCount");
      const baseTerms = num("baseTerms");
      const orderLen = num("orderLen");
      const terms = s.strings("terms");
      const senders = s.strings("senders");
      const baseOff = s.u32("baseOff");
      const baseDocs = s.u32("baseDocs");
      const baseMask = s.u8("baseMask");
      const docFwd = s.u32("docFwd");
      const fwd = s.u8("fwd");
      const deltaTerms = s.u32("deltaTerms");
      const deltaOff = s.u32("deltaOff");
      const deltaPairs = s.u32("deltaPairs");
      const catOff = s.u32("catOff");
      const catIds = s.f64("catIds");
      const docArrays = [s.f64("docMsg"), s.i32("docThread"), s.f64("docDate"), s.u8("docAtt"), s.i32("docFrom"), s.i32("docNext")];
      const thrArrays = [s.f64("thrId"), s.f64("thrDate"), s.u8("thrFlags"), s.f64("thrAccount"), s.i32("thrHead")];
      const order = s.i32("order");
      const baseSortedIds = s.i32("baseSortedIds");
      const deltaSortedIds = s.i32("deltaSortedIds");
      const alive = s.u32("alive");
      const consistent =
        [n, T, baseTerms, orderLen, num("baseN"), num("dead")].every(Number.isFinite) &&
        baseTerms <= terms.length &&
        baseOff.length === baseTerms + 1 &&
        baseOff[baseTerms] === baseDocs.length &&
        baseMask.length === baseDocs.length &&
        docFwd.length === n + 1 &&
        docFwd[n] === fwd.length &&
        alive.length === words(n) &&
        docArrays.every((a) => a.length === n) &&
        thrArrays.every((a) => a.length === T) &&
        order.length === orderLen &&
        orderLen <= T &&
        catOff.length === T + 1 &&
        catOff[T] === catIds.length &&
        deltaOff.length === deltaTerms.length + 1 &&
        deltaOff[deltaTerms.length] === deltaPairs.length &&
        baseSortedIds.length === baseTerms &&
        baseSortedIds.length + deltaSortedIds.length === terms.length;
      if (!consistent) return false;

      const clock = this.clock();
      this.terms = terms;
      for (let i = 0; i < terms.length; i++) {
        this.termIds.set(terms[i]!, i);
        this.termChars += terms[i]!.length;
        if ((i & 4095) === 0) await clock.tick();
      }
      this.baseSortedIds = baseSortedIds.slice();
      this.baseSorted = Array.from(this.baseSortedIds, (i) => terms[i]!);
      this.deltaSortedIds = Array.from(deltaSortedIds);
      this.deltaSorted = this.deltaSortedIds.map((i) => terms[i]!);
      await clock.tick();
      this.senders = senders;
      for (let i = 0; i < senders.length; i++) {
        this.senderIds.set(senders[i]!, i);
        this.senderChars += senders[i]!.length;
        if ((i & 4095) === 0) await clock.tick();
      }
      this.baseTerms = baseTerms;
      this.baseOff = baseOff;
      this.baseDocs = baseDocs;
      this.baseMask = baseMask;
      for (let i = 0; i < deltaTerms.length; i++) {
        this.delta.set(deltaTerms[i]!, Array.from(deltaPairs.subarray(deltaOff[i]!, deltaOff[i + 1]!)));
      }
      this.deltaEntries = deltaPairs.length / 2;
      await clock.tick();

      // the arrays stay in the snapshot's buffer until they first grow
      this.n = n;
      this.docCap = n;
      this.dead = num("dead");
      this.baseN = num("baseN");
      this.docMsg = docArrays[0] as Float64Array<ArrayBuffer>;
      this.docThread = docArrays[1] as Int32Array<ArrayBuffer>;
      this.docDate = docArrays[2] as Float64Array<ArrayBuffer>;
      this.docAtt = docArrays[3] as Uint8Array<ArrayBuffer>;
      this.docFrom = docArrays[4] as Int32Array<ArrayBuffer>;
      this.docNext = docArrays[5] as Int32Array<ArrayBuffer>;
      this.docFwd = docFwd;
      this.alive = alive;
      this.fwd = fwd;
      this.fwdLen = fwd.length;
      for (let d = 0; d < n; d++) {
        if (has(this.alive, d)) this.msgToDoc.set(this.docMsg[d]!, d);
        if ((d & 1023) === 0) await clock.tick();
      }

      this.tCount = T;
      this.tCap = T;
      this.thrId = thrArrays[0] as Float64Array<ArrayBuffer>;
      this.thrDate = thrArrays[1] as Float64Array<ArrayBuffer>;
      this.thrFlags = thrArrays[2] as Uint8Array<ArrayBuffer>;
      this.thrAccount = thrArrays[3] as Float64Array<ArrayBuffer>;
      this.thrHead = thrArrays[4] as Int32Array<ArrayBuffer>;
      this.seen = new Uint32Array(T);
      // room for every thread: a removed one may come back
      this.order = new Int32Array(T);
      this.order.set(order);
      this.orderLen = orderLen;
      for (let t = 0; t < T; t++) {
        this.threadIdx.set(this.thrId[t]!, t);
        this.thrCats[t] = EMPTY;
        if (catOff[t + 1]! > catOff[t]!) this.setCats(t, Array.from(catIds.subarray(catOff[t]!, catOff[t + 1]!)));
        if ((t & 1023) === 0) await clock.tick();
      }
      this.rev = revision;
      this.indexed = true;
      this.state = "ready";
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
      if (this.state !== "ready") this.reset();
    }
  }

  private reset(): void {
    const fresh = new InstantSearchEngine(this.o);
    Object.assign(this, fresh);
  }
}
