/**
 * Plan 225: conversations whose read state the user just set by hand (Mark as read, Mark as unread, from a key, a menu or
 * the palette). A showing under way leaves them as set (`read-on-show`). Its own module so both sides import it without
 * importing each other.
 */
const listeners = new Set<(ids: readonly number[]) => void>();

export function readSetByHand(ids: readonly number[]): void {
  for (const listener of listeners) listener(ids);
}

export function onReadSetByHand(listener: (ids: readonly number[]) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
