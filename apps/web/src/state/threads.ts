import type { ThreadDetail } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp } from "./app";

const MAX = 150;

interface ThreadCache {
  details: Map<number, ThreadDetail>;
  version: number;
}

export const useThreads = create<ThreadCache>(() => ({ details: new Map(), version: 0 }));
// each fetch is numbered: an answer older than the newest fetch, or than the last change, can't pass for current
let seq = 0;
const inflight = new Map<number, { p: Promise<ThreadDetail | null>; n: number }>();
const newest = new Map<number, number>();
/** cached threads that changed after their fetch (the open one, still on screen): the next load refetches them */
const staleSince = new Map<number, number>();

function put(detail: ThreadDetail): void {
  const details = new Map(useThreads.getState().details);
  details.delete(detail.thread.id);
  details.set(detail.thread.id, detail);
  while (details.size > MAX) {
    const evicted = details.keys().next().value as number;
    details.delete(evicted);
    staleSince.delete(evicted);
  }
  useThreads.setState((s) => ({ details, version: s.version + 1 }));
}

export function loadThread(id: number, force = false): Promise<ThreadDetail | null> {
  if (!force) {
    const cached = useThreads.getState().details.get(id);
    if (cached && !staleSince.has(id)) return Promise.resolve(cached);
    const pending = inflight.get(id);
    if (pending && pending.n > (staleSince.get(id) ?? 0)) return pending.p;
  }
  const n = ++seq;
  newest.set(id, n);
  const p = client
    .call("threads.get", { threadId: id })
    .then((d) => {
      if (newest.get(id) !== n) return d;
      put(d);
      if (n > (staleSince.get(id) ?? Infinity)) staleSince.delete(id);
      return d;
    })
    .catch(() => null)
    .finally(() => {
      if (inflight.get(id)?.p === p) inflight.delete(id);
      if (newest.get(id) === n) newest.delete(id);
      if (!inflight.has(id) && !useThreads.getState().details.has(id)) staleSince.delete(id);
    });
  inflight.set(id, { p, n });
  return p;
}

/**
 * Threads that changed. The open one stays on screen as it is (blanking it
 * would remount the reader and lose focus, caret and scroll) and the next
 * load replaces it; the rest drop so their next view refetches them.
 */
export function invalidateThreads(ids: readonly number[]): void {
  const open = getApp().selectedId;
  const details = useThreads.getState().details;
  const at = ++seq;
  // a fetch already on its way may have read the thread before this change
  for (const id of ids) if (inflight.has(id)) staleSince.set(id, at);
  if (open !== null && details.has(open) && ids.includes(open)) staleSince.set(open, at);
  if (!ids.some((id) => id !== open && details.has(id))) return;
  const next = new Map(details);
  for (const id of ids) if (id !== open) next.delete(id);
  useThreads.setState((s) => ({ details: next, version: s.version + 1 }));
}

export function useThread(id: number | null): ThreadDetail | undefined {
  return useThreads((s) => (id === null ? undefined : s.details.get(id)));
}
