/**
 * Sender icons on disk (plan 22), bounded however the index fares: icons
 * live in numbered slot files (`<base>.icons/<n>`, n < slots, each at most
 * MAX_STORED bytes), allocated lowest-free-first, and an index file maps keys
 * to slots. A lost index means slots are overwritten from 0 again, never new
 * names, so the files can't outgrow slots × MAX_STORED; with the index, an
 * LRU keeps the live set under `maxBytes`. Without files (tests, in-memory
 * stores) the bytes stay in memory under the same bounds.
 */
import type { PlatformFiles } from "@terno/store";
import { MAX_STORED, type IconMime } from "./image";

export interface PositiveEntry {
  kind: "icon";
  mime: IconMime;
  px: number;
  full: boolean;
  size: number;
  hash: number;
  slot: number;
  fetchedAt: number;
  usedAt: number;
}

export interface NegativeEntry {
  kind: "none";
  until: number;
  /** timeouts in a row (the second one is cached as "none" for a day) */
  timeouts?: number;
  usedAt: number;
}

export type CacheEntry = PositiveEntry | NegativeEntry;

export interface IconCacheOptions {
  files?: PlatformFiles;
  /** where the slot files and the index live (null: memory only) */
  base: string | null;
  maxBytes: number;
  maxEntries: number;
  slots: number;
  now: () => number;
  /** how long after a change the index is written (one-shot) */
  writeDelayMs?: number;
  /** the LRU made room (diagnostics: counts and bytes only) */
  onTrim?: (count: number, bytes: number) => void;
}

interface IndexFile {
  v: 1;
  entries: [string, CacheEntry][];
}

/** FNV-1a: tells a slot that was overwritten (or never finished writing) from the icon the index expects. */
export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

export class IconCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly memory = new Map<number, Uint8Array>();
  private readonly usedSlots = new Set<number>();
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** every file operation, in order: a slow slot write can't land after a clear (or another write) that came later */
  private io: Promise<void> = Promise.resolve();
  private loaded: Promise<void> | null = null;

  constructor(private readonly o: IconCacheOptions) {}

  private get disk(): boolean {
    return !!this.o.files && !!this.o.base;
  }

  private slotPath(n: number): string {
    return `${this.o.base}.icons/${n}`;
  }

  private get indexPath(): string {
    return `${this.o.base}.icons.json`;
  }

  /** Reads the index once; an unreadable one starts empty (its slots are reused from 0). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.disk) return;
      let raw: Uint8Array | null = null;
      try {
        raw = await this.o.files!.read(this.indexPath);
      } catch {
        raw = null;
      }
      if (!raw) return;
      try {
        const index = JSON.parse(new TextDecoder().decode(raw)) as IndexFile;
        if (index.v !== 1 || !Array.isArray(index.entries)) return;
        for (const [key, e] of index.entries.slice(0, this.o.maxEntries)) {
          if (typeof key !== "string" || !e || (e.kind !== "icon" && e.kind !== "none")) continue;
          if (e.kind === "icon") {
            if (!Number.isInteger(e.slot) || e.slot < 0 || e.slot >= this.o.slots || this.usedSlots.has(e.slot) || !(e.size > 0 && e.size <= MAX_STORED)) continue;
            this.usedSlots.add(e.slot);
            this.bytes += e.size;
          }
          this.entries.set(key, e);
        }
      } catch {
        this.entries.clear();
        this.usedSlots.clear();
        this.bytes = 0;
      }
    })();
    return this.loaded;
  }

  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  /** The entry (an expired negative one reads as absent); marks it used. */
  get(key: string): CacheEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.kind === "none" && e.until <= this.o.now()) return undefined;
    e.usedAt = this.o.now();
    return e;
  }

  /** The entry without touching it (tests, the people map). */
  peek(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  /** An icon's bytes, verified against the index; null (and the entry dropped) when the slot doesn't hold them. */
  async read(key: string): Promise<Uint8Array | null> {
    const e = this.entries.get(key);
    if (!e || e.kind !== "icon") return null;
    let bytes: Uint8Array | null;
    try {
      bytes = this.disk ? await this.o.files!.read(this.slotPath(e.slot)) : (this.memory.get(e.slot) ?? null);
    } catch {
      bytes = null;
    }
    if (bytes && bytes.length === e.size && fnv1a(bytes) === e.hash) return bytes;
    // overwritten, lost or never fully written: a miss, refetched on the next lookup
    if (this.entries.get(key) === e) this.drop(key);
    this.schedule();
    return null;
  }

  async put(key: string, icon: { mime: IconMime; bytes: Uint8Array; px: number; full: boolean }, fetchedAt: number): Promise<void> {
    if (icon.bytes.length > MAX_STORED) return;
    const old = this.entries.get(key);
    // a refresh reuses its slot; otherwise the lowest free one (evicting first if all are taken)
    let slot = old?.kind === "icon" ? old.slot : -1;
    if (old) this.drop(key);
    this.evict(icon.bytes.length, 1);
    if (slot < 0 || this.usedSlots.has(slot)) slot = this.freeSlot();
    if (slot < 0) return;
    this.usedSlots.add(slot);
    const entry: PositiveEntry = { kind: "icon", mime: icon.mime, px: icon.px, full: icon.full, size: icon.bytes.length, hash: fnv1a(icon.bytes), slot, fetchedAt, usedAt: this.o.now() };
    this.entries.set(key, entry);
    this.bytes += entry.size;
    if (this.disk) {
      try {
        await this.serial(() => this.o.files!.replace(this.slotPath(slot), icon.bytes));
      } catch {
        if (this.entries.get(key) === entry) this.drop(key);
        return;
      }
    } else {
      this.memory.set(slot, icon.bytes);
    }
    this.schedule();
  }

  /** No icon here until `until`. */
  negative(key: string, until: number, timeouts?: number): void {
    if (this.entries.has(key)) this.drop(key);
    this.evict(0, 1);
    this.entries.set(key, { kind: "none", until, usedAt: this.o.now(), ...(timeouts ? { timeouts } : {}) });
    this.schedule();
  }

  /** Timeouts in a row recorded for the key (kept on a short negative entry). */
  timeouts(key: string): number {
    const e = this.entries.get(key);
    return e?.kind === "none" ? (e.timeouts ?? 0) : 0;
  }

  delete(key: string): void {
    if (!this.entries.has(key)) return;
    this.drop(key);
    this.schedule();
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /** "Forget saved icons": every slot path and the index removed, whatever the index knew. */
  async clear(): Promise<void> {
    this.entries.clear();
    this.usedSlots.clear();
    this.memory.clear();
    this.bytes = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.disk) return;
    const files = this.o.files!;
    await this.serial(async () => {
      for (let n = 0; n < this.o.slots; n++) await files.remove(this.slotPath(n)).catch(() => {});
      await files.remove(this.indexPath).catch(() => {});
    });
  }

  /** Writes a pending index now (quit). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.write();
    }
    await this.io;
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    if (e.kind === "icon") {
      this.usedSlots.delete(e.slot);
      this.memory.delete(e.slot);
      this.bytes -= e.size;
    }
  }

  private freeSlot(): number {
    for (let n = 0; n < this.o.slots; n++) if (!this.usedSlots.has(n)) return n;
    return -1;
  }

  /** Makes room for `bytes` more and `count` more entries: negative entries first, then the least recently used. */
  private evict(bytes: number, count: number): void {
    const over = () => this.bytes + bytes > this.o.maxBytes || this.entries.size + count > this.o.maxEntries || (bytes > 0 && this.usedSlots.size >= this.o.slots);
    if (!over()) return;
    const order = [...this.entries.entries()].sort(([, a], [, b]) => (a.kind === b.kind ? a.usedAt - b.usedAt : a.kind === "none" ? -1 : 1));
    const before = { count: this.entries.size, bytes: this.bytes };
    for (const [key] of order) {
      if (!over()) break;
      this.drop(key);
    }
    this.o.onTrim?.(before.count - this.entries.size, before.bytes - this.bytes);
  }

  private schedule(): void {
    if (!this.disk || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, this.o.writeDelayMs ?? 5000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private write(): Promise<void> {
    const index: IndexFile = { v: 1, entries: [...this.entries.entries()] };
    const bytes = new TextEncoder().encode(JSON.stringify(index));
    return this.serial(() => this.o.files!.replace(this.indexPath, bytes)).catch(() => {});
  }

  /** Runs `op` after every file operation queued before it; its failure is the caller's, never the queue's. */
  private serial(op: () => Promise<void>): Promise<void> {
    const run = this.io.then(op);
    this.io = run.catch(() => {});
    return run;
  }
}
