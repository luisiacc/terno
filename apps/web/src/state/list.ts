import type { ThreadSummary } from "@unica/core";
import { RpcError } from "@unica/core/rpc";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "./app";

interface ListState {
  key: string;
  items: ThreadSummary[];
  index: Map<number, number>;
  nextCursor: { lastDate: number; id: number } | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  searchMs: number | null;
  complete: boolean;
}

export const PAGE = 100;

export const useList = create<ListState>(() => ({
  key: "",
  items: [],
  index: new Map(),
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
  searchMs: null,
  complete: true,
}));

function indexOf(items: ThreadSummary[]): Map<number, number> {
  return new Map(items.map((t, i) => [t.id, i]));
}

export function listKey(): string {
  const s = getApp();
  return JSON.stringify([s.view, s.accountId, s.categoryId, s.query.trim()]);
}

let seq = 0;

async function fetchPage(cursor?: { lastDate: number; id: number }, limit = PAGE) {
  const s = getApp();
  const scope = { accountId: s.accountId ?? undefined, categoryId: s.categoryId ?? undefined };
  const q = s.query.trim();
  if (q) {
    // the sidebar view scopes the search unless the query says otherwise (in:…)
    const query = /(^|\s)(in|en):/.test(q) || s.view === "all" ? q : `in:${s.view} ${q}`;
    return client.call("threads.search", { query, cursor, limit, ...scope });
  }
  return client.call("threads.list", { view: s.view, cursor, limit, ...scope });
}

/** (Re)loads the first page for the current view/search. Latest call wins. */
export async function reloadList(options: { keepSelection?: boolean } = {}): Promise<void> {
  const key = listKey();
  const mine = ++seq;
  const current = useList.getState();
  const sameView = current.key === key;
  if (!sameView) useList.setState({ key, loading: true, error: null });
  // keep as many rows as are loaded so a background refresh doesn't shrink the list
  const limit = sameView ? Math.min(Math.max(PAGE, current.items.length), 500) : PAGE;
  try {
    const page = await fetchPage(undefined, limit);
    if (mine !== seq) return;
    useList.setState({
      key,
      items: page.items,
      index: indexOf(page.items),
      nextCursor: page.nextCursor,
      loading: false,
      error: null,
      searchMs: "tookMs" in page ? (page.tookMs as number) : null,
      complete: "complete" in page ? (page.complete as boolean) : true,
    });
    const s = getApp();
    if (!options.keepSelection && !sameView) setApp({ selectedId: page.items[0]?.id ?? null });
    else if (s.selectedId !== null && !page.items.some((t) => t.id === s.selectedId)) {
      // selected thread left this view (archived elsewhere): keep reader stable by not auto-jumping
    }
  } catch (error) {
    if (error instanceof RpcError && error.code === "CANCELLED") return;
    if (mine !== seq) return;
    useList.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function loadMore(): Promise<void> {
  const st = useList.getState();
  if (!st.nextCursor || st.loadingMore) return;
  const key = st.key;
  useList.setState({ loadingMore: true });
  try {
    const page = await fetchPage(st.nextCursor);
    if (useList.getState().key !== key) return;
    const seen = new Set(useList.getState().items.map((t) => t.id));
    const items = [...useList.getState().items, ...page.items.filter((t) => !seen.has(t.id))];
    useList.setState({ items, index: indexOf(items), nextCursor: page.nextCursor, loadingMore: false });
  } catch {
    useList.setState({ loadingMore: false });
  }
}

/** Optimistic local edit of rows (actions apply instantly, then the backend confirms). */
export function patchRows(ids: readonly number[], patch: (t: ThreadSummary) => ThreadSummary | null): void {
  const set = new Set(ids);
  const items = useList.getState().items.flatMap((t) => {
    if (!set.has(t.id)) return [t];
    const next = patch(t);
    return next ? [next] : [];
  });
  useList.setState({ items, index: indexOf(items) });
}
