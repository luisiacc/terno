import { client } from "~/rpc/connection";
import { create } from "zustand";
import { getApp, setApp, useApp, type AppState } from "./app";
import { reloadList, useList } from "./list";

/**
 * Plan 143: a sentence's preview, a list of its own. What's here is small enough for the entry chunk: which rows are
 * unticked, and the way back to where you were. The rest of it comes with its header.
 */
type From = Pick<AppState, "view" | "accountId" | "categoryId" | "reviewCategoryId" | "folder" | "gmailTab" | "reminders" | "followups" | "query" | "selectedId" | "readerOpen"> & {
  scrollTop: number;
  /** the rows you were among, however deep: scroll can't come back to a place the list doesn't hold yet */
  rows: Pick<ReturnType<typeof useList.getState>, "key" | "itemsKey" | "items" | "index" | "nextCursor">;
};

interface ActionRows {
  unticked: ReadonlySet<number>;
  showLeftOut: boolean;
  from: From | null;
}

export const useActionRows = create<ActionRows>(() => ({ unticked: new Set(), showLeftOut: false, from: null }));

/** Rows the backend says aren't ticked, as a page of them arrives. */
export function noteRows(ids: readonly number[], unticked: readonly number[]): void {
  const off = new Set(unticked);
  useActionRows.setState((s) => {
    const next = new Set(s.unticked);
    for (const id of ids) if (off.has(id)) next.add(id);
    else next.delete(id);
    return { unticked: next };
  });
}

const listEl = () => document.querySelector<HTMLElement>('[data-keep-scroll="list"]');

export function enterPreview(previewId: string): void {
  const s = getApp();
  const { key, itemsKey, items, index, nextCursor } = useList.getState();
  useActionRows.setState({
    unticked: new Set(),
    showLeftOut: false,
    from: { view: s.view, accountId: s.accountId, categoryId: s.categoryId, reviewCategoryId: s.reviewCategoryId, folder: s.folder, gmailTab: s.gmailTab, reminders: s.reminders, followups: s.followups, query: s.query, selectedId: s.selectedId, readerOpen: s.readerOpen, scrollTop: listEl()?.scrollTop ?? 0, rows: { key, itemsKey, items, index, nextCursor } },
  });
  setApp({ actionPreview: previewId, view: "all", accountId: null, categoryId: null, reviewCategoryId: null, folder: null, gmailTab: null, reminders: false, followups: false, query: "", selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
  // from the top: a place deep in the last list means nothing in this one
  const el = listEl();
  if (el) el.scrollTop = 0;
}

/** Back to the list and scroll position you left, with no trace. */
export function leavePreview(): void {
  const { from } = useActionRows.getState();
  if (!getApp().actionPreview) return;
  useActionRows.setState({ unticked: new Set(), from: null });
  if (!from) return setApp({ actionPreview: null });
  const { scrollTop, rows, ...place } = from;
  useList.setState({ ...rows, loading: false, loadingMore: false, error: null });
  setApp({ ...place, actionPreview: null, checked: new Set(), anchorId: null, scope: null });
  // what changed while away comes in place, over the same window
  void reloadList({ keepSelection: true, window: true });
  // once those rows have rendered
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = listEl();
      if (el) el.scrollTop = scrollTop;
    }),
  );
}

/** `x` and a row's check: this row in or out. Multi-select is off here (revision 3). */
export function toggleRow(threadId: number): void {
  const previewId = getApp().actionPreview;
  if (!previewId) return;
  const on = useActionRows.getState().unticked.has(threadId);
  useActionRows.setState((s) => {
    const next = new Set(s.unticked);
    if (on) next.delete(threadId);
    else next.add(threadId);
    return { unticked: next };
  });
  void client.call("ai.actionToggle", { previewId, threadId, included: on }).then(
    (preview) => rowsToggled.current?.(preview),
    () => {},
  );
}

/** The header, once it's loaded, hears the new count. */
export const rowsToggled: { current: ((preview: import("@terno/core").ActionPreviewInfo) => void) | null } = { current: null };

// whatever took the list elsewhere, the backend lets go of the preview too
useApp.subscribe((s, prev) => {
  if (!prev.actionPreview || s.actionPreview === prev.actionPreview) return;
  void client.call("ai.actionCancel", { previewId: prev.actionPreview }).catch(() => {});
  // the rows it kept to come back to hold mail: nothing keeps them once it's over, however it ended
  if (!s.actionPreview) useActionRows.setState({ from: null, unticked: new Set() });
});
