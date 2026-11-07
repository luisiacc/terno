import type { Category, CategoryColor } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@terno/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@terno/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { cn } from "@terno/ui/lib/utils";
import { formatNumber, t } from "@terno/i18n";
import { Check, ChevronDown, Plus } from "@terno/ui/icons";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useDesign, variant } from "~/lib/design";
import { viewLabel } from "~/lib/format";
import { renderProbe } from "~/lib/render-probe";
import { createCategory, fitTabs, openTab, selectedTab, type Tab } from "~/lib/tabs";
import { useApp } from "~/state/app";
import { useDropState } from "~/state/drag";

/** the listbox's panel: what every tab controls */
export const TAB_PANEL_ID = "list-tabpanel";
const tabId = (tab: Tab) => `list-tab-${tab}`;
/** px between tabs (gap-1) */
const GAP = 4;

/** A tab's look (plan 24 §2.10): text over an indicator (macOS, Atelier), or a pill (Lumen). Shared by the tab and its measuring copy. */
/** A tab's look in the design's variant (the first-run preview draws the same). */
export function tabClass(kind: "underline" | "pill") {
  return variant(kind, {
    underline: cn(
      "type-nav relative flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 whitespace-nowrap text-muted-foreground hover:text-foreground",
      "aria-selected:type-nav-strong aria-selected:text-foreground",
      // the indicator sits on the strip's hairline
      "after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity after:duration-fast aria-selected:after:opacity-100",
    ),
    // the selected place is quiet: what's strongest on the page is the mail
    pill: "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-selected:bg-muted aria-selected:text-foreground",
  });
}

const DROP = "data-[drop-state=over]:bg-drop-target data-[drop-state=over]:text-foreground data-[drop-state=over]:ring-1 data-[drop-state=over]:ring-primary data-[drop-state=over]:ring-inset";

/** The unread count of a tab: one selector each, so a count change renders that tab alone. */
function useTabCount(tab: Tab): number {
  return useApp((s) => (tab === "all" ? 0 : (s.counts.categoryUnread[tab] ?? 0)));
}

/** The first tab is the place itself (the Inbox, or a Gmail tab's All): the words "All" and "Unread" are the quick filter's. */
function labelOf(tab: Tab, categories: readonly Category[], gmailTab: unknown): string {
  return tab === "all" ? (gmailTab ? t("list.filter.all") : viewLabel("inbox")) : (categories.find((c) => c.id === tab)?.name ?? "");
}

interface TabProps {
  tab: Tab;
  label: string;
  color?: CategoryColor;
  selected: boolean;
  focusable: boolean;
  kind: "underline" | "pill";
}

/** One tab. A category's is a drop target (a drop moves, like the sidebar's item). */
const TabButton = memo(function TabButton({ tab, label, color, selected, focusable, kind }: TabProps) {
  renderProbe("ListTab");
  const count = useTabCount(tab);
  const drop = useDropState(typeof tab === "number" ? tab : undefined);
  return (
    <button
      type="button"
      role="tab"
      id={tabId(tab)}
      data-testid={`list-tab-${tab}`}
      aria-selected={selected}
      aria-controls={TAB_PANEL_ID}
      aria-describedby={count > 0 ? `${tabId(tab)}-count` : undefined}
      tabIndex={focusable ? 0 : -1}
      data-drop-target={typeof tab === "number" ? tab : undefined}
      data-drop-state={drop ?? undefined}
      onClick={() => openTab(tab)}
      className={cn("no-drag", tabClass(kind), DROP)}
    >
      {color && <CategoryDot color={color} />}
      {/* the name is the label; the count is its description in words ("3 unread"), the visible number decoration */}
      <span>{label}</span>
      {count > 0 && (
        <>
          <span aria-hidden className="tabular">
            {formatNumber(count)}
          </span>
          <span id={`${tabId(tab)}-count`} hidden>
            {t("list.unreadCount", { count })}
          </span>
        </>
      )}
      {drop === "already" && <Check aria-label={t("sidebar.alreadyHere")} className="size-3.5" />}
    </button>
  );
});

/** "+": a category from its name, then its list (its tab selected). */
function NewCategory({ kind }: { kind: "underline" | "pill" }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  data-testid="list-tabs-new"
                  aria-label={t("sidebar.newCategory")}
                  className={cn("no-drag flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-tint hover:text-foreground", kind === "pill" ? "rounded-full" : "rounded-md")}
                >
                  <Plus className="size-4" />
                </button>
              }
            />
          }
        />
        <TooltipContent>{t("sidebar.newCategory")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 p-2">
        <input
          autoFocus
          data-testid="list-tabs-new-input"
          aria-label={t("sidebar.categoryName")}
          placeholder={t("sidebar.categoryName")}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const name = e.currentTarget.value;
            setOpen(false);
            void createCategory(name);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The List layout's category tabs (plan 24 §2.7): the Inbox, the
 * categories with their unread counts, "More" for what doesn't fit, "+".
 * Places only: Unread and the other filters are the design's quick filters, the same as in Split (plan 158).
 * One row; the selected category always shows. Widths come from a hidden
 * copy of every tab, each observed, so a count, a name, a font arriving or a
 * design switch refits it (no polling).
 */
export function ListTabs() {
  const design = useDesign();
  const kind = design.variants.categoryTabs;
  const categories = useApp((s) => s.categories);
  const selected = useApp(selectedTab);
  const gmailTab = useApp((s) => s.gmailTab);
  const counts = useApp((s) => s.counts.categoryUnread);
  const stripRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<{ available: number; widths: number[]; pinned: number; more: number }>({ available: Infinity, widths: [], pinned: 0, more: 0 });

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const mirror = mirrorRef.current;
    if (!strip || !mirror) return;
    const read = () => {
      const w = (sel: string) => [...mirror.querySelectorAll<HTMLElement>(sel)].map((el) => el.offsetWidth);
      const widths = w("[data-measure=category]");
      const [all = 0] = w("[data-measure=pinned]");
      const [plus = 0] = w("[data-measure=plus]");
      const [more = 0] = w("[data-measure=more]");
      const next = { available: strip.clientWidth, widths, pinned: all + plus + GAP, more };
      setM((p) => (p.available === next.available && p.pinned === next.pinned && p.more === next.more && p.widths.join() === next.widths.join() ? p : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(strip);
    for (const el of mirror.children) ro.observe(el);
    return () => ro.disconnect();
  }, [categories, kind, gmailTab]);

  const selectedIndex = typeof selected === "number" ? categories.findIndex((c) => c.id === selected) : -1;
  const fit = m.widths.length === categories.length ? fitTabs({ widths: m.widths, available: m.available, pinned: m.pinned, more: m.more, gap: GAP, selected: selectedIndex }) : { visible: categories.map((_, i) => i), overflow: [] };
  const visible: Tab[] = ["all", ...fit.visible.map((i) => categories[i]!.id)];
  const overflow = fit.overflow.map((i) => categories[i]!);
  const focusable = selected !== null && visible.includes(selected) ? selected : "all";

  // ← → Home End move along the tabs and open the one reached (a list load is cheap; the latest answer wins)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const i = visible.findIndex((tab) => tabId(tab) === (document.activeElement as HTMLElement | null)?.id);
    if (i < 0) return;
    const to = e.key === "ArrowRight" ? Math.min(visible.length - 1, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? visible.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    document.getElementById(tabId(visible[to]!))?.focus();
    openTab(visible[to]!);
  };

  const tabFor = (tab: Tab) => {
    const c = typeof tab === "number" ? categories.find((x) => x.id === tab) : undefined;
    return <TabButton key={String(tab)} tab={tab} label={labelOf(tab, categories, gmailTab)} color={c?.color as CategoryColor | undefined} selected={selected === tab} focusable={focusable === tab} kind={kind} />;
  };

  return (
    <div data-testid="list-tabs" data-kind={kind} className={cn("relative flex min-w-0 flex-1 items-center gap-1", kind === "underline" ? "hairline-b -mb-2 -ml-2" : "py-0.5")}>
      <div ref={stripRef} data-drop-scroll className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        <div role="tablist" aria-label={t("list.tabs.label")} className="flex items-center gap-1" onKeyDown={onKeyDown}>
          {visible.map(tabFor)}
        </div>
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  data-testid="list-tabs-more"
                  aria-label={t("list.tabs.moreLabel", { count: overflow.length })}
                  className={cn("no-drag", tabClass(kind))}
                >
                  {t("list.tabs.more")}
                  <ChevronDown aria-hidden className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuRadioGroup value={typeof selected === "number" ? String(selected) : ""} onValueChange={(v) => openTab(Number(v))}>
                {overflow.map((c) => (
                  <DropdownMenuRadioItem key={c.id} value={String(c.id)} closeOnClick data-testid={`list-tabs-more-${c.id}`}>
                    <CategoryDot color={c.color as CategoryColor} />
                    <span className="flex-1 truncate">{c.name}</span>
                    {(counts[c.id] ?? 0) > 0 && <span className="text-xs text-muted-foreground tabular">{formatNumber(counts[c.id]!)}</span>}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <NewCategory kind={kind} />
      </div>
      {/* every tab, measured where nobody sees it (the strong weight: the widest a tab gets); in a box of no size, so it adds no overflow */}
      <div aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden">
      <div ref={mirrorRef} className="flex w-max gap-1">
        <span data-measure="pinned" className={cn(tabClass(kind), kind === "underline" && "type-nav-strong")}>
          {labelOf("all", categories, gmailTab)}
        </span>
        {categories.map((c) => (
          <span key={c.id} data-measure="category" className={cn(tabClass(kind), kind === "underline" && "type-nav-strong")}>
            <CategoryDot color={c.color as CategoryColor} />
            {c.name}
            {(counts[c.id] ?? 0) > 0 && <span className="tabular">{formatNumber(counts[c.id]!)}</span>}
          </span>
        ))}
        <span data-measure="more" className={tabClass(kind)}>
          {t("list.tabs.more")}
          <ChevronDown className="size-3.5" />
        </span>
        <span data-measure="plus" className="size-7" />
      </div>
      </div>
    </div>
  );
}
