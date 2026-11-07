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
