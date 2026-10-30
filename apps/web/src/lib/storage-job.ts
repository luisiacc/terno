import type { RemovableBucket, StorageAge } from "@terno/core";
import { create } from "zustand";

/**
 * Plan 69: a storage removal running in this window (its percent), so nothing that would cut it short is offered
 * meanwhile (Codex R11); `finished` counts the ones done, so whichever Storage tab is open measures again (Codex code
 * review #7: the one that started it may be gone). What was chosen to remove stays while the window is open: a look
 * at another tab doesn't lose it.
 */
export const useStorageJob = create<{ removing: boolean; percent: number; finished: number; age: StorageAge; picked: ReadonlySet<RemovableBucket> }>(() => ({
  removing: false,
  percent: 0,
  finished: 0,
  age: 365,
  picked: new Set(["spam", "trash"]),
}));
