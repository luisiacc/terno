/** Pending reconciliation may persist progress, but only a phase-free history row completes coverage. */
export function completedGmailCursors(cursors: readonly unknown[]): unknown[] {
  return cursors.filter((value) => value !== null && typeof value === "object"
    && "historyId" in value && !("reconciliation" in value));
}
