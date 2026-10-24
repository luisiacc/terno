import type { Account, Category, Counts, FilterRule, View } from "@unica/core";
import type { AppSettings, HostInfo, OwnerIdentity, ThreadScope } from "@unica/core/rpc";
import { create } from "zustand";

export type DialogName = "settings" | "shortcuts" | "palette" | "categoryPicker" | "filters" | "addAccount" | null;
export type SettingsTab = "general" | "appearance" | "accounts" | "categories" | "ai" | "agents";

export interface ComposeDraft {
  key: number;
  mode: "new" | "reply" | "replyAll" | "forward";
  accountId: number;
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyToMessageId?: number;
  forwardOfMessageId?: number;
  threadId?: number;
  draftId?: number;
}

/** "Select all N": the selection is every thread of the current view or search, acted on by the backend. */
export interface ScopeSelection {
  /** the list it was taken on (listKey()): any other list ends it */
  key: string;
  scope: ThreadScope;
  /** "Entrada", "Facturas", "«factura»"… */
  label: string;
  count: number;
}

export interface AppState {
  ready: boolean;
  fatal: string | null;
  version: string;
  accounts: Account[];
  categories: Category[];
  counts: Counts;
  settings: AppSettings | null;
  /** the person this install belongs to (the Única account); null until the first verified mailbox */
  owner: OwnerIdentity | null;
  /** demo build: no owner, no first-run */
  demo: boolean;
  /** what the backend's host can do (the web can't run IMAP or agents) */
  host: HostInfo | null;

  view: View;
  accountId: number | null;
  categoryId: number | null;
  /** "Revisar": the engine's pending suggestions for this category */
  reviewCategoryId: number | null;
  query: string;
  selectedId: number | null;
  /** multi-selection (x, ⌘-click, ⇧-click, ⇧J/⇧K, ⌘A) */
  checked: ReadonlySet<number>;
  /** where ⇧-click and ⇧J/⇧K ranges start */
  anchorId: number | null;
  /** "Seleccionar las N conversaciones de …" accepted */
  scope: ScopeSelection | null;
  /** the thread context menu is open: global shortcuts wait (its own keys apply) */
  menuOpen: boolean;
  /** "Crear filtro desde este remitente…": what the filter builder opens with */
  filterPrefill: { name: string; rule: FilterRule } | null;
  /** the reader pane shows the selected thread */
  readerOpen: boolean;

  compose: ComposeDraft | null;
  dialog: DialogName;
  /** the category picker toggles categories (l) or moves exclusively (v, "Mover a…") */
  pickerMode: "toggle" | "move";
  settingsTab: SettingsTab;
  /** e.g. "g" while waiting for the second key of a sequence */
  pendingKeys: string | null;
  /** the categorization snackbar is up (its keys win: 1–5, z, Esc) */
  snackbar: boolean;
}

export const EMPTY_COUNTS: Counts = { inboxUnread: 0, inboxUnreadByAccount: {}, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} };

export const useApp = create<AppState>(() => ({
  ready: false,
  fatal: null,
  version: "",
  accounts: [],
  categories: [],
  counts: EMPTY_COUNTS,
  settings: null,
  owner: null,
  demo: false,
  host: null,
  view: "inbox",
  accountId: null,
  categoryId: null,
  reviewCategoryId: null,
  query: "",
  selectedId: null,
  checked: new Set(),
  anchorId: null,
  scope: null,
  menuOpen: false,
  filterPrefill: null,
  readerOpen: true,
  compose: null,
  dialog: null,
  pickerMode: "toggle",
  settingsTab: "general",
  pendingKeys: null,
  snackbar: false,
}));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

export function navigate(to: { view?: View; accountId?: number | null; categoryId?: number | null; reviewCategoryId?: number | null }): void {
  setApp((s) => ({
    reviewCategoryId: to.reviewCategoryId ?? null,
    view: to.view ?? (to.categoryId ? "all" : s.view),
    accountId: to.accountId === undefined ? s.accountId : to.accountId,
    categoryId: to.categoryId === undefined ? null : to.categoryId,
    query: "",
    selectedId: null,
    checked: new Set(),
    anchorId: null,
    scope: null,
  }));
}
