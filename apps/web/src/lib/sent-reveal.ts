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

/** Plan 158: a send held for its Undo has no message yet: the reader goes to the copy that arrives in this conversation. */
const awaitingIn = new Map<number, number>();
export function revealHeldSend(threadId: number, holdMs: number): void {
  const now = performance.now();
  for (const [id, until] of awaitingIn) if (until <= now) awaitingIn.delete(id);
  awaitingIn.set(threadId, now + holdMs + WAIT_MS);
}
export const forgetHeldSend = (threadId: number): void => void awaitingIn.delete(threadId);
/** The newest of these just-shown messages, if it's the copy of a held send (once). */
export function takeHeldSent(messages: readonly { id: number; threadId: number; isSent: boolean }[]): number | null {
  const sent = messages.findLast((m) => m.isSent && awaitingIn.has(m.threadId));
  if (!sent) return null;
  const until = awaitingIn.get(sent.threadId)!;
  awaitingIn.delete(sent.threadId);
  return until > performance.now() ? sent.id : null;
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
