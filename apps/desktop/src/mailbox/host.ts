/**
 * Plan 95: main's side of the mailbox gate. The backend reports where the
 * mailbox stands (being migrated, open, or a failure the window explains);
 * this keeps the latest, pushes it to every window, and answers the
 * window's ask: Try Again. There is no backup to restore (plan 255).
 *
 * A failure the backend explained ends that process and is never restarted
 * on a timer: retrying a step that failed five times only delays the
 * screen. Everything else (a crash) keeps the restart policy. Electron
 * comes in as deps, so this is tested in Node.
 */
import { GATE_OPEN, type MailboxGate } from "@terno/core/mailbox";

export interface MailboxHostDeps {
  publish(gate: MailboxGate): void;
  /** a fresh backend (a new series of restart attempts) and the windows connected to it */
  start(): void;
  /** a backend process exists (running, or exiting after a failure it explained) */
  alive(): boolean;
}

export class MailboxHost {
  private current: MailboxGate = GATE_OPEN;
  /** the backend instance that explained its failure (its exit isn't a crash) */
  private failedInstance: number | null = null;
  /** asked while that backend was still exiting: start once it's gone */
  private startOnExit = false;

  constructor(private readonly deps: MailboxHostDeps) {}

  get gate(): MailboxGate {
    return this.current;
  }

  private set(gate: MailboxGate): void {
    this.current = gate;
    this.deps.publish(gate);
  }

  /** The backend's progress: migrating, then open. */
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
    if (instance !== this.failedInstance) {
      // a crash mid-upgrade isn't still upgrading: the gate steps aside for the restart policy (and, if it gives up,
      // the stopped-engine screen with its Try Again) (Codex review R6)
      if (this.current.kind === "upgrading") this.set(GATE_OPEN);
      return false;
    }
    this.failedInstance = null;
    if (this.startOnExit) {
      this.startOnExit = false;
      this.deps.start();
    }
    return true;
  }

  /** "Try Again" (the disk was freed, a file was fixed, or just once more). */
  retry(): boolean {
    if (this.current.kind === "open" || this.current.kind === "upgrading") return false;
    if (this.failedInstance !== null && this.deps.alive()) this.startOnExit = true;
    else if (!this.deps.alive()) this.deps.start();
    return true;
  }
}
