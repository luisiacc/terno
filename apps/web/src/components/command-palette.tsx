import { DIGEST_ROW_ID, shortcutsFor, type Command as KeyCommand, type ThreadSummary } from "@terno/core";
import { conversationKeys } from "~/lib/conversation-keys";
import { focusAccount, goToAccount, goToFolder } from "~/lib/account-folders";
import { normalizeText, remindPresets, separatesTabs, snippetPreview, TABS, type CategoryColor, type ReminderKind, type Snippet } from "@terno/core";
import { t, type TextKey } from "@terno/i18n";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { cn } from "@terno/ui/lib/utils";
import { Chip } from "@terno/ui/components/chip";
import { Command, CommandDescription, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@terno/ui/components/command";
import { Archive, AtSign, Bell, BellOff, ListChecks, BookmarkPlus, CalendarClock, CheckCheck, Clock, Copy, FileDown, Focus, FolderInput, Forward, Keyboard, Link, Mail, MailOpen, Moon, OctagonAlert, Palette, Paperclip, Pin, PinOff, Inbox, Layers, ListFilter, Mails, PenLine, Plus, Printer, RefreshCw, Reply, ReplyAll, RotateCw, Search, Send, Sparkles, Star, Sun, Tag, NotepadText, Trash2, Undo2, Users } from "@terno/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fitWholeRows, markMore } from "@terno/ui/lib/whole-rows";
import { act, openCompose, targetRows, toggleStar, undoLast } from "~/lib/actions";
import { addScopeToCategory, addToCategory, isExclusivelyIn, moveToCategory } from "~/lib/categorize";
import { currentTargets, isMac, selectAll } from "~/lib/select";
import { updateAppearance } from "~/lib/appearance";
import { copyOpenThread } from "~/lib/copy-thread";
import { printCommand } from "~/lib/print-open";
import { setListFilter, toggleUnreadFilter } from "~/lib/unread";
import { activeFilter, isUnreadOnly } from "~/lib/unread-filter";
import { DESIGNS } from "@terno/ui/designs/index";
import { designName } from "~/lib/design";
import { aiReady, askOffered, followupsOffered, summariesOffered, todayOffered } from "~/lib/ai";
import { useCanDraft } from "~/lib/ai-draft-state";
import { openAiDraft } from "~/lib/ai-draft";
import { checkForUpdates, installUpdate, useHasUpdates, useUpdates } from "~/lib/updates";
import { englishWords as english } from "~/lib/palette-words";
import { getApp, navigate, setApp, useApp } from "~/state/app";
import { openRemind, presetLabel, presetWhen, setReminder, clearReminder, useReminders } from "~/lib/reminders";
import { draftCommands, type DraftCommands } from "~/lib/draft-commands";
import { isInstruction } from "~/lib/imperative";
import { askFrom, paletteBack, paletteFrom, paletteKeys, paletteReturn, returnPaletteFocus, setPalettePage, usePalettePage } from "~/lib/palette-open";
import { loadSnippets, newSnippetId, useSnippets } from "~/lib/snippets";
import { insertSnippetInto, newMessageFromSnippet, saveDraftAsSnippet } from "~/lib/snippet-insert";
import { openSnippetEditor } from "~/lib/snippet-editor-state";
import { arrange, itemValue, namesCommand, words, type PaletteCommand, type PaletteGroup, type PalettePage } from "~/lib/palette-commands";
import { noteUse, readUsage, type Usage } from "~/lib/palette-usage";
import { focusSearchField, reply } from "~/lib/keyboard";
import { listDate } from "~/lib/format";
import { reachesSeveral } from "~/lib/compose-fields";
import { draftIndex, useDrafts } from "~/lib/drafts";
import { openThread as openConversation } from "~/lib/page";
import { client } from "~/rpc/connection";
import { summarizable, summarize } from "~/lib/summaries";
import { useThread } from "~/state/threads";
import { createCategory } from "./category-picker";
import { snack } from "~/lib/snack";
import { DEV_TAB, SETTINGS_TABS } from "./settings/tabs";
import AskPages from "./ask-page";

const NONE: readonly never[] = [];
/** plan 158: a row's key is the binding the keyboard answers to (the shortcuts sheet's first), drawn as everywhere else */
const keysOf = (command: KeyCommand): string | undefined => shortcutsFor(command, undefined, isMac)[0];
const NO_USAGE: Usage = new Map();
/** how long a draft command waits for focus to come back into its composer */
const DRAFT_FOCUS_MS = 300;

/** A command's synonyms: the language's own, and in another language the English ones too (matched, not shown). */
type AliasKey = Extract<TextKey, `palette.alias.${string}`>;
type FilterKey = "palette.showAll" | "palette.showUnread" | "palette.showPeople" | "palette.showWaiting" | "palette.showAttachments" | "palette.showStarred";
const synonyms = (key: AliasKey, label: string[] = []) => ({ aliases: words(t(key)), keywords: [...label, ...english(key).flatMap(words)] });

/**
 * A draft command runs once the palette has closed and focus is back in that
 * composer (or soon after): only if nothing else happened meanwhile (another
 * dialog, another conversation or new message, the draft gone or replaced).
 */
function runInDraft(key: string, fn: (c: DraftCommands) => void) {
  const commands = draftCommands(key);
  if (!commands) return;
  const { selectedId, compose } = getApp();
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    document.removeEventListener("focusin", onFocus, true);
    clearTimeout(timer);
    const s = getApp();
    if (draftCommands(key) !== commands || s.dialog !== null || s.selectedId !== selectedId || s.compose !== compose) return;
    fn(commands);
  };
  const onFocus = (e: FocusEvent) => {
    if ((e.target as Element | null)?.closest?.(`[data-testid=composer][data-draft-key="${CSS.escape(key)}"]`)) go();
  };
  document.addEventListener("focusin", onFocus, true);
  const timer = setTimeout(go, DRAFT_FOCUS_MS);
}

const HEADINGS: Record<PaletteGroup, (count: number) => string | undefined> = {
  draft: () => t("palette.group.draft"),
  recent: () => t("palette.group.recent"),
  conversation: (count) => t("palette.group.conversation", { count }),
  start: () => undefined,
  goTo: () => t("palette.group.goTo"),
  actions: () => t("palette.group.actions"),
  settings: () => t("common.settings"),
  move: () => t("category.picker.moveTitle"),
  addTo: (count) => t("palette.group.addTo", { count }),
  remindAlways: () => t("remind.kind.always"),
  remindNoReply: () => t("remind.kind.noReply"),
  remindClear: () => undefined,
  snippets: () => t("palette.group.snippets"),
  snippetsManage: () => undefined,
};

/** how long typing rests before mail is asked for, and the most rows it offers (the list has the rest) */
const MAIL_MS = 120;
const MAIL_ROWS = 5;

/**
 * Plan 158: the conversations a query finds, for the palette to go straight to one. The search the list runs (at 50k+
 * threads in both stores it answers within its gates), asked once typing rests; a stale answer is dropped and the rows
 * on screen stay until a new one comes, so the panel doesn't flicker. Spam and Trash stay out: a search of its own still
 * looks there, but nothing offers their mail unasked.
 */
const NO_IDS: ReadonlySet<number> = new Set();

function useFoundMail(query: string, on: boolean, accountId: number | null, filter: ReturnType<typeof activeFilter>): { query: string; rows: readonly ThreadSummary[] } | null {
  const [found, setFound] = useState<{ query: string; rows: readonly ThreadSummary[] } | null>(null);
  const asks = on && query.length >= 2;
  useEffect(() => {
    if (!asks) {
      setFound(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void client.call("threads.search", { query, limit: MAIL_ROWS * 2, accountId: accountId ?? undefined, filter }).then(
        (page) => alive && setFound({ query, rows: page.items.filter((r) => !r.inSpam && !r.inTrash).slice(0, MAIL_ROWS) }),
        () => alive && setFound(null),
      );
    }, MAIL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, asks, accountId, filter]);
  return found;
}

/** The conversation the actions under it change: its subject in the ink, who it's from muted (one line, the subject first to go) */
function TargetHeading({ row }: { row: ThreadSummary }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" data-testid="palette-target">
      <span className="min-w-0 truncate text-foreground">{row.subject || t("common.noSubject")}</span>
      <span className="shrink-0">{t("palette.targetFrom", { name: row.fromName || row.fromEmail })}</span>
    </span>
  );
}

/**
 * Plan 162 (after ai162-r04): Ask is a column bounded by the window (its top at 18%, a margin under it): its answer gives
 * up height first, so its header, follow-up box and keys are always whole. It ran past a 1100x700 window.
 */
const ASK_FITS = "flex flex-col max-h-[calc(82dvh-1rem)]";

const TABBABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";

/** The dialog's own field (the palette's input, or Ask's follow-up box), else its first control. */
const paletteHome = (): HTMLElement | null => {
  const dialog = document.querySelector<HTMLElement>("[data-slot=dialog-content]");
  return dialog?.querySelector<HTMLElement>("[data-ask-followup]:not(:disabled), [cmdk-input]:not(:disabled)") ?? dialog?.querySelector<HTMLElement>("button:not(:disabled), [tabindex='0']") ?? null;
};

/**
 * Plan 162 (after ai162-r04): the app behind the scrim never takes the keys while the palette is open. A control that
 * goes from under focus (New question, Previous AI questions) dropped it to <body>, and Tab then walked the sidebar behind;
 * the keys come back to the dialog's field instead, whichever page it's on.
 */
function useKeysInPalette(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const behind = (el: EventTarget | null) => el instanceof Node && document.getElementById("root")?.contains(el) === true;
    const onFocus = (e: FocusEvent) => {
      if (behind(e.target)) paletteHome()?.focus({ preventScroll: true });
    };
    // Tab and ⇧Tab go round the dialog's own controls: past its last, its first (it stepped out to <body>, then the app)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const dialog = document.querySelector<HTMLElement>("[data-slot=dialog-content]");
      if (!dialog) return;
      const stops = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0);
      const at = document.activeElement;
      const inside = at instanceof HTMLElement && dialog.contains(at);
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      const to = !inside ? (e.shiftKey ? last : first) : e.shiftKey && at === first ? last : !e.shiftKey && at === last ? first : null;
      if (!to) return;
      e.preventDefault();
      to.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}

export function CommandPalette() {
  const open = useApp((s) => s.dialog === "palette");
  // closed means idle: no re-render for category or account changes
  const categories = useApp((s) => (open ? s.categories : NONE));
  const accounts = useApp((s) => (open ? s.accounts : NONE));
  const soloName = useApp((s) => (open && s.soloAccountId !== null ? (s.accounts.find((a) => a.id === s.soloAccountId)?.displayName ?? null) : null));
  // what the actions and "Add to" apply to: all N of a view, the checked threads, else the selected one
  const targets = useApp((s) => (open ? (s.scope ? s.scope.count : s.checked.size ? s.checked.size : s.selectedId !== null ? 1 : 0) : 0));
  // printing takes the conversation the reader shows (one, with no new message in the pane)
  const printable = useApp((s) => open && s.selectedId !== null && !s.scope && s.checked.size < 2 && s.compose === null);
  const onDigest = useApp((s) => s.selectedId === DIGEST_ROW_ID);
  // Reply, Reply all and Forward: the selected conversation, when it's the one target
  const replyable = useApp((s) => open && s.selectedId !== null && !s.scope && (s.checked.size === 0 || (s.checked.size === 1 && s.checked.has(s.selectedId))));
  const openThread = useThread(useApp((s) => (replyable ? s.selectedId : null)));
  // plan 87: reminders need ids ("select all N" has none)
  const scoped = useApp((s) => s.scope !== null);
  const openId = useApp((s) => (open ? s.selectedId : null));
  const checkedOne = useApp((s) => (open && s.checked.size === 1 ? [...s.checked][0]! : null));
  const single = useApp((s) => (open && !s.scope && s.checked.size === 0 ? s.selectedId : null));
  const reminder = useReminders((s) => (single !== null ? s.byThread.get(single) : undefined));
  // the unread filter applies to a mailbox (not "Review")
  // the unread toggle's state: Unread on or not (another filter on: it switches to Unread)
  const filter = useApp((s) => (open && s.reviewCategoryId === null && !s.reminders && !s.followups && !s.today ? (isUnreadOnly(s) ? "on" : "off") : null));
  const active = useApp((s) => (open ? activeFilter(s) : undefined));
  const supported = useApp((s) => s.supportedFilters);
  const design = useApp((s) => (open ? (s.settings?.design ?? null) : null));
  const canAi = useApp((s) => open && aiReady(s.settings?.ai));
  const hasDevMode = useApp((s) => s.devAi !== null);
  const followupsOn = useApp((s) => open && followupsOffered(s));
  const todayOn = useApp((s) => open && todayOffered(s));
  const canAsk = useApp((s) => open && askOffered(s));
  const canSummarize = useApp((s) => open && summariesOffered(s));
  const drafting = useCanDraft();
  const updatesAvailable = useHasUpdates();
  const readyVersion = useUpdates((s) => (open && s.state?.ready && s.state.status !== "installing" ? s.state.ready.version : null));
  const [value, setValue] = useState("");
  useKeysInPalette(open);
  // the page: set by whoever opened it (⌘K the root, ⌘; the snippets), changed inside
  const page = usePalettePage((s) => s.page);
  const setPage = setPalettePage;
  // every opening starts with nothing typed, however it was closed (⌘K closes from the keyboard handler); a page switch too (⌘; on a page)
  const [wasOpen, setWasOpen] = useState(open);
  const [wasPage, setWasPage] = useState(page);
  if (open !== wasOpen || page !== wasPage) {
    setWasOpen(open);
    setWasPage(page);
    if (open) setValue("");
  }
  // plan 93: the snippets, listed again on each opening (a local call; another window's edits show)
  useEffect(() => {
    if (open) loadSnippets();
  }, [open]);
  const snippets = useSnippets((s) => (open ? (s.list ?? NONE) : NONE)) as readonly Snippet[];
  // read once per open: what was run, when, and the draft it was opened from
  const usage = useMemo(() => (open ? readUsage() : NO_USAGE), [open]);
  const now = useMemo(() => (open ? Date.now() : 0), [open]);
  const draftKey = open ? paletteFrom.draftKey : null;
  const draft = open ? draftCommands(draftKey) : null;
  const draftState = draft?.state();

  const reset = () => {
    setValue("");
    usePalettePage.setState({ page: "root", entry: "root" });
  };
  const close = () => {
    setApp({ dialog: null });
    reset();
    returnPaletteFocus();
  };
  const listRef = useRef<HTMLDivElement>(null);
  const goTo = (next: PalettePage) => {
    setPage(next);
    setValue("");
    // a page starts at its top, wherever the list it came from was scrolled
    listRef.current?.scrollTo({ top: 0 });
  };
  // plan 160: the list ends on a whole row, --float-inset above the window's foot, at any height and whatever it holds
  // (measured when what it holds or the window changes, never per row); from when the list mounts (the dialog's popup
  // mounts after `open`) until it goes
  const wholeRows = useCallback((list: HTMLDivElement | null) => {
    listRef.current = list;
    if (!list) return;
    const fit = () => fitWholeRows(list, "[data-slot=command-item]");
    const more = () => markMore(list);
    // what it holds (cmdk's sizer), and its own box (the dialog's layout settling after it mounts); once more a frame on
    const ro = new ResizeObserver(fit);
    ro.observe(list.firstElementChild ?? list);
    ro.observe(list);
    const frame = requestAnimationFrame(fit);
    window.addEventListener("resize", fit);
    list.addEventListener("scroll", more, { passive: true });
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
      list.removeEventListener("scroll", more);
      if (listRef.current === list) listRef.current = null;
    };
  }, []);
  // a reply chosen here puts focus in its draft itself: handed back on closing, focus would cancel it (converting the open draft)
  const tookFocus = useRef(false);
  const select = (c: PaletteCommand) => {
    if (c.page) return goTo(c.page);
    noteUse(c.id);
    tookFocus.current = !!c.takesFocus;
    close();
    c.run?.();
  };
  const inDraft = (fn: (d: DraftCommands) => void) => () => {
    if (draftKey) runInDraft(draftKey, fn);
  };
  const ids = () => {
    const target = currentTargets();
    return "ids" in target ? target.ids : [];
  };

  const commands: PaletteCommand[] = [];
  const add = (c: PaletteCommand) => commands.push(c);
  if (open) {
    // ── the draft the palette was opened from
    if (draft && draftState) {
      if (draftState.send) add({ id: "draft.send", group: "draft", label: t("common.send"), icon: <Send />, shortcut: keysOf("compose.send"), testId: "palette-draft-send", ...synonyms("palette.alias.send", english("common.send")), draft: true, run: inDraft((d) => d.send()) });
      // plan 133: the row, in this draft
      if (drafting && draftState.link) add({ id: "draft.ai", group: "draft", label: t("palette.aiDraft"), icon: <Sparkles />, shortcut: keysOf("compose.ai"), testId: "palette-draft-ai", ...synonyms("palette.alias.aiDraft", english("palette.aiDraft")), draft: true, run: () => draftKey && runInDraft(draftKey, () => openAiDraft({ key: draftKey })) });
      // plan 93: snippets, while the text can change
      if (draftState.link) add({ id: "draft.snippet", group: "draft", label: t("palette.insertSnippet"), icon: <NotepadText />, shortcut: keysOf("snippets.open"), testId: "palette-draft-snippet", ...synonyms("palette.alias.snippet", english("palette.insertSnippet")), page: "snippets" });
      if (draftState.attach) add({ id: "draft.attach", group: "draft", label: t("attachments.attach"), icon: <Paperclip />, testId: "palette-draft-attach", ...synonyms("palette.alias.attach", english("attachments.attach")), draft: true, run: inDraft((d) => d.attach()) });
      if (draftState.addCc) add({ id: "draft.cc", group: "draft", label: t("palette.addCc"), icon: <AtSign />, testId: "palette-draft-cc", keywords: english("palette.addCc"), draft: true, run: inDraft((d) => d.showCc()) });
      if (draftState.addBcc) add({ id: "draft.bcc", group: "draft", label: t("palette.addBcc"), icon: <AtSign />, testId: "palette-draft-bcc", keywords: english("palette.addBcc"), draft: true, run: inDraft((d) => d.showBcc()) });
      if (draftState.link) add({ id: "draft.link", group: "draft", label: t("compose.link.insert"), icon: <Link />, shortcut: "mod+l", testId: "palette-draft-link", keywords: english("compose.link.insert"), draft: true, run: inDraft((d) => d.link()) });
      if (draftState.link) add({ id: "draft.saveSnippet", group: "draft", label: t("palette.saveAsSnippet"), icon: <BookmarkPlus />, testId: "palette-draft-save-snippet", keywords: english("palette.saveAsSnippet"), draft: true, run: () => draftKey && runInDraft(draftKey, () => void saveDraftAsSnippet(draftKey)) });
      if (draftState.pin) add({ id: "draft.pin", group: "draft", label: t("compose.pin"), icon: <Pin />, testId: "palette-draft-pin", keywords: english("compose.pin"), draft: true, run: inDraft((d) => d.pin()) });
      if (draftState.unpin) add({ id: "draft.unpin", group: "draft", label: t("compose.unpin"), icon: <PinOff />, testId: "palette-draft-unpin", keywords: english("compose.unpin"), draft: true, run: inDraft((d) => d.unpin()) });
      if (draftState.discard) add({ id: "draft.discard", group: "draft", label: t("compose.discard"), icon: <Trash2 />, testId: "palette-draft-discard", ...synonyms("palette.alias.discard", english("compose.discard")), draft: true, run: inDraft((d) => d.discard()) });
    }

    // ── plan 93: snippets (the page's rows, and each reached from the root by typing its name)
    const inDraftNow = draft !== null && draftState?.link === true;
    if (!inDraftNow) add({ id: "snippet.newMessage", group: "actions", label: t("palette.newFromSnippet"), icon: <NotepadText />, shortcut: keysOf("snippets.open"), testId: "palette-new-from-snippet", ...synonyms("palette.alias.snippet", english("palette.newFromSnippet")), page: "snippets" });
    const newSnippet = () => {
      openSnippetEditor(newSnippetId(), { fresh: true });
      setApp({ dialog: "settings", settingsTab: "snippets" });
    };
    // most used first, then by name
    const used = (s: Snippet) => usage.get(`snippet:${s.id}`)?.n ?? 0;
    for (const s of [...snippets].sort((a, b) => used(b) - used(a))) {
      const name = s.name || t("snippets.untitled");
      const use = inDraftNow ? () => draftKey && runInDraft(draftKey, () => insertSnippetInto(draftKey, s)) : () => void newMessageFromSnippet(s);
      const id = `snippet:${s.id}`;
      add({ id, group: "snippets", label: name, search: `${name} ${s.bodyText.slice(0, 200)}`, icon: <NotepadText />, hint: snippetPreview(s, 60), testId: `palette-snippet-${s.id}`, draft: inDraftNow, run: use });
      add({ id, group: inDraftNow ? "draft" : "actions", label: t(inDraftNow ? "palette.snippet.insert" : "palette.snippet.newFrom", { name }), search: name, icon: <NotepadText />, hint: snippetPreview(s, 40), keywords: [...english("palette.search.snippet").map((w) => `${w} ${name}`), `${t("palette.search.snippet")} ${name}`], searchOnly: true, scale: inDraftNow ? 1 : 0.5, draft: inDraftNow, run: use });
    }
    add({ id: "snippet.new", group: "snippetsManage", label: t("palette.newSnippet"), icon: <Plus />, testId: "palette-snippet-new", keywords: english("palette.newSnippet"), run: newSnippet });

    // ── go to
    /** The heading names them, so the rows don't; "go to reminders" still finds them. */
    const goTo = (key: "palette.goToday" | "palette.goFollowups" | "palette.goReminders") => `${t("palette.group.goTo")} ${t(key)}`;
    const folder = (id: string, key: "view.inbox" | "view.starred" | "view.sent" | "view.archive" | "view.spam" | "view.trash" | "view.all", icon: ReactNode, run: () => void, shortcut?: string, testId?: string) =>
      add({ id, group: "goTo", label: t(key), icon, shortcut, testId, keywords: english(key), run });
    folder("go.inbox", "view.inbox", <Inbox />, () => goToFolder("inbox"), keysOf("go.inbox"));
    folder("go.starred", "view.starred", <Star />, () => goToFolder("starred"), keysOf("go.starred"));
    folder("go.sent", "view.sent", <Send />, () => goToFolder("sent"), keysOf("go.sent"));
    folder("go.archive", "view.archive", <Archive />, () => goToFolder("archive"), keysOf("go.archive"));
    folder("go.spam", "view.spam", <OctagonAlert />, () => goToFolder("spam"), undefined, "palette-go-spam");
    folder("go.trash", "view.trash", <Trash2 />, () => goToFolder("trash"), keysOf("go.trash"));
    folder("go.all", "view.all", <Mails />, () => goToFolder("all"), undefined, "palette-go-all");
    if (todayOn) add({ id: "go.today", group: "goTo", label: t("palette.goToday"), icon: <Sun />, testId: "palette-go-today", keywords: [goTo("palette.goToday"), ...english("palette.goToday")], run: () => navigate({ today: true }) });
    if (followupsOn) add({ id: "go.followups", group: "goTo", label: t("palette.goFollowups"), icon: <ListChecks />, testId: "palette-go-followups", keywords: [goTo("palette.goFollowups"), ...english("palette.goFollowups")], run: () => navigate({ followups: true }) });
    add({ id: "go.reminders", group: "goTo", label: t("palette.goReminders"), icon: <Bell />, shortcut: keysOf("go.reminders"), testId: "palette-go-reminders", keywords: [goTo("palette.goReminders"), ...english("palette.goReminders")], run: () => navigate({ reminders: true }) });
    for (const c of categories) {
      add({ id: `category:${c.id}`, group: "goTo", label: c.name, search: `${t("palette.search.category")} ${c.name}`, icon: <CategoryDot color={c.color as CategoryColor} className="mx-1" />, keywords: english("palette.search.category"), run: () => navigate({ categoryId: c.id, accountId: null }) });
    }
    if (accounts.length > 1) {
      add({ id: "account:all", group: "goTo", label: t("sidebar.allAccounts"), search: `${t("palette.search.account")} ${t("sidebar.allAccounts")}`, icon: <Layers />, keywords: english("palette.search.account"), run: () => navigate({ view: "inbox", accountId: null }) });
    }
    for (const a of accounts) {
      add({ id: `account:${a.id}`, group: "goTo", label: a.displayName, hint: a.email, search: `${t("palette.search.account")} ${a.displayName} ${a.email}`, icon: <Layers />, keywords: english("palette.search.account"), run: () => goToAccount(a.id) });
    }
    // plan 108: the sidebar shows only that account, and search looks only in it ("All accounts" leaves)
    if (accounts.length > 1) {
      for (const a of accounts) {
        add({ id: `focus:${a.id}`, group: "goTo", label: t("palette.focusAccount", { account: a.displayName }), hint: a.email, search: `${t("palette.focusAccount", { account: a.displayName })} ${a.email}`, icon: <Focus />, testId: `palette-focus-${a.id}`, keywords: english("account.menu.focus"), run: () => focusAccount(a.id) });
      }
    }
    // plan 86: a Gmail account's Promotions and Social
    for (const a of accounts.filter(separatesTabs)) {
      for (const tab of TABS) {
        add({ id: `tab:${a.id}:${tab}`, group: "goTo", label: t(`view.tab.${tab}`), hint: a.displayName, search: `${t(`view.tab.${tab}`)} ${a.displayName} ${a.email}`, icon: tab === "promotions" ? <Tag /> : <Users />, keywords: english(`view.tab.${tab}`), run: () => navigate({ accountId: a.id, gmailTab: tab }) });
      }
    }

    // ── actions
    add({ id: "compose.new", group: "start", label: t("palette.compose"), icon: <PenLine />, shortcut: keysOf("compose.new"), testId: "palette-compose", ...synonyms("palette.alias.compose"), keywords: [...english("palette.compose"), ...english("palette.alias.compose").flatMap(words)], run: () => void openCompose("new") });
    // once the closing palette has given focus back (it would take it from the field)
    add({ id: "search.focus", group: "start", label: t("palette.searchMail"), icon: <Search />, shortcut: keysOf("search.focus"), testId: "palette-search-mail", ...synonyms("palette.alias.search", english("palette.searchMail")), run: () => requestAnimationFrame(() => requestAnimationFrame(focusSearchField)) });
    // plan 133: from a conversation or the list, the draft §5.2 opens, with its row
    if (drafting && !draft) add({ id: "compose.ai", group: "actions", label: t("palette.aiDraft"), icon: <Sparkles />, shortcut: keysOf("compose.ai"), testId: "palette-ai-draft", ...synonyms("palette.alias.aiDraft", english("palette.aiDraft")), run: () => requestAnimationFrame(() => requestAnimationFrame(() => openAiDraft())) }); // once the closing palette has given focus back: an open whose focus moves under it gives up
    if (targets > 0) {
      const withEnglish = (words: string[], alias: AliasKey) => {
        const s = synonyms(alias);
        return { aliases: s.aliases, keywords: [...words, ...s.keywords] };
      };
      // what would change something, as in the row menu ("select all N" holds rows it hasn't loaded: both read states)
      const rows = targetRows();
      const allStarred = rows.length > 0 && rows.every((r) => r.starred);
      const starKey = allStarred ? "actions.unstar" : "actions.star";
      const inHand: PaletteGroup = "conversation";
      // in the order they lead an empty root (CONVERSATION_LEAD)
      add({ id: "thread.archive", group: inHand, label: t("actions.archive"), icon: <Archive />, shortcut: keysOf("thread.archive"), ...withEnglish(english("palette.archive", { count: targets }), "palette.alias.archive"), run: () => void act("archive") });
      add({ id: "thread.trash", group: inHand, label: t("palette.trash"), icon: <Trash2 />, destructive: true, shortcut: keysOf("thread.trash"), ...withEnglish(english("palette.trash"), "palette.alias.trash"), run: () => void act("trash") });
      // Reply all: beside Reply where it reaches several people, as in the row menu and the toolbar (plan 158), else further down
      const replyAll = () => add({ id: "compose.replyAll", group: inHand, label: t("palette.replyAll"), icon: <ReplyAll />, shortcut: keysOf("compose.replyAll"), testId: "palette-reply-all", keywords: english("palette.replyAll"), takesFocus: true, run: () => reply("replyAll") });
      const several = replyable && openThread !== undefined && reachesSeveral(openThread, accounts.map((a) => a.email));
      if (replyable) {
        add({ id: "compose.reply", group: inHand, label: t("palette.reply"), icon: <Reply />, shortcut: keysOf("compose.reply"), testId: "palette-reply", ...synonyms("palette.alias.reply", english("palette.reply")), takesFocus: true, run: () => reply("reply") });
        if (several) replyAll();
        add({ id: "compose.forward", group: inHand, label: t("palette.forward"), icon: <Forward />, shortcut: keysOf("compose.forward"), testId: "palette-forward", ...synonyms("palette.alias.forward", english("palette.forward")), takesFocus: true, run: () => reply("forward") });
      }
      add({ id: "thread.star", group: inHand, label: t(starKey), icon: <Star />, shortcut: keysOf("thread.star"), ...withEnglish([t("actions.star"), t("actions.unstar"), ...english("actions.star"), ...english("actions.unstar")], "palette.alias.star"), run: () => toggleStar(undefined, { announce: true }) });
      if (scoped || rows.some((r) => r.unread)) add({ id: "thread.markRead", group: inHand, label: t("palette.markRead"), icon: <MailOpen />, shortcut: keysOf("thread.markRead"), ...withEnglish(english("palette.markRead"), "palette.alias.markRead"), run: () => void act("markRead", undefined, { announce: true }) });
      if (scoped || rows.some((r) => !r.unread)) add({ id: "thread.markUnread", group: inHand, label: t("palette.markUnread"), icon: <Mail />, shortcut: keysOf("thread.toggleRead"), ...withEnglish(english("palette.markUnread"), "palette.alias.markUnread"), run: () => void act("markUnread", undefined, { announce: true }) });
      if (!scoped) add({ id: "thread.remind", group: inHand, label: t("palette.remind"), icon: <Bell />, shortcut: keysOf("thread.remind"), testId: "palette-remind", ...withEnglish(english("palette.remind"), "palette.alias.remind"), page: "remind" });
      // a "select all N" moves nothing in the palette: the picker says why (moves need selected conversations)
      add({ id: "thread.move", group: inHand, label: t("palette.move"), icon: <FolderInput />, shortcut: keysOf("thread.move"), testId: "palette-move", ...withEnglish(english("palette.move"), "palette.alias.move"), ...(scoped ? { run: () => setApp({ dialog: "categoryPicker", pickerMode: "move" }) } : { page: "move" as const }) });
      add({ id: "thread.addTo", group: inHand, label: t("palette.addToCategory"), icon: <Tag />, testId: "palette-add-to", keywords: english("palette.addToCategory"), page: "addTo" });
      add({ id: "thread.spam", group: inHand, label: t("palette.spam"), icon: <OctagonAlert />, shortcut: keysOf("thread.spam"), ...withEnglish(english("palette.spam"), "palette.alias.spam"), run: () => void act("spam") });
      if (replyable && !several) replyAll();

      const targetIds = scoped ? [] : ids();
      for (const c of categories) {
        const dot = <CategoryDot color={c.color as CategoryColor} className="mx-1" />;
        if (!scoped) {
          const moveTo = () => void moveToCategory(c.id, ids(), { source: "picker" });
          const disabled = targetIds.length > 0 && isExclusivelyIn(c.id, targetIds);
          add({ id: `move:${c.id}`, group: "move", label: c.name, icon: dot, testId: `palette-move-${c.id}`, disabled, run: moveTo });
          add({ id: `move:${c.id}`, group: "actions", label: t("palette.moveTo", { name: c.name }), search: `${t("palette.search.moveTo")} ${c.name}`, icon: dot, keywords: english("palette.search.moveTo").map((w) => `${w} ${c.name}`), disabled, searchOnly: true, scale: 0.5, run: moveTo });
        }
        const addTo = () => {
          const target = currentTargets();
          if ("scope" in target) void addScopeToCategory(c.id, target.scope);
          else void addToCategory(c.id, target.ids, { source: "picker" });
        };
        add({ id: `addTo:${c.id}`, group: "addTo", label: c.name, icon: dot, testId: `palette-add-page-${c.id}`, run: addTo });
        add({ id: `addTo:${c.id}`, group: "actions", label: t("palette.addTo", { name: c.name }), search: `${t("palette.search.addTo")} ${c.name}`, icon: dot, testId: `palette-add-${c.id}`, keywords: english("palette.search.addTo").map((w) => `${w} ${c.name}`), searchOnly: true, scale: 0.5, run: addTo });
      }

      if (!scoped) {
        const kinds: [ReminderKind, PaletteGroup, "remind.menu" | "remind.menuNoReply"][] = [["always", "remindAlways", "remind.menu"], ["noReply", "remindNoReply", "remind.menuNoReply"]];
        for (const [kind, group, kindKey] of kinds) {
          for (const p of remindPresets(new Date(now), kind)) {
            const id = `remind:${kind}:${p.id}`;
            const set = () => void setReminder(ids(), p.at, kind);
            const hint = presetWhen(p, now);
            add({ id, group, label: presetLabel(p.id), icon: <Bell />, hint, testId: `palette-remind-${kind}-${p.id}`, run: set });
            add({ id, group: "actions", label: t("palette.remindAt", { kind: t(kindKey), preset: presetLabel(p.id) }), icon: <Bell />, hint, keywords: [...english(kindKey), ...english("palette.alias.remind").flatMap(words)], searchOnly: true, scale: 0.5, run: set });
          }
          add({ id: `remind:${kind}:custom`, group, label: t("remind.pick"), icon: <CalendarClock />, testId: `palette-remind-${kind}-custom`, run: () => openRemind({ kind, custom: true }) });
        }
        if (reminder) add({ id: "remind:clear", group: "remindClear", label: t("remind.clear"), icon: <BellOff />, testId: "palette-remind-clear", run: () => void clearReminder([reminder.threadId]) });
      }
    }
    // plan 132 §7: the open conversation, never in spam or trash; no shortcut of its own
    if (canSummarize && replyable && summarizable(openThread?.thread)) {
      add({ id: "thread.summarize", group: "conversation", label: t("palette.summarize"), icon: <Sparkles />, testId: "palette-summarize", ...synonyms("palette.alias.summarize", english("palette.summarize")), run: () => void summarize(openThread!.thread.id) });
    }
    if (printable) {
      add({ id: "thread.print", group: "conversation", label: t("palette.print"), icon: <Printer />, shortcut: keysOf("thread.print"), testId: "palette-print", ...synonyms("palette.alias.print"), keywords: english("palette.print"), run: () => printCommand("print") });
      add({ id: "thread.exportPdf", group: "conversation", label: t("palette.exportPdf"), icon: <FileDown />, shortcut: keysOf("thread.exportPdf"), testId: "palette-pdf", keywords: english("palette.exportPdf"), run: () => printCommand("pdf") });
      // plan 149: the keyboard's way to the reader's menu; the digest's row isn't a conversation
      // plan 158: every message open, or folded again, in a conversation of several
      if (conversationKeys.current) add({ id: "message.toggleAll", group: "conversation", label: t(conversationKeys.current.allOpen() ? "reader.collapseAll" : "reader.expandAll"), icon: <Layers />, shortcut: keysOf("message.toggleAll"), testId: "palette-toggle-all", run: () => conversationKeys.current?.toggleAll() });
      if (!onDigest) add({ id: "thread.copyText", group: "conversation", label: t("threadMenu.copyText"), icon: <Copy />, testId: "palette-copy-text", ...synonyms("palette.alias.copyText", english("threadMenu.copyText")), run: copyOpenThread });
    }
    add({ id: "list.selectAll", group: "actions", label: t("palette.selectAll"), icon: <CheckCheck />, shortcut: keysOf("list.selectAll"), keywords: english("palette.selectAll"), run: selectAll });
    if (filter) {
      const filterWords = (key: FilterKey) => [...english(key), ...english("palette.search.unreadFilter")];
      const filterSearch = (key: FilterKey) => `${t(key)} ${t("palette.search.unreadFilter")}`;
      const toggle = filter === "on" ? "palette.showAll" : "palette.showUnread";
      add({ id: "filter.unread", group: "actions", label: t(toggle), search: filterSearch(toggle), icon: <ListFilter />, testId: "palette-unread-filter", keywords: filterWords(toggle), run: toggleUnreadFilter });
      if (active && active !== "unread") add({ id: "filter.all", group: "actions", label: t("palette.showAll"), search: filterSearch("palette.showAll"), icon: <ListFilter />, shortcut: keysOf("list.filterAll"), testId: "palette-filter-all", keywords: filterWords("palette.showAll"), run: () => setListFilter(undefined) });
      if (active !== "people" && supported.includes("people")) add({ id: "filter.people", group: "actions", label: t("palette.showPeople"), search: filterSearch("palette.showPeople"), icon: <Users />, testId: "palette-filter-people", keywords: filterWords("palette.showPeople"), run: () => setListFilter("people") });
      if (active !== "waiting" && supported.includes("waiting")) add({ id: "filter.waiting", group: "actions", label: t("palette.showWaiting"), search: filterSearch("palette.showWaiting"), icon: <Reply />, testId: "palette-filter-waiting", keywords: filterWords("palette.showWaiting"), run: () => setListFilter("waiting") });
      if (active !== "attachments") add({ id: "filter.attachments", group: "actions", label: t("palette.showAttachments"), search: filterSearch("palette.showAttachments"), icon: <Paperclip />, testId: "palette-filter-attachments", keywords: filterWords("palette.showAttachments"), run: () => setListFilter("attachments") });
      if (active !== "starred") add({ id: "filter.starred", group: "actions", label: t("palette.showStarred"), search: filterSearch("palette.showStarred"), icon: <Star />, testId: "palette-filter-starred", keywords: filterWords("palette.showStarred"), sameAs: "go.starred", run: () => setListFilter("starred") });
    }
    if (design) {
      for (const d of DESIGNS) {
        if (d.id === design) continue;
        add({ id: `design:${d.id}`, group: "actions", label: t("palette.style", { name: designName(d.id) }), icon: <Palette />, testId: `palette-design-${d.id}`, keywords: [...english("palette.styleKeyword"), t("palette.styleKeyword"), designName(d.id)], run: () => void updateAppearance({ design: d.id }) });
      }
    }
    add({ id: "action.undo", group: "actions", label: t("common.undo"), icon: <Undo2 />, shortcut: keysOf("action.undo"), ...synonyms("palette.alias.undo"), keywords: [...english("common.undo"), ...english("palette.alias.undo").flatMap(words)], run: undoLast });
    // plan 141; plan 147: only where it can run
    if (canAsk) {
      add({ id: "ask.open", group: "actions", label: t("palette.ask"), icon: <Sparkles />, shortcut: keysOf("ask.open"), testId: "palette-ask", ...synonyms("palette.alias.ask", english("palette.ask")), page: "ask" });
      add({ id: "ask.history", group: "actions", label: t("palette.askHistory"), icon: <Clock />, testId: "palette-ask-history", keywords: english("palette.askHistory"), page: "askHistory" });
    }
    if (canAi) add({ id: "filters.ai", group: "actions", label: t("palette.aiFilter"), icon: <Sparkles />, ...synonyms("palette.alias.aiFilter"), keywords: [...english("palette.aiFilter"), ...english("palette.alias.aiFilter").flatMap(words)], run: () => setApp({ dialog: "filters" }) });
    add({
      id: "appearance.theme",
      group: "actions",
      label: t("palette.theme"),
      icon: (
        <>
          <Moon className="dark:hidden" />
          <Sun className="hidden dark:block" />
        </>
      ),
      ...synonyms("palette.alias.theme"),
      keywords: [...english("palette.theme"), ...english("palette.alias.theme").flatMap(words)],
      run: () => void updateAppearance({ theme: document.documentElement.classList.contains("dark") ? "light" : "dark" }),
    });
    add({ id: "help.shortcuts", group: "actions", label: t("shortcuts.title"), icon: <Keyboard />, shortcut: keysOf("help.shortcuts"), testId: "palette-shortcuts", ...synonyms("palette.alias.shortcuts"), keywords: [...english("shortcuts.title"), ...english("palette.alias.shortcuts").flatMap(words)], run: () => setApp({ dialog: "shortcuts" }) });
    if (updatesAvailable) add({ id: "updates.check", group: "actions", label: t("updates.palette.check"), icon: <RefreshCw />, testId: "palette-check-updates", keywords: english("updates.palette.check"), run: () => void checkForUpdates() });
    if (readyVersion) add({ id: "updates.restart", group: "actions", label: t("updates.pill.restart"), search: `${t("updates.pill.restart")} ${readyVersion}`, icon: <RotateCw />, testId: "palette-restart-update", keywords: english("updates.pill.restart"), run: () => void installUpdate() });

    // ── settings
    for (const { value: tab, label, icon: Icon } of hasDevMode ? [...SETTINGS_TABS, DEV_TAB] : SETTINGS_TABS) {
      add({
        id: `settings:${tab}`,
        group: "settings",
        label: `${t("common.settings")} ${label}`,
        display: (
          <>
            {t("common.settings")} <span aria-hidden>→</span> {label}
          </>
        ),
        icon: <Icon />,
        shortcut: tab === "general" ? keysOf("settings.open") : undefined,
        testId: `palette-settings-${tab}`,
        // Rules were Filters: the old word still finds them
        ...(tab === "filters" ? { aliases: words(t("palette.alias.aiFilter")).map((w) => `${t("common.settings")} ${w}`) } : {}),
        // plan 158: "preferences" finds where they start
        ...(tab === "general" ? synonyms("palette.alias.settings", english("common.settings")) : { keywords: english("common.settings") }),
        run: () => setApp({ dialog: "settings", settingsTab: tab }),
      });
    }
    add({ id: "settings.newSnippet", group: "settings", label: t("palette.newSnippet"), icon: <Plus />, testId: "palette-settings-new-snippet", keywords: english("palette.newSnippet"), run: newSnippet });
  }

  const query = value.trim();
  const groups = open ? arrange(commands, page, value, usage, now) : [];
  // plan 158: one conversation in hand is named over its actions (the reader may show another, or the row be out of view)
  // (only when it's also the one the reader's actions there act on: a checked row beside another open one isn't named)
  const named = open && targets === 1 && !scoped && (checkedOne === null || checkedOne === openId) ? (targetRows()[0] ?? null) : null;
  const soloId = useApp((s) => s.soloAccountId);
  // (the filter the list would keep: what's offered is what the results will hold)
  const mail = useFoundMail(query, open && page === "root", soloId, active);
  const drafted = useDrafts((s) => (mail ? draftIndex(s.drafts).written : NO_IDS));
  // plan 158: nothing named outright, so it's about mail: the search leads, and Enter runs it
  const aboutMail = page === "root" && query !== "" && !namesCommand(groups, value);
  // plan 161, pass 3: a sentence that's plainly an instruction ("Archive shipping notices older than a month") is AI's
  // first, and says what it does; any other text keeps the search first, as before
  const instruction = aboutMail && canAsk && isInstruction(query);
  // the search that found it, whatever's typed by now: the row opens among its own results, and is what acts on next
  const openFound = (id: number, query: string) => {
    close();
    // as a click on a row: a new message in the pane steps aside (it stays in the drafts), and it's a search, not Review
    setApp({ query, checked: new Set(), scope: null, compose: null, reviewCategoryId: null });
    openConversation(id);
  };
  const mailRows = page === "root" && query && (
    <>
      <CommandGroup value="search" forceMount>
        <CommandItem forceMount value={`search\u0000${value}`} data-testid="palette-search-row" onSelect={() => { close(); setApp({ query: value }); }}>
          {/* plan 108: focused, a search looks only in that account (Codex code review #4) */}
          <Search /> <span className="truncate">{soloName === null ? t("palette.searchAll", { query: value }) : t("palette.searchIn", { query: value, account: soloName })}</span>
        </CommandItem>
      </CommandGroup>
      {mail && mail.rows.length > 0 && (
        <CommandGroup value="mail" heading={t("palette.group.mail")} forceMount data-group="mail">
          {mail.rows.map((r) => (
            <CommandItem key={r.id} forceMount value={`mail\u0000${r.id}`} data-testid="palette-mail" data-thread-id={r.id} onSelect={() => openFound(r.id, mail.query)}>
              <Mail />
              <span className="max-w-[40%] shrink-0 truncate">{r.fromName || r.fromEmail}</span>
              <span className="min-w-0 truncate font-normal text-muted-foreground">{r.subject || t("common.noSubject")}</span>
              {/* plan 158: what tells two alike apart, as their rows in the list do: a draft, and the account */}
              {drafted.has(r.id) && <span data-testid="palette-mail-draft" className="shrink-0 text-xs font-medium text-draft-foreground">{t("list.draft")}</span>}
              {/* the account bounded, so a long one never takes the subject's room */}
              {accounts.length > 1 && <CommandDescription className="max-w-32 shrink-0" data-testid="palette-mail-account">{accounts.find((a) => a.id === r.accountId)?.displayName}</CommandDescription>}
              <CommandDescription className={cn("min-w-14 shrink-0 text-right tabular", accounts.length > 1 && "ms-0")}>{listDate(r.lastDate)}</CommandDescription>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
  // a page's create row, and the root's search: always there while typing, last (Enter on a match wins)
  const exact = categories.some((c) => normalizeText(c.name) === normalizeText(query));
  const create = (page === "move" || page === "addTo") && query !== "" && !exact;
  const createAnd = async () => {
    const name = query;
    const intoMove = page === "move";
    // the conversations it was picked for, before the create's wait (the selection may move meanwhile)
    const target = currentTargets();
    close();
    let id: number;
    try {
      id = await createCategory(name);
    } catch (error) {
      snack.error(t("category.addFailed", { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (intoMove && "ids" in target) void moveToCategory(id, target.ids, { source: "picker" });
    else if ("scope" in target) void addScopeToCategory(id, target.scope);
    else void addToCategory(id, target.ids, { source: "picker" });
  };

  const askRow = (
    <CommandGroup value="ask" forceMount>
      <CommandItem forceMount value={`ask\u0000${value}`} data-testid="palette-ask-row" data-instruction={instruction || undefined} onSelect={() => { askFrom.question = value; goTo("ask"); }}>
        <Sparkles /> {t(instruction ? "palette.doRow" : "palette.askRow", { query: value })}
      </CommandItem>
    </CommandGroup>
  );

  // plan 162: one step back, to where the palette was opened from: Ask opened with ⌘⇧K closes (it was two presses)
  const back = () => {
    const to = paletteBack(page, usePalettePage.getState().entry);
    if (to === null) close();
    else goTo(to);
  };
  const pageName: Record<Exclude<PalettePage, "root">, string> = {
    move: t("category.picker.moveTitle"),
    addTo: t("palette.group.addTo", { count: targets }),
    remind: t("remind.title"),
    snippets: t("palette.group.snippets"),
    ask: t("palette.ask.page"),
    askHistory: t("palette.askHistory"),
  };
  const placeholder = page === "root" ? t("palette.placeholder") : page === "remind" ? t("palette.remindPlaceholder") : page === "snippets" ? t("palette.snippetsPlaceholder") : t("category.picker.placeholder");

  return (
    <CommandDialog open={open} onOpenChange={(o) => !o && close()} finalFocus={() => { const own = tookFocus.current; tookFocus.current = false; return own ? false : paletteReturn(); }} title={page === "ask" ? t("ask.dialog.title") : page === "askHistory" ? t("palette.askHistory") : t("palette.title")} description={page === "ask" || page === "askHistory" ? t("ask.dialog.description") : t("palette.description")} hints={page !== "ask"} className={page === "ask" || page === "askHistory" ? ASK_FITS : undefined}>
      {/* CommandDialog (base-nova) doesn't provide the cmdk root itself */}
      <Command
        className="min-h-0"
        // cmdk's Ctrl+J/K/N/P: off the Mac Ctrl+K is the palette's own chord (it closes it)
        vimBindings={isMac}
        // the palette filters and orders (arrange): cmdk keeps the selection and the keys
        shouldFilter={false}
        onKeyDownCapture={(e) => {
          if (page === "root") return;
          // a popup a page opened (Ask's "Written with AI ▾") is portalled out of the palette: its keys are its own, so its
          // Esc closes it and not the page under it (plan 161, pass 3)
          if (!e.currentTarget.contains(e.target as Node)) return;
          // and while it's open, its trigger's Esc is the popup's too: it closes it, not the page (Codex review)
          if (e.key === "Escape" && (e.target as Element | null)?.closest?.("[data-popup-open]")) return;
          // a page: Esc, or Backspace with nothing typed, goes back to all commands (Esc at the root closes)
          // (not while an input method composes, nor a held Backspace that just emptied the text)
          if (e.nativeEvent.isComposing) return;
          // plan 141: a running answer stops first; a second Esc goes back
          if (e.key === "Escape" && paletteKeys.escape?.()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          // only the palette's own input: a follow-up box types its own Backspace
          const inInput = (e.target as Element | null)?.closest?.("[data-testid=palette-input]") != null;
          if (e.key === "Escape" || (e.key === "Backspace" && inInput && value === "" && !e.repeat && !e.metaKey && !e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            back();
          }
        }}
      >
        {page === "ask" || page === "askHistory" ? (
          <AskPages page={page} value={value} setValue={setValue} onBack={back} onClose={close} />
        ) : (
        <>
        <CommandInput
          placeholder={placeholder}
          value={value}
          onValueChange={setValue}
          data-testid="palette-input"
          addon={
            page !== "root" && (
              // the page's name, its × the way back (Enter and Space on it stay out of the list's keys)
              <Chip
                data-testid="palette-page"
                onRemove={back}
                removeLabel={t("palette.back")}
                removeProps={{ "data-testid": "palette-back", onKeyDown: (e) => (e.key === "Enter" || e.key === " ") && e.stopPropagation() }}
              >
                {pageName[page]}
              </Chip>
            )
          }
        />
        {/* plan 158: as tall as what it holds, up to its maximum: the field stays put, the footer follows the last row.
            Taller than the base list where the window has room, so the places under an open conversation's actions show */}
        <CommandList ref={wholeRows} label={t("palette.results")} className="relative max-h-[min(30rem,55vh)] data-more:[mask-image:linear-gradient(to_top,transparent,black_0.375rem)]">
          {/* a row offered below says it already: the root's search while typing, a page's create */}
          {!(page === "root" && query) && !create && <CommandEmpty>{t("palette.empty")}</CommandEmpty>}
          {instruction && askRow}
          {aboutMail && mailRows}
          {groups.map(({ group, commands: list }) => (
            // an ASCII value: cmdk finds a group to sort it by its URL-encoded value (a heading with spaces never matched)
            <CommandGroup key={group} value={group} heading={group === "snippetsManage" && snippets.length === 0 && !query ? t("palette.snippets.empty") : group === "conversation" && named ? <TargetHeading row={named} /> : HEADINGS[group](targets)} data-group={group}>
              {list.map(({ command: c, alias }) => {
                return (
                  <CommandItem key={`${group}:${c.id}`} value={itemValue(c)} disabled={c.disabled} data-testid={c.testId} data-command={c.id} data-variant={c.destructive ? "destructive" : undefined} onSelect={() => select(c)}>
                    {c.icon} <span className="truncate">{c.display ?? c.label}</span>
                    {alias && <span className="shrink-0 text-muted-foreground" data-testid="palette-alias">({alias})</span>}
                    {c.hint && <CommandDescription>{c.hint}</CommandDescription>}
                    {c.shortcut && <CommandShortcut keys={c.shortcut} className={c.hint ? "ms-3" : undefined} />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
          {create && (
            <CommandGroup value="create" forceMount>
              <CommandItem forceMount value={`create\u0000${query}`} data-testid="palette-create" onSelect={() => void createAnd()}>
                <Plus /> {t(page === "move" ? "category.picker.createAndMove" : "category.picker.create", { name: query })}
              </CommandItem>
            </CommandGroup>
          )}
          {!aboutMail && mailRows}
          {/* plan 141: last, like search: Enter on a command that matches still wins */}
          {page === "root" && query && canAsk && !instruction && askRow}
        </CommandList>
        </>
        )}
      </Command>
    </CommandDialog>
  );
}
