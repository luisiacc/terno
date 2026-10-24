import type { ThreadDetail } from "@terno/core";
import { create } from "zustand";
import { client } from "~/rpc/connection";

const MAX = 150;

interface ThreadCache {
  details: Map<number, ThreadDetail>;
  version: number;
}

export const useThreads = create<ThreadCache>(() => ({ details: new Map(), version: 0 }));
const inflight = new Map<number, Promise<ThreadDetail | null>>();

function put(detail: ThreadDetail): void {
  const details = new Map(useThreads.getState().details);
  details.delete(detail.thread.id);
  details.set(detail.thread.id, detail);
  while (details.size > MAX) details.delete(details.keys().next().value as number);
  useThreads.setState((s) => ({ details, version: s.version + 1 }));
}

export function loadThread(id: number, force = false): Promise<ThreadDetail | null> {
  if (!force) {
    const cached = useThreads.getState().details.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(id);
    if (pending) return pending;
  }
  const p = client
    .call("threads.get", { threadId: id })
    .then((d) => {
      put(d);
      return d;
    })
    .catch(() => null)
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Drops cached threads that changed so the next view refetches them. */
export function invalidateThreads(ids: readonly number[]): void {
  const details = useThreads.getState().details;
  if (!ids.some((id) => details.has(id))) return;
  const next = new Map(details);
  for (const id of ids) next.delete(id);
  useThreads.setState((s) => ({ details: next, version: s.version + 1 }));
}

export function useThread(id: number | null): ThreadDetail | undefined {
  return useThreads((s) => (id === null ? undefined : s.details.get(id)));
}
