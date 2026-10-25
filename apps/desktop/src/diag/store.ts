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
      const policy = raw.policy && typeof raw.policy.localMode === "boolean" && ERROR_REPORTS.includes(raw.policy.errorReports) ? { localMode: raw.policy.localMode, errorReports: raw.policy.errorReports } : null;
      const installId = typeof raw.installId === "string" && /^[0-9a-f-]{36}$/.test(raw.installId) ? raw.installId : randomUUID();
      return { installId, seen: ids(raw.seen), sent: ids(raw.sent), policy };
    } catch {
      return { installId: randomUUID(), seen: [], sent: [], policy: null };
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
export class Rings {
  private rings = new Map<string, Crumb[]>();
  private dirty = false;
  constructor(
    private readonly path: string,
    /** told when the rings changed (main persists a little later) */
    private readonly onDirty: () => void = () => {},
  ) {}

  set(instance: string, crumbs: Crumb[]): void {
    this.rings.set(instance, crumbs);
    this.dirty = true;
    this.onDirty();
  }

  get(instance: string): Crumb[] {
    return this.rings.get(instance) ?? [];
  }

  delete(instance: string): void {
    this.dirty = this.rings.delete(instance) || this.dirty;
  }

  persistSync(session: string): void {
    if (!this.dirty) return;
    try {
      writeAtomicSync(this.path, JSON.stringify({ session, rings: Object.fromEntries(this.rings) }));
      this.dirty = false;
    } catch {
      // next time
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
