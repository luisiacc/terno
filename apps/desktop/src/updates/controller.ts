/**
 * The updater's brain in main: the state (a pure reducer), when it may
 * check and download (policy.ts), the timers, the install with its
 * coordinated shutdown, and the health check after an install. Electron,
 * electron-updater and the disk come in as deps, so the whole flow is
 * unit-tested in Node.
 *
 * Idle means idle: nothing runs until the startup delay, the periodic check
 * is scheduled only while automatic checks are allowed (never in local
 * mode), and electron-updater isn't even loaded before the first check.
 */
import { initialUpdateState, notesText, reduceUpdate, type UnsupportedReason, type UpdateChannel, type UpdateEvent, type UpdateMode, type UpdateState } from "@terno/core/updates";
import type { Engine, EngineHandlers, EngineInfo } from "./engine";
import { errorKind, expectedKind, Grants, installOutcome, mayCheck, mayDownload, updateRequestAllowed, type FeedConfig, type PendingInstall, type Trigger, type UpdatePrefs } from "./policy";

/** the first check waits this long after launch, so a cold start never pays for it */
export const STARTUP_CHECK_DELAY_MS = 30_000;
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type InstallShutdown = "closed" | "forced" | "sending" | "timeout" | "unsaved";

export interface ControllerDeps {
  version: string;
  feed: FeedConfig;
  /** a test build's own feed (its origin is allowed besides GitHub's) */
  testFeed: string | null;
  checkDelayMs: number;
  loadEngine(o: { feed: FeedConfig; allowed(url: string): boolean; handlers: EngineHandlers }): Engine;
  /** why this copy can't update itself (codesign, location), or null */
  probe(): Promise<UnsupportedReason | null>;
  prefs: { read(): UpdatePrefs; write(p: UpdatePrefs): void };
  pending: { read(): PendingInstall | null; write(p: PendingInstall): void; clear(): void };
  /** the coordinated shutdown, not forced (a send in flight answers "sending") */
  shutdown(): Promise<InstallShutdown>;
  /** called once, when no send is in flight any more */
  onSendsIdle(cb: () => void): void;
  /** the install didn't happen after the shutdown closed the backend: bring it back */
  recover(): void;
  publish(state: UpdateState): void;
  log(code: "update.check" | "update.available" | "update.not_available" | "update.downloaded" | "update.ready" | "update.unsupported" | "update.install" | "update.deferred" | "update.applied" | "update.blocked", fields?: Record<string, string | number | boolean | undefined>): void;
  capture(error: unknown, code: "update.failed" | "update.not_applied", fields: Record<string, string | number | boolean | undefined>, expected: boolean): void;
  newId(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class UpdateController {
  private state: UpdateState;
  private prefs: UpdatePrefs;
  private engine: Engine | null = null;
  private readonly grants = new Grants();
  private timer: unknown = null;
  private started = false;
  private probed: Promise<boolean> | null = null;
  private checking: Promise<UpdateState> | null = null;
  private downloading: Promise<UpdateState> | null = null;
  private downloadGrant: number | null = null;
  private checkGrant: number | null = null;
  private downloadStartedAt = 0;
  private healthChecked = false;
  private waitingForSends = false;
  /** a grant revoked while its request ran: its failure is a cancellation, not an error */
  private revoked = new Set<number>();
  /** the open grants that are automatic (local mode revokes them) */
  private automatic = new Set<number>();

  constructor(
    private readonly deps: ControllerDeps,
    localMode: boolean,
  ) {
    this.prefs = deps.prefs.read();
    this.state = initialUpdateState({ current: deps.version, mode: this.prefs.mode, channel: this.prefs.channel, localMode, checkedAt: this.prefs.checkedAt });
  }

  get view(): UpdateState {
    return this.state;
  }

  /** After launch: nothing now; the location probe (local, no network) and the first automatic check after the delay. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(this.deps.checkDelayMs, () => this.autoCheck());
  }

  /** Once per run: can this copy update itself? (codesign and the bundle's location) */
  private supported(): Promise<boolean> {
    this.probed ??= this.deps
      .probe()
      .catch(() => null)
      .then((reason) => {
        if (!reason) return true;
        this.dispatch({ type: "unsupported", reason });
        this.deps.log("update.unsupported", { unsupported: reason });
        return false;
      });
    return this.probed;
  }

  private schedule(ms: number, fn: () => void | Promise<void>): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void fn();
    }, ms);
  }

  private unschedule(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  /** The background check; the next one is scheduled only while they're allowed. */
  private async autoCheck(): Promise<void> {
    if (!(await this.supported()) || !mayCheck({ localMode: this.state.localMode, trigger: "auto" })) return;
    await this.check("auto");
    if (!this.state.localMode && this.state.status !== "unsupported") this.schedule(CHECK_EVERY_MS, () => this.autoCheck());
  }

  private dispatch(e: UpdateEvent): void {
    const next = reduceUpdate(this.state, e);
    if (next === this.state) return;
    const quiet = e.type === "download-progress" && next.percent === this.state.percent;
    this.state = next;
    if (!quiet) this.deps.publish(next);
  }

  private ensureEngine(): Engine {
    this.engine ??= this.deps.loadEngine({
      feed: this.deps.feed,
      allowed: (url) => {
        const host = updateRequestAllowed(url, this.deps.testFeed);
        const ok = host && this.grants.active;
        if (!ok) this.deps.log("update.blocked", { reason: host ? "local-mode" : "host" });
        return ok;
      },
      handlers: {
        progress: (percent) => this.dispatch({ type: "download-progress", percent }),
        ready: () => {
          this.dispatch({ type: "ready" });
          this.deps.log("update.ready", { toVersion: this.state.ready?.version });
        },
        squirrelError: (error) => {
          const kind = errorKind(error) === "unknown" ? "integrity" : errorKind(error);
          if (this.state.status === "installing") this.failInstall(error, kind);
          else if (this.state.status === "verifying" || this.state.status === "downloading") {
            this.dispatch({ type: "verify-failed", kind });
            this.deps.capture(error, "update.failed", { stage: "verify" }, expectedKind(kind));
          }
        },
      },
    });
    return this.engine;
  }

  /** A check: automatic (policy permitting) or the user's ("Check for Updates…", one grant). */
  async check(trigger: Trigger): Promise<UpdateState> {
    if (!(await this.supported())) return this.state;
    if (this.checking) return this.checking;
    // one thing at a time, through Squirrel's own check of a finished download
    if (this.downloading || this.state.status === "verifying" || this.state.status === "installing") return Promise.resolve(this.state);
    if (!mayCheck({ localMode: this.state.localMode, trigger })) return Promise.resolve(this.state);
    const grant = this.takeGrant(trigger);
    if (grant === null) return Promise.resolve(this.state);
    this.checkGrant = grant;
    this.checking = this.runCheck(trigger, grant).finally(() => {
      this.dropGrant(grant);
      this.checkGrant = null;
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(trigger: Trigger, grant: number): Promise<UpdateState> {
    this.dispatch({ type: "check-start" });
    this.deps.log("update.check", { updateChannel: this.state.channel, trigger });
    let info: EngineInfo | null;
    try {
      info = await this.ensureEngine().check(this.state.channel);
    } catch (error) {
      if (this.revoked.has(grant)) {
        this.dispatch({ type: "cancelled" });
        return this.state;
      }
      const kind = errorKind(error);
      this.dispatch({ type: "check-failed", at: this.deps.now(), kind });
      this.deps.capture(error, "update.failed", { stage: "check" }, expectedKind(kind));
      this.saveCheckedAt();
      return this.state;
    }
    if (this.revoked.has(grant)) {
      this.dispatch({ type: "cancelled" });
      return this.state;
    }
    const at = this.deps.now();
    if (info) {
      this.dispatch({ type: "available", at, update: { version: info.version, notes: notesText(info.releaseNotes), size: info.size, releaseDate: info.releaseDate } });
      this.deps.log("update.available", { updateChannel: this.state.channel, toVersion: info.version });
    } else {
      this.dispatch({ type: "not-available", at });
      this.deps.log("update.not_available", { updateChannel: this.state.channel });
    }
    this.saveCheckedAt();
    // automatic mode downloads what it found (a manual check in automatic mode too, as long as local mode is off)
    if (this.state.available && this.state.available.version !== this.state.ready?.version && mayDownload({ localMode: this.state.localMode, mode: this.state.mode, trigger: "auto" })) void this.download("auto");
    return this.state;
  }

  /** "Download": automatic in automatic mode, otherwise the user's second grant. */
  download(trigger: Trigger): Promise<UpdateState> {
    if (this.downloading) return this.downloading;
    const target = this.state.available;
    if (!target || target.version === this.state.ready?.version || this.state.status === "verifying" || this.state.status === "installing") return Promise.resolve(this.state);
    if (!mayDownload({ localMode: this.state.localMode, mode: this.state.mode, trigger })) return Promise.resolve(this.state);
    const grant = this.takeGrant(trigger);
    if (grant === null) return Promise.resolve(this.state);
    this.downloadGrant = grant;
    this.downloading = this.runDownload(grant).finally(() => {
      this.dropGrant(grant);
      this.downloadGrant = null;
      this.downloading = null;
    });
    return this.downloading;
  }

  private async runDownload(grant: number): Promise<UpdateState> {
    this.dispatch({ type: "download-start" });
    this.downloadStartedAt = this.deps.now();
    try {
      await this.ensureEngine().download();
      this.dispatch({ type: "downloaded" });
      this.deps.log("update.downloaded", { toVersion: this.state.target?.version, durationMs: this.deps.now() - this.downloadStartedAt });
    } catch (error) {
      if (this.revoked.has(grant)) {
        this.dispatch({ type: "cancelled" });
        return this.state;
      }
      const kind = errorKind(error);
      // Squirrel's refusal may surface here as well as through its own event
      if (this.state.status === "verifying") this.dispatch({ type: "verify-failed", kind: kind === "unknown" ? "integrity" : kind });
      else this.dispatch({ type: "download-failed", kind });
      this.deps.capture(error, "update.failed", { stage: this.state.error?.stage ?? "download" }, expectedKind(kind));
    }
    return this.state;
  }

  /** "Restart now": drafts flushed, the backend closed (a send in flight defers it), then Squirrel swaps and relaunches. */
  async install(): Promise<UpdateState> {
    const ready = this.state.ready;
    if (!ready || this.state.status === "installing") return this.state;
    this.dispatch({ type: "install-start" });
    const outcome = await this.deps.shutdown();
    if (outcome === "unsaved") {
      this.dispatch({ type: "install-failed", kind: "unsaved" });
      this.deps.log("update.deferred", { reason: "drafts" });
      return this.state;
    }
    if (outcome === "forced") {
      this.dispatch({ type: "install-failed", kind: "unknown" });
      this.deps.log("update.deferred", { reason: "other" });
      this.deps.recover();
      return this.state;
    }
    // only a clean close goes ahead; a send still running, or a backend that didn't answer (it may be mid-send), waits
    if (outcome !== "closed") {
      this.dispatch({ type: "install-deferred", reason: "sending" });
      this.deps.log("update.deferred", { reason: outcome === "sending" ? "sending" : "other" });
      if (!this.waitingForSends) {
        this.waitingForSends = true;
        this.deps.onSendsIdle(() => {
          this.waitingForSends = false;
          if (this.state.deferred === "sending") void this.install();
        });
      }
      return this.state;
    }
    try {
      this.recordPending(ready.version);
      this.deps.log("update.install", { toVersion: ready.version, trigger: "restart" });
      this.ensureEngine().quitAndInstall();
    } catch (error) {
      this.failInstall(error, errorKind(error));
    }
    return this.state;
  }

  private failInstall(error: unknown, kind: ReturnType<typeof errorKind>): void {
    try {
      try { this.deps.pending.clear(); }
      catch (cleanup) { this.deps.capture(cleanup, "update.failed", { stage: "install" }, false); }
      this.dispatch({ type: "install-failed", kind });
      this.deps.capture(error, "update.failed", { stage: "install" }, expectedKind(kind));
    } finally { this.deps.recover(); }
  }

  private recordPending(to: string): void {
    this.deps.pending.write({ from: this.deps.version, to, txId: this.deps.newId(), at: this.deps.now() });
  }

  /** A plain quit (after its shutdown): with an update ready, Squirrel installs it now, so the next run checks it. */
  quitting(): void {
    this.unschedule();
    if (this.state.ready && this.state.status !== "installing") {
      this.recordPending(this.state.ready.version);
      this.deps.log("update.install", { toVersion: this.state.ready.version, trigger: "quit" });
    }
  }

  /** The backend is ready (migrations done): the first time in a run, settle the last install's record. */
  backendReady(): void {
    if (this.healthChecked) return;
    this.healthChecked = true;
    const pending = this.deps.pending.read();
    if (!pending) return;
    this.deps.pending.clear();
    const outcome = installOutcome(pending, this.deps.version);
    if (outcome === "applied") {
      this.dispatch({ type: "applied", version: pending.to });
      this.deps.log("update.applied", { fromVersion: pending.from, toVersion: pending.to });
    } else if (outcome === "not-applied") {
      this.dispatch({ type: "not-applied", version: pending.to });
      this.deps.capture(Object.assign(new Error("update not applied"), { name: "UpdateNotApplied" }), "update.not_applied", { fromVersion: pending.from, toVersion: pending.to }, false);
    }
  }

  setLocalMode(on: boolean): void {
    if (on === this.state.localMode) return;
    this.dispatch({ type: "local-mode", on });
    if (on) {
      // automatic work stops now: its requests are refused from here on, a download is cancelled
      const cut = [this.downloadGrant, this.checkGrant].some((g) => g !== null && this.automatic.has(g));
      if (cut) this.engine?.cancel();
      // the grants end; the requests they covered fail as cancellations, not errors
      for (const id of this.automatic) this.revoked.add(id);
      this.automatic.clear();
      this.grants.revokeAutomatic();
      this.unschedule();
    } else if (this.started && this.state.status !== "unsupported") {
      this.schedule(this.deps.checkDelayMs, () => this.autoCheck());
    }
  }

  private takeGrant(trigger: Trigger): number | null {
    const id = this.grants.grant(trigger, { localMode: this.state.localMode });
    if (id !== null && trigger === "auto") this.automatic.add(id);
    return id;
  }

  private dropGrant(id: number): void {
    this.grants.release(id);
    this.automatic.delete(id);
    this.revoked.delete(id);
  }

  setPrefs(p: { mode: UpdateMode; channel: UpdateChannel }): void {
    // Squirrel can't unstage a ready update: the channel waits until it's installed (Settings says so)
    const channelChanged = p.channel !== this.state.channel && !this.state.ready;
    // what the other channel is answering or downloading no longer applies
    if (channelChanged && this.checkGrant !== null) this.revoked.add(this.checkGrant);
    if (channelChanged && this.downloadGrant !== null) {
      this.revoked.add(this.downloadGrant);
      this.engine?.cancel();
    }
    this.dispatch({ type: "prefs", mode: p.mode, channel: p.channel });
    this.prefs = { ...this.prefs, mode: this.state.mode, channel: this.state.channel };
    this.deps.prefs.write(this.prefs);
    if (channelChanged && this.started && this.state.status !== "unsupported" && mayCheck({ localMode: this.state.localMode, trigger: "auto" })) {
      void Promise.allSettled([this.checking, this.downloading]).then(() => this.check("auto"));
    } else if (this.state.available && mayDownload({ localMode: this.state.localMode, mode: this.state.mode, trigger: "auto" })) void this.download("auto");
  }

  seen(): void {
    this.dispatch({ type: "seen" });
  }

  private saveCheckedAt(): void {
    this.prefs = { ...this.prefs, checkedAt: this.state.checkedAt };
    this.deps.prefs.write(this.prefs);
  }
}
