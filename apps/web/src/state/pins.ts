import { create } from "zustand";

/** Plan 177: the pinned conversations, as the backend last said (lib/pins keeps it and acts on it). No imports of the app: rows read it. */
interface PinsState {
  ids: ReadonlySet<number>;
  loaded: boolean;
}

export const usePins = create<PinsState>(() => ({ ids: new Set(), loaded: false }));

/** Is anything pinned (the Inbox's first page asks for its pinned rows only then; the first snapshot reloads it if it came later) */
export function anyPinned(): boolean {
  return usePins.getState().ids.size > 0;
}

export const isPinned = (id: number): boolean => usePins.getState().ids.has(id);
