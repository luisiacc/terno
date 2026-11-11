/**
 * A reply just sent from a thread: the reader scrolls to its copy, by id (the
 * send names it). The copy may already show (the thread's change can beat the
 * send's answer): then at once; else when it arrives, if it does within a few
 * seconds (a forward that started another thread never shows here).
 */
const WAIT_MS = 10_000;
const awaiting = new Map<number, number>();
/** how the reader reveals a message, set by its scroll module (kept out of the send path's imports) */
const reader = { reveal: null as ((id: number) => void) | null };

export function setSentRevealer(reveal: (id: number) => void): void {
  reader.reveal = reveal;
}

export function revealSent(messageId: number): void {
  const now = performance.now();
  for (const [id, until] of awaiting) if (until <= now) awaiting.delete(id);
  if (reader.reveal && typeof document !== "undefined" && document.querySelector(`[data-reader-scroller] article[data-message-id="${messageId}"]`)) reader.reveal(messageId);
  else awaiting.set(messageId, now + WAIT_MS);
}

/** The newest of these just-shown messages that a send asked to reveal (each once). */
export function takeSent(ids: number[]): number | null {
  let found: number | null = null;
  for (const id of ids) {
    const until = awaiting.get(id);
    if (until === undefined) continue;
    awaiting.delete(id);
    if (until > performance.now()) found = id;
  }
  return found;
}
