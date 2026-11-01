import type { SyncProgress } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 103: each account's live sync progress, from the `syncProgress` event (at most every 2 s an account). Its own
 * store: only the sync card reads it, so nothing else re-renders as a sync goes on. An account not here shows the
 * progress its syncState saved (a window opened meanwhile).
 */
export const useSyncProgress = create<{ byAccount: ReadonlyMap<number, SyncProgress | null> }>(() => ({ byAccount: new Map() }));

export function setSyncProgress(accountId: number, progress: SyncProgress | null): void {
  useSyncProgress.setState((s) => ({ byAccount: new Map(s.byAccount).set(accountId, progress) }));
}
