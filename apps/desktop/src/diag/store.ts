/**
 * Main's diagnostics on disk, under the profile:
 *   logs/<proc>.jsonl (+ .1 … .4)   rotating JSONL, 2 MB × 5 per process
 *   crashes/<ts>-<proc>-<id>.json   records: 64 KB each, 20 at most, 30 days
 *   crashes/rings.json              the last breadcrumbs of every live process
 *   diag/state.json                 install id, reports seen/sent, last policy
 *   diag/running                    the run marker (gone after a clean quit)
 * Everything is 0600 and written atomically; nothing here throws.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ERROR_REPORTS, RecordStore as CoreRecordStore, sanitizeCrumbs, type Crumb, type RecordFs, type RotatingFs } from "@terno/core/diag";
import type { ErrorReports } from "@terno/core/diag";

export { fitRecord, RECORD_MAX_BYTES, RECORDS_MAX, RECORD_MAX_AGE_MS } from "@terno/core/diag";
const MODE = 0o600;

export interface DiagPaths {
  logs: string;
  crashes: string;
  diag: string;
}

export function diagPaths(userData: string): DiagPaths {
  return { logs: join(userData, "logs"), crashes: join(userData, "crashes"), diag: join(userData, "diag") };
}

export function ensureDirs(p: DiagPaths): void {
  for (const d of [p.logs, p.crashes, p.diag]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** Node's file system for RotatingLog: appends create files 0600. */
export const nodeRotatingFs: RotatingFs = {
  appendFile: (path, data) => appendFile(path, data, { mode: MODE }),
  appendFileSync: (path, data) => appendFileSync(path, data, { mode: MODE }),
  size: async (path) => (await stat(path).catch(() => null))?.size ?? 0,
  sizeSync: (path) => statSync(path, { throwIfNoEntry: false })?.size ?? 0,
  rename: (from, to) => rename(from, to),
  renameSync: (from, to) => renameSync(from, to),
  remove: (path) => rm(path, { force: true }),
  removeSync: (path) => rmSync(path, { force: true }),
};

function writeAtomicSync(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: MODE });
  renameSync(tmp, path);
}


/** Node's file system for the shared record store (records are 0600). */
const nodeRecordFs: RecordFs = {
  writeFileSync: (path, data) => writeFileSync(path, data, { mode: MODE }),
  renameSync: (from, to) => renameSync(from, to),
  readdirSync: (dir) => readdirSync(dir),
  readFileSync: (path) => readFileSync(path, "utf8"),
  rmSync: (path) => rmSync(path, { force: true }),
  writeFile: (path, data) => writeFile(path, data, { mode: MODE }),
  rename: (from, to) => rename(from, to),
};

/** Main's crash records (the MCP sidecar writes into the same folder through the same store). */
export class RecordStore extends CoreRecordStore {
  constructor(dir: string) {
    super(dir, nodeRecordFs, `main${process.pid}`);
  }
}

export interface DiagState {
  installId: string;
  /** reports the user has acted on (sent or dismissed): the row doesn't offer them again */
  seen: string[];
  sent: string[];
  /** the last policy the backend published, so a backend that never starts still has one (fail closed until the first) */
  policy: { localMode: boolean; errorReports: ErrorReports } | null;
  /** plan 78: 2 once local mode stopped deciding reports */
  policyVersion?: number;
}

const POLICY_VERSION = 2;

/**
 * Plan 78: local mode no longer decides reports. A policy kept before that
 * with local mode and "always" (chosen while connected) sent nothing; it
 * keeps that until the user chooses again: "ask". The backend migrates its
 * setting the same way and publishes it at start.
 */
export function keptPolicy(p: { localMode: boolean; errorReports: ErrorReports }, version: unknown): { localMode: boolean; errorReports: ErrorReports } {
  if (typeof version === "number" && version >= POLICY_VERSION) return { localMode: p.localMode, errorReports: p.errorReports };
  return { localMode: p.localMode, errorReports: p.localMode && p.errorReports === "always" ? "ask" : p.errorReports };
}

export class StateFile {
  private state: DiagState;
  constructor(private readonly path: string) {
    this.state = this.read();
  }

  private read(): DiagState {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DiagState>;
      const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{32}$/.test(x)).slice(-200) : []);
      const policy = raw.policy && typeof raw.policy.localMode === "boolean" && ERROR_REPORTS.includes(raw.policy.errorReports) ? keptPolicy(raw.policy, raw.policyVersion) : null;
      const installId = typeof raw.installId === "string" && /^[0-9a-f-]{36}$/.test(raw.installId) ? raw.installId : randomUUID();
      return { installId, seen: ids(raw.seen), sent: ids(raw.sent), policy, policyVersion: POLICY_VERSION };
    } catch {
      return { installId: randomUUID(), seen: [], sent: [], policy: null, policyVersion: POLICY_VERSION };
    }
  }

  get(): Readonly<DiagState> {
    return this.state;
  }

  update(patch: (s: DiagState) => void): void {
    patch(this.state);
    this.state.seen = [...new Set(this.state.seen)].slice(-200);
    this.state.sent = [...new Set(this.state.sent)].slice(-200);
    try {
      writeAtomicSync(this.path, JSON.stringify(this.state));
    } catch {
      // kept in memory for this run
    }
  }
}

/** The last ring of each live process instance, persisted for the case where one dies without a word. */
/** How rings reach the disk: atomically, asynchronously in normal use, synchronously only when dying. */
export interface RingsIo {
  write(path: string, data: string): Promise<void>;
  writeSync(path: string, data: string): void;
}

const nodeRingsIo: RingsIo = {
  async write(path, data) {
    const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, data, { mode: MODE });
    await rename(tmp, path);
  },
  writeSync: (path, data) => writeAtomicSync(path, data),
};

/**
 * The last ring of each live process instance, persisted for the case where
 * one dies without a word: written (asynchronously, one write at a time) a
 * little after they change, so an idle app writes nothing and main never
 * blocks on the disk for it; synchronously only on a fatal event or quit.
 */
export class Rings {
  private rings = new Map<string, Crumb[]>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly delayMs: number;
  private readonly io: RingsIo;

  constructor(
    private readonly path: string,
    private readonly session: () => string,
    o: { delayMs?: number; io?: RingsIo } = {},
  ) {
    this.delayMs = o.delayMs ?? 10_000;
    this.io = o.io ?? nodeRingsIo;
  }

  set(instance: string, crumbs: Crumb[]): void {
    this.rings.set(instance, crumbs);
    this.changed();
  }

  get(instance: string): Crumb[] {
    return this.rings.get(instance) ?? [];
  }

  delete(instance: string): void {
    if (this.rings.delete(instance)) this.changed();
  }

  private changed(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist();
    }, this.delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private snapshot(): string {
    this.dirty = false;
    return JSON.stringify({ session: this.session(), rings: Object.fromEntries(this.rings) });
  }

  /** The periodic path: asynchronous, serialized (a write never overlaps the previous one). */
  persist(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!this.dirty) return;
      try {
        await this.io.write(this.path, this.snapshot());
      } catch {
        this.dirty = true; // next time
      }
    });
    return this.chain;
  }

  /** A fatal event or quit: whatever changed is on disk before this returns. */
  persistSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    try {
      this.io.writeSync(this.path, this.snapshot());
    } catch {
      this.dirty = true;
    }
  }

  /** What the previous run left (its session and rings), sanitized. */
  readPrevious(): { session: string | null; rings: Record<string, Crumb[]> } {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { session?: unknown; rings?: Record<string, unknown> };
      const rings: Record<string, Crumb[]> = {};
      for (const [k, v] of Object.entries(raw.rings ?? {}).slice(0, 20)) if (/^[a-z]+(#\d+)?$/.test(k)) rings[k] = sanitizeCrumbs(v);
      return { session: typeof raw.session === "string" ? raw.session : null, rings };
    } catch {
      return { session: null, rings: {} };
    }
  }
}

export interface RunMarker {
  session: string;
  version: string;
  build: string;
  startedAt: number;
}

export const runMarker = {
  read(dir: string): RunMarker | null {
    try {
      const m = JSON.parse(readFileSync(join(dir, "running"), "utf8")) as RunMarker;
      return typeof m.session === "string" && typeof m.startedAt === "number" ? m : null;
    } catch {
      return null;
    }
  },
  write(dir: string, m: RunMarker): void {
    try {
      writeAtomicSync(join(dir, "running"), JSON.stringify(m));
    } catch {
      // without a marker, an unclean exit just goes unnoticed
    }
  },
  clear(dir: string): void {
    rmSync(join(dir, "running"), { force: true });
  },
};
