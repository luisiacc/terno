import { create } from "zustand";

/**
 * Plan 295: "Show original", per message, for the session: a designed mail the dark theme rewrote goes back to the
 * colors it was written in, on its paper, until "Match theme" (or the next session).
 */
export const useMailOriginal = create<{ shown: ReadonlySet<number> }>(() => ({ shown: new Set() }));

export function showOriginal(messageId: number, original: boolean): void {
  const { shown } = useMailOriginal.getState();
  if (shown.has(messageId) === original) return;
  const next = new Set(shown);
  if (original) next.add(messageId);
  else next.delete(messageId);
  useMailOriginal.setState({ shown: next });
}
