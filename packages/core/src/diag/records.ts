/**
 * Crash records on disk, bounded: each at most 64 KB, 20 at most, none older
 * than 30 days, written atomically and pruned after every write. One store
 * for every process that keeps records in the profile (main, the MCP
 * sidecar), with the file system injected (core runs everywhere).
 */
import { utf8Bytes } from "./rotating";
import type { ErrorRecord } from "./types";
import { sanitizeRecord } from "./validate";

export const RECORD_MAX_BYTES = 64 * 1024;
export const RECORDS_MAX = 20;
export const RECORD_MAX_AGE_MS = 30 * 86_400_000;

export interface RecordFs {
  /** creates the file 0600 */
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  readdirSync(dir: string): string[];
  readFileSync(path: string): string;
  rmSync(path: string): void;
  writeFile?(path: string, data: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}

const NAME = /^\d+-[a-z]+-[0-9a-f]{32}\.json$/;
const recordFile = (r: ErrorRecord) => `${r.ts}-${r.proc}-${r.id}.json`;
let tmpSeq = 0;

/** The record as at most 64 KB of JSON (UTF-8): older crumbs go first, then deeper frames. */
export function fitRecord(r: ErrorRecord): string {
  let rec = r;
  let json = JSON.stringify(rec);
  while (utf8Bytes(json) > RECORD_MAX_BYTES && rec.crumbs.length) {
    rec = { ...rec, crumbs: rec.crumbs.slice(Math.ceil(rec.crumbs.length / 2)) };
    json = JSON.stringify(rec);
  }
  if (utf8Bytes(json) > RECORD_MAX_BYTES && rec.error) {
    rec = { ...rec, error: { ...rec.error, frames: rec.error.frames.slice(0, 10) } };
    json = JSON.stringify(rec);
  }
  return json;
}

export class RecordStore {
  constructor(
    private readonly dir: string,
    private readonly fs: RecordFs,
    /** distinguishes temp files of processes writing at once */
    private readonly writer = "w",
  ) {}

  private path(name: string): string {
    return `${this.dir}/${name}`;
  }

  /** Synchronous: a fatal error may be the last thing this process does. */
  writeSync(r: ErrorRecord): void {
    try {
      const target = this.path(recordFile(r));
      const tmp = `${target}.${this.writer}.${++tmpSeq}.tmp`;
      this.fs.writeFileSync(tmp, fitRecord(r));
      this.fs.renameSync(tmp, target);
      this.prune();
    } catch {
      // a full disk loses the record, never the process
    }
  }

  async write(r: ErrorRecord): Promise<void> {
    if (!this.fs.writeFile || !this.fs.rename) return this.writeSync(r);
    try {
      const target = this.path(recordFile(r));
      const tmp = `${target}.${this.writer}.${++tmpSeq}.tmp`;
      await this.fs.writeFile(tmp, fitRecord(r));
      await this.fs.rename(tmp, target);
      this.prune();
    } catch {
      // same
    }
  }

  /** Newest first; anything unreadable or forged is skipped. */
  list(): ErrorRecord[] {
    const out: ErrorRecord[] = [];
    for (const name of this.files()) {
      try {
        const r = sanitizeRecord(JSON.parse(this.fs.readFileSync(this.path(name))));
        if (r) out.push(r);
      } catch {
        // half-written or foreign
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  get(id: string): ErrorRecord | null {
    return this.list().find((r) => r.id === id) ?? null;
  }

  private files(): string[] {
    try {
      return this.fs.readdirSync(this.dir).filter((n) => NAME.test(n));
    } catch {
      return [];
    }
  }

  /** At most 20, none older than 30 days: oldest go first. */
  prune(now = Date.now()): void {
    const files = this.files().sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]));
    files.forEach((name, i) => {
      if (i >= RECORDS_MAX || now - Number(name.split("-")[0]) > RECORD_MAX_AGE_MS) {
        try {
          this.fs.rmSync(this.path(name));
        } catch {
          // gone already
        }
      }
    });
  }
}
