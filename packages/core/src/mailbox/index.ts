/**
 * Plan 95: the mailbox gate, what the desktop window shows while the
 * mailbox can't be used: a migration past its first moments, not enough
 * disk, a step that failed, a file that's damaged or can't be written, one
 * from a newer Terno. Main owns it (the backend reports, main decides about
 * restarts) and pushes it to every window; the window only draws it and
 * asks. There is no backup before a migration (plan 255).
 */

export type OpenFailureReason = "migration" | "corrupt" | "unwritable";

export type MailboxGate =
  | { kind: "open" }
  | { kind: "upgrading"; from: number; to: number }
  /** the numbers are estimates */
  | { kind: "no-room"; needBytes: number; freeBytes: number }
  | { kind: "failed"; reason: OpenFailureReason; step: number | null }
  | { kind: "newer"; schema: number; supported: number };

export const GATE_OPEN: MailboxGate = { kind: "open" };

/** The window covers itself for every gate but an open mailbox. */
export function gateBlocks(gate: MailboxGate | null): boolean {
  return gate !== null && gate.kind !== "open";
}
