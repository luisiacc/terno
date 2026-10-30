import { create } from "zustand";

/** Plan 69: a storage removal running in this window (its percent), so nothing that would cut it short is offered meanwhile (Codex R11). */
export const useStorageJob = create<{ removing: boolean; percent: number }>(() => ({ removing: false, percent: 0 }));
