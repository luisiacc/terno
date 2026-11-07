import { create } from "zustand";

/** What Send found wrong with a recipient field: said at that field, gone when the field changes or the form closes (plan 158). */
export interface SendProblem {
  key: string;
  field: "to" | "cc" | "bcc";
  message: string;
}

export const useSendProblem = create<{ problem: SendProblem | null }>(() => ({ problem: null }));

export function clearSendProblem(key: string): void {
  if (useSendProblem.getState().problem?.key === key) useSendProblem.setState({ problem: null });
}
