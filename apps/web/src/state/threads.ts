import type { ThreadDetail } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp } from "./app";
import { editCount, syncRow } from "./list";

const MAX = 150;

interface ThreadCache {
  details: Map<number, ThreadDetail>;
  /** threads the backend no longer has (deleted on the server): the reader says so instead of waiting */
  gone: ReadonlySet<number>;
  version: number;
}

export const useThreads = create<ThreadCache>(() => ({ details: new Map(), gone: new Set(), version: 0 }));
// each fetch is numbered: an answer older than the newest fetch, or than the last change, can't pass for current
let seq = 0;
const inflight = new Map<number, { p: Promise<ThreadDetail | null>; n: number }>();
const newest = new Map<number, number>();
/** cached threads that changed after their fetch (the open one, still on screen): the next load refetches them */
const staleSince = new Map<number, number>();

function put(detail: ThreadDetail): void {
  const id = detail.thread.id;
  const details = new Map(useThreads.getState().details);
  details.delete(id);
  details.set(id, detail);
  while (details.size > MAX) {
    const evicted = details.keys().next().value as number;
    details.delete(evicted);
    staleSince.delete(evicted);
  }
  useThreads.setState((s) => ({ details, gone: s.gone.has(id) ? new Set([...s.gone].filter((g) => g !== id)) : s.gone, version: s.version + 1 }));
}

function lost(id: number): void {
  staleSince.delete(id);
  const details = new Map(useThreads.getState().details);
  details.delete(id);
  useThreads.setState((s) => ({ details, gone: new Set([...s.gone, id].slice(-MAX)), version: s.version + 1 }));
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
  const since = editCount();
  const p = client
    .call("threads.get", { threadId: id })
    .then((d) => {
      if (newest.get(id) !== n) return d;
      put(d);
      // its row says what the conversation now says (List's page waits to refresh the list; actions read the row), unless an
      // optimistic edit landed after this fetch started
      syncRow(d.thread, since);
      if (n > (staleSince.get(id) ?? Infinity)) staleSince.delete(id);
      return d;
    })
    .catch((error: unknown) => {
      // a passing failure keeps what is on screen (the next load tries again); a thread that is gone stops being shown
      if (error instanceof RpcError && error.code === "NOT_FOUND" && newest.get(id) === n) lost(id);
      return null;
    })
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
  // a fetch already on its way may have read the thread before this change; a dropped one needs no mark
  for (const id of ids) {
    if (inflight.has(id) || (id === open && details.has(id))) staleSince.set(id, at);
    else staleSince.delete(id);
  }
  if (!ids.some((id) => id !== open && details.has(id))) return;
  const next = new Map(details);
  for (const id of ids) if (id !== open) next.delete(id);
  useThreads.setState((s) => ({ details: next, version: s.version + 1 }));
}

export function useThread(id: number | null): ThreadDetail | undefined {
  return useThreads((s) => (id === null ? undefined : s.details.get(id)));
}

/** How many threads carry a stale mark (the unit tests bound it). */
export function staleMarksForTests(): number {
  return staleSince.size;
}

/** The thread is gone from the backend (and not on screen any more). */
export function useThreadGone(id: number | null): boolean {
  return useThreads((s) => id !== null && s.gone.has(id));
}
