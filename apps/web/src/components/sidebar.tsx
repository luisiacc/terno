import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { COUNTED_VIEWS, FOLDER_VIEWS, folderRef, separatesTabs, tabRef, TABS, viewRef, type Account, type Category, type CategoryColor, type CountedView, type Folder, type FolderView, type Tab, type View } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Sun, Archive, ArrowLeft, Bell, Check, ChevronDown, ChevronRight, EyeOff, Folder as FolderIcon, Forward, Inbox, Layers, OctagonAlert, Plus, Route, Send, Settings2, SquarePen, Star, Tag, Tags, Trash2, Users, ListChecks } from "@terno/ui/icons";
import { openCompose } from "~/lib/actions";
import { useDesign, variant } from "~/lib/design";
import { formatNumber, t } from "@terno/i18n";
import { viewLabel } from "~/lib/format";
import { getApp, navigate, setApp, useApp, type AppState } from "~/state/app";
import { useReminders } from "~/lib/reminders";
import { followupsOffered, todayOffered } from "~/lib/ai";
import { useFollowups } from "~/state/followups";
import { createCategory as createNamedCategory } from "~/lib/new-category";
import { offerTip, usePendingTip } from "~/lib/tips";
import { ACCOUNT_VIEWS, SOLO_VIEWS, listedByAccount, useFolderRows, toggleAccount, useOpenAccount, type FolderRow } from "~/lib/account-folders";
import { renderProbe } from "~/lib/render-probe";
import { enterReview, reviewTotals } from "~/lib/review";
import type { DropId } from "~/lib/drag";
import { useDropState } from "~/state/drag";
import { CloudAiPill } from "./cloud-ai-pill";
import { FirstSyncPill } from "./first-sync-pill";
import { ConnectionPill } from "./connection-pill";
import { SignInMarker, SignInNotice } from "./sign-in-notice";
import { UpdatePill } from "./update-pill";
import { CategoryMenu } from "./category-menu";
import { AccountMenu, leaveSoloKeepingFocus } from "./account-menu";
import { AddFolderButton, FolderMenu, FolderNameRow } from "./folder-rows";
import { createFolder, renameFolder, siblingsAt, siblingsOf, startCreate, stopEditing, useFolderEdit, type FolderTarget } from "~/lib/folders";
import { accountLabels } from "~/lib/account-labels";
import { patchAccount } from "~/lib/accounts";
import { snack } from "~/lib/snack";
import CategoryInboxTip from "./category-inbox-tip";
import TodayTip from "./today-tip";

const VIEWS: { view: View; icon: typeof Inbox; keys?: string }[] = [
  { view: "inbox", icon: Inbox, keys: "g i" },
  { view: "starred", icon: Star, keys: "g s" },
  { view: "sent", icon: Send, keys: "g t" },
  { view: "archive", icon: Archive, keys: "g a" },
  { view: "all", icon: Layers },
  { view: "spam", icon: OctagonAlert },
  { view: "trash", icon: Trash2, keys: "g #" },
];
/** always shown; the rest wait behind More (plan 21) */
const PINNED = 2;
const MORE_VIEWS = VIEWS.slice(PINNED).map((f) => f.view);

// ── More: open or closed, remembered on this device (like the format bar)

const MORE_KEY = "terno:sidebar-more";
function readMore(): boolean {
  try {
    return localStorage.getItem(MORE_KEY) === "open";
  } catch {
    return false;
  }
}
/**
 * Stacked rows share no margin, so a hovered row's fill would touch the selected one's: each fill
 * stops half a pixel short at the top and bottom (a transparent border it isn't painted under),
 * leaving a hairline between neighbors while the rows keep their height and pitch.
 */

/** Plan 113: the first new category's tip (components/tip), beside its row once the row is there. */
function CategoryTip() {
  const id = usePendingTip("category-inbox");
  const category = useApp((s) => (id === null ? undefined : s.categories.find((c) => c.id === id)));
  if (!category) return null;
  return (
    <CategoryInboxTip key={category.id} category={category} />
  );
}

const ROW_SEAM = "border-y-[0.5px] border-transparent bg-clip-padding";
/** An account's folders: one step in under it, one more per level of its own folders (plan 68), up to four */
const INSET = ["pl-7", "pl-10", "pl-13", "pl-16"];
/**
 * A folder's indent at `depth`. Plan 108: focused on its account, the folders sit flush (no account row above
 * them), and each level under a top one takes the steps a folder under an account does.
 */
function insetOf(depth: number, solo: boolean): string {
  const at = solo ? depth - 1 : depth;
  return at < 0 ? "" : (INSET[at] ?? INSET.at(-1)!);
}

export const useSidebarMore = create<{ open: boolean }>(() => ({ open: readMore() }));
function toggleMore(): void {
  const open = !useSidebarMore.getState().open;
  useSidebarMore.setState({ open });
  try {
    localStorage.setItem(MORE_KEY, open ? "open" : "closed");
  } catch {
    // private mode: remembered for this session only
  }
}

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  countTone = "muted",
  testId,
  dropTarget,
  reserveEnd,
  inset,
  depth = 0,
  expanded,
  controls,
  countHelp,
  shortcut,
  note,
  hoverAction,
  tip,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  /** the inbox's count in the unread color (the design decides) */
  countTone?: "muted" | "unread";
  testId?: string;
  /** rows can be dropped on it: a category's id, or (plan 127) a folder's `folderRef` */
  dropTarget?: DropId;
  /** room at the end for a control drawn over the row (a review badge; "icon": the sign-in key, plan 25) */
  reserveEnd?: boolean | "icon";
  /** a folder under its account (plan 67) */
  inset?: boolean;
  /** plan 68: how deep an account's own folder sits under its parents */
  depth?: number;
  /** an account: a disclosure of its folders (plan 67) */
  expanded?: boolean;
  controls?: string;
  /** a category's numbers in words, as the row's tooltip and description (described by its element `id`) */
  countHelp?: { id: string; text: string };
  shortcut?: string;
  /** a quiet mark after the name (plan 83: a category hidden from the Inbox) */
  note?: React.ReactNode;
  /** plan 107: a control over the row's end on hover (a folder's "+"): the count steps aside meanwhile */
  hoverAction?: boolean;
  /** plan 159: the row's whole sentence as its tooltip, where the label and count say it in parts (its name stays the
   * label and count, as the other rows': a name that doesn't start with what's shown is one a voice user can't say) */
  tip?: string;
}) {
  renderProbe("NavItem");
  // the perf gates tell the rows below More (which only slide when it toggles) from the folders
  if (import.meta.env.VITE_RENDER_PROBE) renderProbe(
      testId?.startsWith("nav-folder-") || testId?.startsWith("nav-own-") ? "NavItem:account-folder" : testId?.startsWith("nav-category-") || testId?.startsWith("nav-account-") ? "NavItem:below" : "NavItem:folder",
    );
  // only the item under the pointer (and the one it left) re-renders during a drag
  const drop = useDropState(dropTarget);
  const button = (
    <button
      type="button"
      aria-describedby={countHelp?.id}
      data-testid={testId}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      data-drop-target={typeof dropTarget === "number" ? dropTarget : undefined}
      data-drop-folder={typeof dropTarget === "string" ? dropTarget : undefined}
      data-drop-state={drop ?? undefined}
      onClick={onClick}
      className={cn(
        "group type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-sidebar-foreground transition-colors",
        ROW_SEAM,
        inset && (INSET[depth] ?? INSET.at(-1)),
        reserveEnd === "icon" ? "pr-8" : reserveEnd && "pr-14",
        "not-data-active:hover:bg-sidebar-hover hover:text-sidebar-accent-foreground",
        "data-active:type-nav-strong data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground",
        "data-[drop-state=over]:bg-drop-target data-[drop-state=over]:text-sidebar-accent-foreground data-[drop-state=over]:ring-1 data-[drop-state=over]:ring-primary data-[drop-state=over]:ring-inset",
        "data-[drop-state=already]:bg-sidebar-accent data-[drop-state=already]:text-muted-foreground",
        "data-[drop-state=refused]:bg-transparent data-[drop-state=refused]:text-muted-foreground",
      )}
    >
      <span data-slot="nav-icon" className="flex size-(--icon-nav) items-center justify-center text-sidebar-glyph transition-transform group-data-[drop-state=over]:scale-125">{icon}</span>
      {expanded === undefined ? (
        note ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate">{label}</span>
            {note}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{label}</span>
        )
      ) : (
        // the disclosure's mark beside the name: shown while open, and on hover or focus while closed
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate">{label}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-[transform,opacity] duration-fast ease-motion",
              expanded ? "rotate-90" : "opacity-0 group-hover:opacity-100 group-focus-reveal:opacity-100",
            )}
          />
        </span>
      )}
      {drop === "already" && <Check aria-label={t("sidebar.alreadyHere")} className="size-3.5 text-muted-foreground" />}
      {count ? (
        <span data-slot="nav-count" className={cn("inline-block text-xs tabular", countTone === "unread" ? "font-semibold text-unread-ink" : "text-muted-foreground", hoverAction && "group-hover/row:invisible")}>
          {formatNumber(count)}
        </span>
      ) : null}
    </button>
  );
  if (!countHelp && !shortcut && !tip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">
        {tip ?? countHelp?.text}
        {shortcut && <Shortcut keys={shortcut} />}
      </TooltipContent>
    </Tooltip>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="group/section mt-(--nav-section-gap) mb-0.5 flex min-h-(--nav-section-h) items-center justify-between px-2">
      <span className="type-section-label text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

/** Atelier: "New message" as an outlined button at the top of the sidebar, its key beside it. */
function ComposeOutline() {
  return (
    <div className="shrink-0 px-2 pb-3">
      <button type="button" data-testid="compose-button" onClick={() => openCompose("new")} className="type-compose flex h-9 w-full items-center gap-2.5 rounded-lg bg-card px-3 text-left text-foreground shadow-raised transition-[background-color,box-shadow] hover:bg-muted">
        <SquarePen className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate">{t("compose.newMessage")}</span>
        <Shortcut keys="c" />
      </button>
    </div>
  );
}

/** Lumen: "Compose" as a soft raised pill, modest beside the mail: the solid fill is for the one action of the task at hand (Send, Archive). */
function ComposePill() {
  return (
    <div className="shrink-0 px-2 pb-3">
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" data-testid="compose-button" onClick={() => openCompose("new")} className="type-compose flex h-9 w-full items-center gap-2.5 rounded-full border border-border bg-card pr-3 pl-2 text-left text-foreground shadow-xs transition-colors outline-none hover:border-input hover:bg-muted focus-visible:ring-2 focus-visible:ring-sidebar-ring">
              <span className="flex size-(--icon-nav) items-center justify-center text-muted-foreground">
                <SquarePen className="size-(--icon-nav)" />
              </span>
              {t("list.compose")}
            </button>
          }
        />
        <TooltipContent>
          {t("list.compose")} <Shortcut keys="c" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** A category row's tooltip: "11 unread, 4 suggested for this category"; null with neither. */
function categoryHelp(unread: number, suggested: number): string | null {
  const u = unread ? t("sidebar.categoryHelp.unread", { count: unread }) : null;
  const s = suggested ? t("sidebar.categoryHelp.suggested", { count: suggested }) : null;
  return u && s ? t("sidebar.categoryHelp.both", { unread: u, suggested: s }) : u ?? s;
}

/** Graphite: "New message" as the first row of the mailboxes, on their line and pitch, a step stronger than them; the calls to action are the only pills. */
function ComposeRow() {
  return (
    <div className="shrink-0 px-(--sidebar-pad)">
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" data-testid="compose-button" onClick={() => openCompose("new")} className={cn("type-nav-strong flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-sidebar-accent-foreground transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring", ROW_SEAM)}>
              <span className="flex size-(--icon-nav) items-center justify-center text-sidebar-accent-foreground">
                <SquarePen className="size-(--icon-nav)" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t("compose.newMessage")}</span>
            </button>
          }
        />
        <TooltipContent side="right">
          {t("compose.newMessage")} <Shortcut keys="c" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Plan 159: the categories' suggestions as a row like the others, first under their heading: "Sort into categories",
 * how many in all as its count, the sentence whole as its tooltip. A click opens the Review of the category with
 * the most, whose header switches between them; each category's own is in its menu, its count in its row's tooltip.
 */
function ReviewRow({ categories, suggestions, reviewing }: { categories: readonly Category[]; suggestions: Readonly<Record<number, number>>; reviewing: boolean }) {
  const { total, pending } = reviewTotals(categories, suggestions);
  const most = pending[0];
  // shown with something to sort, and while you're sorting (its last one answered, it's still where you are)
  if (!most && !reviewing) return null;
  const to = most?.category.id;
  return (
    <NavItem
      testId="nav-review"
      active={reviewing}
      onClick={() => to !== undefined && enterReview(to)}
      icon={<Tags className="size-(--icon-nav)" />}
      label={t("sidebar.sort")}
      count={total}
      tip={total ? t("sidebar.reviewAll", { count: total }) : undefined}
    />
  );
}

/**
 * Sent, Archive, All Mail, Spam and Trash behind a quiet More (plan 21). Closed,
 * the group takes no space (plan 40): each slot is a 0fr grid row that grows to
 * its row when shown, and what's below slides with it (CSS transitions only;
 * the content below sits on its own layer, so the slide re-records nothing).
 * The folder you're in is shown while More is closed; one you leave with a
 * click in the sidebar stays until the pointer leaves it, so nothing moves
 * under the pointer. A hidden slot is inert: not focusable, not clickable, not
 * in the accessibility tree.
 */
/** A row behind More: one of the views, or Reminders (plan 87) */
type MoreSlot = View | "reminders" | "followups";

/**
 * Plan 107: favorite folders, right below Starred: an account's own folder or one of its standard rows, each a way
 * there with its unread count where the sidebar has one, its menu, and (with several accounts) whose it is.
 * One that's gone (deleted elsewhere, its account removed) isn't drawn.
 */
function FavoriteRows() {
  const favorites = useApp((s) => s.settings?.favoriteFolders);
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  const counts = useApp((s) => s.counts);
  // where you are, as primitives (an object would re-render this on every change of the store)
  // (plan 158: a search is nowhere in the sidebar: it looks everywhere)
  const plain = useApp((s) => s.accountId !== null && s.reviewCategoryId === null && s.categoryId === null && s.gmailTab === null && !s.reminders && !s.followups && !s.today && s.query.trim() === "");
  const hereAccount = useApp((s) => s.accountId);
  const hereFolder = useApp((s) => s.folder);
  const hereView = useApp((s) => s.view);
  const here = plain ? { accountId: hereAccount, folder: hereFolder, view: hereView } : null;
  const labels = useMemo(() => accountLabels(accounts), [accounts]);
  const rows = (favorites ?? []).flatMap((f) => {
    const account = accounts.find((a) => a.id === f.accountId);
    if (!account) return [];
    if (f.folder !== null) {
      const folder = folders.find((x) => x.accountId === f.accountId && x.key === f.folder && x.selectable);
      return folder ? [{ f, account, name: folder.path.at(-1)!, icon: <FolderIcon className="size-(--icon-nav)" />, count: counts.folderUnread?.[folderRef(f.accountId, f.folder)] }] : [];
    }
    const Icon = VIEWS.find((v) => v.view === f.view)!.icon;
    return [{ f, account, name: viewLabel(f.view!), icon: <Icon className="size-(--icon-nav)" />, count: f.view === "inbox" ? counts.inboxUnreadByAccount[f.accountId] : undefined }];
  });
  // a focused favorite that goes from under the keyboard (removed or renamed in another window, round 25 #4): the
  // one now in its place takes the focus (a rename keeps its place), else the last, else its account's row
  const groupRef = useRef<HTMLDivElement>(null);
  const focused = useRef<{ id: string; index: number; accountId: number } | null>(null);
  const ids = rows.map(({ f }) => `nav-fav-${f.accountId}-${f.folder ?? f.view}`);
  useLayoutEffect(() => {
    const was = focused.current;
    if (!was || ids.includes(was.id)) return;
    focused.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const at = ids[Math.min(was.index, ids.length - 1)];
    const target = at ? groupRef.current?.querySelector<HTMLElement>(`[data-testid="${CSS.escape(at)}"]`) : document.querySelector<HTMLElement>(`[data-testid="nav-account-${was.accountId}"]`);
    target?.focus({ preventScroll: true });
  });
  if (rows.length === 0) return null;
  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={t("sidebar.favorites")}
      data-testid="nav-favorites"
      onFocus={(e) => {
        const id = (e.target as HTMLElement).dataset.testid ?? "";
        const index = ids.indexOf(id);
        focused.current = index < 0 ? null : { id, index, accountId: rows[index]!.f.accountId };
      }}
      onBlur={(e) => {
        // left on purpose (Tab away, a click elsewhere) unless the row itself went: told apart a frame later
        const left = e.target as HTMLElement;
        requestAnimationFrame(() => {
          if (left.isConnected && !groupRef.current?.contains(document.activeElement)) focused.current = null;
        });
      }}
    >
      {rows.map(({ f, account, name, icon, count }) => {
        const target = (f.folder !== null ? { accountId: f.accountId, folder: f.folder, view: null } : { accountId: f.accountId, folder: null, view: f.view! }) as FolderTarget;
        const active = here !== null && here.accountId === f.accountId && (f.folder !== null ? here.folder === f.folder : here.folder === null && here.view === f.view);
        return (
          <FolderMenu key={`${f.accountId}:${f.folder ?? `~${f.view}`}`} target={target} name={name} account={account} favoriteRow>
            <div>
              <NavItem
                testId={`nav-fav-${f.accountId}-${f.folder ?? f.view}`}
                dropTarget={f.folder !== null ? folderRef(f.accountId, f.folder) : undefined}
                active={active}
                onClick={() => (f.folder !== null ? navigate({ accountId: f.accountId, folder: f.folder }) : navigate({ accountId: f.accountId, view: f.view! }))}
                icon={icon}
                label={name}
                count={count || undefined}
                // with several accounts, whose it is, quietly (plan 23's label)
                note={accounts.length > 1 ? <span className="min-w-0 truncate text-2xs text-muted-foreground" title={account.email}>{labels.get(account.id)?.text}</span> : undefined}
              />
            </div>
          </FolderMenu>
        );
      })}
    </div>
  );
}

/** The More row you're in (none inside an account, a category or its suggestions) */
function moreSlotOf(s: AppState): MoreSlot | null {
  if (s.reminders) return "reminders";
  if (s.followups) return "followups";
  if (s.today) return null;
  return s.accountId === null && s.categoryId === null && s.reviewCategoryId === null && MORE_VIEWS.includes(s.view) ? s.view : null;
}

function MoreFolders({ view, folder, reminders, followups }: { view: View | null; folder: (f: (typeof VIEWS)[number]) => React.ReactNode; reminders: React.ReactNode; followups: React.ReactNode }) {
  const open = useSidebarMore((s) => s.open);
  const inReminders = useApp((s) => s.reminders);
  // a due reminder shows its row even with More closed: its count is never behind a fold
  const due = useReminders((s) => s.due > 0);
  const inFollowups = useApp((s) => s.followups);
  const followupsDue = useFollowups((s) => s.due > 0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  // folders shown only because you were in them, kept after a click in the sidebar took you elsewhere
  const [held, setHeld] = useState<MoreSlot[]>([]);
  useEffect(() => {
    const aside = toggleRef.current?.closest("aside");
    const group = groupRef.current;
    if (!aside || !group) return;
    let over = false;
    /** the hidden folder you were in when a mouse click landed here; held only if that click takes you elsewhere */
    let armed: MoreSlot | null = null;
    const drop = () => setHeld((h) => (h.length ? [] : h));
    // captured, so it runs before the click's own handler: with a mouse or pen (a keyboard's click or a tap has no pointer resting here)
    const click = (e: MouseEvent) => {
      const type = (e as PointerEvent).pointerType;
      if ((type !== "mouse" && type !== "pen") || useSidebarMore.getState().open) return;
      const slot = moreSlotOf(getApp());
      if (slot === null) return;
      armed = slot;
    };
    // the click's dispatch is over (the window hears it last): one that went nowhere (the folder's own row, the + of
    // Categories) holds nothing. A key or a press disarms too, in case a handler stopped the click on its way up
    const disarm = () => (armed = null);
    // the click navigated (synchronously, inside its handler): the hold joins that render
    const unsubscribe = useApp.subscribe((s) => {
      if (armed === null || moreSlotOf(s) === armed) return;
      const left = armed;
      armed = null;
      setHeld((h) => (h.includes(left) ? h : [...h, left]));
    });
    const enter = (e: PointerEvent) => (over = e.pointerType !== "touch");
    // the pointer left, or something covered the sidebar (a dialog): they go, except under keyboard focus (then on blur)
    const leave = () => {
      over = false;
      if (!group.contains(document.activeElement)) drop();
    };
    const blur = (e: FocusEvent) => {
      if (!over && !group.contains(e.relatedTarget as Node | null)) drop();
    };
    aside.addEventListener("click", click, true);
    window.addEventListener("click", disarm);
    window.addEventListener("keydown", disarm, true);
    window.addEventListener("pointerdown", disarm, true);
    aside.addEventListener("pointerenter", enter);
    aside.addEventListener("pointerleave", leave);
    group.addEventListener("focusout", blur);
    return () => {
      unsubscribe();
      aside.removeEventListener("click", click, true);
      window.removeEventListener("click", disarm);
      window.removeEventListener("keydown", disarm, true);
      window.removeEventListener("pointerdown", disarm, true);
      aside.removeEventListener("pointerenter", enter);
      aside.removeEventListener("pointerleave", leave);
      group.removeEventListener("focusout", blur);
    };
  }, []);
  // a focused folder just hidden (More closed over it, a key went elsewhere, a held one let go): focus goes to More,
  // not to the document (the browser drops focus from an inert node only at the next frame, so it's still there now)
  useLayoutEffect(() => {
    if (document.activeElement?.closest("[data-more-slot][inert]")) toggleRef.current?.focus({ preventScroll: true });
  }, [open, view, held]);
  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        data-testid="nav-more"
        aria-expanded={open}
        aria-controls="sidebar-more-folders"
        onClick={() => {
          // toggling on purpose lets held folders go (the one you're in stays)
          setHeld([]);
          toggleMore();
        }}
        className={cn("group/more type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-accent-foreground", ROW_SEAM)}
      >
        <span className="flex size-(--icon-nav) items-center justify-center">
          <ChevronDown className={cn("size-3.5 transition-transform duration-base ease-motion", !open && "-rotate-90")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{open ? t("sidebar.less") : t("sidebar.more")}</span>
      </button>
      <div ref={groupRef} id="sidebar-more-folders" role="group" aria-label={t("sidebar.moreFolders")}>
        {(() => {
          const shown = open || inReminders || due || held.includes("reminders");
          return (
            <div
              data-more-slot="reminders"
              data-active-slot={inReminders || undefined}
              data-shown={shown || undefined}
              inert={!shown}
              className="invisible grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility] duration-base ease-motion data-shown:visible data-shown:grid-rows-[1fr] data-shown:opacity-100 data-shown:duration-slow data-shown:[transition-timing-function:var(--ease-drawer),linear,var(--ease-drawer)]"
            >
              <div className="min-h-0 overflow-clip [overflow-clip-margin:3px]">{reminders}</div>
            </div>
          );
        })()}
        {followups && (() => {
          const shown = open || inFollowups || followupsDue || held.includes("followups");
          return (
            <div
              data-more-slot="followups"
              data-active-slot={inFollowups || undefined}
              data-shown={shown || undefined}
              inert={!shown}
              className="invisible grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility] duration-base ease-motion data-shown:visible data-shown:grid-rows-[1fr] data-shown:opacity-100"
            >
              <div className="min-h-0 overflow-clip [overflow-clip-margin:3px]">{followups}</div>
            </div>
          );
        })()}
        {VIEWS.slice(PINNED).map((f) => {
          const active = view === f.view;
          const shown = open || active || held.includes(f.view);
          return (
            <div
              key={f.view}
              data-more-slot={f.view}
              data-active-slot={active || undefined}
              data-shown={shown || undefined}
              inert={!shown}
              // opening at slow on the drawer curve, the rows fading in linearly (on the curve they'd show as slivers of
              // themselves in the first frame); closing at base (many rows move: at fast it would read as a jump);
              // the 3 px clip margin keeps the focus ring (2 px, 1 px out)
              className="invisible grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility] duration-base ease-motion data-shown:visible data-shown:grid-rows-[1fr] data-shown:opacity-100 data-shown:duration-slow data-shown:[transition-timing-function:var(--ease-drawer),linear,var(--ease-drawer)]"
            >
              <div className="min-h-0 overflow-clip [overflow-clip-margin:3px]">{folder(f)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * One of an account's own folders (plan 68): memoized, so a counts update renders only the rows whose count moved.
 * Plan 107: its menu, a hover "+" for a subfolder, and its name in place while renamed (only that row re-renders).
 */
const OwnFolderRow = memo(function OwnFolderRow({ accountId, accountKind, folderKey, name, depth, active, count, solo }: { accountId: number; accountKind: Account["kind"]; folderKey: string; name: string; depth: number; active: boolean; count: number; solo: boolean }) {
  const renaming = useFolderEdit((s) => (s.editing?.kind === "rename" && s.editing.accountId === accountId && s.editing.key === folderKey ? s.editing.id : null));
  const account = { id: accountId, kind: accountKind } as Account;
  if (renaming !== null) {
    const self = getApp().folders.find((f) => f.accountId === accountId && f.key === folderKey);
    return (
      <FolderNameRow
        // each edit its own field: an older answer never settles a newer one (Codex code review round 9 #2)
        key={renaming}
        // its own name: past eight levels the row shows the rest of its path joined (round 10 #5)
        initial={self?.path.at(-1) ?? name}
        label={t("folder.rename.label", { name })}
        inset={insetOf(depth, solo)}
        testId={`folder-rename-${accountId}-${folderKey}`}
        editId={renaming}
        siblings={siblingsAt(getApp().folders, accountId, self?.path.slice(0, -1) ?? [], folderKey)}
        account={account}
        cancel={(how) => {
          // only Esc gives the row the focus back (a blur went somewhere on purpose, Codex code review #6), through
          // the same pin a finished edit uses, so a row past the first batch is still there for it (round 24 #4)
          if (how === "escape") stopEditing(renaming, { accountId, key: folderKey });
          else stopEditing(renaming);
        }}
        submit={async (next) => {
          const r = await renameFolder(accountId, folderKey, next);
          if ("error" in r) return r.error;
          stopEditing(renaming, { accountId, key: r.key });
          return null;
        }}
      />
    );
  }
  return (
    <FolderMenu target={{ accountId, folder: folderKey, view: null }} name={name} account={account}>
      <div className="group/row relative">
        <NavItem
          testId={`nav-own-${accountId}-${folderKey}`}
          dropTarget={folderRef(accountId, folderKey)}
          // plan 108: flush at the top when focused on the account
          inset={!solo || depth > 0}
          depth={solo ? depth - 1 : depth}
          active={active}
          onClick={() => navigate({ accountId, folder: folderKey })}
          icon={<FolderIcon className="size-(--icon-nav)" />}
          label={name}
          count={count || undefined}
          hoverAction
        />
        <AddFolderButton accountId={accountId} parent={folderKey} label={t("folder.add.in", { name })} testId={`folder-add-${accountId}-${folderKey}`} />
      </div>
    </FolderMenu>
  );
});

/** plan 107: a folder's row takes the focus (a rename ended, a create landed), unless the user put it elsewhere */
function focusRow(accountId: number, key: string, then?: () => void): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!(active && active !== document.body && active.isConnected && !active.closest("[data-testid^=folder-rename-], [data-testid^=folder-new-]"))) {
      document.querySelector<HTMLElement>(`[data-testid="nav-own-${accountId}-${CSS.escape(key)}"]`)?.focus({ preventScroll: false });
    }
    then?.();
  });
}

/** Plan 107: the field of a new folder, where it will be (`depth`: one step in from its parent) */
function NewFolderRow({ account, parent, depth, id, solo }: { account: Account; parent: string | null; depth: number; id: number; solo: boolean }) {
  return (
    <FolderNameRow
      initial=""
      label={parent === null ? t("folder.add.inAccount", { account: account.displayName }) : t("folder.new.label")}
      inset={insetOf(depth, solo)}
      testId={`folder-new-${account.id}`}
      editId={id}
      siblings={siblingsOf(getApp().folders, account.id, parent)}
      account={account}
      cancel={(how) => {
        // only Esc gives the focus back; a blur went somewhere on purpose (Codex code review #6). A parent gets it
        // through the finished-edit pin (round 24 #4: it may sit past the first batch)
        if (how === "escape" && parent !== null) return stopEditing(id, { accountId: account.id, key: parent });
        stopEditing(id);
        if (how === "escape") requestAnimationFrame(() => document.querySelector<HTMLElement>(homeRow(account.id, solo))?.focus());
      }}
      submit={async (name) => {
        const r = await createFolder(account.id, parent, name);
        if ("error" in r) return r.error;
        stopEditing(id, { accountId: account.id, key: r.folder.key });
        return null;
      }}
    />
  );
}

/** Where a folder's focus goes when its row goes: its account's row, or (plan 108, focused) the back row. */
const homeRow = (accountId: number, solo: boolean) => (solo ? '[data-testid="solo-back"]' : `[data-testid="nav-account-${accountId}"]`);

/** what the folder-focus recovery calls "N more folders" (no folder's key) */
const MORE = "\u0000more";

/** An open account's own folders mounted at once, and revealed per "more" (plan 68, Codex R1: a catalog may hold 10,000). */
const FOLDER_BATCH = 250;

/** How long a closing account keeps its rows for the slide (past `slow`; transitionend never comes without motion). */
const CLOSING_MS = 400;

/**
 * An open account's own folders under its row (plan 67), on the More group's 0fr→1fr row: what's below slides with
 * it, and closed it's inert (not focusable, not in the accessibility tree). Its rows are mounted only while it's open
 * or closing, so closed accounts cost nothing. A focused folder that closes hands focus to its account's row.
 */
function AccountFolders({
  account,
  open,
  active,
  activeFolder,
  rows,
  folderUnread,
  unread,
  countTone,
  tabs,
  activeTab,
  tabUnread,
  viewUnread,
  solo = false,
}: {
  account: Account;
  open: boolean;
  active: View | null;
  /** plan 68: the account's own folder you're in */
  activeFolder: string | null;
  rows: readonly FolderRow[];
  folderUnread: Record<string, number>;
  unread?: number;
  countTone: "muted" | "unread";
  /** plan 86: a Gmail account that keeps Promotions and Social apart lists them after its Trash */
  tabs: boolean;
  activeTab: Tab | null;
  tabUnread: Readonly<Record<Tab, number>>;
  /** unread threads in its Archive and Spam */
  viewUnread: Readonly<Record<CountedView, number>>;
  /** plan 108: the whole sidebar, focused on this account: every view, flush, its own folders under a title */
  solo?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [batches, setBatches] = useState(1);
  const cap = batches * FOLDER_BATCH;
  const revealFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const from = revealFrom.current;
    revealFrom.current = null;
    if (from === null) return;
    const next = rows.slice(from).find((r) => r.selectable && r.key !== null);
    if (next) groupRef.current?.querySelector<HTMLElement>(`[data-testid="nav-own-${account.id}-${CSS.escape(next.key!)}"]`)?.focus({ preventScroll: false });
  }, [batches, rows, account.id]);
  // the folder you're in is always among the rows: past the batches shown, it's drawn after them alone, never with
  // every row before it (Codex R7: a rename that sorts it last could otherwise mount the whole catalog)
  // and the one with the keyboard's focus (Codex R10: a rename that sorts it past the batches never drops focus)
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // plan 107: a new folder's parent, the one renamed and the one just made stay mounted too (Codex R8)
  const creating = useFolderEdit((s) => (s.editing?.kind === "create" && s.editing.accountId === account.id ? s.editing.parent : undefined));
  const editId = useFolderEdit((s) => s.editing?.id ?? 0);
  const renamingKey = useFolderEdit((s) => (s.editing?.kind === "rename" && s.editing.accountId === account.id ? s.editing.key : null));
  const doneKey = useFolderEdit((s) => (s.done?.accountId === account.id ? s.done.key : null));
  const kept = new Set([activeFolder, focusedKey, creating ?? null, renamingKey, doneKey].filter((k): k is string => k !== null && k !== undefined));
  const beyond = rows.slice(cap).filter((r) => r.key !== null && kept.has(r.key));
  const visible = [...rows.slice(0, cap), ...beyond];
  const hidden = rows.length - visible.length;
  const ownPrefix = `nav-own-${account.id}-`;
  // the folder with the keyboard's focus and where it was among the rows: one the server takes away hands focus to
  // the folder now in its place, or the account's row (Codex R22), never to the document
  const focusedAt = useRef<{ key: string; index: number } | null>(null);
  const placesToGo = visible.filter((r) => r.selectable && r.key !== null);
  const morePrefix = `nav-own-more-${account.id}`;
  // plan 86 (Codex code review #6): a focused Gmail tab row that goes (its account stops keeping them apart)
  const focusedTab = useRef(false);
  const trackFocus = (e: React.FocusEvent) => {
    const id = (e.target as HTMLElement).dataset.testid;
    focusedTab.current = !!id?.startsWith(`nav-tab-${account.id}-`);
    const key = id?.startsWith(ownPrefix) ? id.slice(ownPrefix.length) : null;
    setFocusedKey(key);
    // "N more folders" too: a catalog update that takes it away hands focus to the last folder shown (Codex R54)
    if (id === morePrefix) focusedAt.current = { key: MORE, index: placesToGo.length };
    else focusedAt.current = key === null ? null : { key, index: placesToGo.findIndex((r) => r.key === key) };
  };
  const dropFocus = (e: React.FocusEvent) => {
    if (groupRef.current?.contains(e.relatedTarget as Node | null)) return;
    setFocusedKey(null);
    const tab = e.target as HTMLElement;
    requestAnimationFrame(() => {
      if (tab.isConnected) focusedTab.current = false;
    });
    // left on purpose (Tab away, a click elsewhere) unless the row itself went: told apart a frame later
    const left = e.target as HTMLElement;
    requestAnimationFrame(() => {
      if (left.isConnected) focusedAt.current = null;
    });
  };
  useLayoutEffect(() => {
    const was = focusedAt.current;
    if (was === null || (was.key === MORE ? hidden > 0 : placesToGo.some((r) => r.key === was.key))) return;
    focusedAt.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const next = placesToGo[Math.min(Math.max(was.index, 0), placesToGo.length - 1)];
    const target = next ? groupRef.current?.querySelector<HTMLElement>(`[data-testid="${ownPrefix}${CSS.escape(next.key!)}"]`) : document.querySelector<HTMLElement>(homeRow(account.id, solo));
    target?.focus({ preventScroll: true });
  }, [rows]);
  // its rows gone under the keyboard's focus: the account's Inbox takes it (its row, with one account)
  useLayoutEffect(() => {
    if (tabs || !focusedTab.current) return;
    focusedTab.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    const inbox = groupRef.current?.querySelector<HTMLElement>(`[data-testid="nav-folder-${account.id}-inbox"]`);
    (inbox ?? document.querySelector<HTMLElement>(homeRow(account.id, solo)))?.focus({ preventScroll: true });
  }, [tabs, account.id, solo]);
  // plan 107: the folder a create or rename just made takes the focus once it's listed
  useLayoutEffect(() => {
    if (doneKey === null || !rows.some((r) => r.key === doneKey)) return;
    // the pin holds the row (past the first batch too) until it has the focus and focusedKey keeps it (Codex code review #5)
    focusRow(account.id, doneKey, () => {
      if (useFolderEdit.getState().done?.key === doneKey) useFolderEdit.setState({ done: null });
    });
  }, [rows, doneKey, account.id]);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), CLOSING_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);
  useLayoutEffect(() => {
    if (!open && groupRef.current?.contains(document.activeElement)) document.querySelector<HTMLElement>(`[data-testid="nav-account-${account.id}"]`)?.focus({ preventScroll: true });
  }, [open, account.id]);
  return (
    <div
      ref={groupRef}
      id={`account-folders-${account.id}`}
      role="group"
      aria-label={t("sidebar.accountFolders", { account: account.displayName })}
      data-shown={open || undefined}
      inert={!open}
      onFocus={trackFocus}
      onBlur={dropFocus}
      className="invisible grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility] duration-base ease-motion data-shown:visible data-shown:grid-rows-[1fr] data-shown:opacity-100 data-shown:duration-slow data-shown:[transition-timing-function:var(--ease-drawer),linear,var(--ease-drawer)]"
    >
      <div className="min-h-0 overflow-clip [overflow-clip-margin:3px]">
        {mounted &&
          (solo ? SOLO_VIEWS : ACCOUNT_VIEWS).map((v: View) => {
            const { icon: Icon, keys } = VIEWS.find((f) => f.view === v)!;
            const item = (
              <NavItem
                testId={`nav-folder-${account.id}-${v}`}
                inset={!solo}
                active={active === v}
                onClick={() => navigate({ accountId: account.id, view: v })}
                icon={<Icon className="size-(--icon-nav)" />}
                label={viewLabel(v)}
                count={(v === "inbox" ? unread : isCounted(v) ? viewUnread[v] : 0) || undefined}
                countTone={v === "inbox" ? countTone : "muted"}
                // plan 108: focused, these are the places the shortcuts go (they stay in the account)
                shortcut={solo ? keys : undefined}
              />
            );
            // plan 107: a standard row's menu: favorite and export (Starred and All Mail aren't folders: none)
            return isFolderView(v) ? (
              <FolderMenu key={v} target={{ accountId: account.id, folder: null, view: v }} name={viewLabel(v)} account={account}>
                <div>{item}</div>
              </FolderMenu>
            ) : (
              <Fragment key={v}>{item}</Fragment>
            );
          })}
        {/* plan 86: Gmail's Promotions and Social, out of the Inbox, after its standard folders */}
        {mounted &&
          tabs &&
          TABS.map((tab) => {
            const Icon = TAB_ICONS[tab];
            return (
              <NavItem
                key={tab}
                testId={`nav-tab-${account.id}-${tab}`}
                inset={!solo}
                active={activeTab === tab}
                onClick={() => navigate({ accountId: account.id, gmailTab: tab })}
                icon={<Icon className="size-(--icon-nav)" />}
                label={t(`view.tab.${tab}`)}
                count={tabUnread[tab] || undefined}
              />
            );
          })}
        {/* plan 68: its own folders, under its standard ones, nested by path */}
        {/* plan 108: focused, they're a section of their own, with its "+" (there even before the first one) */}
        {mounted && solo && (
          <SectionTitle
            action={
              <button type="button" data-testid="solo-add-folder" aria-label={t("folder.add.inAccount", { account: account.displayName })} onClick={() => startCreate(account.id, null)} className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/section:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-reveal:opacity-100">
                <Plus className="size-3.5" />
              </button>
            }
          >
            <span data-testid="solo-folders">{t("sidebar.solo.folders")}</span>
          </SectionTitle>
        )}
        {mounted && !solo && (rows.length > 0 || creating !== undefined) && <div role="separator" className="hairline-t my-1 ml-7" />}
        {/* plan 107: a new folder at the top goes first, where it's looked for */}
        {mounted && creating === null && <NewFolderRow key={editId} account={account} parent={null} depth={0} id={editId} solo={solo} />}
        {mounted &&
          visible.map((r) =>
            r.selectable && r.key !== null ? (
              // keyed by the provider's folder (Codex R9: a renamed label stays the same row, focus and all)
              <Fragment key={`own:${r.key}`}>
                <OwnFolderRow accountId={account.id} accountKind={account.kind} folderKey={r.key} name={r.name} depth={r.depth} active={activeFolder === r.key} count={folderUnread[folderRef(account.id, r.key)] || 0} solo={solo} />
                {creating === r.key && <NewFolderRow key={editId} account={account} parent={r.key} depth={r.depth + 1} id={editId} solo={solo} />}
              </Fragment>
            ) : (
              // a parent that only groups what's under it: not a place to go
              // keyed by its full path (Codex R6: "A/X/Y" and "B/X/Z" both draw an "X")
              <div key={r.id} data-testid="nav-own-group" className={cn("type-nav flex h-(--nav-h) items-center gap-2.5 px-2 text-muted-foreground", insetOf(r.depth, solo))}>
                <span className="flex size-(--icon-nav) items-center justify-center text-sidebar-glyph">
                  <FolderIcon className="size-(--icon-nav)" />
                </span>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
              </div>
            ),
          )}
        {mounted && hidden > 0 && (
          <button
            type="button"
            data-testid={`nav-own-more-${account.id}`}
            onClick={() => {
              // the keyboard goes to the first folder revealed (Codex R11), not to the document or past the new rows
              revealFrom.current = cap;
              setBatches((b) => b + 1);
            }}
            className={cn("type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-accent-foreground", ROW_SEAM, insetOf(0, solo))}
          >
            <span className="flex size-(--icon-nav) items-center justify-center">
              <ChevronDown className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t("sidebar.moreOwnFolders", { count: hidden })}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const NO_UNREAD: Record<string, number> = {};
const TAB_ICONS: Record<Tab, typeof Tag> = { promotions: Tag, social: Users };

/**
 * Folder unread counts per account, each account's slice kept as the same object while its numbers are the same
 * (Codex R2): a counts update that changes nothing of an account renders none of it.
 */
// an object property, not a module let (React Compiler: memory note react-compiler-module-let)
const unreadSlices = { last: new Map<number, Record<string, number>>() };
function folderUnreadByAccount(all: Record<string, number> | undefined): ReadonlyMap<number, Record<string, number>> {
  const next = new Map<number, Record<string, number>>();
  for (const [ref, n] of Object.entries(all ?? {})) {
    const id = Number(ref.slice(0, ref.indexOf(":")));
    let slice = next.get(id);
    if (!slice) next.set(id, (slice = {}));
    slice[ref] = n;
  }
  for (const [id, slice] of next) {
    const before = unreadSlices.last.get(id);
    const keys = Object.keys(slice);
    if (before && keys.length === Object.keys(before).length && keys.every((k) => before[k] === slice[k])) next.set(id, before);
  }
  unreadSlices.last = next;
  return next;
}
const isCounted = (v: View): v is CountedView => (COUNTED_VIEWS as readonly View[]).includes(v);
const isFolderView = (v: View): v is FolderView => (FOLDER_VIEWS as readonly View[]).includes(v);

/** Every account's Archive and Spam unread together, for the folders above the accounts. */
function useViewUnreadTotals(all: Record<string, number> | undefined): Record<CountedView, number> {
  return useMemo(() => {
    const out: Record<CountedView, number> = { archive: 0, spam: 0 };
    for (const [ref, n] of Object.entries(all ?? {})) {
      const v = ref.slice(ref.lastIndexOf(":") + 1);
      if (isCounted(v as View)) out[v as CountedView] += n;
    }
    return out;
  }, [all]);
}

function useFolderUnreadByAccount(all: Record<string, number> | undefined): ReadonlyMap<number, Record<string, number>> {
  return useMemo(() => folderUnreadByAccount(all), [all]);
}

/**
 * Plan 106: an account's name being renamed, in place: the row's shape and the name's place, the field where the
 * name was (not inside the row's button, Codex R5). Enter saves, Esc cancels (both give the row back its focus),
 * leaving saves; empty or unchanged saves nothing. Each edit settles once (Codex R6: the blur after Enter is not a
 * second save), and a composition's Enter is the input method's.
 */
function RenameRow({ account, active, count, reserveEnd, onDone, home }: { account: Account; active: boolean; count?: number; reserveEnd?: boolean; onDone: () => void; /** plan 108: where Enter and Esc put the focus (the account's row by default) */ home?: string }) {
  const settled = useRef(false);
  const finish = (value: string | null, refocus: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const name = value?.trim();
    if (name && name !== account.displayName) {
      patchAccount(account.id, { displayName: name }).catch((e: unknown) => snack.error(t("account.renameFailed", { error: e instanceof Error ? e.message : String(e) })));
    }
    onDone();
    if (refocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(home ?? `[data-testid="nav-account-${account.id}"]`)?.focus());
  };
  return (
    <div
      data-testid={`account-rename-${account.id}`}
      data-active={active || undefined}
      className={cn(
        "type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-sidebar-foreground",
        ROW_SEAM,
        reserveEnd && "pr-8",
        "data-active:type-nav-strong data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground",
      )}
    >
      <span className="flex size-(--icon-nav) items-center justify-center text-sidebar-glyph">
        <CategoryDot color={account.color as CategoryColor} />
      </span>
      {/* the text starts where the name did: the field's padding sits outside the label's line */}
      <input
        autoFocus
        data-testid={`account-rename-input-${account.id}`}
        aria-label={t("account.rename.label")}
        defaultValue={account.displayName}
        maxLength={200}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          // the field's keys are its own: never the row's disclosure or a shortcut
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            finish(e.currentTarget.value, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(null, true);
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value, false)}
        // the field's own menu (cut, copy, paste), not the account's
        onContextMenu={(e) => e.stopPropagation()}
        className="-mx-1 h-[calc(var(--nav-h)-6px)] min-w-0 flex-1 rounded-sm bg-background px-1 text-foreground ring-2 ring-ring outline-none"
      />
      {count ? <span className="inline-block text-xs text-muted-foreground tabular">{formatNumber(count)}</span> : null}
    </div>
  );
}

/**
 * An account in the sidebar: its row and, open, its folders (plans 67, 68). Memoized: opening one account, or a
 * count of another, never renders the rest (they get the same props: where you are is passed only to its own).
 */
const AccountEntry = memo(function AccountEntry({
  account: a,
  open: openHere,
  here,
  view,
  inCategory,
  ownFolder,
  folders,
  unread,
  folderUnread,
  countTone,
  gmailTab,
  promotionsUnread,
  socialUnread,
  archiveUnread,
  spamUnread,
}: {
  account: Account;
  open: boolean;
  here: boolean;
  view: View | null;
  inCategory: boolean;
  ownFolder: string | null;
  folders: readonly Folder[];
  unread: number | undefined;
  folderUnread: Record<string, number> | undefined;
  countTone: "muted" | "unread";
  /** plan 86: the Gmail tab you're in, only for the account it's in */
  gmailTab: Tab | null;
  promotionsUnread: number;
  socialUnread: number;
  archiveUnread: number;
  spamUnread: number;
}) {
  // every account opens to its standard folders, a lone one too (its Inbox, Sent, Spam… inside it, as Mail
  // shows them), then its own folders and Gmail tabs
  const rows = useFolderRows(folders, a.id, openHere);
  // plan 86: its Gmail tabs are places of its own
  const tabs = separatesTabs(a);
  const open = openHere;
  // the account's folder you're in: one of its own, else a standard one (a category tab filters its Inbox)
  const ownActive = here && open && ownFolder !== null && rows.some((r) => r.key === ownFolder);
  const tabActive = here && open && tabs && gmailTab !== null;
  const child = here && open && ownFolder === null && gmailTab === null && view !== null ? (inCategory ? "inbox" : view) : null;
  const childActive = ownActive || tabActive || (child !== null && listedByAccount(child));
  const tabUnread = useMemo(() => ({ promotions: promotionsUnread, social: socialUnread }), [promotionsUnread, socialUnread]);
  const viewUnread = useMemo(() => ({ archive: archiveUnread, spam: spamUnread }), [archiveUnread, spamUnread]);
  // plan 106: Rename puts a field where the name is
  const [renaming, setRenaming] = useState(false);
  return (
    <div data-account-id={a.id}>
      {/* the row and its sign-in key together (plan 25), apart from the folders below; its menu (plan 106) */}
      <AccountMenu account={a} unread={unread ?? 0} onRename={() => setRenaming(true)}>
        <div className="group/row relative">
          {renaming ? (
            <RenameRow account={a} active={here && !childActive} count={open ? undefined : unread || undefined} reserveEnd={a.syncState.authRequired} onDone={() => setRenaming(false)} />
          ) : (
            <NavItem
              testId={`nav-account-${a.id}`}
              // closed over where you are, the account is what's selected
              active={here && !childActive}
              expanded={open}
              controls={`account-folders-${a.id}`}
              onClick={() => toggleAccount(a.id)}
              // syncing stays quiet here: the first-sync and connection pills speak for it
              icon={<CategoryDot color={a.color as CategoryColor} />}
              label={a.displayName}
              // open, the count is its Inbox's row's
              count={open ? undefined : unread || undefined}
              // open, its "+" sits where the count was (plan 107)
              reserveEnd={a.syncState.authRequired || open ? "icon" : undefined}
            />
          )}
          {a.syncState.authRequired && <SignInMarker account={a} />}
          {open && !renaming && !a.syncState.authRequired && <AddFolderButton accountId={a.id} parent={null} label={t("folder.add.inAccount", { account: a.displayName })} testId={`account-add-folder-${a.id}`} />}
        </div>
      </AccountMenu>
      <AccountFolders
        account={a}
        open={open}
        active={child !== null && listedByAccount(child) ? child : null}
        activeFolder={ownActive ? ownFolder : null}
        rows={rows}
        folderUnread={folderUnread ?? NO_UNREAD}
        unread={unread}
        countTone={countTone}
        tabs={tabs}
        activeTab={tabActive ? gmailTab : null}
        tabUnread={tabUnread}
        viewUnread={viewUnread}
      />
    </div>
  );
});

/**
 * Plan 108: the sidebar focused on one account: a way back, the account's name and address, then all its places
 * flush (every view, its Gmail tabs, its own folders under a title). Built on its own, open or not in the normal
 * sidebar; where you are is always shown here (there are no favorites to share it with).
 */
function SoloSidebar({ account: a, countTone }: { account: Account; countTone: "muted" | "unread" }) {
  const view = useApp((s) => s.view);
  const searching = useApp((s) => s.query.trim() !== "");
  const categoryId = useApp((s) => s.categoryId);
  const ownFolder = useApp((s) => s.folder);
  const gmailTab = useApp((s) => s.gmailTab);
  const folders = useApp((s) => s.folders);
  const counts = useApp((s) => s.counts);
  const folderUnread = useFolderUnreadByAccount(counts.folderUnread).get(a.id);
  const rows = useFolderRows(folders, a.id, true);
  const tabs = separatesTabs(a);
  const unread = counts.inboxUnreadByAccount[a.id];
  const tabUnread = useMemo(() => ({ promotions: counts.tabUnread?.[tabRef(a.id, "promotions")] ?? 0, social: counts.tabUnread?.[tabRef(a.id, "social")] ?? 0 }), [counts.tabUnread, a.id]);
  const viewUnread = useMemo(() => ({ archive: counts.viewUnread?.[viewRef(a.id, "archive")] ?? 0, spam: counts.viewUnread?.[viewRef(a.id, "spam")] ?? 0 }), [counts.viewUnread, a.id]);
  const [renaming, setRenaming] = useState(false);
  const ownActive = ownFolder !== null && rows.some((r) => r.key === ownFolder) && !searching;
  // a category in the account is its list there: no row of its own, so none is selected; nor is one during a search
  const active = ownFolder === null && gmailTab === null && categoryId === null && !searching ? view : null;
  return (
    <>
      {/* the back row and the title share the account's menu: ⇧F10 on the back row opens it */}
      <AccountMenu account={a} unread={unread ?? 0} onRename={() => setRenaming(true)} solo>
        <div data-testid="solo-header" className="mb-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-testid="solo-back"
                  aria-label={t("sidebar.solo.back")}
                  onClick={() => leaveSoloKeepingFocus(a.id)}
                  className={cn("group type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-accent-foreground", ROW_SEAM)}
                >
                  <span className="flex size-(--icon-nav) items-center justify-center">
                    <ArrowLeft className="size-(--icon-nav)" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t("sidebar.allAccounts")}</span>
                </button>
              }
            />
            <TooltipContent side="right">{t("sidebar.solo.back")}</TooltipContent>
          </Tooltip>
          <div className="group/row relative">
            {renaming ? (
              <RenameRow account={a} active={false} reserveEnd={a.syncState.authRequired} onDone={() => setRenaming(false)} home='[data-testid="solo-back"]' />
            ) : (
              <div data-testid="solo-title" className={cn("flex min-h-(--nav-h) items-center gap-2.5 px-2 py-1", a.syncState.authRequired && "pr-8")}>
                <span className="flex size-(--icon-nav) shrink-0 items-center justify-center">
                  <CategoryDot color={a.color as CategoryColor} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="type-nav-strong block truncate text-sidebar-foreground">{a.displayName}</span>
                  {a.email !== a.displayName && <span className="block truncate text-xs text-muted-foreground">{a.email}</span>}
                </span>
              </div>
            )}
            {a.syncState.authRequired && <SignInMarker account={a} />}
          </div>
        </div>
      </AccountMenu>
      <AccountFolders
        account={a}
        open
        solo
        active={active}
        activeFolder={ownActive ? ownFolder : null}
        rows={rows}
        folderUnread={folderUnread ?? NO_UNREAD}
        unread={unread}
        countTone={countTone}
        tabs={tabs}
        activeTab={tabs && !searching ? gmailTab : null}
        tabUnread={tabUnread}
        viewUnread={viewUnread}
      />
    </>
  );
}

export function Sidebar() {
  const view = useApp((s) => s.view);
  const accountId = useApp((s) => s.accountId);
  const categoryId = useApp((s) => s.categoryId);
  const reviewCategoryId = useApp((s) => s.reviewCategoryId);
  const inReminders = useApp((s) => s.reminders);
  const dueReminders = useReminders((s) => s.due);
  const inFollowups = useApp((s) => s.followups);
  const inToday = useApp((s) => s.today);
  // plan 158: a search is the list's, across every place: nothing here is where you are while it shows
  const searching = useApp((s) => s.query.trim() !== "");
  // plan 145: no provider, no row, no list and no work; and never for an app that's still reading its settings
  const todayShown = useApp(todayOffered);
  const todayTip = usePendingTip("today-first") !== null;
  useEffect(() => {
    if (todayShown) offerTip("today-first", 0);
  }, [todayShown]);
  const dueFollowups = useFollowups((s) => s.due);
  const followupsOn = useApp(followupsOffered);
  const accounts = useApp((s) => s.accounts);
  // plan 108: focused on one account, the sidebar is its alone
  const soloAccount = useApp((s) => (s.soloAccountId === null ? undefined : s.accounts.find((a) => a.id === s.soloAccountId)));
  const folders = useApp((s) => s.folders);
  const ownFolder = useApp((s) => s.folder);
  const gmailTab = useApp((s) => s.gmailTab);
  // plan 107 (Codex code review round 3 #6): a favorite that's where you are is the one current row; its copy under
  // the account isn't too
  const favoriteHere = useApp((s) =>
    s.accountId !== null && s.reviewCategoryId === null && s.categoryId === null && s.gmailTab === null && !s.reminders &&
    (s.settings?.favoriteFolders ?? []).some((f) => f.accountId === s.accountId && (f.folder !== null ? f.folder === s.folder && s.folders.some((x) => x.accountId === f.accountId && x.key === f.folder && x.selectable) : s.folder === null && f.view === s.view)),
  );
  const categories = useApp((s) => s.categories);
  const counts = useApp((s) => s.counts);
  const design = useDesign();

  const openAccount = useOpenAccount((s) => s.id);
  const unreadByAccount = useFolderUnreadByAccount(counts.folderUnread);
  const viewTotals = useViewUnreadTotals(counts.viewUnread);
  // a focused account that's removed hands focus to the row now in its place (or Add account), not to the document
  const accountsRef = useRef<HTMLDivElement>(null);
  const focusedAccount = useRef<number | null>(null);
  const rememberFocus = (e: React.FocusEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-account-id]")?.dataset.accountId;
    focusedAccount.current = id ? Number(id) : null;
  };
  // focus that leaves on purpose (a click elsewhere, Tab away) is forgotten; a row removed under it isn't: by the
  // next frame the removal's own recovery has run, and a row still in the page is one that was left (Codex R3)
  const forgetFocus = (e: React.FocusEvent) => {
    const left = e.target as HTMLElement;
    requestAnimationFrame(() => {
      if (left.isConnected && !accountsRef.current?.contains(document.activeElement)) focusedAccount.current = null;
    });
  };
  const lastAccounts = useRef(accounts);
  useLayoutEffect(() => {
    const before = lastAccounts.current;
    lastAccounts.current = accounts;
    const gone = focusedAccount.current;
    if (gone === null || (document.activeElement && document.activeElement !== document.body)) return;
    // only when rows went away: an account removed, or the folders of the one that stays (two to one)
    const removed = before.some((b) => !accounts.some((a) => a.id === b.id));
    if (!removed) return;
    // still here, its folders gone with the other accounts (two to one): its row
    if (accounts.some((a) => a.id === gone)) return accountsRef.current?.querySelector<HTMLElement>(`[data-testid="nav-account-${gone}"]`)?.focus({ preventScroll: true });
    focusedAccount.current = null;
    const next = accounts.find((a) => before.findIndex((b) => b.id === a.id) > before.findIndex((b) => b.id === gone));
    const target = next ? accountsRef.current?.querySelector<HTMLElement>(`[data-testid="nav-account-${next.id}"]`) : accountsRef.current?.nextElementSibling;
    (target as HTMLElement | null | undefined)?.focus({ preventScroll: true });
  }, [accounts]);

  const [creating, setCreating] = useState(false);
  const createCategory = async (name: string) => {
    setCreating(false);
    await createNamedCategory(name);
  };

  // the folder you're in at the top: none in a category or its suggestions (both are "all" underneath), none inside an account (plan 67)
  const folderView = accountId === null && categoryId === null && reviewCategoryId === null && !inReminders && !inToday && !searching ? view : null;
  const folder = ({ view: v, icon: Icon, keys }: (typeof VIEWS)[number]) => (
    <NavItem
      key={v}
      testId={`nav-${v}`}
      active={folderView === v}
      onClick={() => navigate({ view: v, accountId: null })}
      icon={<Icon className="size-(--icon-nav)" />}
      label={viewLabel(v)}
      count={(v === "inbox" ? counts.inboxUnread : isCounted(v) ? viewTotals[v] : 0) || undefined}
      countTone={v === "inbox" ? design.surfaces.inboxCount : "muted"}
      shortcut={keys}
    />
  );

  // every account's places, built as before whether shown or not (plan 108: a conditional around them would make
  // the compiler memoize them as one block, and an account's toggle would render every category row again)
  // plan 108 (Codex code review round 2 #2): the two sidebars share one scroll: focused starts at its top, and back
  // to all accounts is where you'd scrolled to
  const navRef = useRef<HTMLElement>(null);
  const allScroll = useRef(0);
  const soloId = soloAccount?.id ?? null;
  const lastSolo = useRef(soloId);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const was = lastSolo.current;
    lastSolo.current = soloId;
    if (!nav || was === soloId) return;
    if (soloId === null) nav.scrollTop = allScroll.current;
    else {
      if (was === null) allScroll.current = nav.scrollTop;
      nav.scrollTop = 0;
    }
  }, [soloId]);
  const all = (
    <>
      {todayShown && (
        <NavItem
          testId="nav-today"
          active={inToday && !searching}
          onClick={() => navigate({ today: true })}
          icon={<Sun className="size-(--icon-nav)" />}
          label={t("today.title")}
          count={counts.today || undefined}
          countTone={design.surfaces.inboxCount}
        />
      )}
      {todayTip && <TodayTip />}
      {VIEWS.slice(0, PINNED).map(folder)}
      <FavoriteRows />
      <MoreFolders
        view={folderView}
        folder={folder}
        reminders={
          <NavItem
            testId="nav-reminders"
            active={inReminders && !searching}
            onClick={() => navigate({ reminders: true })}
            icon={<Bell className="size-(--icon-nav)" />}
            label={t("view.reminders")}
            count={dueReminders}
            countTone={design.surfaces.inboxCount}
            shortcut="g r"
          />
        }
        followups={
          followupsOn ? (
            <NavItem
              testId="nav-followups"
              active={inFollowups && !searching}
              onClick={() => navigate({ followups: true })}
              icon={<ListChecks className="size-(--icon-nav)" />}
              label={t("followups.title")}
              count={dueFollowups}
              countTone={design.surfaces.inboxCount}
            />
          ) : null
        }
      />

      {/* what slides when More opens or closes: its own layer, so the slide moves it without repainting it (plan 40) */}
      <div data-more-below className="will-change-transform">
        <SectionTitle
          action={
            <button type="button" data-testid="new-category" aria-label={t("sidebar.newCategory")} onClick={() => setCreating(true)} className="-my-0.5 -mr-1 flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/section:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-reveal:opacity-100">
              <Plus className="size-3.5" />
            </button>
          }
        >
          {t("sidebar.categories")}
        </SectionTitle>
        <ReviewRow categories={categories} suggestions={counts.categorySuggestions} reviewing={reviewCategoryId !== null && !searching} />
        {categories.map((c) => {
          const help = categoryHelp(counts.categoryUnread[c.id] ?? 0, counts.categorySuggestions[c.id] ?? 0);
          const suggested = counts.categorySuggestions[c.id] ?? 0;
          return (
            <CategoryMenu key={c.id} category={c} suggested={suggested}>
            <div className="relative" data-suggested={suggested || undefined}>
              {help && <span id={`sidebar-count-category-${c.id}`} className="sr-only">{help}</span>}
              <NavItem
                testId={`nav-category-${c.id}`}
                dropTarget={c.id}
                // categories are cross-account: inside an account, a category tab is a filter of its Inbox (plan 67)
                active={categoryId === c.id && reviewCategoryId === null && accountId === null && !searching}
                onClick={() => navigate({ categoryId: c.id, accountId: null })}
                icon={<CategoryDot color={c.color as CategoryColor} />}
                label={c.name}
                count={counts.categoryUnread[c.id] || undefined}
                countHelp={help ? { id: `sidebar-count-category-${c.id}`, text: help } : undefined}
                note={
                  (!c.showInInbox || c.forward?.enabled) && (
                    <>
                      {!c.showInInbox && (
                        <EyeOff
                          role="img"
                          aria-label={t("category.hiddenFromInboxBadge")}
                          data-testid={`nav-category-hidden-${c.id}`}
                          className="size-3 shrink-0 text-muted-foreground animate-in fade-in zoom-in-75"
                        />
                      )}
                      {/* plan 116: its new mail is forwarded */}
                      {c.forward?.enabled && (
                        <Forward
                          role="img"
                          aria-label={t("category.forward.on", { to: c.forward.addresses.map((a) => a.name || a.email).join(", ") })}
                          data-testid={`nav-category-forward-${c.id}`}
                          className="size-3 shrink-0 text-muted-foreground animate-in fade-in zoom-in-75"
                        />
                      )}
                    </>
                  )
                }
              />
            </div>
            </CategoryMenu>
          );
        })}
        {creating && (
          <input
            autoFocus
            data-testid="new-category-input"
            placeholder={t("sidebar.categoryName")}
            className="mt-0.5 h-7 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            onBlur={(e) => void createCategory(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createCategory(e.currentTarget.value);
              if (e.key === "Escape") setCreating(false);
            }}
          />
        )}
        {categories.length === 0 && !creating && <p className="px-2 py-1 text-xs text-muted-foreground">{t("sidebar.categoriesEmpty")}</p>}
      <CategoryTip />

        <SectionTitle>{t("sidebar.accounts")}</SectionTitle>
        <div ref={accountsRef} onFocus={rememberFocus} onBlur={forgetFocus}>
          {accounts.map((a) => (
            <AccountEntry
              key={a.id}
              account={a}
              open={openAccount === a.id}
              // where you are, only for the account it's in: the others' props stay the same, so they don't render
              here={accountId === a.id && reviewCategoryId === null && !favoriteHere && !searching}
              view={accountId === a.id && !searching ? view : null}
              inCategory={accountId === a.id && categoryId !== null}
              ownFolder={accountId === a.id && !searching ? ownFolder : null}
              folders={folders}
              unread={counts.inboxUnreadByAccount[a.id]}
              // only the open account's folders show counts; its own slice, the same object while nothing in it moved
              folderUnread={openAccount === a.id ? unreadByAccount.get(a.id) : undefined}
              countTone={design.surfaces.inboxCount}
              gmailTab={accountId === a.id && !searching ? gmailTab : null}
              promotionsUnread={counts.tabUnread?.[tabRef(a.id, "promotions")] ?? 0}
              socialUnread={counts.tabUnread?.[tabRef(a.id, "social")] ?? 0}
              archiveUnread={counts.viewUnread?.[viewRef(a.id, "archive")] ?? 0}
              spamUnread={counts.viewUnread?.[viewRef(a.id, "spam")] ?? 0}
            />
          ))}
        </div>
        <button
          type="button"
          data-testid="sidebar-add-account"
          onClick={() => setApp({ dialog: "addAccount" })}
          className="mt-0.5 flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
        >
          <Plus className="size-(--icon-nav)" /> {t("sidebar.addAccount")}
        </button>
      </div>
    </>
  );

  return (
    <aside id="app-sidebar" data-testid="sidebar" className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="drag-region h-[52px] shrink-0" />
      {variant(design.variants.compose, { "list-header": null, "sidebar-outline": <ComposeOutline />, "sidebar-pill": <ComposePill />, "sidebar-row": <ComposeRow /> })}
      <nav ref={navRef} data-drop-scroll aria-label={soloAccount ? t("sidebar.solo.nav", { account: soloAccount.displayName }) : undefined} className="min-h-0 flex-1 overflow-y-auto px-(--sidebar-pad) pb-3">
        {/* keyed: another account focused is another sidebar (Codex code review #1: never the last one's rows) */}
        {soloAccount ? <SoloSidebar key={soloAccount.id} account={soloAccount} countTone={design.surfaces.inboxCount} /> : all}
      </nav>
      {/* The last pill stands clear of the footer's hairline; empty, the stack takes no room. */}
      <div className="flex shrink-0 flex-col pb-2 empty:hidden">
        <SignInNotice />
        <ConnectionPill />
        <FirstSyncPill />
        <UpdatePill />
      </div>
      {/* the left stays put: a ghost button's own padding puts Rules' icon on the rows' icon line in the wider inset */}
      <div className="hairline-t hairline-strong flex shrink-0 items-center gap-1 py-2 pr-(--sidebar-pad) pl-2">
        <Button data-testid="open-filters" variant="ghost" size="sm" className="flex-1 justify-start gap-2 text-sidebar-foreground" onClick={() => setApp({ dialog: "filters" })}>
          <Route className="text-sidebar-glyph" /> {t("sidebar.filters")}
        </Button>
        <CloudAiPill />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button data-testid="open-settings" variant="ghost" size="icon-sm" aria-label={t("common.settings")} onClick={() => setApp({ dialog: "settings", settingsTab: "general" })}>
                <Settings2 />
              </Button>
            }
          />
          <TooltipContent>{t("common.settings")}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
