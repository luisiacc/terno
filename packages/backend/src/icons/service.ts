/**
 * Sender icons (plan 22): answers lookups for the addresses on screen from
 * memory, and fetches what's missing in the background: website icons per
 * registrable domain, only where the host can and the setting allows (plan
 * 258 removed Google photos). Nothing happens until the first lookup; lookups
 * only come from visible avatars.
 */
import type { IconAnswer, IconRef } from "@terno/core/rpc";
import { log } from "@terno/core/diag";
import type { PlatformFiles } from "@terno/store";
import { IconCache, type CacheEntry } from "./cache";
import { iconDomain, registrableDomain } from "./domain";
import { fetchSiteIcon } from "./fetcher";
import { IconNetworkError, type IconTransport } from "./transport";

const DAY = 86_400_000;
/** an icon is refreshed after this (served meanwhile) */
export const ICON_TTL = 30 * DAY;
/** "this site has no icon Terno accepts" */
export const NEGATIVE_TTL = 7 * DAY;
/** the second timeout in a row */
export const TIMEOUT_TTL = DAY;
const QUEUE_MAX = 200;
const WAITING_MAX = 4000;
const RETRY_MAX = 100;

export interface IconServiceOptions {
  /** null: this host can't fetch website icons (the web) */
  transport: IconTransport | null;
  files?: PlatformFiles;
  base: string | null;
  web: boolean;
  now: () => number;
  /** the policy's check for purpose "icons" (throws when not allowed) */
  assertSite(url: URL): Promise<void>;
  siteIconsOn(): Promise<boolean>;
  emit(payload: { icons: Record<string, IconAnswer>; reset?: boolean }): void;
  /** tests: the fetcher's deadlines */
  timeouts?: { requestMs?: number; budgetMs?: number };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class IconService {
  readonly cache: IconCache;
  private ready: Promise<void> | null = null;
  /** bumped by turning website icons off and by forgetting: late results are dropped */
  private generation = 0;
  private ctl = new AbortController();
  private readonly queue: string[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<string>>();
  private waiting = 0;
  private readonly retryOnline = new Set<string>();
  private online = true;
  private closed = false;
  private batch = { count: 0, startedAt: 0 };

  constructor(private readonly o: IconServiceOptions) {
    this.cache = new IconCache({
      files: o.files,
      base: o.base,
      maxBytes: o.web ? 8 * 1024 * 1024 : 24 * 1024 * 1024,
      maxEntries: o.web ? 1500 : 4000,
      slots: o.web ? 400 : 1000,
      now: o.now,
      onTrim: (count, bytes) => log.info("icons.trimmed", { count, bytes }),
    });
  }

  private get concurrency(): number {
    return this.o.web ? 2 : 4;
  }

  private load(): Promise<void> {
    this.ready ??= this.cache.load();
    return this.ready;
  }

  /** The icon for each address: a ref, null (initials) or nothing yet (fetched, then the `icons` event); "again" when the queue was full. */
  async lookup(emails: string[]): Promise<Record<string, IconAnswer>> {
    const out: Record<string, IconAnswer> = {};
    if (this.closed) return out;
    if (!this.o.transport || !(await this.o.siteIconsOn())) {
      for (const e of emails) out[e] = null;
      return out;
    }
    await this.load();
    for (const email of emails) {
      const domain = iconDomain(email);
      if (domain) this.answer(`d:${domain}`, email, out);
      else out[email] = null;
    }
    this.pump();
    return out;
  }

  /** Icons' bytes as data: URLs. */
  async data(ids: string[]): Promise<Record<string, string | null>> {
    await this.load();
    const out: Record<string, string | null> = {};
    // a screenful of avatars, one file each (the contract caps a call at 50)
    await Promise.all(ids.map(async (id) => {
      const e = this.cache.peek(id);
      const bytes = e?.kind === "icon" ? await this.cache.read(id) : null;
      out[id] = e?.kind === "icon" && bytes ? `data:${e.mime};base64,${toBase64(bytes)}` : null;
    }));
    return out;
  }

  private ref(key: string, e: Extract<CacheEntry, { kind: "icon" }>): IconRef {
    return { id: key, v: e.fetchedAt, px: e.px, full: e.full };
  }

  private answer(key: string, email: string, out: Record<string, IconAnswer>): void {
    const e = this.cache.get(key);
    if (e?.kind === "icon") {
      out[email] = this.ref(key, e);
      // stale: served, and refreshed once in the background
      if (this.o.now() - e.fetchedAt > ICON_TTL && !this.inflight.has(key) && !this.queue.includes(key)) this.enqueue(key, null);
      return;
    }
    if (e?.kind === "none") {
      out[email] = null;
      return;
    }
    if (!this.enqueue(key, email)) out[email] = "again";
  }

  /** Queues a key (newest first); false when its waiter couldn't be kept. */
  private enqueue(key: string, email: string | null): boolean {
    if (email !== null) {
      let set = this.waiters.get(key);
      if (!set?.has(email)) {
        if (this.waiting >= WAITING_MAX) return false;
        if (!set) this.waiters.set(key, (set = new Set()));
        set.add(email);
        this.waiting++;
      }
    }
    if (this.inflight.has(key)) return true;
    const at = this.queue.indexOf(key);
    if (at >= 0) this.queue.splice(at, 1);
    this.queue.push(key);
    // a full queue drops its oldest: whoever waited on it hears "again" (asked again while still shown)
    while (this.queue.length > QUEUE_MAX) {
      const dropped = this.queue.shift()!;
      this.settle(dropped, "again");
    }
    return true;
  }

  /** Tells everyone waiting on `key`, once. */
  private settle(key: string, answer: IconAnswer): void {
    const set = this.waiters.get(key);
    if (!set) return;
    this.waiters.delete(key);
    this.waiting -= set.size;
    const icons: Record<string, IconAnswer> = {};
    for (const email of set) icons[email] = answer;
    this.o.emit({ icons });
  }

  private pump(): void {
    while (!this.closed && this.online && this.inflight.size < this.concurrency && this.queue.length > 0) {
      const key = this.queue.pop()!;
      if (this.batch.count === 0) this.batch.startedAt = this.o.now();
      this.batch.count++;
      const run = this.run(key).finally(() => {
        this.inflight.delete(key);
        if (this.inflight.size === 0 && this.queue.length === 0 && this.batch.count > 0) {
          log.info("icons.batch", { count: this.batch.count, durationMs: this.o.now() - this.batch.startedAt });
          this.batch.count = 0;
        }
        this.pump();
      });
      this.inflight.set(key, run);
    }
  }

  private async run(key: string): Promise<void> {
    const generation = this.generation;
    const signal = this.ctl.signal;
    const now = this.o.now();
    try {
      const icon = await this.fetchSite(key.slice(2), signal);
      if (generation !== this.generation || this.closed) return;
      if (icon) {
        await this.cache.put(key, icon, now);
        const e = this.cache.peek(key);
        this.settle(key, e?.kind === "icon" ? this.ref(key, e) : null);
      } else {
        this.cache.negative(key, now + NEGATIVE_TTL);
        this.settle(key, null);
      }
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      if (error instanceof IconNetworkError && error.kind === "timeout") {
        // a slow site gets a second chance; twice in a row it waits a day
        const n = this.cache.timeouts(key) + 1;
        this.cache.negative(key, n >= 2 ? now + TIMEOUT_TTL : now, n);
        this.settle(key, null);
        return;
      }
      if (error instanceof IconNetworkError && error.kind === "network") {
        // unreachable: nothing cached; tried again when the network changes (the avatars keep their initials)
        if (this.retryOnline.size < RETRY_MAX) this.retryOnline.add(key);
        else this.settle(key, null);
        return;
      }
      // refused by the policy (turned off meanwhile) or anything else: no icon, nothing cached
      this.settle(key, null);
    }
  }

  private async fetchSite(domain: string, signal: AbortSignal) {
    const found = await fetchSiteIcon(domain, {
      transport: this.o.transport!,
      assert: (url) => this.o.assertSite(url),
      registrable: registrableDomain,
      signal,
      now: this.o.now,
      timeoutMs: this.o.timeouts?.requestMs,
      budgetMs: this.o.timeouts?.budgetMs,
    });
    return found ? { ...found.image, full: found.full } : null;
  }

  // ───────────────────────────── network (plan 20) ─────────────────────────────

  /** Offline: nothing starts. Online or changed: what failed to reach its site goes again. */
  network(online: boolean): void {
    this.online = online;
    if (!online) return;
    for (const key of this.retryOnline) if (!this.inflight.has(key) && !this.queue.includes(key)) this.queue.push(key);
    this.retryOnline.clear();
    this.pump();
  }

  // ───────────────────────────── invalidation ─────────────────────────────

  /** Everything in flight or waiting is dropped and the windows forget their icons. */
  invalidate(): void {
    this.generation++;
    this.ctl.abort();
    this.ctl = new AbortController();
    this.queue.length = 0;
    this.waiters.clear();
    this.waiting = 0;
    this.retryOnline.clear();
    this.o.emit({ icons: {}, reset: true });
  }

  /** "Forget saved icons". */
  async forget(): Promise<void> {
    this.invalidate();
    await this.load();
    await this.cache.clear();
  }

  /**
   * Plan 258: what Photos from Google left goes, on either host and whatever the website-icons switch says. Its list
   * of the contacts' addresses and photo URLs marks that there is something to do: the cache's photo bytes are swept
   * first and the list removed last, so a sweep that fails is tried again at the next start. Without the list, this is
   * one read of a missing file.
   */
  async forgetGooglePhotos(): Promise<void> {
    const files = this.o.files;
    if (!files || !this.o.base) return;
    const people = `${this.o.base}.icons-people.json`;
    try {
      if (!(await files.read(people))) return;
      await this.cache.sweep();
      await files.remove(people);
    } catch {
      // the next start tries again
    }
  }

  /** Quit: what's in flight is aborted and awaited, the index written. */
  async close(): Promise<void> {
    this.closed = true;
    this.ctl.abort();
    // aborted above; a request that ignores it doesn't hold the quit for long
    await Promise.race([Promise.allSettled(this.inflight.values()), new Promise((r) => setTimeout(r, 2000))]);
    await this.cache.flush();
  }
}
