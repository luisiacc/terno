import { useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { CategoryColor, View } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Shortcut } from "@terno/ui/components/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Check, ChevronDown, Inbox, Layers, OctagonAlert, Plus, Send, Settings2, Sparkles, SquarePen, Star, Trash2 } from "lucide-react";
import { Kbd } from "@terno/ui/components/kbd";
import { openCompose } from "~/lib/actions";
import { useDesign, variant } from "~/lib/design";
import { formatNumber, t } from "@terno/i18n";
import { viewLabel } from "~/lib/format";
import { navigate, setApp, useApp } from "~/state/app";
import { client } from "~/rpc/connection";
import { CATEGORY_COLORS } from "@terno/core";
import { snack } from "~/lib/snack";
import { renderProbe } from "~/lib/render-probe";
import { useDropState } from "~/state/drag";
import { LocalPill } from "./local-pill";
import { ConnectionPill } from "./connection-pill";
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

// ── More: open or closed, remembered on this device (like the format bar)

const MORE_KEY = "terno:sidebar-more";
function readMore(): boolean {
  try {
    return localStorage.getItem(MORE_KEY) === "open";
  } catch {
    return false;
  }
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
  /** room at the end for a control drawn over the row (a review badge) */
  reserveEnd?: boolean;
}) {
  renderProbe("NavItem");
  // only the item under the pointer (and the one it left) re-renders during a drag
  const drop = useDropState(dropTarget);
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      data-drop-target={dropTarget}
      data-drop-state={drop ?? undefined}
      onClick={onClick}
      className={cn(
        "group type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-sidebar-foreground transition-colors",
        reserveEnd && "pr-14",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "data-active:type-nav-strong data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground",
        "data-[drop-state=over]:bg-drop-target data-[drop-state=over]:text-sidebar-accent-foreground data-[drop-state=over]:ring-1 data-[drop-state=over]:ring-primary data-[drop-state=over]:ring-inset",
        "data-[drop-state=already]:bg-sidebar-accent data-[drop-state=already]:text-muted-foreground",
      )}
    >
      <span className="flex size-4 items-center justify-center text-sidebar-glyph transition-transform group-data-[drop-state=over]:scale-125">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
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
      onClick={() => navigate({ view: "all", reviewCategoryId: id })}
      className="absolute top-1/2 right-1.5 flex h-5 -translate-y-1/2 items-center gap-0.5 rounded-full bg-(--review-badge-bg) px-1.5 text-2xs font-semibold text-(--review-badge-fg) tabular transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
    >
      <Sparkles className="size-3" />
      {formatNumber(n)}
    </button>
  );
}

/**
 * Sent, Archive, All Mail, Spam and Trash behind a quiet More (plan 21). Their
 * slots keep their height while hidden, so nothing below moves when they fade
 * in or out; the folder you're in stays shown, in its own slot. A hidden slot
 * is inert: not focusable, not clickable, not in the accessibility tree.
 */
function MoreFolders({ view, folder }: { view: View | null; folder: (f: (typeof VIEWS)[number]) => React.ReactNode }) {
  const open = useSidebarMore((s) => s.open);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // a focused folder just hidden (More closed over it, or a key went elsewhere): focus goes to More, not to the
  // document (the browser drops focus from an inert node only at the next frame, so it's still there now)
  useLayoutEffect(() => {
    if (document.activeElement?.closest("[data-more-slot][inert]")) toggleRef.current?.focus();
  }, [open, view]);
  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        data-testid="nav-more"
        aria-expanded={open}
        aria-controls="sidebar-more-folders"
        onClick={toggleMore}
        className="group/more type-nav flex h-(--nav-h) w-full items-center gap-2.5 rounded-(--nav-radius) px-2 text-left text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <span className="flex size-4 items-center justify-center">
          <ChevronDown className={cn("size-3.5 transition-transform duration-base ease-motion", !open && "-rotate-90")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{open ? t("sidebar.less") : t("sidebar.more")}</span>
      </button>
      <div id="sidebar-more-folders" role="group" aria-label={t("sidebar.moreFolders")}>
        {VIEWS.slice(PINNED).map((f) => {
          const active = view === f.view;
          const shown = open || active;
          return (
            <div
              key={f.view}
              data-more-slot={f.view}
              data-active-slot={active || undefined}
              data-shown={shown || undefined}
              inert={!shown}
              className="invisible -translate-y-0.5 opacity-0 transition-[opacity,translate,visibility] duration-base ease-motion data-shown:visible data-shown:translate-y-0 data-shown:opacity-100"
            >
              {folder(f)}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function Sidebar() {
  const view = useApp((s) => s.view);
  const accountId = useApp((s) => s.accountId);
  const categoryId = useApp((s) => s.categoryId);
  const reviewCategoryId = useApp((s) => s.reviewCategoryId);
  const accounts = useApp((s) => s.accounts);
  const categories = useApp((s) => s.categories);
  const counts = useApp((s) => s.counts);
  const design = useDesign();
  const inlineReview = design.variants.categoryReview === "inline-badge";

  const [creating, setCreating] = useState(false);
  const createCategory = async (name: string) => {
    setCreating(false);
    if (!name.trim()) return;
    try {
      const color = CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]!;
      const c = await client.call("categories.create", { name: name.trim(), color });
      navigate({ categoryId: c.id });
    } catch (e) {
      snack.error(String(e));
    }
  };

  // the folder you're in: none in a category or its suggestions (both are "all" underneath)
  const folderView = categoryId === null && reviewCategoryId === null ? view : null;
  const folder = ({ view: v, icon: Icon, keys }: (typeof VIEWS)[number]) => (
    <Tooltip key={v}>
      <TooltipTrigger
        render={
          <NavItem
            testId={`nav-${v}`}
            active={folderView === v}
            onClick={() => navigate({ view: v })}
            icon={<Icon className="size-4" />}
            label={viewLabel(v)}
            count={v === "inbox" ? (accountId ? counts.inboxUnreadByAccount[accountId] : counts.inboxUnread) : undefined}
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

        <SectionTitle
          action={
            <button type="button" data-testid="new-category" aria-label={t("sidebar.newCategory")} onClick={() => setCreating(true)} className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/section:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100">
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
              active={categoryId === c.id && reviewCategoryId === null}
              onClick={() => navigate({ categoryId: c.id })}
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
                onClick={() => navigate({ view: "all", reviewCategoryId: c.id })}
                className="flex h-6 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left text-xs text-muted-foreground tabular hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
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
        <NavItem
          testId="nav-account-all"
          active={accountId === null}
          onClick={() => navigate({ accountId: null, view })}
          icon={<Layers className="size-3.5" />}
          label={t("sidebar.allAccounts")}
        />
        {accounts.map((a) => (
          <NavItem
            key={a.id}
            testId={`nav-account-${a.id}`}
            active={accountId === a.id}
            onClick={() => navigate({ accountId: a.id, view: categoryId ? "inbox" : view })}
            icon={
              <span className="relative">
                <CategoryDot color={a.color as CategoryColor} />
                {a.syncState.status === "syncing" && <span className="absolute -inset-0.5 animate-ping rounded-full bg-sidebar-primary/40" />}
              </span>
            }
            label={a.displayName}
            count={counts.inboxUnreadByAccount[a.id] || undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => setApp({ dialog: "addAccount" })}
          className="mt-0.5 flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Plus className="size-4" /> {t("sidebar.addAccount")}
        </button>
      </nav>
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
