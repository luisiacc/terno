/**
 * Plan 95: main's side of the mailbox gate. The backend reports where the
 * mailbox stands (being upgraded, open, or a failure the window explains);
 * this keeps the latest, pushes it to every window, and answers the
 * window's three asks: Try Again, Update Without a Backup, Restore.
 *
 * A failure the backend explained ends that process and is never restarted
 * on a timer: retrying a step that failed five times only delays the
 * screen. Everything else (a crash) keeps the restart policy. Electron and
 * the disk come in as deps, so this is tested in Node.
 */
import { join } from "node:path";
import { GATE_OPEN, type MailboxGate } from "@terno/core/mailbox";
import { listBackups } from "@terno/db/backups";
import { reconcileRestore, restoreFromBackup, RestoreError, type RestoreDeps } from "./restore";

export interface MailboxHostDeps {
  dbPath(): string;
  publish(gate: MailboxGate): void;
  /** a fresh backend (a new series of restart attempts) and the windows connected to it */
  start(): void;
  /** a backend process exists (running, or exiting after a failure it explained) */
  alive(): boolean;
  log(code: "mailbox.restored" | "mailbox.restore_failed" | "mailbox.restore_reconciled", fields?: Record<string, string | number | undefined>): void;
  now(): number;
  restore?: RestoreDeps;
}

export class MailboxHost {
  private current: MailboxGate = GATE_OPEN;
  /** the backend instance that explained its failure (its exit isn't a crash) */
  private failedInstance: number | null = null;
  /** asked while that backend was still exiting: start once it's gone */
  private startOnExit = false;
  private skipNext = false;

  constructor(private readonly deps: MailboxHostDeps) {}

  get gate(): MailboxGate {
    return this.current;
  }

  private set(gate: MailboxGate): void {
    this.current = gate;
    this.deps.publish(gate);
  }

  /** Before every backend start: a restore a crash cut short is settled first. Returns the init's one-shot flags. */
  beforeStart(): { skipBackup?: true } {
    try {
      const outcome = reconcileRestore(this.deps.dbPath(), this.deps.restore);
      if (outcome) this.deps.log("mailbox.restore_reconciled", { outcome });
    } catch (error) {
      this.deps.log("mailbox.restore_failed", { errorClass: error instanceof Error ? error.name : "Error", errno: (error as { code?: string }).code });
    }
    const skip = this.skipNext;
    this.skipNext = false;
    return skip ? { skipBackup: true } : {};
  }

  /** The backend's progress: upgrading, then open. */
  reported(gate: MailboxGate): void {
    this.set(gate);
  }

  /** The backend explained why the mailbox can't open; it exits next. */
  failed(instance: number, gate: MailboxGate): void {
    this.failedInstance = instance;
    this.set(gate);
  }

  /** A backend exited. True when it was one that explained itself: no restart, no crash report. */
  exited(instance: number): boolean {
    if (instance !== this.failedInstance) return false;
    this.failedInstance = null;
    if (this.startOnExit) {
      this.startOnExit = false;
      this.deps.start();
    }
    return true;
  }

  private startFresh(): void {
    if (this.failedInstance !== null && this.deps.alive()) this.startOnExit = true;
    else if (!this.deps.alive()) this.deps.start();
  }

  /** "Try Again" (the disk was freed, a file was fixed, or just once more). */
  retry(): boolean {
    if (this.current.kind === "open" || this.current.kind === "upgrading" || this.current.kind === "restoring") return false;
    this.startFresh();
    return true;
  }

  /** "Update Without a Backup": only where the backup is what failed or doesn't fit; for the next start only. */
  skipBackup(): boolean {
    const g = this.current;
    const allowed = (g.kind === "no-room" && g.stage === "backup" && g.canSkipBackup) || (g.kind === "failed" && g.reason === "backup");
    if (!allowed) return false;
    this.skipNext = true;
    this.startFresh();
    return true;
  }

  /** "Restore": a damaged mailbox only, with a backup, while no backend holds the file. */
  async restore(): Promise<boolean> {
    const g = this.current;
    if (g.kind !== "failed" || g.reason !== "corrupt" || !g.backup || this.deps.alive()) return false;
    const db = this.deps.dbPath();
    const backup = listBackups(join(db, "..", "backups"))[0];
    if (!backup) {
      this.set({ ...g, backup: null, restoreFailed: "failed" });
      return false;
    }
    this.set({ kind: "restoring" });
    const at = this.deps.now();
    try {
      await restoreFromBackup(db, backup, this.deps.restore);
      this.deps.log("mailbox.restored", { durationMs: this.deps.now() - at });
    } catch (error) {
      this.deps.log("mailbox.restore_failed", { errorClass: error instanceof Error ? error.name : "Error", errno: ((error as { cause?: { code?: string } }).cause ?? {}).code });
      this.set({ ...g, restoreFailed: error instanceof RestoreError && error.kind === "no-room" ? "no-room" : "failed" });
      return false;
    }
    this.deps.start();
    return true;
  }
}
