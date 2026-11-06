import { getApp } from "~/state/app";

/**
 * Plan 144 revision 9: a conversation the user opened and stayed on, once, for everyone who waits on that: a click,
 * Enter, j/k or a notification, not a reload's first-row pick or the move after an archive. Each listener gets the
 * thread when the dwell ends, if it's still the one on screen. A listener takes its own snapshot at `opened` to compare
 * with what it finds at `settled`.
 */
export const OPEN_DWELL_MS = 450;

/** Told by the page module: importing it from here would tie this to the whole list, whose rows listen here. */
export const dwellOn: { shown: () => boolean } = { shown: () => true };

export interface OpenListener {
  /** at the open: what to remember, or null to sit this one out */
  opened(id: number): unknown;
  settled(id: number, seen: unknown): void;
}

const listeners = new Set<OpenListener>();
const opening: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

export function onExplicitOpen(listener: OpenListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The user opened this conversation. Only ever from an explicit path. */
export function noteExplicitOpen(id: number): void {
  if (opening.timer) clearTimeout(opening.timer);
  opening.timer = null;
  const seen = [...listeners].flatMap((listener) => {
    const snapshot = listener.opened(id);
    return snapshot === null ? [] : [{ listener, snapshot }];
  });
  if (!seen.length) return;
  opening.timer = setTimeout(() => {
    opening.timer = null;
    if (getApp().selectedId !== id || !dwellOn.shown()) return;
    for (const { listener, snapshot } of seen) listener.settled(id, snapshot);
  }, OPEN_DWELL_MS);
}
