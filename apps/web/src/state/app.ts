import type { Account, Category, Counts, View } from "@unica/core";
import type { AppSettings, OwnerIdentity } from "@unica/core/rpc";
import { create } from "zustand";

export type DialogName = "settings" | "shortcuts" | "palette" | "categoryPicker" | "filters" | "addAccount" | null;
export type SettingsTab = "general" | "accounts" | "ai" | "agents";

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

  view: View;
  accountId: number | null;
  categoryId: number | null;
  query: string;
  selectedId: number | null;
  /** multi-selection (x) */
  checked: ReadonlySet<number>;
  /** the reader pane shows the selected thread */
  readerOpen: boolean;

  compose: ComposeDraft | null;
  dialog: DialogName;
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
  view: "inbox",
  accountId: null,
  categoryId: null,
  query: "",
  selectedId: null,
  checked: new Set(),
  readerOpen: true,
  compose: null,
  dialog: null,
  settingsTab: "general",
  pendingKeys: null,
  snackbar: false,
}));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

export function navigate(to: { view?: View; accountId?: number | null; categoryId?: number | null }): void {
  setApp((s) => ({
    view: to.view ?? (to.categoryId ? "all" : s.view),
    accountId: to.accountId === undefined ? s.accountId : to.accountId,
    categoryId: to.categoryId === undefined ? null : to.categoryId,
    query: "",
    selectedId: null,
    checked: new Set(),
  }));
}
