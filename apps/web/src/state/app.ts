import type { Account, Category, Counts, Filter, FilterRule, Folder, ListFilter, ReminderKind, View } from "@terno/core";
import type { AppSettings, HostInfo, OwnerIdentity, ThreadScope } from "@terno/core/rpc";
import { create } from "zustand";
import type { PrintTarget } from "~/lib/print-open";
import { LEGACY_FILTERS, loadListFilters } from "~/lib/unread-filter";

export type DialogName = "settings" | "shortcuts" | "palette" | "categoryPicker" | "filters" | "addAccount" | "print" | "remind" | null;
export type SettingsTab = "general" | "appearance" | "accounts" | "categories" | "filters" | "ai" | "agents" | "data" | "storage";

/** The draft being written (lib/drafts holds its content); seq changes each time it is (re)opened, for focus. */
export interface ComposeState {
  key: string;
  seq: number;
  readonly storedFocusSeq?: number;
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
  /** the person this install belongs to (the Terno account); null until the first verified mailbox */
  owner: OwnerIdentity | null;
  /** demo build: no owner, no first-run */
  demo: boolean;
  /** what the backend's host can do (the web can't run IMAP or agents) */
  host: HostInfo | null;

  view: View;
  accountId: number | null;
  categoryId: number | null;
  /** plan 68: one of the account's own folders (with accountId; its view "all") */
  folder: string | null;
  /** plan 68: every account's own folders */
  folders: Folder[];
  /** "Revisar": the engine's pending suggestions for this category */
  reviewCategoryId: number | null;
  /** plan 87: the Reminders list (view "all", no account, category, folder or review) */
  reminders: boolean;
  query: string;
  /** mailboxes with the unread filter on (lib/unread-filter: the current list's flag is derived from this) */
  /** each mailbox's quick filter (plan 12's unread filter, generalized in plan 15) */
  listFilters: ReadonlyMap<string, ListFilter>;
  /** the quick filters the backend knows (plan 17, Codex R12): an older one knows only plan 15's */
  supportedFilters: readonly ListFilter[];
  selectedId: number | null;
  /** multi-selection (x, ⌘-click, ⇧-click, ⇧J/⇧K, ⌘A) */
  checked: ReadonlySet<number>;
  /** where ⇧-click and ⇧J/⇧K ranges start */
  anchorId: number | null;
  /** "Seleccionar las N conversaciones de …" accepted */
  scope: ScopeSelection | null;
  /** the thread context menu is open: global shortcuts wait (its own keys apply) */
  menuOpen: boolean;
  /** "Crear filtro desde este remitente…", Ajustes → Filtros → Editar: what the filter builder opens with (an id edits that filter) */
  filterPrefill: { id?: number; name: string; rule: FilterRule; enabled?: boolean; source?: Filter["source"]; returnTo?: "settings" } | null;
  /** plan 24: in the List layout, the selected conversation is the page (not just the list's cursor); Split ignores it */
  readerOpen: boolean;

  compose: ComposeState | null;
  /** an inline draft to focus (set when one is opened explicitly; seq makes each request distinct) */
  draftFocus: { key: string; target: "body" | "to"; seq: number; readonly leased?: true; readonly move?: import("~/lib/compose-focus-move").InlineFocusMove } | null;
  /** a conversation's draft opened explicitly (from the strip): shown inline instead of its newest one */
  draftShown: { threadId: number; key: string } | null;
  dialog: DialogName;
  /** what the print sheet prints (set with dialog "print") */
  printTarget: PrintTarget | null;
  /** plan 87: what the reminder dialog sets a reminder on (set with dialog "remind") */
  remindTarget: { ids: number[]; kind?: ReminderKind; custom: boolean } | null;
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
  folder: null,
  folders: [],
  reviewCategoryId: null,
  reminders: false,
  query: "",
  listFilters: loadListFilters(),
  supportedFilters: LEGACY_FILTERS,
  selectedId: null,
  checked: new Set(),
  anchorId: null,
  scope: null,
  menuOpen: false,
  filterPrefill: null,
  // List starts on its list: only an explicit open (or a reload on a conversation) shows one (plan 24, R7)
  readerOpen: false,
  compose: null,
  draftFocus: null,
  draftShown: null,
  dialog: null,
  printTarget: null,
  remindTarget: null,
  pickerMode: "toggle",
  settingsTab: "general",
  pendingKeys: null,
  snackbar: false,
}));

let selectionWriteRevision = 0;
let composeSelectionRetirement: { retire: () => void } | undefined;
export const getSelectionWriteRevision = (): number => selectionWriteRevision;
export const markSelectionIntent = (): void => { selectionWriteRevision++; composeSelectionRetirement?.retire(); };
export function subscribeComposeSelectionIntent(retire: () => void): () => void {
  const registration = { retire };
  composeSelectionRetirement = registration;
  return () => { if (composeSelectionRetirement === registration) composeSelectionRetirement = undefined; };
}

export function setApp(partial: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>), replace?: false): void;
export function setApp(partial: AppState | ((state: AppState) => AppState), replace: true): void;
export function setApp(partial: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>), replace?: boolean): void {
  const update = typeof partial === "function" ? (state: AppState) => {
    const next = partial(state);
    if (!Object.is(next, useApp.getState()) && next != null && Object.hasOwn(next, "selectedId")) markSelectionIntent();
    return next;
  } : partial;
  if (typeof update !== "function" && !Object.is(update, useApp.getState()) && update != null && Object.hasOwn(update, "selectedId")) markSelectionIntent();
  if (replace) useApp.setState(update as AppState | ((state: AppState) => AppState), true);
  else useApp.setState((state) => keepFolderValid(state, typeof update === "function" ? update(state) : update));
}

/**
 * Plan 68 (Codex R2): a folder is its account's, alone, in "all". Any write that leaves it otherwise (a search
 * scope across accounts, a tab back to the Inbox) leaves the folder too, so a list is never asked for an invalid one.
 */
function keepFolderValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  next = keepRemindersValid(state, next);
  const m = { ...state, ...next };
  return m.folder !== null && (m.accountId === null || m.categoryId !== null || m.reviewCategoryId !== null || m.reminders || m.view !== "all") ? { ...next, folder: null } : next;
}

/** Plan 87: any other list (a tab, an account, a search: a search looks everywhere) leaves Reminders. */
function keepRemindersValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  if (!state.reminders || Object.hasOwn(next, "reminders")) return next;
  const m = { ...state, ...next };
  const other = m.view !== "all" || m.accountId !== null || m.categoryId !== null || m.reviewCategoryId !== null || m.folder !== null || m.query.trim() !== "";
  return other ? { ...next, reminders: false } : next;
}

/** First-page selection is passive; nested explicit writes still use setApp. */
export function setListAutoSelection(selectedId: number | null): void {
  useApp.setState({ selectedId });
}
export const getApp = useApp.getState;

export function navigate(to: { view?: View; accountId?: number | null; categoryId?: number | null; reviewCategoryId?: number | null; folder?: string | null; reminders?: boolean }): void {
  // plan 68: a folder is its account's, alone (no category, no review), its view "all"; anywhere else leaves it
  const folder = to.folder ?? null;
  // plan 87: Reminders is a list of its own, of every account
  const reminders = !folder && to.reminders === true;
  setApp((s) => ({
    reviewCategoryId: folder || reminders ? null : (to.reviewCategoryId ?? null),
    reminders,
    view: folder || reminders ? "all" : (to.view ?? (to.categoryId ? "all" : s.view)),
    accountId: reminders ? null : to.accountId === undefined ? s.accountId : to.accountId,
    categoryId: folder || reminders || to.categoryId === undefined ? null : to.categoryId,
    folder,
    query: "",
    selectedId: null,
    checked: new Set(),
    anchorId: null,
    scope: null,
    // another mailbox is the list (List layout); Split ignores it
    readerOpen: false,
  }));
}

/** plan 68: the folder list changed: a folder you're in that's gone sends you to its account's Inbox. */
export function setFolders(folders: Folder[]): void {
  setApp({ folders });
  const { folder, accountId } = getApp();
  if (folder !== null && !folders.some((f) => f.accountId === accountId && f.key === folder && f.selectable)) navigate({ view: "inbox", accountId });
}

/** Plan 83: the Inbox itself (not a category's tab of it, a folder, Revisar or a search): what hidden categories leave. */
export function inPlainInbox(s: Pick<AppState, "view" | "categoryId" | "reviewCategoryId" | "folder" | "query">): boolean {
  return s.view === "inbox" && s.categoryId === null && s.reviewCategoryId === null && s.folder === null && s.query.trim() === "";
}

/**
 * The category list changed (an edit here, an event from the backend): a
 * view of a category that is gone (its list or its Revisar) goes back to the
 * inbox instead of querying nothing.
 */
export function setCategories(categories: Category[]): void {
  const hidden = (list: readonly Category[]) => list.filter((c) => !c.showInInbox).map((c) => c.id).join();
  // plan 83: what the Inbox shows changed (here or in another window): a "select all N" of it counted other threads
  const regrouped = hidden(getApp().categories) !== hidden(categories) && inPlainInbox(getApp()) && getApp().scope !== null;
  setApp({ categories, ...(regrouped ? { scope: null, checked: new Set<number>() } : {}) });
  const { categoryId, reviewCategoryId } = getApp();
  const gone = (id: number | null) => id !== null && !categories.some((c) => c.id === id);
  if (gone(categoryId) || gone(reviewCategoryId)) navigate({ view: "inbox", categoryId: null, reviewCategoryId: null });
}
