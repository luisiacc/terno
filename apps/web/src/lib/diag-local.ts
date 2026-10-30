/**
 * Diagnostics without a desktop shell (the web build, and the renderer in
 * tests and dev): this page is its own "main".
 *
 * - Entries: a ring of 2,000 in IndexedDB (terno-diag), in memory when
 *   IndexedDB fails (the very case where the mailbox may be failing too).
 * - Records: the last 20, same store.
 * - Run markers are per tab (localStorage, with the tab's last breadcrumbs),
 *   each paired with a Web Lock the tab holds for its life: a marker whose
 *   lock nobody holds belongs to a tab that died without a goodbye (pagehide
 *   removes it), and the next tab reports it. No heartbeat: idle is idle.
 * - Reports (web builds with a DSN): the shared reporter over fetch, behind
 *   the same consent boundary as desktop (plan 78).
 */
import {
  breadcrumbs,
  buildReport,
  ERROR_REPORTS,
  mayReport,
  newId,
  reportOffer,
  reportsAutomatically,
  Ring,
  sanitizeCrumbs,
  sanitizeEntry,
  sanitizeRecord,
  setDiagSink,
  diagContext,
  diagSession,
  log,
  type Crumb,
  type DiagEntry,
  type DiagSink,
  type DiagView,
  type ErrorRecord,
  type ErrorReports,
  type ReportEvent,
  type ReportPolicy,
} from "@terno/core/diag";
import type { Reporter } from "@terno/core/diag/envelope";
import { t } from "@terno/i18n";
import { BUILD, pendingSink } from "./diag";
import { ENTRIES_MAX, mergeRecords, openDiagDb, readEntries, readRecords, writeBatch } from "./diag-store";

const DSN: string = import.meta.env.VITE_SENTRY_DSN ?? "";
const RECORDS_MAX = 20;
const STATE_KEY = "terno:diag:state";
const TAB_PREFIX = "terno:diag:tab:";
const LOCK_PREFIX = "terno-diag-tab:";

interface LocalState {
  installId: string;
  seen: string[];
  sent: string[];
}

function readState(): LocalState {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}") as Partial<LocalState>;
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-200) : []);
    return { installId: typeof raw.installId === "string" ? raw.installId : crypto.randomUUID(), seen: ids(raw.seen), sent: ids(raw.sent) };
  } catch {
    return { installId: crypto.randomUUID(), seen: [], sent: [] };
  }
}

export class LocalDiag implements DiagSink {
  private readonly entries = new Ring<DiagEntry>(ENTRIES_MAX);
  records: ErrorRecord[] = [];
  private toWrite: DiagEntry[] = [];
  private recordsToWrite: ErrorRecord[] = [];
  private db: IDBDatabase | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private state = readState();
  private policy: ReportPolicy = { localMode: true, errorReports: "never", dsn: Boolean(DSN) };
  private approved = new Set<string>();
  /** reports whose send was tried this run and didn't go */
  private failed = new Set<string>();
  private reporter: Promise<Reporter> | null = null;
  private readonly tabId = crypto.randomUUID();
  private crumbs: Crumb[] = [];
  private listeners = new Set<() => void>();
  readonly counters = { allowed: 0, refused: 0, sent: 0 };

  async open(factory: IDBFactory = indexedDB): Promise<void> {
    try {
      const db = await openDiagDb(factory);
      // what was captured while the store opened stays: merged with what it held, not replaced by it
      this.records = mergeRecords(await readRecords(db), this.records);
      this.db = db;
      // and what was queued meanwhile goes in now
      this.flush();
    } catch {
      this.db = null; // memory only
    }
    await this.holdTabLock();
    await this.checkOtherTabs();
    window.addEventListener("pagehide", () => {
      this.flush();
      localStorage.removeItem(TAB_PREFIX + this.tabId);
    });
  }

  // ───────────────────────────── sink ─────────────────────────────

  write(e: DiagEntry): void {
    this.entries.push(e);
    this.toWrite.push(e);
    this.schedule();
  }

  capture(r: ErrorRecord): void {
    this.records = [r, ...this.records.filter((x) => x.id !== r.id)].slice(0, RECORDS_MAX);
    this.recordsToWrite.push(r);
    if (r.fatal) this.flush();
    else this.schedule();
    if (reportsAutomatically(this.policy)) void this.send(r);
    this.changed();
  }

  mirror(c: Crumb[]): void {
    this.crumbs = c;
    // the mirror is already debounced (every 2 s or 20 crumbs, only when there are new ones)
    this.writeMarker();
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), 1000);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // not open yet: keep everything queued for when it is
    if (!this.db) return;
    const entries = this.toWrite.splice(0);
    const records = this.recordsToWrite.splice(0);
    if (!entries.length && !records.length) return;
    const db = this.db;
    // one write at a time; retention is decided in it, from what every tab wrote
    this.writes = this.writes.then(() => writeBatch(db, entries, records)).catch(() => {
      // a full or broken IndexedDB: memory keeps going
    });
  }

  /** Resolves when every write so far has landed (tests, export). */
  idle(): Promise<void> {
    return this.writes;
  }

  // ───────────────────────────── run markers ─────────────────────────────

  /** This tab's lock, held until the tab goes away (its marker is written once it is held). */
  private holdTabLock(): Promise<void> {
    const locks = navigator.locks;
    if (!locks) return Promise.resolve();
    return new Promise<void>((held) => {
      void locks.request(LOCK_PREFIX + this.tabId, () => {
        this.writeMarker();
        held();
        return new Promise<never>(() => {});
      });
    });
  }

  private writeMarker(): void {
    try {
      localStorage.setItem(TAB_PREFIX + this.tabId, JSON.stringify({ session: diagSession(), version: BUILD.version, build: BUILD.id, startedAt: performance.timeOrigin, crumbs: this.crumbs.slice(-30) }));
    } catch {
      // storage full: no marker, no false alarm either
    }
  }

  /** A tab whose lock is free but whose marker is still here never said goodbye: it crashed (or the browser was killed). */
  private async checkOtherTabs(): Promise<void> {
    if (!navigator.locks) return;
    const held = new Set(((await navigator.locks.query().catch(() => null))?.held ?? []).map((l) => l.name));
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(TAB_PREFIX) || key === TAB_PREFIX + this.tabId || held.has(LOCK_PREFIX + key.slice(TAB_PREFIX.length))) continue;
      let m: { session?: unknown; version?: unknown; build?: unknown; crumbs?: unknown } = {};
      try {
        m = JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        // unreadable: dropped below
      }
      localStorage.removeItem(key);
      if (typeof m.session !== "string" || this.records.some((r) => r.context.session === m.session && r.proc === "renderer" && r.kind === "crash")) continue;
      const ctx = diagContext();
      const record = sanitizeRecord({
        id: newId(),
        ts: now,
        kind: "unclean_exit",
        proc: "renderer",
        code: "app.unclean_exit",
        fatal: true,
        crumbs: sanitizeCrumbs(m.crumbs),
        context: { ...ctx, session: m.session, version: typeof m.version === "string" ? m.version : ctx.version, build: typeof m.build === "string" ? m.build : ctx.build },
      });
      if (record) {
        log.warn("app.unclean_exit");
        this.capture(record);
      }
    }
  }

  // ───────────────────────────── reporting ─────────────────────────────

  setPolicy(p: { localMode: boolean; errorReports: ErrorReports }): void {
    if (!ERROR_REPORTS.includes(p.errorReports)) return;
    const next = { localMode: p.localMode, errorReports: p.errorReports, dsn: Boolean(DSN) };
    if (next.localMode === this.policy.localMode && next.errorReports === this.policy.errorReports) return;
    this.policy = next;
    if (reportsAutomatically(next)) for (const r of this.records.filter((x) => !this.state.sent.includes(x.id) && !this.state.seen.includes(x.id)).slice(0, 10)) void this.send(r);
    this.changed();
  }

  private saveState(): void {
    this.state.seen = [...new Set(this.state.seen)].slice(-200);
    this.state.sent = [...new Set(this.state.sent)].slice(-200);
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch {
      // kept in memory
    }
  }

  reportFor(r: ErrorRecord): ReportEvent {
    return buildReport(r, { installId: this.state.installId });
  }

  private async send(r: ErrorRecord): Promise<boolean> {
    // a constant: builds without a DSN contain no report code at all
    if (!DSN) return false;
    if (this.state.sent.includes(r.id)) return true;
    this.reporter ??= import("./diag-report").then((m) =>
      m.createWebReporter({
        dsn: DSN,
        client: `terno/${BUILD.version}`,
        allow: (eventId) => {
          const ok = mayReport(this.policy, this.approved.has(eventId));
          this.approved.delete(eventId);
          if (ok) this.counters.allowed++;
          else this.counters.refused++;
          return ok;
        },
      }),
    );
    const result = await (await this.reporter).send(this.reportFor(r));
    if (!result.sent) {
      if (result.reason !== "policy") this.failed.add(r.id);
      this.changed();
      return false;
    }
    this.failed.delete(r.id);
    this.counters.sent++;
    this.state.sent.push(r.id);
    this.state.seen.push(r.id);
    this.saveState();
    this.changed();
    return true;
  }

  view(): DiagView {
    return {
      build: BUILD,
      session: diagSession(),
      reporting: { ...this.policy, offer: reportOffer(this.policy) },
      pending: this.records
        .filter((r) => !this.state.seen.includes(r.id))
        .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, proc: r.proc, code: r.code, fatal: r.fatal, sent: this.state.sent.includes(r.id), failed: this.failed.has(r.id), previousRun: r.context.session !== diagSession() })),
      engine: "running",
      installId: this.state.installId,
      logs: false,
    };
  }

  async decide(ids: string[], decision: "send" | "dismiss"): Promise<{ sent: number }> {
    let sent = 0;
    const failed = new Set<string>();
    for (const id of ids) {
      const r = this.records.find((x) => x.id === id);
      if (!r) continue;
      if (decision === "send") {
        this.approved.add(id);
        if (await this.send(r)) sent++;
        else failed.add(id);
        this.approved.delete(id);
      }
    }
    // a report that couldn't go stays pending: the row keeps offering Send
    this.state.seen.push(...ids.filter((id) => !failed.has(id)));
    this.saveState();
    this.changed();
    return { sent };
  }

  preview(target: string): { event: ReportEvent; host: string | null } | null {
    const r =
      target === "sample"
        ? ({ id: newId(), ts: Date.now(), kind: "error", proc: "renderer", code: "diag.selftest", fields: { source: "renderer" }, fatal: false, error: { name: "Error", frames: [] }, crumbs: breadcrumbs(), context: diagContext() } satisfies ErrorRecord)
        : this.records.find((x) => x.id === target);
    if (!r) return null;
    let host: string | null = null;
    try {
      host = DSN ? new URL(DSN).host : null;
    } catch {
      host = null;
    }
    return { event: this.reportFor(r), host };
  }

  resetInstall(): string {
    this.state.installId = crypto.randomUUID();
    this.saveState();
    this.changed();
    return this.state.installId;
  }

  /** The export: every entry and record kept here, validated again, as one JSON file. */
  async exportJson(): Promise<string> {
    this.flush();
    let stored: unknown[] = this.entries.toArray();
    if (this.db) {
      await this.writes;
      stored = await readEntries(this.db).catch(() => stored);
    }
    const entries = stored.map((e) => sanitizeEntry(e, (e as { proc?: "renderer" | "worker" }).proc === "worker" ? "worker" : "renderer")).filter(Boolean);
    return JSON.stringify(
      {
        // in the user's language at export time; the field names stay fixed
        readme: t("diag.export.webReadme"),
        system: { terno: BUILD, ...diagContext(), userAgent: navigator.userAgent.replace(/\([^)]*\)/g, "(…)"), exportedAt: new Date().toISOString() },
        entries,
        records: this.records.map((r) => sanitizeRecord(r)).filter(Boolean),
      },
      null,
      2,
    );
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}

export const localDiag = new LocalDiag();

/** Takes over from the pending sink: what was logged during boot is kept. */
export async function startLocalDiag(): Promise<void> {
  if (!pendingSink) return;
  const q = pendingSink.queue;
  setDiagSink(localDiag);
  for (const e of q.entries) localDiag.write(e);
  if (q.crumbs) localDiag.mirror(q.crumbs);
  await localDiag.open();
  for (const r of q.records) localDiag.capture(r);
}

/** The web worker's diagnostics, posted to the page: validated as the worker's, kept here. */
export function ingestWorker(batch: { entries?: unknown[]; records?: unknown[] }): void {
  for (const raw of (batch.entries ?? []).slice(0, 500)) {
    const e = sanitizeEntry(raw, "worker");
    if (e) localDiag.write(e);
  }
  for (const raw of (batch.records ?? []).slice(0, 5)) {
    const r = sanitizeRecord(raw, "worker");
    if (r) localDiag.capture(r);
  }
}
