import type { ReminderInfo } from "@terno/core/rpc";
import { create } from "zustand";

/** Plan 87: the backend's last reminders snapshot (lib/reminders keeps it and acts on it). No imports of the app: the list reads it. */
interface RemindersState {
  byThread: ReadonlyMap<number, ReminderInfo>;
  /** how many are due (the sidebar's number) */
  due: number;
  loaded: boolean;
}

export const useReminders = create<RemindersState>(() => ({ byThread: new Map(), due: 0, loaded: false }));

/** Is anything due (the Inbox's first page asks for its top only then; the first snapshot reloads it if it came later) */
export function anyDue(): boolean {
  return useReminders.getState().due > 0;
}
