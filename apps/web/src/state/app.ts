import { inAllInbox, separatesTabs, type Account, type DevAiProvider, type Category, type Counts, type Filter, type FilterRule, type Folder, type ListFilter, type ReminderKind, type Tab, type View } from "@terno/core";
import type { AppSettings, HostInfo, OwnerIdentity, ThreadScope } from "@terno/core/rpc";
import { create } from "zustand";
import type { PrintTarget } from "~/lib/print-open";
import { LEGACY_FILTERS, loadListFilters } from "~/lib/unread-filter";

export type DialogName = "settings" | "shortcuts" | "palette" | "categoryPicker" | "filters" | "addAccount" | "print" | "remind" | "todayLater" | "todayChange" | "firstScreen" | null;
export type SettingsTab = "general" | "whatMatters" | "appearance" | "accounts" | "categories" | "filters" | "snippets" | "ai" | "agents" | "dev" | "data" | "storage" | "about";

/** The draft being written (lib/drafts holds its content); seq changes each time it is (re)opened, for focus. */
export interface ComposeState {
  key: string;
  seq: number;
  readonly storedFocusSeq?: number;
  /** plan 133: opened for the AI row: focus goes to it instead of To */
  readonly target?: "ai";
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
  /** plan 146: which of Dev mode's variables are set; null outside a local build, and no section */
  devAi: Record<DevAiProvider, boolean> | null;
  /** what the backend's host can do (the web can't run IMAP or agents) */
  host: HostInfo | null;

  view: View;
  accountId: number | null;
  categoryId: number | null;
  /** plan 68: one of the account's own folders (with accountId; its view "all") */
  folder: string | null;
  /** plan 68: every account's own folders */
  folders: Folder[];
  /** plan 86: a Gmail account's Promotions or Social (with accountId; its view "inbox") */
  gmailTab: Tab | null;
  /** "Revisar": the engine's pending suggestions for this category */
  reviewCategoryId: number | null;
  /** plan 87: the Reminders list (view "all", no account, category, folder or review) */
  reminders: boolean;
  /** plan 142: the Follow-ups list, likewise */
  followups: boolean;
  /** plan 282: Put away, likewise */
  putAway: boolean;
  /** plan 145: Today, a list of its own */
  today: boolean;
  /** plan 281: People, a list of its own (of people, not conversations) */
  people: boolean;
  /** plan 281: the person People has selected (`personKey`'s), whose page the reader shows while no conversation is open */
  person: string | null;
  /** plan 143: a sentence's preview is the list: its id with the backend */
  actionPreview: string | null;
  /** plan 108: the account the sidebar is focused on ("solo", never keyboard focus); while set, accountId is it */
  soloAccountId: number | null;
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
  /** `note`: what the builder says beside its count, opened from a sentence's preview (plan 161) */
  filterPrefill: { id?: number; name: string; rule: FilterRule; enabled?: boolean; source?: Filter["source"]; auto?: boolean; returnTo?: "settings"; note?: string } | null;
  /** plan 24: in the List layout, the selected conversation is the page (not just the list's cursor); Split ignores it */
  readerOpen: boolean;

  compose: ComposeState | null;
  /** plan 182: a new message just sent, shown in the pane (its draft id) through its Undo window, until it opens as its conversation */
  heldView: number | null;
  /** an inline draft to focus (set when one is opened explicitly; seq makes each request distinct) */
  draftFocus: { key: string; target: "body" | "to" | "ai"; seq: number; readonly leased?: true; readonly move?: import("~/lib/compose-focus-move").InlineFocusMove } | null;
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
  /** plan 106: the account Settings opens on (the sidebar menu's Account Settings…); read once as it opens */
  settingsAccount: number | null;
  /** e.g. "g" while waiting for the second key of a sequence */
  pendingKeys: string | null;
  /** the categorization snackbar is up (its keys win: 1–5, z, Esc) */
  snackbar: boolean;
}

export const EMPTY_COUNTS: Counts = { inboxUnread: 0, inboxUnreadByAccount: {}, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} };

/** The same numbers, field by field (a record by its keys, in any order; an absent field differs from null and from 0). */
export function sameCounts(a: Counts, b: Counts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Counts>;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    const xs = Object.keys(x);
    if (xs.length !== Object.keys(y).length) return false;
    for (const id of xs) if (!Object.hasOwn(y, id) || (x as Record<string, number>)[id] !== (y as Record<string, number>)[id]) return false;
  }
  return true;
}

/**
 * The backend's counts (a push or an answer), published only when a number differs from what the window shows (plan
 * 234): the backend says "counts" whenever they may have moved, mostly with the same numbers, and every reader of
 * `counts` would render again for nothing. Compared with what's on screen, so an optimistic guess the backend doesn't
 * confirm is corrected, and one it does stays as it is.
 */
export function publishCounts(counts: Counts): void {
  if (!sameCounts(useApp.getState().counts, counts)) setApp({ counts });
}

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
  devAi: null,
  host: null,
  view: "inbox",
  accountId: null,
  categoryId: null,
  folder: null,
  folders: [],
  gmailTab: null,
  reviewCategoryId: null,
  reminders: false,
  followups: false,
  putAway: false,
  today: false,
  people: false,
  person: null,
  actionPreview: null,
  soloAccountId: null,
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
  heldView: null,
  draftFocus: null,
  draftShown: null,
  dialog: null,
  printTarget: null,
  remindTarget: null,
  pickerMode: "toggle",
  settingsTab: "general",
  settingsAccount: null,
  pendingKeys: null,
  snackbar: false,
}));

let selectionWriteRevision = 0;
let composeSelectionRetirement: { retire: () => void } | undefined;
export const getSelectionWriteRevision = (): number => selectionWriteRevision;
export const markSelectionIntent = (): void => { selectionWriteRevision++; composeSelectionRetirement?.retire(); };

/**
 * Plan 158: the thread the app opened by itself (a list's first page: the first load, another mailbox, a search's top
 * hit), until the user chooses it. It decides only where the app goes next (What matters' Done, Undo), never whether
 * it's read: what the reader shows is read either way (plan 225, lib/read-on-show).
 */
const openedSelf: { id: number | null } = { id: null };
export const openedByApp = (id: number): boolean => openedSelf.id === id;
/** The user chose what's open (the row, Enter, a reply, a press in the reader): from here on it's an open like any other. */
export function chooseOpenThread(): void {
  openedSelf.id = null;
}
/** A selection write is the user's: on the same thread it chooses it, anywhere else what the app opened isn't open any more. */
function noteSelectionWrite(): void {
  markSelectionIntent();
  chooseOpenThread();
}
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
    if (!Object.is(next, useApp.getState()) && next != null && Object.hasOwn(next, "selectedId")) noteSelectionWrite();
    return next;
  } : partial;
  if (typeof update !== "function" && !Object.is(update, useApp.getState()) && update != null && Object.hasOwn(update, "selectedId")) noteSelectionWrite();
  if (replace) useApp.setState(update as AppState | ((state: AppState) => AppState), true);
  else useApp.setState((state) => keepFolderValid(state, typeof update === "function" ? update(state) : update));
}

/**
 * Plan 68 (Codex R2): a folder is its account's, alone, in "all". Any write that leaves it otherwise (a search
 * scope across accounts, a tab back to the Inbox) leaves the folder too, so a list is never asked for an invalid one.
 */
function keepFolderValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  next = keepSoloValid(state, keepPeopleValid(state, keepTodayValid(state, keepActionPreviewValid(state, keepPutAwayValid(state, keepFollowupsValid(state, keepRemindersValid(state, keepReviewValid(state, next))))))));
  const m = { ...state, ...next };
  const out = m.folder !== null && (m.accountId === null || m.categoryId !== null || m.reviewCategoryId !== null || ownList(m) || m.view !== "all") ? { ...next, folder: null } : next;
  // plan 86: a Gmail tab is its account's Inbox, alone, likewise
  return m.gmailTab !== null && (m.accountId === null || m.categoryId !== null || m.reviewCategoryId !== null || ownList(m) || m.folder !== null || m.view !== "inbox") ? { ...out, gmailTab: null } : out;
}

/**
 * Plan 108: focus on an account lasts while you're in it. A write that takes you to another account or to all of
 * them (Reminders, a category across accounts, a notification, the palette) ends it in the same write.
 */
function keepSoloValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  const m = { ...state, ...next };
  return m.soloAccountId !== null && m.accountId !== m.soloAccountId ? { ...next, soloAccountId: null } : next;
}

/** Reminders, Follow-ups, Put away, What matters and People: lists of their own (every account; no category, folder or filter) */
export const ownList = (s: Pick<AppState, "reminders" | "followups" | "putAway" | "today" | "people">): boolean => s.reminders || s.followups || s.putAway || s.today || s.people;

/** The lists of their own that only another place leaves (What matters, with its preview rule, is apart) */
const OWN_LISTS = ["reminders", "followups", "putAway"] as const;

/**
 * Plans 87, 142, 282: Reminders, Follow-ups and Put away are lists of every account: any other list (a tab, an account,
 * a category, a folder, another of them, a search: a search looks everywhere) leaves the one you're in.
 */
function keepOwnListValid(flag: (typeof OWN_LISTS)[number]) {
  return (state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> => {
    if (!state[flag] || Object.hasOwn(next, flag)) return next;
    const m = { ...state, ...next };
    const other = m.view !== "all" || m.accountId !== null || m.categoryId !== null || m.reviewCategoryId !== null || m.folder !== null || OWN_LISTS.some((l) => l !== flag && m[l]) || m.people || m.query.trim() !== "";
    return other ? { ...next, [flag]: false } : next;
  };
}
const keepRemindersValid = keepOwnListValid("reminders");
const keepFollowupsValid = keepOwnListValid("followups");
const keepPutAwayValid = keepOwnListValid("putAway");

/**
 * Plan 158: a search typed in Review leaves it, as one from the palette does: Review's suggestions don't answer a
 * query, and typing there changed nothing at all.
 */
function keepReviewValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  if (state.reviewCategoryId === null || Object.hasOwn(next, "reviewCategoryId") || !Object.hasOwn(next, "query")) return next;
  return (next.query ?? "").trim() !== "" ? { ...next, reviewCategoryId: null } : next;
}

/** Plan 145: likewise for Today. */
function keepTodayValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  if (!state.today || Object.hasOwn(next, "today")) return next;
  const m = { ...state, ...next };
  const other = m.view !== "all" || m.accountId !== null || m.categoryId !== null || m.reviewCategoryId !== null || m.folder !== null || m.reminders || m.followups || m.putAway || m.people || m.actionPreview !== null || m.query.trim() !== "";
  return other ? { ...next, today: false } : next;
}

/** Plan 281: likewise for People (its chosen person kept, for when it's back). */
function keepPeopleValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  if (!state.people || Object.hasOwn(next, "people")) return next;
  const m = { ...state, ...next };
  const other = m.view !== "all" || m.accountId !== null || m.categoryId !== null || m.reviewCategoryId !== null || m.folder !== null || m.reminders || m.followups || m.putAway || m.today || m.actionPreview !== null || m.query.trim() !== "";
  // (the person chosen stays chosen: coming back to People finds them)
  return other ? { ...next, people: false } : next;
}

/** Plan 143: any other list ends a preview too (and the backend lets go of it). */
function keepActionPreviewValid(state: AppState, next: AppState | Partial<AppState>): AppState | Partial<AppState> {
  if (!state.actionPreview || Object.hasOwn(next, "actionPreview")) return next;
  const m = { ...state, ...next };
  // (its view is the rule's scope, plan 161: Inbox or All Mail; another one is another place)
  const other = m.view !== state.view || m.accountId !== null || m.categoryId !== null || m.reviewCategoryId !== null || m.folder !== null || m.gmailTab !== null || ownList(m) || m.query.trim() !== "";
  return other ? { ...next, actionPreview: null } : next;
}

/**
 * Plan 158: the app moves the selection itself (Archive or Delete going on to the next conversation, an Undo putting back
 * one it had opened): that one is opened by the app, as a first load's is.
 */
export function setAppOpened(selectedId: number | null): void {
  setApp({ selectedId });
  openedSelf.id = selectedId;
}

/** First-page selection is passive; nested explicit writes still use setApp. */
export function setListAutoSelection(selectedId: number | null): void {
  openedSelf.id = selectedId;
  useApp.setState({ selectedId });
}
export const getApp = useApp.getState;

export function navigate(to: { view?: View; accountId?: number | null; categoryId?: number | null; reviewCategoryId?: number | null; folder?: string | null; reminders?: boolean; followups?: boolean; putAway?: boolean; today?: boolean; people?: boolean; gmailTab?: Tab | null }): void {
  // plan 68: a folder is its account's, alone (no category, no review), its view "all"; anywhere else leaves it
  const folder = to.folder ?? null;
  // plan 87: Reminders is a list of its own, of every account
  const reminders = !folder && to.reminders === true;
  // plan 142: Follow-ups, the same way
  const followups = !folder && !reminders && to.followups === true;
  // plan 282: Put away, the same way
  const putAway = !folder && !reminders && !followups && to.putAway === true;
  const today = !folder && !reminders && !followups && !putAway && to.today === true;
  // plan 281: People, likewise (its selected person kept while it stays there)
  const people = !folder && !reminders && !followups && !putAway && !today && to.people === true;
  const own = reminders || followups || putAway || today || people;
  // plan 86: a Gmail tab likewise, its view "inbox"
  const gmailTab = folder || own ? null : (to.gmailTab ?? null);
  setApp((s) => {
    const place = {
      reviewCategoryId: folder || own || gmailTab ? null : (to.reviewCategoryId ?? null),
      reminders,
      followups,
      putAway,
      today,
      people,
      view: folder || own ? ("all" as const) : gmailTab ? ("inbox" as const) : (to.view ?? (to.categoryId ? ("all" as const) : s.view)),
      accountId: own ? null : to.accountId === undefined ? s.accountId : to.accountId,
      categoryId: folder || own || gmailTab || to.categoryId === undefined ? null : to.categoryId,
      folder,
      gmailTab,
    };
    // plan 158: already there (g i in the Inbox): the cursor, the conversation and the checks stay; List's page still closes
    const here = !s.query && !s.actionPreview && (Object.keys(place) as (keyof typeof place)[]).every((k) => s[k] === place[k]);
    if (here) return { readerOpen: false };
    return {
      ...place,
      actionPreview: null,
      query: "",
      selectedId: null,
      checked: new Set(),
      anchorId: null,
      scope: null,
      // another mailbox is the list (List layout); Split ignores it
      readerOpen: false,
    };
  });
}

/** plan 68: the folder list changed: a folder you're in that's gone sends you to its account's Inbox. */
export function setFolders(folders: Folder[]): void {
  setApp({ folders });
  const { folder, accountId } = getApp();
  if (folder !== null && !folders.some((f) => f.accountId === accountId && f.key === folder && f.selectable)) navigate({ view: "inbox", accountId });
}

/** Plan 83: the Inbox itself (not a category's tab of it, a folder, a Gmail tab, Revisar or a search): what hidden categories and Gmail tabs leave. */
export function inPlainInbox(s: Pick<AppState, "view" | "categoryId" | "reviewCategoryId" | "folder" | "query"> & { gmailTab?: Tab | null }): boolean {
  return s.view === "inbox" && s.categoryId === null && s.reviewCategoryId === null && s.folder === null && !s.gmailTab && s.query.trim() === "";
}

/** Plan 86: is this thread out of the Inbox in a Gmail tab its account keeps apart? */
export function inSeparateTab(t: { accountId?: number; tab?: number }, accounts: readonly Account[]): boolean {
  if (!t.tab || t.accountId === undefined) return false;
  const account = accounts.find((a) => a.id === t.accountId);
  return !!account && separatesTabs(account);
}

/**
 * What the Inbox shows changed (plans 83, 86, 238): a page of it still on its way was asked of the Inbox as it was,
 * so it asks again (state/list's next page). An object property, not a module let (React Compiler).
 */
export const inboxShape = { rev: 0 };

/**
 * Plan 86: the account list changed (an edit here, an event from the backend). An account that stops keeping its
 * tabs apart takes you from one of them to its Inbox, and a "select all N" of the Inbox counted other threads.
 * Plan 238: likewise an account taken out of (or back into) the all-accounts Inbox.
 */
export function setAccounts(accounts: Account[]): void {
  // which accounts, not their order (plan 169: a reorder regroups nothing)
  const ids = (list: readonly Account[], test: (a: Account) => boolean) => list.filter(test).map((a) => a.id).sort((a, b) => a - b).join();
  const before = getApp();
  const tabs = ids(before.accounts, separatesTabs) !== ids(accounts, separatesTabs);
  const out = (a: Account) => !inAllInbox(a);
  const unified = ids(before.accounts, out) !== ids(accounts, out);
  if (tabs || unified) inboxShape.rev++;
  const regrouped = before.scope !== null && ((tabs && (inPlainInbox(before) || before.gmailTab !== null)) || (unified && inPlainInbox(before) && before.accountId === null));
  setApp({ accounts, ...(regrouped ? { scope: null, checked: new Set<number>() } : {}) });
  const { gmailTab, accountId } = getApp();
  const account = accounts.find((a) => a.id === accountId);
  if (gmailTab !== null && (!account || !separatesTabs(account))) navigate({ view: "inbox", accountId: account ? accountId : null });
}

/**
 * The category list changed (an edit here, an event from the backend): a
 * view of a category that is gone (its list or its Revisar) goes back to the
 * inbox instead of querying nothing.
 */
export function setCategories(categories: Category[]): void {
  const hidden = (list: readonly Category[]) => list.filter((c) => !c.showInInbox).map((c) => c.id).sort((a, b) => a - b).join();
  // plan 83: what the Inbox shows changed (here or in another window): a "select all N" of it counted other threads
  const changed = hidden(getApp().categories) !== hidden(categories);
  if (changed) inboxShape.rev++;
  const regrouped = changed && inPlainInbox(getApp()) && getApp().scope !== null;
  setApp({ categories, ...(regrouped ? { scope: null, checked: new Set<number>() } : {}) });
  const { categoryId, reviewCategoryId } = getApp();
  const gone = (id: number | null) => id !== null && !categories.some((c) => c.id === id);
  if (gone(categoryId) || gone(reviewCategoryId)) navigate({ view: "inbox", categoryId: null, reviewCategoryId: null });
}
