/**
 * Sender icons (plan 22): answers lookups for the addresses on screen from
 * memory, and fetches what's missing in the background: website icons per
 * registrable domain (only where the host can and the setting allows) and
 * Google photos for Gmail accounts that turned them on. Nothing happens until
 * the first lookup; lookups only come from visible avatars.
 */
import type { AppSettings, GooglePhotoState, IconAnswer, IconRef } from "@terno/core/rpc";
import { log } from "@terno/core/diag";
import { MAX_PHOTO_CONTACTS, type MailProvider } from "@terno/mail/portable";
import type { PlatformFiles } from "@terno/store";
import { IconCache, fnv1a, type CacheEntry } from "./cache";
import { iconSubject, loadSuffixList, normalizeEmail, registrableDomain } from "./domain";
import { fetchSiteIcon } from "./fetcher";
import { readIcon } from "./image";
import { IconNetworkError, type IconTransport } from "./transport";

const DAY = 86_400_000;
/** an icon is refreshed after this (served meanwhile) */
export const ICON_TTL = 30 * DAY;
/** "this site has no icon Terno accepts" */
export const NEGATIVE_TTL = 7 * DAY;
/** the second timeout in a row */
export const TIMEOUT_TTL = DAY;
/** contacts' photos are listed again after this, lazily (on a lookup) */
export const PEOPLE_TTL = 7 * DAY;
const QUEUE_MAX = 200;
const WAITING_MAX = 4000;
const RETRY_MAX = 100;
const PHOTO_BYTES = 256 * 1024;

export interface IconServiceOptions {
  /** null: this host can't fetch website icons (the web) */
  transport: IconTransport | null;
  files?: PlatformFiles;
  base: string | null;
  web: boolean;
  now: () => number;
  /** the policy's check for purpose "icons" (throws when not allowed) */
  assertSite(url: URL): Promise<void>;
  /** the policy's fetch for Google's photo host (purpose "mail": the user's mail provider) */
  photoFetch: typeof fetch;
  siteIconsOn(): Promise<boolean>;
  googlePhotos(): Promise<AppSettings["googlePhotos"]>;
  setGooglePhotoState(accountId: number, state: GooglePhotoState | null): Promise<void>;
  accountEmail(accountId: number): Promise<string | null>;
  provider(accountId: number): Promise<MailProvider | null>;
  emit(payload: { icons: Record<string, IconAnswer>; reset?: boolean }): void;
  /** tests: the fetcher's deadlines */
  timeouts?: { requestMs?: number; budgetMs?: number };
}

interface People {
  /** when the lists were last read */
  at: number;
  own: string | null;
  map: Map<string, string>;
}

interface PeopleFile {
  v: 1;
  accounts: Record<string, { at: number; own: string | null; map: [string, string][] }>;
}

const hex = (n: number) => n.toString(16).padStart(8, "0");
const photoKey = (url: string) => `p:${hex(fnv1a(new TextEncoder().encode(url)))}`;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class IconService {
  readonly cache: IconCache;
  private ready: Promise<void> | null = null;
  private readonly people = new Map<number, People>();
  private peopleWrite: Promise<void> = Promise.resolve();
  private readonly peopleSyncing = new Map<number, Promise<void>>();
  /** each account's listing in flight, cancelled by turning its photos off or quitting */
  private readonly peopleAborts = new Map<number, AbortController>();
  /** bumped by turning a source off, forgetting and removing an account: late results are dropped */
  private generation = 0;
  private ctl = new AbortController();
  private readonly queue: string[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<string>>();
  private waiting = 0;
  private readonly photoUrls = new Map<string, string>();
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
    this.ready ??= Promise.all([this.cache.load(), loadSuffixList(), this.loadPeople()]).then(() => {});
    return this.ready;
  }

  /** The icon for each address: a ref, null (initials) or nothing yet (fetched, then the `icons` event); "again" when the queue was full. */
  async lookup(emails: string[]): Promise<Record<string, IconAnswer>> {
    const out: Record<string, IconAnswer> = {};
    if (this.closed) return out;
    const [site, photos] = await Promise.all([this.o.transport ? this.o.siteIconsOn() : Promise.resolve(false), this.o.googlePhotos()]);
    const photoAccounts = Object.keys(photos).map(Number);
    if (!site && photoAccounts.length === 0) {
      for (const e of emails) out[e] = null;
      return out;
    }
    await this.load();
    for (const id of photoAccounts) this.maybeSyncPeople(id);
    for (const email of emails) {
      const norm = normalizeEmail(email);
      const url = this.photoFor(norm, photoAccounts);
      if (url) {
        const key = photoKey(url);
        this.photoUrls.set(key, url);
        this.answer(key, email, out);
        this.releaseUrl(key);
        continue;
      }
      const subject = iconSubject(norm);
      if (subject.kind === "site" && site) this.answer(`d:${subject.domain}`, email, out);
      else out[email] = null;
    }
    this.pump();
    return out;
  }

  /** Icons' bytes as data: URLs. */
  async data(ids: string[]): Promise<Record<string, string | null>> {
    await this.load();
    const out: Record<string, string | null> = {};
    for (const id of ids) {
      const e = this.cache.peek(id);
      const bytes = e?.kind === "icon" ? await this.cache.read(id) : null;
      out[id] = e?.kind === "icon" && bytes ? `data:${e.mime};base64,${toBase64(bytes)}` : null;
    }
    return out;
  }

  private ref(key: string, e: Extract<CacheEntry, { kind: "icon" }>): IconRef {
    return { id: key, v: e.fetchedAt, kind: key.startsWith("p:") ? "photo" : "site", px: e.px, full: e.full };
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
      this.releaseUrl(dropped);
    }
    return true;
  }

  /** Tells everyone waiting on `key`, once. */
  /** A photo's URL is kept only while its fetch is queued, running or waiting for the network (a later lookup sets it again). */
  private releaseUrl(key: string): void {
    if (key.startsWith("p:") && !this.queue.includes(key) && !this.inflight.has(key) && !this.retryOnline.has(key)) this.photoUrls.delete(key);
  }

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
        this.releaseUrl(key);
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
      const icon = key.startsWith("d:") ? await this.fetchSite(key.slice(2), signal) : await this.fetchPhoto(key, signal);
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

  /** A Google photo (googleusercontent.com only), through the same caps and checks as an icon. */
  private async fetchPhoto(key: string, signal: AbortSignal) {
    const url = this.photoUrls.get(key);
    if (!url) return null;
    const timeout = AbortSignal.timeout(this.o.timeouts?.requestMs ?? 10_000);
    let res: Response;
    try {
      res = await this.o.photoFetch(url, { signal: AbortSignal.any([signal, timeout]), credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (error) {
      throw new IconNetworkError(timeout.aborted ? "timeout" : "network", error instanceof Error ? error.message : String(error));
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > PHOTO_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const image = readIcon(bytes);
    if (typeof image === "string" || image.mime === "image/svg+xml" || image.mime === "image/x-icon") return null;
    return { ...image, full: true };
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
    this.photoUrls.clear();
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

  /** An account's photos off, or the account removed: its lists go, and their photos with them. */
  async dropPhotos(accountId: number): Promise<void> {
    await this.load();
    this.peopleAborts.get(accountId)?.abort();
    this.peopleAborts.delete(accountId);
    this.peopleSyncing.delete(accountId);
    const had = this.people.get(accountId);
    this.people.delete(accountId);
    if (had) {
      for (const url of [had.own, ...had.map.values()]) if (url) this.cache.delete(photoKey(url));
      this.savePeople();
    }
    this.invalidate();
  }

  // ───────────────────────────── Google photos ─────────────────────────────

  private photoFor(email: string, accounts: number[]): string | null {
    for (const id of accounts) {
      const p = this.people.get(id);
      const url = p?.map.get(email) ?? (p?.own && this.ownEmails.get(id) === email ? p.own : undefined);
      if (url) return url;
    }
    return null;
  }

  private readonly ownEmails = new Map<number, string>();

  /** tests: photo URLs kept for fetches queued or running */
  get pendingPhotoUrls(): number {
    return this.photoUrls.size;
  }

  /** tests and diagnostics: how many addresses have a photo for an account */
  photoCount(accountId: number): number {
    return this.people.get(accountId)?.map.size ?? 0;
  }

  /** Lists the account's photos now (turning photos on) or lazily when the last list is older than PEOPLE_TTL. */
  syncPeople(accountId: number, state: GooglePhotoState, externalSignal?: AbortSignal): Promise<void> {
    const running = this.peopleSyncing.get(accountId);
    if (running && !externalSignal) return running;
    // Explicit consent owns a new listing; an older flow's abort only ever reaches its own controller.
    if (running) this.peopleAborts.get(accountId)?.abort();
    const generation = this.generation;
    const started = this.o.now();
    let run!: Promise<void>;
    // cancellable from the start: turning photos off while this still waits for the provider stops it too
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener("abort", cancel, { once: true });
    const wait = async <T,>(work: Promise<T>): Promise<T> => {
      let stop: (() => void) | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_resolve, reject) => {
          stop = () => reject(ctl.signal.reason);
          if (ctl.signal.aborted) stop(); else ctl.signal.addEventListener("abort", stop, { once: true });
        })]);
      } finally { if (stop) ctl.signal.removeEventListener("abort", stop); }
    };
    this.peopleAborts.set(accountId, ctl);
    run = (async () => {
      await wait(this.load());
      const provider = await wait(this.o.provider(accountId));
      const email = await wait(this.o.accountEmail(accountId));
      if (!provider?.photos || !email || ctl.signal.aborted || generation !== this.generation || this.closed) return;
      // still on (not turned off between the call and now)
      if (!(await wait(this.o.googlePhotos()))[String(accountId)] || ctl.signal.aborted) return;
      let result;
      try {
        result = await wait(provider.photos({ connections: state.connections, otherContacts: state.otherContacts }, ctl.signal));
      } catch {
        if (ctl.signal.aborted) return;
        log.info("icons.people", { count: 0, durationMs: this.o.now() - started, status: 0 });
        return;
      }
      if (ctl.signal.aborted || generation !== this.generation || this.closed || this.peopleSyncing.get(accountId) !== run) return;
      const disabled = result.connections === "disabled" || result.otherContacts === "disabled";
      const next: GooglePhotoState = {
        connections: state.connections && result.connections !== "denied",
        otherContacts: state.otherContacts && result.otherContacts !== "denied",
        apiDisabled: disabled,
      };
      // a source that failed keeps what it found last time
      const before = this.people.get(accountId);
      const map = new Map(result.contacts.map((c) => [c.email, c.url] as const));
      if (before && (result.connections === "failed" || result.otherContacts === "failed")) {
        for (const [k, v] of before.map) {
          // the same bound as a full listing, however many failures in a row
          if (map.size >= MAX_PHOTO_CONTACTS) break;
          if (!map.has(k)) map.set(k, v);
        }
      }
      this.people.set(accountId, { at: this.o.now(), own: result.own, map });
      this.ownEmails.set(accountId, normalizeEmail(email));
      this.savePeople();
      if (next.connections !== state.connections || next.otherContacts !== state.otherContacts || next.apiDisabled !== state.apiDisabled) await this.o.setGooglePhotoState(accountId, next);
      log.info("icons.people", { count: map.size, durationMs: this.o.now() - started, status: disabled ? 403 : 200 });
      // addresses already answered "initials" may have a photo now
      this.o.emit({ icons: {}, reset: true });
    })().catch((error: unknown) => {
      if (!ctl.signal.aborted) throw error;
    }).finally(() => {
      externalSignal?.removeEventListener("abort", cancel);
      if (this.peopleSyncing.get(accountId) === run) this.peopleSyncing.delete(accountId);
      if (this.peopleAborts.get(accountId) === ctl) this.peopleAborts.delete(accountId);
    });
    this.peopleSyncing.set(accountId, run);
    return run;
  }

  /** when a lazy list was last attempted per account: a failing one is tried at most hourly */
  private readonly peopleTried = new Map<number, number>();

  private maybeSyncPeople(accountId: number): void {
    // offline: the list waits for the network (a lookup after it comes back asks again)
    if (!this.online) return;
    const p = this.people.get(accountId);
    if (p && this.o.now() - p.at < PEOPLE_TTL) return;
    if (this.o.now() - (this.peopleTried.get(accountId) ?? -Infinity) < 3_600_000) return;
    this.peopleTried.set(accountId, this.o.now());
    void this.o.googlePhotos().then((all) => {
      const state = all[String(accountId)];
      if (state && !this.peopleSyncing.has(accountId)) void this.syncPeople(accountId, state);
    });
  }

  private get peoplePath(): string | null {
    return this.o.files && this.o.base ? `${this.o.base}.icons-people.json` : null;
  }

  private async loadPeople(): Promise<void> {
    const path = this.peoplePath;
    if (!path) return;
    try {
      const raw = await this.o.files!.read(path);
      if (!raw) return;
      const f = JSON.parse(new TextDecoder().decode(raw)) as PeopleFile;
      if (f.v !== 1) return;
      for (const [id, a] of Object.entries(f.accounts)) {
        this.people.set(Number(id), { at: a.at, own: a.own, map: new Map(a.map) });
        const email = await this.o.accountEmail(Number(id));
        if (email) this.ownEmails.set(Number(id), normalizeEmail(email));
      }
    } catch {
      this.people.clear();
    }
  }

  private savePeople(): void {
    const path = this.peoplePath;
    if (!path) return;
    const f: PeopleFile = { v: 1, accounts: {} };
    for (const [id, p] of this.people) f.accounts[String(id)] = { at: p.at, own: p.own, map: [...p.map] };
    const bytes = new TextEncoder().encode(JSON.stringify(f));
    this.peopleWrite = this.peopleWrite.then(() => this.o.files!.replace(path, bytes)).catch(() => {});
  }

  /** Quit: what's in flight is aborted and awaited, the index and the lists written. */
  async close(): Promise<void> {
    this.closed = true;
    this.ctl.abort();
    for (const c of this.peopleAborts.values()) c.abort();
    // aborted above; a request that ignores it doesn't hold the quit for long
    await Promise.race([Promise.allSettled([...this.inflight.values(), ...this.peopleSyncing.values()]), new Promise((r) => setTimeout(r, 2000))]);
    await this.cache.flush();
    await this.peopleWrite;
  }
}
