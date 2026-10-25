/**
 * Main's side of diagnostics, and the only process that ever sends a report.
 *
 * - Its own log, and the logs the backend (parent port) and renderers (IPC)
 *   send, each revalidated, go to rotating JSONL files under logs/.
 * - Records (unexpected errors, crashes, a dead backend or renderer, an
 *   unclean exit found at the next start) go to crashes/; every process
 *   mirrors its breadcrumbs here so even a hard crash has its trail.
 * - Native minidumps stay local: crashReporter never uploads.
 * - Reports: built from a record by allowlist, sent through Sentry only when
 *   the live policy allows (never in local mode or without a DSN; "ask"
 *   sends what the user approved, one report at a time).
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, crashReporter, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  buildReport,
  captureError,
  CLOSED_POLICY,
  diagContext,
  diagSession,
  installDiag,
  log,
  newId,
  RotatingLog,
  releaseName,
  reportOffer,
  reportsAutomatically,
  mayReport,
  sanitizeCrumbs,
  sanitizeEntry,
  sanitizeRecord,
  ERROR_REPORTS,
  type Channel,
  type DiagContext,
  type DiagEntry,
  type DiagSink,
  type DiagView,
  type ErrorRecord,
  type ErrorReports,
  type FieldValueOf,
  type Proc,
  type ReportEvent,
  type ReportPolicy,
} from "@terno/core/diag";
import type { Reporter, SendResult } from "@terno/core/diag/sentry";
import { BUILD_DSN, BUILD_ID, BUILD_SHA, BUILD_VERSION, channelOf } from "./build-info";
import { collectExport, zip } from "./export";
import { diagPaths, ensureDirs, nodeRotatingFs, RecordStore, Rings, runMarker, StateFile, type DiagPaths } from "./store";
import { IPC_ENTRIES_PER_SECOND, IPC_MAX_BATCH_BYTES, RateLimit } from "./supervisor";

export type EngineState = DiagView["engine"];

export interface PreviewResult {
  event: ReportEvent;
  /** where it would go (the DSN's host), or null in a build without one */
  host: string | null;
}

export interface MainDiagDeps {
  /** the sender is one of Terno's windows, top frame, on the app's own URL (as for printing) */
  trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean;
  windows(): Iterable<BrowserWindow>;
  demo: boolean;
  restartEngine(): void;
}

const MAX_RECENT_SEND_DAYS = 7;
const RINGS_EVERY_MS = 10_000;
const RELOADS_PER_MINUTE = 3;
const OS: Record<string, DiagContext["os"]> = { darwin: "darwin", win32: "win32", linux: "linux" };
const ARCH: Record<string, DiagContext["arch"]> = { arm64: "arm64", x64: "x64", ia32: "ia32" };

function osVersion(): string | undefined {
  try {
    return process.getSystemVersion();
  } catch {
    return undefined;
  }
}

class MainDiag implements DiagSink {
  private paths: DiagPaths | null = null;
  private logs = new Map<string, RotatingLog>();
  /** before userData is known: entries wait here (bounded) */
  private early: { proc: Proc; line: string }[] = [];
  private records: RecordStore | null = null;
  private state: StateFile | null = null;
  private rings: Rings | null = null;
  private deps: MainDiagDeps | null = null;
  private policy: ReportPolicy = CLOSED_POLICY;
  private approved = new Set<string>();
  private reporter: Promise<Reporter> | null = null;
  private engine: EngineState = "running";
  private limits = new Map<number, RateLimit>();
  private reloads = new Map<number, number[]>();
  private backendFatalAt = new Map<number, number>();
  /** at the transport: what the policy let through and what it refused (the smoke test reads these) */
  readonly counters = { allowed: 0, refused: 0, sent: 0, failed: 0 };
  private sessionStartedAt = Date.now();
  private ringsTimer: NodeJS.Timeout | null = null;
  private testHooks = false;
  readonly channel: Channel;
  readonly dsn: string;

  constructor() {
    const test = process.env.TERNO_DIAG_TEST === "1" && (!app.isPackaged || process.env.TERNO_DEMO === "1" || process.argv.includes("--demo"));
    const demo = process.env.TERNO_DEMO === "1" || process.argv.includes("--demo");
    this.testHooks = test;
    this.channel = channelOf({ packaged: app.isPackaged, demo, test });
    // a test build points at a local sink; a release only ever uses the DSN it was built with
    this.dsn = BUILD_DSN || (test ? (process.env.TERNO_TEST_SENTRY_DSN ?? "") : "");
  }

  // ───────────────────────────── the main process's own diag ─────────────────────────────

  /** First thing main does: its log, breadcrumbs and fatal hooks (entries wait in memory until open()). */
  installEarly(): void {
    installDiag({
      proc: "main",
      version: BUILD_VERSION,
      build: BUILD_ID,
      channel: this.channel,
      sink: this,
      context: () => this.context(),
    });
    process.on("uncaughtException", (error) => {
      captureError(error, { code: "process.uncaught", fields: { source: "main" }, fatal: true, expected: false });
    });
    process.on("unhandledRejection", (reason) => {
      captureError(reason, { code: "process.unhandled_rejection", fields: { source: "main" }, expected: false });
    });
    log.info("app.start", { packaged: app.isPackaged });
  }

  context(): Partial<DiagContext> {
    let locale: string | undefined;
    try {
      locale = app.isReady() ? app.getLocale() : undefined;
    } catch {
      locale = undefined;
    }
    return {
      os: OS[process.platform] ?? "other",
      osVersion: osVersion(),
      arch: ARCH[process.arch] ?? "other",
      locale,
      runtime: `electron-${process.versions.electron}`,
      engine: "node-sqlite",
      memMb: Math.round(totalmem() / 1048576),
    };
  }

  write(entry: DiagEntry): void {
    this.line("main", entry);
  }

  capture(record: ErrorRecord): void {
    this.onRecord(record);
  }

  mirror(crumbs: ErrorRecord["crumbs"]): void {
    this.rings?.set("main", crumbs);
  }

  flush(): void {
    for (const l of this.logs.values()) l.flushSync();
    this.rings?.persistSync(diagSession());
  }

  private line(proc: Proc, entry: DiagEntry): void {
    const line = JSON.stringify(entry);
    if (!app.isPackaged && entry.level !== "info") process.stderr.write(`[${proc}:${entry.level}] ${entry.code} ${entry.fields ? JSON.stringify(entry.fields) : ""} ${entry.msg ?? ""}\n`);
    if (!this.paths) {
      if (this.early.length < 500) this.early.push({ proc, line });
      return;
    }
    this.logFor(proc).write(line);
  }

  private logFor(proc: Proc): RotatingLog {
    let l = this.logs.get(proc);
    if (!l) {
      // a logging failure is counted, never reported (it would only fail again)
      l = new RotatingLog(join(this.paths!.logs, `${proc}.jsonl`), nodeRotatingFs, { maxBytes: 2 * 1024 * 1024, maxFiles: 5 });
      this.logs.set(proc, l);
    }
    return l;
  }

  // ───────────────────────────── open: after the single-instance lock ─────────────────────────────

  open(userData: string, deps: MainDiagDeps): void {
    this.deps = deps;
    const paths = (this.paths = diagPaths(userData));
    try {
      ensureDirs(paths);
    } catch {
      // without its folders diagnostics stay in memory; the app opens all the same
    }
    for (const e of this.early.splice(0)) this.logFor(e.proc).write(e.line);
    this.records = new RecordStore(paths.crashes);
    this.state = new StateFile(join(paths.diag, "state.json"));
    // persisted 10 s after they change, and at once on a fatal event: an idle app writes nothing
    this.rings = new Rings(join(paths.crashes, "rings.json"), () => {
      this.ringsTimer ??= setTimeout(() => {
        this.ringsTimer = null;
        this.rings?.persistSync(diagSession());
      }, RINGS_EVERY_MS).unref();
    });
    const known = this.state.get().policy;
    if (known) this.policy = { ...known, dsn: Boolean(this.dsn) };
    else this.policy = { ...CLOSED_POLICY, dsn: Boolean(this.dsn) };

    // native crashes: one owner (Electron's crashReporter), local only, before any child process starts
    try {
      app.setPath("crashDumps", join(paths.crashes, "native"));
      crashReporter.start({ uploadToServer: false, compress: true, ignoreSystemCrashHandler: false });
    } catch {
      // crash dumps are a bonus
    }

    this.checkPreviousRun();
    runMarker.write(paths.diag, { session: diagSession(), version: BUILD_VERSION, build: BUILD_ID, startedAt: this.sessionStartedAt });
    this.records.prune();


    app.on("render-process-gone", (_e, wc, details) => this.rendererGone(wc, details.reason, details.exitCode));
    app.on("child-process-gone", (_e, details) => this.childGone(details));
    app.on("will-quit", () => {
      log.info("app.quit");
      this.flush();
      if (this.paths) runMarker.clear(this.paths.diag);
    });
    this.registerIpc();
    if (this.testHooks) this.installTestHooks();
  }

  /** A run marker left behind: that run never quit. If it left no record of why, say so ("cierre inesperado"). */
  private checkPreviousRun(): void {
    const marker = runMarker.read(this.paths!.diag);
    if (!marker) return;
    const previous = this.rings!.readPrevious();
    const explained = this.records!.list().some((r) => r.context.session === marker.session && (r.fatal || r.kind !== "error"));
    if (explained) return;
    const crumbs = previous.session === marker.session ? Object.values(previous.rings).flat().sort((a, b) => a.ts - b.ts).slice(-100) : [];
    const ctx = diagContext();
    const record: ErrorRecord = {
      id: newId(),
      ts: Date.now(),
      kind: "unclean_exit",
      proc: "main",
      code: "app.unclean_exit",
      fatal: true,
      crumbs,
      context: { ...ctx, session: marker.session, version: typeof marker.version === "string" ? marker.version : ctx.version, build: typeof marker.build === "string" ? marker.build : ctx.build, uptimeS: Math.round((Date.now() - marker.startedAt) / 1000) },
    };
    const clean = sanitizeRecord(record);
    if (clean) this.records!.writeSync(clean);
    log.warn("app.unclean_exit");
  }

  // ───────────────────────────── records and reports ─────────────────────────────

  private onRecord(record: ErrorRecord): void {
    if (!this.records) return; // too early to keep it on disk: it was logged all the same
    if (record.fatal || record.kind !== "error") this.records.writeSync(record);
    else void this.records.write(record);
    this.rings?.persistSync(diagSession());
    if (reportsAutomatically(this.policy)) void this.send(record);
    this.changed();
  }

  /** The backend's policy (it owns the settings): kept, so a backend that can't start still has one. */
  setPolicy(p: { localMode: boolean; errorReports: ErrorReports }): void {
    if (typeof p.localMode !== "boolean" || !ERROR_REPORTS.includes(p.errorReports)) return;
    this.policy = { localMode: p.localMode, errorReports: p.errorReports, dsn: Boolean(this.dsn) };
    this.state?.update((s) => (s.policy = { localMode: p.localMode, errorReports: p.errorReports }));
    // "always": what this run or the last few days recorded and never sent goes now
    if (reportsAutomatically(this.policy)) for (const r of this.unsent()) void this.send(r);
    this.changed();
  }

  private unsent(): ErrorRecord[] {
    const s = this.state!.get();
    const since = Date.now() - MAX_RECENT_SEND_DAYS * 86_400_000;
    return this.records!.list().filter((r) => r.ts >= since && !s.sent.includes(r.id) && !s.seen.includes(r.id)).slice(0, 10);
  }

  private reportFor(record: ErrorRecord): ReportEvent {
    return buildReport(record, { installId: this.state?.get().installId ?? "unknown", release: releaseName(BUILD_VERSION, BUILD_SHA), environment: this.channel });
  }

  private async send(record: ErrorRecord): Promise<SendResult> {
    if (!this.dsn) return { sent: false, reason: "policy" };
    // its own bundle (dist/reporter.cjs, @sentry/core inside): main.cjs stays small and never loads it without a DSN
    this.reporter ??= Promise.resolve((require(join(__dirname, "reporter.cjs")) as typeof import("./reporter")).createMainReporter).then((createMainReporter) =>
      createMainReporter({
        dsn: this.dsn,
        release: releaseName(BUILD_VERSION, BUILD_SHA),
        environment: this.channel,
        // the consent boundary: asked for every envelope, at send time
        allow: (eventId) => {
          const ok = mayReport(this.policy, this.approved.has(eventId));
          this.approved.delete(eventId);
          if (ok) this.counters.allowed++;
          else this.counters.refused++;
          return ok;
        },
        onResult: (_id, r) => {
          if (r.sent) this.counters.sent++;
          else if (r.reason === "error" || r.reason === "timeout") this.counters.failed++;
        },
      }),
    );
    const result = await (await this.reporter).send(this.reportFor(record));
    if (result.sent) {
      this.state?.update((s) => {
        s.sent.push(record.id);
        s.seen.push(record.id);
      });
      log.info("report.sent", { count: 1 });
      this.changed();
    } else {
      log.info("report.dropped", { reason: result.reason === "policy" ? "policy" : "error", count: 1 });
    }
    return result;
  }

  view(): DiagView {
    const s = this.state?.get();
    const all = this.records?.list() ?? [];
    return {
      build: { version: BUILD_VERSION, sha: BUILD_SHA, channel: this.channel, id: BUILD_ID },
      session: diagSession(),
      reporting: { ...this.policy, offer: reportOffer(this.policy) },
      pending: all
        .filter((r) => !s?.seen.includes(r.id))
        .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, proc: r.proc, code: r.code, fatal: r.fatal, sent: Boolean(s?.sent.includes(r.id)), previousRun: r.context.session !== diagSession() })),
      engine: this.engine,
      installId: s?.installId ?? "",
      logs: Boolean(this.paths),
    };
  }

  async decide(ids: string[], decision: "send" | "dismiss"): Promise<{ sent: number }> {
    let sent = 0;
    for (const id of ids.slice(0, 20)) {
      const record = this.records?.get(id);
      if (!record) continue;
      if (decision === "send") {
        // one-time approval of this report; the transport still checks local mode, the setting and the DSN
        this.approved.add(id);
        if ((await this.send(record)).sent) sent++;
      }
    }
    this.state?.update((s) => s.seen.push(...ids.filter((id) => /^[0-9a-f]{32}$/.test(id))));
    this.changed();
    return { sent };
  }

  /** The exact event a record would send (or, for "sample", a synthetic one built the same way). */
  preview(target: string): PreviewResult | null {
    let record = target === "sample" ? null : this.records?.get(target);
    if (target === "sample") {
      record = { id: newId(), ts: Date.now(), kind: "error", proc: "main", code: "diag.selftest", fields: { source: "main" }, fatal: false, crumbs: [], context: diagContext() };
      record.error = { name: "Error", message: "", frames: [] };
      record.crumbs = sanitizeCrumbs(this.rings?.get("main") ?? []);
    }
    if (!record) return null;
    let host: string | null = null;
    try {
      host = this.dsn ? new URL(this.dsn).host : null;
    } catch {
      host = null;
    }
    return { event: this.reportFor(record), host };
  }

  resetInstallId(): string {
    const id = randomUUID();
    this.state?.update((s) => (s.installId = id));
    this.changed();
    return id;
  }

  setEngine(state: EngineState): void {
    if (state === this.engine) return;
    this.engine = state;
    this.changed();
  }

  private changed(): void {
    for (const w of this.deps?.windows() ?? []) if (!w.isDestroyed()) w.webContents.send("terno:diag-event", { type: "state" });
  }

  // ───────────────────────────── the backend ─────────────────────────────

  backendEntries(instance: number, entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const raw of entries.slice(0, 500)) {
      const e = sanitizeEntry(raw, "backend");
      if (e) this.line("backend", e);
    }
    void instance;
  }

  backendRing(instance: number, crumbs: unknown): void {
    this.rings?.set(`backend#${instance}`, sanitizeCrumbs(crumbs));
  }

  backendRecord(instance: number, raw: unknown): void {
    const r = sanitizeRecord(raw, "backend");
    if (!r) return;
    if (r.fatal) this.backendFatalAt.set(instance, Date.now());
    this.onRecord(r);
  }

  /** The utility process exited on its own (a deliberate stop never gets here). */
  backendExited(instance: number, exitCode: number, attempt: number): void {
    log.warn("backend.exited", { exitCode, attempt, deliberate: false });
    const reported = Date.now() - (this.backendFatalAt.get(instance) ?? 0) < 5000;
    if (!reported) {
      const ctx = diagContext();
      this.onRecord({
        id: newId(),
        ts: Date.now(),
        kind: "backend_exit",
        proc: "backend",
        code: "backend.exited",
        fields: { exitCode, attempt },
        fatal: true,
        crumbs: this.rings?.get(`backend#${instance}`) ?? [],
        context: ctx,
      });
    }
    this.rings?.delete(`backend#${instance}`);
  }

  // ───────────────────────────── renderers and other children ─────────────────────────────

  private rendererGone(wc: WebContents, reason: string, exitCode: number): void {
    if (reason === "clean-exit") return;
    const id = wc.id;
    this.onRecord({
      id: newId(),
      ts: Date.now(),
      kind: "renderer_gone",
      proc: "renderer",
      code: "renderer.gone",
      fields: { reason: reason as FieldValueOf<"reason">, exitCode },
      fatal: true,
      crumbs: this.rings?.get(`renderer#${id}`) ?? [],
      context: diagContext(),
    });
    this.rings?.delete(`renderer#${id}`);
    // the window comes back on its own, a few times a minute at most (a page that crashes on load must not loop)
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed() || reason === "killed") return;
    const now = Date.now();
    const recent = (this.reloads.get(id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RELOADS_PER_MINUTE) return;
    this.reloads.set(id, [...recent, now]);
    setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 250);
  }

  private childGone(d: Electron.Details): void {
    if (d.reason === "clean-exit" || d.reason === "killed") return;
    // the backend's own exit is handled (and deduplicated) by its supervisor
    if (d.type === "Utility" && d.serviceName === "Terno Mail Engine") return;
    const childType = (["Utility", "Zygote", "Sandbox helper", "GPU", "Pepper Plugin", "Pepper Plugin Broker", "Unknown"] as const).find((t) => t === d.type) ?? "Unknown";
    this.onRecord({ id: newId(), ts: Date.now(), kind: "child_gone", proc: "main", code: "child.gone", fields: { childType, reason: d.reason as FieldValueOf<"reason">, exitCode: d.exitCode }, fatal: false, crumbs: this.rings?.get("main") ?? [], context: diagContext() });
  }

  // ───────────────────────────── IPC ─────────────────────────────

  private registerIpc(): void {
    const deps = this.deps!;
    ipcMain.on("terno:diag-info", (e) => {
      e.returnValue = deps.trusted(e) ? { version: BUILD_VERSION, sha: BUILD_SHA, build: BUILD_ID, channel: this.channel, session: diagSession(), dsn: Boolean(this.dsn) } : null;
    });
    ipcMain.on("terno:diag", (e, batch: unknown) => {
      if (!deps.trusted(e)) return;
      this.rendererBatch(e.sender.id, batch);
    });
    ipcMain.handle("terno:diag-state", (e) => (deps.trusted(e) ? this.view() : null));
    ipcMain.handle("terno:diag-decide", (e, ids: unknown, decision: unknown) => {
      if (!deps.trusted(e) || !Array.isArray(ids) || (decision !== "send" && decision !== "dismiss")) return { sent: 0 };
      return this.decide(ids.filter((x): x is string => typeof x === "string"), decision);
    });
    ipcMain.handle("terno:diag-preview", (e, target: unknown) => (deps.trusted(e) && typeof target === "string" ? this.preview(target) : null));
    ipcMain.handle("terno:diag-export", (e) => (deps.trusted(e) ? this.exportInteractive(BrowserWindow.fromWebContents(e.sender)) : { status: "failed" }));
    ipcMain.handle("terno:diag-show-logs", (e) => {
      if (!deps.trusted(e) || !this.paths) return false;
      void shell.openPath(this.paths.logs);
      return true;
    });
    ipcMain.handle("terno:diag-reset-install", (e) => (deps.trusted(e) ? this.resetInstallId() : null));
    ipcMain.handle("terno:engine-restart", (e) => {
      if (!deps.trusted(e)) return false;
      deps.restartEngine();
      return true;
    });
  }

  /** A renderer's batch: bounded in bytes and rate, every entry, crumb and record revalidated. */
  rendererBatch(senderId: number, batch: unknown): void {
    if (!batch || typeof batch !== "object") return;
    let bytes = 0;
    try {
      bytes = JSON.stringify(batch).length;
    } catch {
      return;
    }
    const now = Date.now();
    let limit = this.limits.get(senderId);
    if (!limit) this.limits.set(senderId, (limit = new RateLimit(IPC_ENTRIES_PER_SECOND, now)));
    const b = batch as { entries?: unknown; crumbs?: unknown; records?: unknown; dropped?: unknown };
    if (bytes > IPC_MAX_BATCH_BYTES) {
      log.warn("diag.ipc_dropped", { count: Array.isArray(b.entries) ? b.entries.length : 0, reason: "size", source: "renderer" });
      return;
    }
    if (Array.isArray(b.entries)) {
      const ok = limit.take(b.entries.length, now);
      for (const raw of b.entries.slice(0, ok)) {
        const e = sanitizeEntry(raw, "renderer");
        if (e) this.line("renderer", e);
      }
      if (ok < b.entries.length) log.warn("diag.ipc_dropped", { count: b.entries.length - ok, reason: "rate", source: "renderer" });
    }
    if (Array.isArray(b.crumbs)) this.rings?.set(`renderer#${senderId}`, sanitizeCrumbs(b.crumbs));
    if (Array.isArray(b.records)) {
      for (const raw of b.records.slice(0, 5)) {
        const r = sanitizeRecord(raw, "renderer");
        if (r) this.onRecord(r);
      }
    }
    if (typeof b.dropped === "number" && b.dropped > 0) log.warn("diag.ipc_dropped", { count: b.dropped, reason: "rate", source: "renderer" });
  }

  // ───────────────────────────── export ─────────────────────────────

  private exportDir(): string | null {
    const dir = process.env.TERNO_TEST_EXPORT_DIR;
    return dir && this.testHooks ? dir : null;
  }

  /** Asks (native dumps are a separate, explicit choice), then where to save. */
  async exportInteractive(parent: BrowserWindow | null): Promise<{ status: "saved" | "cancelled" | "failed"; name?: string }> {
    const testDir = this.exportDir();
    let includeNative = false;
    let path: string;
    if (testDir) {
      path = join(testDir, "Terno-diagnostics.zip");
      includeNative = process.env.TERNO_TEST_EXPORT_NATIVE === "1";
    } else {
      const opts: Electron.MessageBoxOptions = {
        type: "none",
        message: "Export Diagnostics",
        detail: "Saves Terno's logs and error reports, scrubbed: none of your mail, addresses or keys. You can look through it before sending it to anyone.",
        checkboxLabel: "Include native crash dumps (they can contain fragments of your mail)",
        checkboxChecked: false,
        buttons: ["Export…", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      };
      const ask = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      if (ask.response !== 0) return { status: "cancelled" };
      includeNative = ask.checkboxChecked;
      const day = new Date().toISOString().slice(0, 10);
      const save: Electron.SaveDialogOptions = { defaultPath: join(app.getPath("downloads"), `Terno-diagnostics-${day}.zip`), filters: [{ name: "Zip", extensions: ["zip"] }], properties: ["createDirectory", "showOverwriteConfirmation"] };
      const choice = parent ? await dialog.showSaveDialog(parent, save) : await dialog.showSaveDialog(save);
      if (choice.canceled || !choice.filePath) return { status: "cancelled" };
      path = choice.filePath;
    }
    return this.exportTo(path, includeNative);
  }

  async exportTo(path: string, includeNative: boolean): Promise<{ status: "saved" | "failed"; name?: string }> {
    const started = Date.now();
    try {
      for (const l of this.logs.values()) await l.flush();
      this.rings?.persistSync(diagSession());
      const entries = collectExport({
        paths: this.paths!,
        system: { terno: { version: BUILD_VERSION, sha: BUILD_SHA, build: BUILD_ID, channel: this.channel }, ...this.context(), session: diagSession(), exportedAt: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
        nativeDir: includeNative ? join(this.paths!.crashes, "native") : null,
      });
      writeFileSync(path, zip(entries), { mode: 0o600 });
      log.info("export.done", { count: entries.length, durationMs: Date.now() - started });
      return { status: "saved", name: path.split("/").pop() };
    } catch (error) {
      captureError(error, { code: "export.failed", fields: { errno: (error as { code?: string }).code } });
      return { status: "failed" };
    }
  }

  showLogs(): void {
    if (this.paths) void shell.openPath(this.paths.logs);
  }

  // ───────────────────────────── test hooks (dev builds, or the packaged demo with TERNO_DIAG_TEST) ─────────────────────────────

  private installTestHooks(): void {
    (globalThis as unknown as { __ternoDiag: unknown }).__ternoDiag = {
      paths: () => this.paths,
      view: () => this.view(),
      records: () => this.records?.list() ?? [],
      counters: () => ({ ...this.counters }),
      dsn: () => this.dsn,
      preview: (id: string) => this.preview(id),
      decide: (ids: string[], d: "send" | "dismiss") => this.decide(ids, d),
      exportTo: (path: string, native: boolean) => this.exportTo(path, native),
      flush: () => this.flush(),
      /** a known exception from a known line of this file: the symbolication test resolves it through the archived maps */
      throwKnown: () => {
        try {
          knownFailure();
        } catch (error) {
          return captureError(error, { code: "diag.selftest", fields: { source: "main" }, expected: false });
        }
        return null;
      },
    };
  }
}

/** Throws from a fixed place in the source (see installTestHooks). */
function knownFailure(): never {
  throw new TypeError("diag selftest: a known failure");
}

export const mainDiag = new MainDiag();
