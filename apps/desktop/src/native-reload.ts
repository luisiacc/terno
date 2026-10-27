import { DRAFTS_DEADLINE_MS } from "./shutdown";
import type { DraftFlush, FlushTarget } from "./draft-flush";

export function nativeReloadKey(input: { type: string; key: string; alt: boolean; meta: boolean; control: boolean; shift: boolean }, platform: string): boolean | null {
  if (input.type !== "keyDown" || input.key.toLowerCase() !== "r" || input.alt) return null;
  if (platform === "darwin" ? !input.meta || input.control : !input.control || input.meta) return null;
  return input.shift;
}

export interface ReloadEvents { navigating(): void; committed(): void; failed(): void; destroyed(): void }
export interface NativeReloadDeps<T extends FlushTarget> {
  allowed(target: T): boolean;
  ready(target: T): boolean;
  flush(target: T): DraftFlush;
  watch(target: T, events: ReloadEvents): () => void;
  reload(target: T, ignoreCache: boolean): void;
  stop(target: T): void;
  warn(target: T, id: number): void;
}

/** Native menu actions capture their target once and keep admission through document replacement. */
export class NativeReloads<T extends FlushTarget> {
  private pending = new Map<T, { promise: Promise<boolean>; cancel(): void }>();
  private refused = new Map<T, { lease: DraftFlush; ignoreCache: boolean }>();
  constructor(private deps: NativeReloadDeps<T>) {}

  request(target: T, ignoreCache = false): Promise<boolean> {
    const existing = this.pending.get(target);
    if (existing) return existing.promise;
    this.refused.delete(target);
    if (!this.deps.allowed(target) || !this.deps.ready(target)) return Promise.resolve(false);
    const lease = this.deps.flush(target);
    let loading = false, done = false, timer: ReturnType<typeof setTimeout>;
    let unwatch = () => {}, resolve!: (saved: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });
    const finish = (committed: boolean, warn = false) => {
      if (done) return;
      done = true; clearTimeout(timer); unwatch(); this.pending.delete(target);
      if (committed) lease.commit();
      else {
        if (loading) { try { this.deps.stop(target); } catch { /* cleanup must still restore editing */ } }
        lease.release(); if (loading) lease.restore();
      }
      if (warn && lease.current() && this.deps.allowed(target)) {
        this.refused.set(target, { lease, ignoreCache }); this.deps.warn(target, lease.id);
      }
      resolve(committed);
    };
    this.pending.set(target, { promise, cancel: () => finish(false) });
    unwatch = this.deps.watch(target, {
      navigating: () => { this.refused.delete(target); if (!loading) finish(false); },
      committed: () => { if (loading) finish(true); },
      failed: () => finish(false), destroyed: () => { this.refused.delete(target); finish(false); },
    });
    timer = setTimeout(() => finish(false, true), DRAFTS_DEADLINE_MS);
    void lease.saved.then((saved) => {
      if (done) return;
      if (!saved) { finish(false, true); return; }
      if (!lease.current() || !this.deps.allowed(target) || !this.deps.ready(target)) { finish(false); return; }
      loading = true; clearTimeout(timer);
      timer = setTimeout(() => finish(false), DRAFTS_DEADLINE_MS);
      try { this.deps.reload(target, ignoreCache); }
      catch { finish(false); }
    }, () => finish(false, true));
    return promise;
  }

  force(target: T, id: unknown): boolean {
    const refused = this.refused.get(target);
    if (!refused || refused.lease.id !== id || !refused.lease.current() || !this.deps.allowed(target)) return false;
    this.refused.delete(target);
    try { this.deps.reload(target, refused.ignoreCache); return true; }
    catch { return false; }
  }

  navigating(target: T): void { this.refused.delete(target); }
  cancel(target: T): void { this.refused.delete(target); this.pending.get(target)?.cancel(); }
  cancelAll(): void { for (const target of new Set([...this.pending.keys(), ...this.refused.keys()])) this.cancel(target); }
}
