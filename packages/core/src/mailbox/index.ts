/**
 * Plan 95: the mailbox gate, what the desktop window shows while the
 * mailbox can't be used: being upgraded (a backup, then the migration), not
 * enough disk, a step that failed, a file that's damaged or can't be
 * written, one from a newer Terno, a restore in progress. Main owns it (the
 * backend reports, main decides about restarts) and pushes it to every
 * window; the window only draws it and asks.
 */

/** The backup an upgrade made of the mailbox as it was (enough to name it in a sentence). */
export interface BackupSummary {
  createdAt: number;
  /** the Terno that made it, i.e. the version the user was updating to */
  appVersion: string;
  fromSchema: number;
}

export type OpenFailureReason = "migration" | "corrupt" | "unwritable" | "backup";

export type MailboxGate =
  /** usable; `restoredFrom` once after a restore (the window says what changed) */
  | { kind: "open"; restoredFrom: number | null }
  | { kind: "upgrading"; phase: "backup" | "migrate"; from: number; to: number }
  /** the numbers are estimates when the stage is "migrate"; canSkipBackup: only the backup doesn't fit */
  | { kind: "no-room"; stage: "backup" | "migrate"; needBytes: number; freeBytes: number; canSkipBackup: boolean }
  /** `restoreFailed`: a restore was tried and didn't happen (the mailbox is as it was) */
  | { kind: "failed"; reason: OpenFailureReason; step: number | null; backup: BackupSummary | null; restoreFailed: "no-room" | "failed" | null }
  | { kind: "newer"; schema: number; supported: number }
  | { kind: "restoring" };

export const GATE_OPEN: MailboxGate = { kind: "open", restoredFrom: null };

/** The window covers itself for every gate but an open mailbox. */
export function gateBlocks(gate: MailboxGate | null): boolean {
  return gate !== null && gate.kind !== "open";
}
