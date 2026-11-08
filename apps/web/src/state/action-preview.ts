import type { ActionPreviewInfo } from "@terno/core";
import { client } from "~/rpc/connection";
import { focusIntent } from "~/lib/focus-intent";
import type { SendersNamed } from "~/lib/rule-words";
import { create } from "zustand";
import { getApp, setApp, useApp, type AppState } from "./app";
import { reloadList, useList } from "./list";

/**
 * Plan 143: a sentence's preview, a list of its own. What's here: which rows are unticked, and the way back to where you
 * were. The rest of it is in `lib/action-preview.ts`.
 */
type From = Pick<AppState, "view" | "accountId" | "categoryId" | "reviewCategoryId" | "folder" | "gmailTab" | "reminders" | "followups" | "today" | "query" | "selectedId" | "readerOpen"> & {
  scrollTop: number;
  /** the rows you were among, however deep: scroll can't come back to a place the list doesn't hold yet */
  rows: Pick<ReturnType<typeof useList.getState>, "key" | "itemsKey" | "items" | "index" | "nextCursor">;
};

interface ActionRows {
  unticked: ReadonlySet<number>;
  showLeftOut: boolean;
  from: From | null;
}

/** Plan 143: the preview's header state and what it asks of the backend. */
interface ActionPreviewState {
  preview: ActionPreviewInfo | null;
  /** plan 161: the words the user typed, echoed back over what Terno made of them */
  sentence: string;
  future: boolean;
  checking: boolean;
  consent: { provider: string; endpoint: string | null; destination: string } | null;
  checkError: string | null;
  applying: boolean;
  /** plan 161: the senders the sentence names for certain (its addresses and domains, the names the mailbox has); null until known */
  senders: SendersNamed | null;
}

export const useActionPreview = create<ActionPreviewState>(() => ({ preview: null, sentence: "", future: false, checking: false, consent: null, checkError: null, applying: false, senders: null }));

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

/**
 * Into the preview's own list. Plan 161: its rows go at once (the skeleton shows until the preview's first page), so the
 * mailbox you were in is never drawn ticked under a count it isn't; and the sidebar shows where the rule looks.
 */
export function enterPreview(previewId: string, view: "inbox" | "all" = "all"): void {
  const s = getApp();
  const { key, itemsKey, items, index, nextCursor } = useList.getState();
  useActionRows.setState({
    unticked: new Set(),
    showLeftOut: false,
    from: { view: s.view, accountId: s.accountId, categoryId: s.categoryId, reviewCategoryId: s.reviewCategoryId, folder: s.folder, gmailTab: s.gmailTab, reminders: s.reminders, followups: s.followups, today: s.today, query: s.query, selectedId: s.selectedId, readerOpen: s.readerOpen, scrollTop: listEl()?.scrollTop ?? 0, rows: { key, itemsKey, items, index, nextCursor } },
  });
  // the place it leaves is remembered first (the list's own memory, for coming back by the sidebar), then its rows go
  setApp({ actionPreview: previewId, view, accountId: null, categoryId: null, reviewCategoryId: null, folder: null, gmailTab: null, reminders: false, followups: false, today: false, query: "", selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
  useList.setState({ items: [], index: new Map(), nextCursor: null, loading: true, loadingMore: false, error: null });
  // from the top: a place deep in the last list means nothing in this one
  const el = listEl();
  if (el) el.scrollTop = 0;
  // plan 161: the keys are the list's (j/k, x, ⌘↩, Esc), not the closed palette's; programmatic, so no ring
  el?.focus({ preventScroll: true });
  handoff.previewId = previewId;
  handoff.seq = focusIntent.seq;
}

/** the list's focus once the preview is ready, unless the user has moved since it opened (a Tab to Cancel, a click) */
const handoff: { previewId: string | null; seq: number } = { previewId: null, seq: 0 };

/**
 * Plan 161: ready (found and checked), the keys go to the list: the palette may have handed focus elsewhere as it closed.
 * A palette still closing is waited for (the page changing, not a timer); a key or a press since the preview opened, or
 * another list, ends the wait.
 */
export function focusWhenReady(previewId: string): void {
  if (handoff.previewId !== previewId) return;
  const attempt = (): boolean => {
    if (handoff.previewId !== previewId) return true;
    if (focusIntent.seq !== handoff.seq || getApp().actionPreview !== previewId) {
      handoff.previewId = null;
      return true;
    }
    if (getApp().dialog !== null || document.querySelector("[role=dialog]")) return false;
    handoff.previewId = null;
    const at = document.activeElement;
    if (!at?.closest?.("input, textarea, select, [contenteditable], [role=menu], [data-composer]")) listEl()?.focus({ preventScroll: true });
    return true;
  };
  if (attempt()) return;
  const watch = new MutationObserver(() => {
    if (attempt()) stop();
  });
  const timer = setTimeout(() => stop(), 10_000);
  const stop = () => {
    watch.disconnect();
    clearTimeout(timer);
  };
  watch.observe(document.body, { childList: true, subtree: true });
}

/**
 * Plan 161, pass 2: back from a matched conversation to the rule, everything kept (the ticks, the request, the count).
 * Esc does this first, while one is open; only an Esc with none open cancels. Whether it closed one.
 */
export function closePreviewRow(): boolean {
  const s = getApp();
  // (Split's: List's conversation is a page, which Esc closes on its own, and its cursor isn't an open conversation)
  if (!s.actionPreview || (s.selectedId === null && !s.readerOpen)) return false;
  setApp({ selectedId: null, readerOpen: false });
  // the keys stay the list's (x, j/k, ⌘↩), wherever the conversation had them; programmatic, so no ring
  listEl()?.focus({ preventScroll: true });
  return true;
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
      // plan 161: Apply and Cancel leave the keys where you were, on the list (what a button or the body had isn't a place)
      const at = document.activeElement;
      if (el && (!at || at === document.body || at.closest("[data-testid=action-preview], [data-testid=action-rule]") || !at.isConnected)) el.focus({ preventScroll: true });
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
