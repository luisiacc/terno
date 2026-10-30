import { codeExpiry, codeFresh, findCode, type ThreadSummary } from "@terno/core";
import { t } from "@terno/i18n";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { snack } from "./snack";

/** How long the check shows after a copy. */
export const COPIED_MS = 5000;
const USED_MAX = 200;

/**
 * Verification codes in the list (plan 69). A code is keyed by its thread and itself (a newer code in the same
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

/** Copies a code: the check shows for COPIED_MS, then the chip settles outlined. False when the clipboard refused (said in a snack). */
export function copyCode(key: string, code: string): Promise<boolean> {
  return navigator.clipboard.writeText(code).then(
    () => {
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
 * The code a thread offers now: its newest message at most two hours old, read from the snippet (the newest
 * message's) and the subject. The subject is the first message's, so it counts only while that is the only one: a
 * reply must not bring back the original's code.
 */
export function threadCode(thread: Pick<ThreadSummary, "subject" | "snippet" | "lastDate" | "messageCount">, now: number): string | null {
  return codeFresh(thread.lastDate, now) ? codeOf(thread) : null;
}

const codeOf = (thread: Pick<ThreadSummary, "subject" | "snippet" | "messageCount">) => findCode(thread.messageCount > 1 ? "" : thread.subject, thread.snippet);

/**
 * A row's code. Older threads cost one subtraction per render; a fresh one is read once (memoized) and one timer, set
 * to the exact expiry, takes the chip away. Nothing runs while idle.
 */
export function useThreadCode(thread: ThreadSummary): string | null {
  // the clock is read again when newer mail arrives: a row on screen for a while must not see it as old
  const [clock, setClock] = useState(() => ({ now: Date.now(), date: thread.lastDate }));
  if (clock.date !== thread.lastDate) setClock({ now: Date.now(), date: thread.lastDate });
  const fresh = codeFresh(thread.lastDate, clock.date === thread.lastDate ? clock.now : Date.now());
  const code = useMemo(() => (fresh ? codeOf(thread) : null), [fresh, thread.subject, thread.snippet, thread.messageCount]);
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
