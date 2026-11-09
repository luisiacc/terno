import { create } from "zustand";

/** What Send found wrong with a recipient field: said at that field, gone when the field changes or the form closes (plan 158). */
export interface SendProblem {
  key: string;
  field: "to" | "cc" | "bcc";
  message: string;
  /** each refusal's own: the message is said again (and shown again) on every Send, not only the first */
  seq: number;
}

export const useSendProblem = create<{ problem: SendProblem | null }>(() => ({ problem: null }));

export function clearSendProblem(key: string): void {
  if (useSendProblem.getState().problem?.key === key) useSendProblem.setState({ problem: null });
}

let refusals = 0;
export function sayProblem(problem: Omit<SendProblem, "seq">): void {
  useSendProblem.setState({ problem: { ...problem, seq: ++refusals } });
}

/**
 * Plan 158: Send found no message (nothing written, nothing attached): it asks once, at the action row, before anything
 * is saved or sent; Send again (the question's, the button, ⌘↵) sends, Cancel or typing puts it away. `sendAt`: what Send
 * later asked for.
 */
export const useEmptySend = create<{ key: string | null; sendAt?: number; /** plan 162 (after ai162-r04): what it asks about: no message, or a note for AI that would go as the email */ reason?: "empty" | "note" }>(() => ({ key: null }));

export function clearEmptySend(key: string): void {
  if (useEmptySend.getState().key === key) useEmptySend.setState({ key: null, sendAt: undefined, reason: undefined });
}

/** Esc in the composer while it asks: the question goes, and nothing else (the composer stays). True when it was asking. */
export function cancelEmptySend(key: string): boolean {
  if (useEmptySend.getState().key !== key) return false;
  clearEmptySend(key);
  return true;
}
