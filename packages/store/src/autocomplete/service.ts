import type { AutocompleteSource, ContactBatch, ContactMessage } from "../autocomplete-source";
import type { Platform } from "../platform";
import { RevisionError, sameRevision, type Revision } from "../search";
import { SliceClock } from "../instant/slices";
import { ContactIndex, DESKTOP_CONTACT_CAPS, type ContactCaps, type ContactHit, type SuggestOptions } from "./contacts";
import { DESKTOP_PHRASE_CAPS, PhraseModel, type PhraseCaps, type PhraseSuggestInput } from "./phrases";

const MiB = 1024 * 1024;

/** Both models together, transient copies included (a snapshot, a merge, a prune). */
export const DESKTOP_AUTOCOMPLETE_PEAK = 160 * MiB;
export const WEB_AUTOCOMPLETE_PEAK = 96 * MiB;

export type AutocompleteEvent = "built" | "restored" | "snapshot" | "evicted" | "rebuild" | "disabled";

export interface AutocompleteOptions {
  source: AutocompleteSource;
  platform: Pick<Platform, "yield" | "files">;
  contactCaps?: ContactCaps;
  phraseCaps?: PhraseCaps;
  peakBytes?: number;
  /** budget of one background slice */
  sliceMs?: number;
  /** quiet time after a commit before catching up, so a burst applies together */
  settleMs?: number;
  /** the longest catching up waits for writes to settle */
  maxLagMs?: number;
  /** a snapshot after this many applied messages, or this long after the first unsaved one */
  snapshotEvery?: { changes: number; ms: number };
  /** learn body suggestions (the setting); recipients are always on */
  phrases?: boolean;
  now?: () => number;
  /** counts and durations only: never an address, a name or text */
  onEvent?: (event: AutocompleteEvent, fields: { model: "contacts" | "phrases"; count?: number; durationMs?: number; bytes?: number; errorClass?: string }) => void;
}

export interface AutocompleteReport {
  state: "cold" | "restoring" | "building" | "catching-up" | "ready" | "disabled" | "closed";
  contacts: { size: number; bytes: number; revision: Revision | null; build?: { ms: number; messages: number }; restore?: { ms: number; bytes: number } };
  phrases: { enabled: boolean; messages: number; bytes: number; revision: Revision | null; build?: { ms: number; messages: number }; restore?: { ms: number; bytes: number } };
  snapshots: number;
  rebuilds: number;
  /** the longest stretch between two yields, in the background work so far */
  longestSliceMs: number;
}

type Model = "contacts" | "phrases";

/**
 * Keeps the contact index and the phrase model current with the store's
 * change log, off the interactive path and only once warmed (a draft opened,
 * a recipient field focused): restores the snapshots or builds in time
 * slices, replays committed batches after commit (a gap or another epoch:
 * rebuild), enforces the memory caps, writes snapshots and then rests with
 * nothing scheduled. Lookups are synchronous reads of whatever is current.
 */
export class Autocomplete {
  private contacts: ContactIndex | null = null;
  private phrases: PhraseModel | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private wakeUp: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private settling = false;
  private resting = false;
  private dirtyAt = 0;
  private firstDirtyAt = 0;
  private unsavedSince = 0;
  private retrySnapshotAt = 0;
  private failures = 0;
  private phrasesOn: boolean;
  private own: string[] = [];
  private resetWaiters: (() => void)[] | null = null;
  private readyWaiters: (() => void)[] = [];
  private readonly clock: SliceClock;
  private readonly contactCaps: ContactCaps;
  private readonly phraseCaps: PhraseCaps;
  private readonly peak: number;
  private readonly now: () => number;
  readonly report: AutocompleteReport;

  constructor(private readonly o: AutocompleteOptions) {
    this.contactCaps = o.contactCaps ?? DESKTOP_CONTACT_CAPS;
    this.phraseCaps = o.phraseCaps ?? DESKTOP_PHRASE_CAPS;
    this.peak = o.peakBytes ?? DESKTOP_AUTOCOMPLETE_PEAK;
    this.now = o.now ?? (() => Date.now());
    this.phrasesOn = o.phrases ?? true;
    this.clock = new SliceClock({ yield: () => o.platform.yield(), sliceMs: o.sliceMs ?? 4 });
    this.report = { state: "cold", contacts: { size: 0, bytes: 0, revision: null }, phrases: { enabled: this.phrasesOn, messages: 0, bytes: 0, revision: null }, snapshots: 0, rebuilds: 0, longestSliceMs: 0 };
  }

  get warmed(): boolean {
    return this.loop !== null;
  }

  /** Starts the background work (once); resolves when recipient suggestions can answer (or it gave up). */
  warm(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.loop ??= this.o.platform.yield().then(() => this.run());
    if (this.contacts || this.report.state === "disabled") return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  /** A write committed: catch up once writes settle (nothing before the first warm). */
  notify(): void {
    if (this.stopped || !this.loop) return;
    const now = this.now();
    this.pending = true;
    this.dirtyAt = now;
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    if (!this.settling) this.wake();
  }

  /** The user's own addresses (the accounts'). */
  setOwn(addresses: readonly string[]): void {
    this.own = [...addresses];
    this.contacts?.setOwn(this.own);
  }

  suggestRecipients(query: string, o: SuggestOptions = {}): { items: ContactHit[]; ready: boolean } {
    const c = this.contacts;
    if (!c) return { items: [], ready: false };
    return { items: c.suggest(query, o), ready: true };
  }

  /**
   * The best few people for each first letter and digit: a recipient field
   * shows them the moment a first letter is typed, before its lookup answers.
   * A letter at a time, yielding between (cold, each is a range scan).
   */
  async initials(o: SuggestOptions = {}): Promise<Record<string, ContactHit[]>> {
    const out: Record<string, ContactHit[]> = {};
    if (!this.contacts) return out;
    for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789") {
      const c = this.contacts;
      if (!c) break;
      const hits = c.suggest(ch, { ...o, limit: o.limit ?? 6 });
      if (hits.length) out[ch] = hits;
      await this.o.platform.yield();
    }
    return out;
  }

  suggestText(input: PhraseSuggestInput): string | null {
    if (!this.phrasesOn) return null;
    return this.phrases?.suggest(input) ?? null;
  }

  /** The body-suggestions setting: off drops the model and its snapshot (after the unit in flight). */
  async setPhrases(on: boolean): Promise<void> {
    this.phrasesOn = on;
    this.report.phrases.enabled = on;
    if (!this.loop || this.stopped) {
      // not running: a snapshot from an earlier session may still be on disk
      if (!on) {
        this.phrases = null;
        await this.removeFile("phrases");
      }
      return;
    }
    this.wake();
    if (!on) await this.whenRested();
  }

  /** Drops both models and their snapshots (an account was removed); a warm session rebuilds. */
  async reset(): Promise<void> {
    if (!this.loop || this.stopped) {
      await this.removeFile("contacts");
      await this.removeFile("phrases");
      return;
    }
    await new Promise<void>((r) => {
      (this.resetWaiters ??= []).push(r);
      this.wake();
    });
  }

  /** Stops background work and persists what changed since the last snapshot. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wake();
    await this.loop?.catch(() => {});
    try {
      await this.persist(true);
    } catch {
      // a cache: the next start rebuilds
    }
    this.contacts = null;
    this.phrases = null;
    this.update("closed");
    this.settleReady();
    for (const w of this.resetWaiters ?? []) w();
    this.resetWaiters = null;
  }

  /** Tests and perf gates: resolves once everything is current and nothing is left to do. */
  async idle(timeoutMs = 300_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (this.report.state === "disabled" || this.report.state === "closed") return;
      if (this.resting && !this.pending && this.contacts) {
        const head = await this.o.source.head();
        if (sameRevision(this.contacts.revision, head) && (!this.phrasesOn || sameRevision(this.phrases?.revision, head))) return;
        this.pending = true;
        this.wake();
      }
      if (this.now() > deadline) throw new Error(`autocomplete didn't come to rest (${this.report.state})`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private whenRested(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => (this.resting || this.stopped || this.report.state === "disabled" ? resolve() : setTimeout(check, 2));
      check();
    });
  }

  private settleReady(): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const r of w) r();
  }

  private update(state: AutocompleteReport["state"]): void {
    if (this.report.state === "disabled" && state !== "closed") return;
    this.report.state = state;
    const c = this.contacts;
    const p = this.phrases;
    Object.assign(this.report.contacts, { size: c?.size ?? 0, bytes: c?.allocatedBytes() ?? 0, revision: c?.revision ?? null });
    Object.assign(this.report.phrases, { messages: p?.messages ?? 0, bytes: p?.allocatedBytes() ?? 0, revision: p?.revision ?? null });
    this.report.longestSliceMs = this.clock.longestMs;
  }

  private wake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const w = this.wakeUp;
    this.wakeUp = null;
    w?.();
  }

  private sleep(ms: number | null): Promise<void> {
    if (this.stopped || this.resetWaiters) return Promise.resolve();
    return new Promise((resolve) => {
      this.wakeUp = resolve;
      if (ms !== null) this.timer = setTimeout(() => this.wake(), Math.max(0, ms));
    });
  }

  private path(model: Model): string | null {
    const base = this.o.source.snapshotBase;
    return base && this.o.platform.files ? `${base}.${model}` : null;
  }

  private identity(model: Model): string {
    return model === "contacts" ? `${this.o.source.identity}|contacts` : `${this.o.source.identity}|phrases|${this.phraseCaps.slots}|${this.phraseCaps.words}`;
  }

  private async removeFile(model: Model): Promise<void> {
    const path = this.path(model);
    if (path) await this.o.platform.files!.remove(path).catch(() => {});
  }

  private event(event: AutocompleteEvent, fields: Parameters<NonNullable<AutocompleteOptions["onEvent"]>>[1]): void {
    try {
      this.o.onEvent?.(event, fields);
    } catch {
      // diagnostics never break the feature
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (this.resetWaiters) {
          const waiters = this.resetWaiters;
          this.contacts = null;
          this.phrases = null;
          await this.removeFile("contacts");
          await this.removeFile("phrases");
          this.resetWaiters = null;
          for (const w of waiters) w();
          continue;
        }
        if (!this.contacts) {
          const c = (await this.restoreContacts()) ?? (await this.buildContacts());
          if (this.stopped || this.resetWaiters) continue;
          if (!c) return;
          c.setOwn(this.own);
          this.contacts = c;
          this.unsavedSince ||= this.now();
          this.update("ready");
          this.settleReady();
          continue;
        }
        if (!this.phrasesOn && this.phrases) {
          this.phrases = null;
          await this.removeFile("phrases");
          this.update("ready");
          continue;
        }
        if (this.phrasesOn && !this.phrases) {
          const p = (await this.restorePhrases()) ?? (await this.buildPhrases());
          if (this.stopped || this.resetWaiters || !this.phrasesOn) continue;
          if (!p) return;
          this.phrases = p;
          this.update("ready");
          continue;
        }
        // writes are still arriving (a sync): catch up once they settle
        if (this.pending && (await this.settle())) continue;
        if (await this.catchUp()) {
          this.failures = 0;
          this.update("ready");
          continue;
        }
        const c = this.contacts;
        if (c.overCaps()) {
          const evicted = await c.enforceCaps(this.clock);
          // a compaction holds a copy of the arrays and segment beside the originals
          if (this.peakAllows(c.allocatedBytes() * 0.6)) await c.compact(this.clock);
          this.event("evicted", { model: "contacts", count: evicted });
          continue;
        }
        if (c.needsMerge() && this.peakAllows(c.allocatedBytes() * 0.5)) {
          await c.merge(this.clock);
          continue;
        }
        if (this.phrases?.needsPrune()) {
          await this.phrases.prune(this.clock);
          continue;
        }
        if (this.snapshotDue()) {
          try {
            await this.persist(false);
          } catch {
            // a cache that can't be written (disk full) is retried later; the models stay
            this.retrySnapshotAt = this.now() + this.snapshotEvery().ms;
          }
          continue;
        }
        if (this.pending) continue;
        const unsaved = this.unsaved() > 0 && this.canSnapshot();
        const until = unsaved ? Math.max(this.unsavedSince + this.snapshotEvery().ms, this.retrySnapshotAt) - this.now() : null;
        this.resting = true;
        this.update("ready");
        await this.sleep(until);
        this.resting = false;
        this.clock.restart();
      } catch (error) {
        if (this.stopped) return;
        this.resting = false;
        const errorClass = error instanceof Error ? error.name : "Error";
        // the log no longer reaches a model (pruned, another database): both rebuild
        this.contacts = null;
        this.phrases = null;
        this.report.rebuilds++;
        this.event("rebuild", { model: "contacts", errorClass });
        if (!(error instanceof RevisionError) && ++this.failures > 3) {
          this.update("disabled");
          this.report.state = "disabled";
          this.event("disabled", { model: "contacts", errorClass });
          this.settleReady();
          return;
        }
      }
    }
  }

  /** Sleeps toward the moment writes have been quiet for settleMs (or lagged maxLagMs); false once it has come. */
  private async settle(): Promise<boolean> {
    const due = Math.min(this.dirtyAt + (this.o.settleMs ?? 50), this.firstDirtyAt + (this.o.maxLagMs ?? 2000));
    const wait = due - this.now();
    if (wait > 0) {
      this.settling = true;
      await this.sleep(wait);
      this.settling = false;
      this.clock.restart();
      return true;
    }
    this.pending = false;
    this.firstDirtyAt = 0;
    return false;
  }

  /** Applies committed batches up to the head; true if it applied anything. */
  private async catchUp(): Promise<boolean> {
    const head = await this.o.source.head();
    const c = this.contacts!;
    const p = this.phrasesOn ? this.phrases : null;
    const behind = !sameRevision(c.revision, head) || (p !== null && !sameRevision(p.revision, head));
    if (!behind) return false;
    this.update("catching-up");
    // one read serves both when they are at the same revision (the usual case)
    if (p && !sameRevision(c.revision, p.revision)) {
      if (!sameRevision(c.revision, head)) await this.catchUpModel(c, null, head);
      if (!sameRevision(p.revision, head)) await this.catchUpModel(null, p, head);
    } else await this.catchUpModel(c, p, head);
    return true;
  }

  private async catchUpModel(c: ContactIndex | null, p: PhraseModel | null, head: Revision): Promise<void> {
    const at = (c ?? p)!.revision!;
    const batches = await this.o.source.changes(at, head, 16);
    if (batches.length === 0 && head.epoch === at.epoch && head.seq > at.seq) throw new RevisionError("gap", "the log served nothing");
    for (const b of batches) {
      if (this.stopped || this.resetWaiters) return;
      if (c) this.applyContacts(c, b);
      if (p) await this.applyPhrases(p, b.messages, b.to);
      if (c) c.revision = b.to;
      // a large catch-up (a sync while it was asleep) must not grow the sorted delta without bound
      if (c?.needsMerge()) await c.merge(this.clock);
      await this.clock.tick();
    }
  }

  private applyContacts(c: ContactIndex, b: ContactBatch): void {
    if (b.messages.length && !this.unsaved()) this.unsavedSince = this.now();
    for (const m of b.messages) c.add(m);
    for (const id of b.removed) c.forget(id);
    if (b.spamSenders.length) c.markSpam(b.spamSenders);
  }

  /** Learns the sent messages among `messages` that have a body and weren't learned, 8 bodies per read. */
  private async applyPhrases(p: PhraseModel, messages: readonly ContactMessage[], to: Revision | null): Promise<void> {
    const ids = messages.filter((m) => m.sent && m.hasBody && !m.spam && !m.draft && !p.hasLearned(m.id)).map((m) => m.id);
    for (let i = 0; i < ids.length; i += 8) {
      if (this.stopped || this.resetWaiters) return;
      for (const t of await this.o.source.sentTexts(ids.slice(i, i + 8))) {
        p.learn(t);
        await this.clock.tick();
      }
    }
    if (to) p.revision = to;
  }

  private async restoreContacts(): Promise<ContactIndex | null> {
    const bytes = await this.read("contacts");
    if (!bytes) return null;
    const started = performance.now();
    const c = new ContactIndex({ caps: this.contactCaps, now: this.now });
    if (!(await c.restore(bytes, this.identity("contacts"), this.clock)) || !(await this.usable(c.revision!))) return null;
    this.report.contacts.restore = { ms: performance.now() - started, bytes: bytes.length };
    this.event("restored", { model: "contacts", count: c.size, bytes: bytes.length, durationMs: Math.round(performance.now() - started) });
    return c;
  }

  private async restorePhrases(): Promise<PhraseModel | null> {
    const bytes = await this.read("phrases");
    if (!bytes) return null;
    const started = performance.now();
    const p = new PhraseModel(this.phraseCaps);
    if (!(await p.restore(bytes, this.identity("phrases"), this.clock)) || !(await this.usable(p.revision!))) return null;
    this.report.phrases.restore = { ms: performance.now() - started, bytes: bytes.length };
    this.event("restored", { model: "phrases", count: p.messages, bytes: bytes.length, durationMs: Math.round(performance.now() - started) });
    return p;
  }

  private async read(model: Model): Promise<Uint8Array | null> {
    const path = this.path(model);
    if (!path) return null;
    this.update("restoring");
    try {
      const bytes = await this.o.platform.files!.read(path);
      // larger than this model could ever write: not ours, or damaged
      if (bytes && bytes.length > this.snapshotCap()) return null;
      return bytes;
    } catch {
      return null;
    }
  }

  /** A restored model's revision belongs to this database and isn't ahead of it. */
  private async usable(at: Revision): Promise<boolean> {
    const head = await this.o.source.head();
    return at.epoch === head.epoch && at.seq <= head.seq;
  }

  private async buildContacts(): Promise<ContactIndex | null> {
    this.update("building");
    const started = performance.now();
    const lease = await this.o.source.beginBuild();
    try {
      const c = new ContactIndex({ caps: this.contactCaps, now: this.now });
      c.beginBuild(lease.from);
      let messages = 0;
      for await (const page of lease.messages()) {
        if (this.stopped || this.resetWaiters) return null;
        // reading the page was a slice of its own
        await this.clock.pause();
        for (let i = 0; i < page.length; i++) {
          c.add(page[i]!);
          if ((i & 63) === 63) await this.clock.tick();
        }
        messages += page.length;
        // past the peak while collecting: stop adding people, keep counting the ones known
        if (c.allocatedBytes() > this.contactCaps.maxBytes * 1.5) c.freeze();
      }
      await c.finishBuild(this.clock);
      // what was written during the scan comes through the log from the lease (seen messages are skipped)
      while (!sameRevision(c.revision, await this.o.source.head())) {
        if (this.stopped || this.resetWaiters) return null;
        await this.catchUpModel(c, null, await this.o.source.head());
      }
      if (c.overCaps()) {
        await c.enforceCaps(this.clock);
        await c.compact(this.clock);
      }
      c.thaw();
      const ms = performance.now() - started;
      this.report.contacts.build = { ms, messages };
      this.event("built", { model: "contacts", count: c.size, durationMs: Math.round(ms) });
      // the next start restores instead of building
      c.changes = Math.max(c.changes, 1);
      this.unsavedSince = this.now() - this.snapshotEvery().ms;
      return c;
    } finally {
      await lease.release();
    }
  }

  private async buildPhrases(): Promise<PhraseModel | null> {
    this.update("building");
    const started = performance.now();
    // the lease keeps the log from here: bodies stored during the scan are learned on the replay
    const lease = await this.o.source.beginBuild();
    try {
      const p = new PhraseModel(this.phraseCaps);
      p.revision = lease.from;
      let after = 0;
      for (;;) {
        if (this.stopped || this.resetWaiters || !this.phrasesOn) return null;
        const page = await this.o.source.sentAfter(after, 16);
        if (page.length === 0) break;
        await this.clock.pause();
        for (const t of page) {
          p.learn(t);
          await this.clock.tick();
        }
        after = page[page.length - 1]!.id;
        if (p.needsPrune()) await p.prune(this.clock);
      }
      while (!sameRevision(p.revision, await this.o.source.head())) {
        if (this.stopped || this.resetWaiters) return null;
        await this.catchUpModel(null, p, await this.o.source.head());
      }
      const ms = performance.now() - started;
      this.report.phrases.build = { ms, messages: p.messages };
      this.event("built", { model: "phrases", count: p.messages, durationMs: Math.round(ms) });
      p.changes = Math.max(p.changes, 1);
      this.unsavedSince = this.now() - this.snapshotEvery().ms;
      return p;
    } finally {
      await lease.release();
    }
  }

  private snapshotEvery(): { changes: number; ms: number } {
    return this.o.snapshotEvery ?? { changes: 2000, ms: 5 * 60_000 };
  }

  private snapshotCap(): number {
    return Math.max(this.contactCaps.maxBytes, 16 * MiB);
  }

  private canSnapshot(): boolean {
    return !!this.o.source.snapshotBase && !!this.o.platform.files;
  }

  private unsaved(): number {
    return (this.contacts?.changes ?? 0) + (this.phrasesOn ? (this.phrases?.changes ?? 0) : 0);
  }

  private snapshotDue(): boolean {
    if (!this.canSnapshot() || this.unsaved() === 0 || this.now() < this.retrySnapshotAt) return false;
    const every = this.snapshotEvery();
    return this.unsaved() >= every.changes || this.now() - this.unsavedSince >= every.ms;
  }

  /** Both models together, plus `transient` bytes of copies (a snapshot, a merge, a compaction), fit under the peak. */
  private peakAllows(transient: number): boolean {
    return (this.contacts?.allocatedBytes() ?? 0) + (this.phrases?.allocatedBytes() ?? 0) + transient <= this.peak;
  }

  private async persist(all: boolean): Promise<void> {
    const files = this.o.platform.files;
    if (!files || !this.canSnapshot()) return;
    for (const model of ["contacts", "phrases"] as const) {
      const m = model === "contacts" ? this.contacts : this.phrasesOn ? this.phrases : null;
      void all;
      if (!m || !m.revision || m.changes === 0) continue;
      // the sections and the packed file: about what the model holds, together
      if (!this.peakAllows(m.allocatedBytes())) {
        m.changes = 0;
        continue;
      }
      const started = performance.now();
      const bytes = await m.snapshot(this.identity(model), this.clock);
      if (bytes.length > this.snapshotCap()) {
        await this.removeFile(model);
        continue;
      }
      await files.replace(this.path(model)!, bytes);
      this.report.snapshots++;
      this.event("snapshot", { model, bytes: bytes.length, durationMs: Math.round(performance.now() - started) });
    }
    this.unsavedSince = this.now();
  }
}
