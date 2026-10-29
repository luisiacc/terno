import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { folderRef, type Account, type CategoryColor, type Folder, type View } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Check, ChevronDown, ChevronRight, Folder as FolderIcon, Inbox, Layers, OctagonAlert, Plus, Send, Settings2, Sparkles, SquarePen, Star, Trash2 } from "lucide-react";
import { Kbd } from "@terno/ui/components/kbd";
import { openCompose } from "~/lib/actions";
import { useDesign, variant } from "~/lib/design";
import { formatNumber, t } from "@terno/i18n";
import { viewLabel } from "~/lib/format";
import { getApp, navigate, setApp, useApp } from "~/state/app";
import { createCategory as createNamedCategory } from "~/lib/tabs";
import { ACCOUNT_VIEWS, folderRows, listedByAccount, setOpenAccount, toggleAccount, useOpenAccount, type FolderRow } from "~/lib/account-folders";
import { renderProbe } from "~/lib/render-probe";
import { useDropState } from "~/state/drag";
import { LocalPill } from "./local-pill";
import { ConnectionPill } from "./connection-pill";
import { SignInMarker, SignInNotice } from "./sign-in-notice";
import { UpdatePill } from "./update-pill";
import { preloadComposer } from "./composer/lazy";

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
const ROW_SEAM = "border-y-[0.5px] border-transparent bg-clip-padding";
/** An account's folders: one step in under it, one more per level of its own folders (plan 65), up to four */
const INSET = ["pl-7", "pl-10", "pl-13", "pl-16"];

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
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  /** the inbox's count in the unread color (the design decides) */
  countTone?: "muted" | "unread";
  testId?: string;
  /** a category: rows can be dropped on it */
  dropTarget?: number;
  /** room at the end for a control drawn over the row (a review badge; "icon": the sign-in key, plan 25) */
  reserveEnd?: boolean | "icon";
  /** a folder under its account (plan 64) */
  inset?: boolean;
  /** plan 65: how deep an account's own folder sits under its parents */
  depth?: number;
  /** an account: a disclosure of its folders (plan 64) */
  expanded?: boolean;
  controls?: string;
}) {
  renderProbe("NavItem");
  // the perf gates tell the rows below More (which only slide when it toggles) from the folders
  if (import.meta.env.VITE_RENDER_PROBE) renderProbe(
      testId?.startsWith("nav-folder-") || testId?.startsWith("nav-own-") ? "NavItem:account-folder" : testId?.startsWith("nav-category-") || testId?.startsWith("nav-account-") ? "NavItem:below" : "NavItem:folder",
    );
  // only the item under the pointer (and the one it left) re-renders during a drag
  const drop = useDropState(dropTarget);
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      data-drop-target={dropTarget}
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
      )}
    >
      <span className="flex size-4 items-center justify-center text-sidebar-glyph transition-transform group-data-[drop-state=over]:scale-125">{icon}</span>
      {expanded === undefined ? (
        <span className="min-w-0 flex-1 truncate">{label}</span>
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
        <span data-slot="nav-count" className={cn("inline-block text-xs tabular", countTone === "unread" ? "font-semibold text-unread-ink" : "text-muted-foreground")}>
          {formatNumber(count)}
        </span>
      ) : null}
    </button>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="group/section mt-4 mb-0.5 flex min-h-5 items-center justify-between px-2">
      <span className="type-section-label text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

/** Atelier: "New message" as an outlined button at the top of the sidebar, its key beside it. */
function ComposeOutline() {
  return (
    <div className="shrink-0 px-2 pb-3">
      <button type="button" data-testid="compose-button" onPointerEnter={preloadComposer} onFocus={preloadComposer} onClick={() => openCompose("new")} className="type-compose flex h-9 w-full items-center gap-2.5 rounded-lg bg-card px-3 text-left text-foreground shadow-raised transition-[background-color,box-shadow] hover:bg-muted">
        <SquarePen className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate">{t("compose.newMessage")}</span>
        <Kbd>C</Kbd>
      </button>
    </div>
  );
}

/** Lumen: "Compose" as the one solid pill in the window. */
function ComposePill() {
  return (
    <div className="shrink-0 px-2.5 pb-4">
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" data-testid="compose-button" onPointerEnter={preloadComposer} onFocus={preloadComposer} onClick={() => openCompose("new")} className="type-compose flex h-10 w-full items-center justify-center gap-2 rounded-full bg-primary px-4 text-primary-foreground shadow-[inset_0_1px_var(--highlight),0_1px_2px_var(--shadow-color)] transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_88%,var(--background))]">
              <SquarePen className="size-4" />
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

/** A category's pending suggestions as a badge in its row (Atelier, Lumen): its own control, drawn over the row's end. */
function ReviewBadge({ id, name, n, active }: { id: number; name: string; n: number; active: boolean }) {
  return (
    <button
      type="button"
      data-testid={`nav-review-${id}`}
      data-active={active || undefined}
      aria-label={t("sidebar.reviewBadge", { count: n, name })}
      title={t("sidebar.reviewBadge", { count: n, name })}
      onClick={() => navigate({ view: "all", reviewCategoryId: id, accountId: null })}
      className="absolute top-1/2 right-1.5 flex h-5 -translate-y-1/2 items-center gap-0.5 rounded-full bg-(--review-badge-bg) px-1.5 text-2xs font-semibold text-(--review-badge-fg) tabular transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
    >
      <Sparkles className="size-3" />
      {formatNumber(n)}
    </button>
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
function MoreFolders({ view, folder }: { view: View | null; folder: (f: (typeof VIEWS)[number]) => React.ReactNode }) {
  const open = useSidebarMore((s) => s.open);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  // folders shown only because you were in them, kept after a click in the sidebar took you elsewhere
  const [held, setHeld] = useState<View[]>([]);
  useEffect(() => {
    const aside = toggleRef.current?.closest("aside");
    const group = groupRef.current;
    if (!aside || !group) return;
    let over = false;
    /** the hidden folder you were in when a mouse click landed here; held only if that click takes you elsewhere */
    let armed: View | null = null;
    const drop = () => setHeld((h) => (h.length ? [] : h));
    // captured, so it runs before the click's own handler: with a mouse or pen (a keyboard's click or a tap has no pointer resting here)
    const click = (e: MouseEvent) => {
      const type = (e as PointerEvent).pointerType;
      if ((type !== "mouse" && type !== "pen") || useSidebarMore.getState().open) return;
      const { view: v, accountId, categoryId, reviewCategoryId } = getApp();
      if (accountId !== null || categoryId !== null || reviewCategoryId !== null || !MORE_VIEWS.includes(v)) return;
      armed = v;
    };
    // the click's dispatch is over (the window hears it last): one that went nowhere (the folder's own row, the + of
    // Categories) holds nothing. A key or a press disarms too, in case a handler stopped the click on its way up
    const disarm = () => (armed = null);
    // the click navigated (synchronously, inside its handler): the hold joins that render
    const unsubscribe = useApp.subscribe((s) => {
      if (armed === null || (s.accountId === null && s.categoryId === null && s.reviewCategoryId === null && s.view === armed)) return;
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
        <span className="flex size-4 items-center justify-center">
          <ChevronDown className={cn("size-3.5 transition-transform duration-base ease-motion", !open && "-rotate-90")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{open ? t("sidebar.less") : t("sidebar.more")}</span>
      </button>
      <div ref={groupRef} id="sidebar-more-folders" role="group" aria-label={t("sidebar.moreFolders")}>
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

/** An open account's own folders mounted at once, and revealed per "more" (plan 65, Codex R1: a catalog may hold 10,000). */
const FOLDER_BATCH = 250;

/** How long a closing account keeps its rows for the slide (past `slow`; transitionend never comes without motion). */
const CLOSING_MS = 400;

/**
 * An open account's own folders under its row (plan 64), on the More group's 0fr→1fr row: what's below slides with
 * it, and closed it's inert (not focusable, not in the accessibility tree). Its rows are mounted only while it's open
 * or closing, so closed accounts cost nothing. A focused folder that closes hands focus to its account's row.
 */
function AccountFolders({
  account,
  open,
  standard,
  active,
  activeFolder,
  rows,
  folderUnread,
  unread,
  countTone,
}: {
  account: Account;
  open: boolean;
  /** its Inbox, Sent… (with one account they'd be the top ones: plan 64) */
  standard: boolean;
  active: View | null;
  /** plan 65: the account's own folder you're in */
  activeFolder: string | null;
  rows: readonly FolderRow[];
  folderUnread: Record<string, number>;
  unread?: number;
  countTone: "muted" | "unread";
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [batches, setBatches] = useState(1);
  // the folder you're in is always among the rows (a deep one shows the batches before it)
  const at = activeFolder === null ? -1 : rows.findIndex((r) => r.key === activeFolder);
  const shown = Math.max(batches * FOLDER_BATCH, at + 1);
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
      className="invisible grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity,visibility] duration-base ease-motion data-shown:visible data-shown:grid-rows-[1fr] data-shown:opacity-100 data-shown:duration-slow data-shown:[transition-timing-function:var(--ease-drawer),linear,var(--ease-drawer)]"
    >
      <div className="min-h-0 overflow-clip [overflow-clip-margin:3px]">
        {mounted &&
          standard &&
          ACCOUNT_VIEWS.map((v) => {
            const Icon = VIEWS.find((f) => f.view === v)!.icon;
            return (
              <NavItem
                key={v}
                testId={`nav-folder-${account.id}-${v}`}
                inset
                active={active === v}
                onClick={() => navigate({ accountId: account.id, view: v })}
                icon={<Icon className="size-4" />}
                label={viewLabel(v)}
                count={v === "inbox" ? unread || undefined : undefined}
                countTone={v === "inbox" ? countTone : "muted"}
              />
            );
          })}
        {/* plan 65: its own folders, under its standard ones, nested by path */}
        {mounted && standard && rows.length > 0 && <div role="separator" className="hairline-t my-1 ml-7" />}
        {mounted &&
          rows.slice(0, shown).map((r) =>
            r.selectable && r.key !== null ? (
              <NavItem
                key={r.key}
                testId={`nav-own-${account.id}-${r.key}`}
                inset
                depth={r.depth}
                active={activeFolder === r.key}
                onClick={() => navigate({ accountId: account.id, folder: r.key })}
                icon={<FolderIcon className="size-4" />}
                label={r.name}
                count={folderUnread[folderRef(account.id, r.key)] || undefined}
              />
            ) : (
              // a parent that only groups what's under it: not a place to go
              <div key={`group:${r.key ?? ""}:${r.depth}:${r.name}`} data-testid="nav-own-group" className={cn("type-nav flex h-(--nav-h) items-center gap-2.5 px-2 text-muted-foreground", INSET[r.depth] ?? INSET.at(-1))}>
                <span className="flex size-4 items-center justify-center text-sidebar-glyph">
                  <FolderIcon className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
              </div>
            ),
          )}
        {mounted && rows.length > shown && (
          <button
            type="button"
            data-testid={`nav-own-more-${account.id}`}
            onClick={() => setBatches((b) => b + 1)}
            className={cn("type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-accent-foreground", ROW_SEAM, INSET[0])}
          >
            <span className="flex size-4 items-center justify-center">
              <ChevronDown className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t("sidebar.moreOwnFolders", { count: rows.length - shown })}</span>
          </button>
        )}
      </div>
    </div>
  );
}

const NO_UNREAD: Record<string, number> = {};

/**
 * An account in the sidebar: its row and, open, its folders (plans 64, 65). Memoized: opening one account, or a
 * count of another, never renders the rest (they get the same props: where you are is passed only to its own).
 */
const AccountEntry = memo(function AccountEntry({
  account: a,
  many,
  open: openHere,
  here,
  view,
  inCategory,
  ownFolder,
  folders,
  unread,
  folderUnread,
  countTone,
}: {
  account: Account;
  many: boolean;
  open: boolean;
  here: boolean;
  view: View | null;
  inCategory: boolean;
  ownFolder: string | null;
  folders: readonly Folder[];
  unread: number | undefined;
  folderUnread: Record<string, number> | undefined;
  countTone: "muted" | "unread";
}) {
  // with one account its standard folders would be the top ones: it lists only its own (plan 65),
  // and with none of those its row just scopes to it
  const rows = useMemo(() => folderRows(folders, a.id), [folders, a.id]);
  const discloses = many || rows.length > 0;
  const open = discloses && openHere;
  // the account's folder you're in: one of its own, else a standard one (a category tab filters its Inbox)
  const ownActive = here && open && ownFolder !== null && rows.some((r) => r.key === ownFolder);
  const child = here && open && many && ownFolder === null && view !== null ? (inCategory ? "inbox" : view) : null;
  const childActive = ownActive || (child !== null && listedByAccount(child));
  return (
    <div data-account-id={a.id}>
      {/* the row and its sign-in key together (plan 25), apart from the folders below */}
      <div className="relative">
        <NavItem
          testId={`nav-account-${a.id}`}
          // closed over where you are, the account is what's selected
          active={here && !childActive}
          expanded={discloses ? open : undefined}
          controls={discloses ? `account-folders-${a.id}` : undefined}
          // one account: its own folders open and close, where you are stays (its Inbox is the top one)
          onClick={() => (many ? toggleAccount(a.id) : discloses ? setOpenAccount(open ? null : a.id) : navigate({ accountId: a.id, view: "inbox" }))}
          icon={
            <span className="relative">
              <CategoryDot color={a.color as CategoryColor} />
              {a.syncState.status === "syncing" && <span className="absolute -inset-0.5 animate-ping rounded-full bg-sidebar-primary/40" />}
            </span>
          }
          label={a.displayName}
          // open, the count is its Inbox's (with one account, the top Inbox's)
          count={open && many ? undefined : unread || undefined}
          reserveEnd={a.syncState.authRequired ? "icon" : undefined}
        />
        {a.syncState.authRequired && <SignInMarker account={a} />}
      </div>
      {discloses && (
        <AccountFolders
          account={a}
          open={open}
          standard={many}
          active={child !== null && listedByAccount(child) ? child : null}
          activeFolder={ownActive ? ownFolder : null}
          rows={rows}
          folderUnread={folderUnread ?? NO_UNREAD}
          unread={unread}
          countTone={countTone}
        />
      )}
    </div>
  );
});

export function Sidebar() {
  const view = useApp((s) => s.view);
  const accountId = useApp((s) => s.accountId);
  const categoryId = useApp((s) => s.categoryId);
  const reviewCategoryId = useApp((s) => s.reviewCategoryId);
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  const ownFolder = useApp((s) => s.folder);
  const categories = useApp((s) => s.categories);
  const counts = useApp((s) => s.counts);
  const design = useDesign();
  const inlineReview = design.variants.categoryReview === "inline-badge";

  const openAccount = useOpenAccount((s) => s.id);
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
  // the same creation as the List layout's tab "+" (lib/tabs)
  const createCategory = async (name: string) => {
    setCreating(false);
    await createNamedCategory(name, { allAccounts: true });
  };

  // the folder you're in at the top: none in a category or its suggestions (both are "all" underneath), none inside an account (plan 64)
  const folderView = accountId === null && categoryId === null && reviewCategoryId === null ? view : null;
  const folder = ({ view: v, icon: Icon, keys }: (typeof VIEWS)[number]) => (
    <Tooltip key={v}>
      <TooltipTrigger
        render={
          <NavItem
            testId={`nav-${v}`}
            active={folderView === v}
            onClick={() => navigate({ view: v, accountId: null })}
            icon={<Icon className="size-4" />}
            label={viewLabel(v)}
            count={v === "inbox" ? counts.inboxUnread : undefined}
            countTone={v === "inbox" ? design.surfaces.inboxCount : "muted"}
          />
        }
      />
      {keys && (
        <TooltipContent side="right">
          <Shortcut keys={keys} />
        </TooltipContent>
      )}
    </Tooltip>
  );

  return (
    <aside id="app-sidebar" data-testid="sidebar" className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="drag-region h-[52px] shrink-0" />
      {variant(design.variants.compose, { "list-header": null, "sidebar-outline": <ComposeOutline />, "sidebar-pill": <ComposePill /> })}
      <nav data-drop-scroll className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {VIEWS.slice(0, PINNED).map(folder)}
        <MoreFolders view={folderView} folder={folder} />

        {/* what slides when More opens or closes: its own layer, so the slide moves it without repainting it (plan 40) */}
        <div data-more-below className="will-change-transform">
          <SectionTitle
            action={
              <button type="button" data-testid="new-category" aria-label={t("sidebar.newCategory")} onClick={() => setCreating(true)} className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/section:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-reveal:opacity-100">
                <Plus className="size-3.5" />
              </button>
            }
          >
            {t("sidebar.categories")}
          </SectionTitle>
          {categories.map((c) => (
            <div key={c.id} className="relative">
              <NavItem
                testId={`nav-category-${c.id}`}
                dropTarget={c.id}
                // categories are cross-account: inside an account, a category tab is a filter of its Inbox (plan 64)
                active={categoryId === c.id && reviewCategoryId === null && accountId === null}
                onClick={() => navigate({ categoryId: c.id, accountId: null })}
                icon={<CategoryDot color={c.color as CategoryColor} />}
                label={c.name}
                count={counts.categoryUnread[c.id] || undefined}
                reserveEnd={inlineReview && (counts.categorySuggestions[c.id] ?? 0) > 0}
              />
              {inlineReview && (counts.categorySuggestions[c.id] ?? 0) > 0 && (
                <ReviewBadge id={c.id} name={c.name} n={counts.categorySuggestions[c.id]!} active={reviewCategoryId === c.id} />
              )}
              {!inlineReview && (counts.categorySuggestions[c.id] ?? 0) > 0 && (
                <button
                  type="button"
                  data-testid={`nav-review-${c.id}`}
                  data-active={reviewCategoryId === c.id || undefined}
                  onClick={() => navigate({ view: "all", reviewCategoryId: c.id, accountId: null })}
                  className={cn("flex h-6 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left text-xs text-muted-foreground tabular not-data-active:hover:bg-sidebar-hover hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground", ROW_SEAM)}
                >
                  <Sparkles className="size-3 text-sidebar-glyph" />
                  <span className="flex-1">{t("sidebar.review")}</span>
                  <span className="text-xs tabular">{formatNumber(counts.categorySuggestions[c.id]!)}</span>
                </button>
              )}
            </div>
          ))}
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

          <SectionTitle>{t("sidebar.accounts")}</SectionTitle>
          <div ref={accountsRef} onFocus={rememberFocus} onBlur={forgetFocus}>
            {accounts.map((a) => (
              <AccountEntry
                key={a.id}
                account={a}
                many={accounts.length > 1}
                open={openAccount === a.id}
                // where you are, only for the account it's in: the others' props stay the same, so they don't render
                here={accountId === a.id && reviewCategoryId === null}
                view={accountId === a.id ? view : null}
                inCategory={accountId === a.id && categoryId !== null}
                ownFolder={accountId === a.id ? ownFolder : null}
                folders={folders}
                unread={counts.inboxUnreadByAccount[a.id]}
                folderUnread={counts.folderUnread}
                countTone={design.surfaces.inboxCount}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setApp({ dialog: "addAccount" })}
            className="mt-0.5 flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
          >
            <Plus className="size-4" /> {t("sidebar.addAccount")}
          </button>
        </div>
      </nav>
      <SignInNotice />
      <ConnectionPill />
      <UpdatePill />
      <div className="hairline-t hairline-strong flex shrink-0 items-center gap-1 px-2 py-2">
        <Button data-testid="open-filters" variant="ghost" size="sm" className="flex-1 justify-start gap-2 text-sidebar-foreground" onClick={() => setApp({ dialog: "filters" })}>
          <Sparkles className="text-sidebar-glyph" /> {t("sidebar.filters")}
        </Button>
        <LocalPill />
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
