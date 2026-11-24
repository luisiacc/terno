import { codeExpiry, codeFresh, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { useEffect, useState, useSyncExternalStore } from "react";
import { act, targetRows } from "./actions";
import { snack } from "./snack";

/** How long the check shows after a copy. */
export const COPIED_MS = 5000;
const USED_MAX = 200;

/**
 * Verification codes in the list (plan 72). A code is keyed by its thread and itself (a newer code in the same
 * thread is a new one). What was copied lives here, not in a row: rows come and go as the list scrolls, and the
 * chip and the thread menu copy the same code.
 */
const copying = new Map<string, ReturnType<typeof setTimeout>>();
/** copied once, oldest first: shown outlined from then on */
const used = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export const codeKey = (threadId: number, code: string): string => `${threadId}:${code}`;

/**
 * Copies a thread's code: the check shows for COPIED_MS, then the chip settles outlined. A copied code has been read, so an
 * unread thread is marked read, quietly, as reading it in the reader does (plan 225: no undo of its own, z still undoes the
 * last triage). False when the clipboard refused (said in a snack).
 */
export function copyCode(threadId: number, code: string): Promise<boolean> {
  const key = codeKey(threadId, code);
  return navigator.clipboard.writeText(code).then(
    () => {
      // read as it is now, not as the row or menu last drew it (a sync may have changed it meanwhile)
      if (targetRows([threadId]).some((t) => t.unread)) void act("markRead", [threadId], { quiet: true });
      clearTimeout(copying.get(key));
      copying.set(
        key,
        setTimeout(() => {
          copying.delete(key);
          used.delete(key);
          used.add(key);
          if (used.size > USED_MAX) used.delete(used.values().next().value!);
          notify();
        }, COPIED_MS),
      );
      notify();
      return true;
    },
    () => {
      snack.error(t("threadMenu.copyFailed"));
      return false;
    },
  );
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** One code's state: showing the check, and copied before. */
export function useCodeState(key: string): { copied: boolean; used: boolean } {
  const copied = useSyncExternalStore(subscribe, () => copying.has(key));
  const wasUsed = useSyncExternalStore(subscribe, () => used.has(key));
  return { copied, used: wasUsed };
}

/**
 * The code a thread offers now: its newest message's, while that is at most two hours old. The store found it in that
 * message's whole text and its own subject when the text arrived (plan 261), so a reply never brings back the original's.
 */
export function threadCode(thread: Pick<ThreadSummary, "code" | "lastDate">, now: number): string | null {
  return thread.code && codeFresh(thread.lastDate, now) ? thread.code : null;
}

/**
 * A row's code. A row without one costs nothing; a fresh one sets one timer, to the exact expiry, that takes the chip
 * away. Nothing runs while idle.
 */
export function useThreadCode(thread: ThreadSummary): string | null {
  // the clock is read again when newer mail arrives: a row on screen for a while must not see it as old
  const [clock, setClock] = useState(() => ({ now: Date.now(), date: thread.lastDate }));
  if (clock.date !== thread.lastDate) setClock({ now: Date.now(), date: thread.lastDate });
  const code = threadCode(thread, clock.date === thread.lastDate ? clock.now : Date.now());
  useEffect(() => {
    if (!code) return;
    const id = setTimeout(() => setClock({ now: Date.now(), date: thread.lastDate }), Math.max(0, codeExpiry(thread.lastDate) - Date.now()) + 1);
    return () => clearTimeout(id);
  }, [code, thread.lastDate]);
  return code;
}

/** Tests: forget every copy. */
export function resetCodes(): void {
  for (const id of copying.values()) clearTimeout(id);
  copying.clear();
  used.clear();
  notify();
}
