import { create } from "zustand";
import type { DropId, DropState } from "~/lib/drag";

/**
 * Drag-and-drop state React needs: which sidebar target is under the pointer
 * and how it would take the drop. Updated only when the target changes, and
 * read by NavItems through per-item selectors, so a target change re-renders
 * the two items involved and nothing else (rows never subscribe).
 */
export interface DragState {
  phase: "idle" | "dragging";
  ids: readonly number[];
  overTarget: DropId | null;
  overState: DropState | null;
}

export const useDrag = create<DragState>(() => ({ phase: "idle", ids: [], overTarget: null, overState: null }));

/** A NavItem's own drop state (null unless it is the target). */
export const useDropState = (target: DropId | undefined) => useDrag((s) => (target !== undefined && s.overTarget === target ? s.overState : null));
