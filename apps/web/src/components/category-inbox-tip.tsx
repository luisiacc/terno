import type { Category, CategoryColor } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { useModalHost } from "@terno/ui/components/modal-host";
import { Popover, PopoverArrow, PopoverContent, PopoverDescription, PopoverTitle } from "@terno/ui/components/popover";
import { t } from "@terno/i18n";
import { EyeOff, Inbox, MousePointer, MouseRightClick, Trash2 } from "@terno/ui/icons";
import { useEffect, useState } from "react";
import { categoryTipShown, dismissCategoryTip, markCategoryTipShown } from "~/lib/category-tip";
import { richT } from "~/lib/i18n";
import { useApp } from "~/state/app";

/**
 * Plan 113: once, beside the first category you make, a picture of how its mail stays out of the Inbox and how to bring
 * it back: the row with its eye-off mark, a right-click, and the menu's Show in Inbox. It never takes focus (nothing in
 * it needs doing); Got it, Escape or a click anywhere closes it, and anything modal, the menu included, ends it.
 */
export default function CategoryInboxTip({ category }: { category: Category }) {
  const modal = useModalHost();
  const busy = useApp((s) => s.dialog !== null || s.menuOpen) || modal !== null;
  const [row, setRow] = useState<HTMLElement | null>(null);

  // its row is there once the category is (a creation's own event may come after it lands you on the category)
  useEffect(() => {
    if (row) {
      if (busy || category.showInInbox || !row.isConnected) dismissCategoryTip();
      return;
    }
    if (busy || category.showInInbox) return;
    // another window showed it meanwhile
    if (categoryTipShown()) return dismissCategoryTip();
    const el = document.querySelector<HTMLElement>(`#app-sidebar [data-drop-target="${category.id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    markCategoryTipShown();
    setRow(el);
  }, [row, busy, category.showInInbox, category.id]);

  // Escape is the tip's while it's up: before the app's own keys (which would also clear a selection or close the reader)
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      dismissCategoryTip();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [row]);

  const open = row !== null;
  return (
    <>
      {/* read once when it opens: the popup itself is never focused */}
      <span aria-live="polite" className="sr-only">
        {open && (
          <>
            {t("category.tip.title", { category: category.name })}. {richT("category.tip.body", { category: category.name, b: (text) => text })}
          </>
        )}
      </span>
      <Popover open={open} onOpenChange={(next) => !next && dismissCategoryTip()}>
        <PopoverContent
          anchor={row}
          side="right"
          align="start"
          alignOffset={-10}
          sideOffset={10}
          initialFocus={false}
          finalFocus={false}
          data-testid="category-inbox-tip"
          className="w-72 gap-3 in-data-anchor-hidden:invisible"
        >
          <PopoverArrow />
          <Picture category={category} />
          <div className="flex flex-col gap-1 px-0.5">
            <PopoverTitle className="text-sm">{t("category.tip.title", { category: category.name })}</PopoverTitle>
            <PopoverDescription className="text-xs leading-relaxed">
              {richT("category.tip.body", { category: category.name, b: (text) => <span className="font-medium text-foreground">{text}</span> })}
            </PopoverDescription>
          </div>
          <div className="flex justify-end">
            <Button size="sm" data-testid="category-inbox-tip-done" onClick={dismissCategoryTip}>
              {t("category.tip.done")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** The gesture as it will look: the sidebar's rows, a right-click on the category, its menu with Show in Inbox under the pointer. */
function Picture({ category }: { category: Category }) {
  return (
    <div aria-hidden data-testid="category-inbox-tip-picture" className="relative h-[132px] overflow-hidden rounded-lg bg-sidebar p-1.5 text-sidebar-foreground hairline">
      <div className="flex h-7 items-center gap-2 rounded-md px-2 text-xs">
        <Inbox className="size-3.5 text-sidebar-glyph" />
        <span>{t("view.inbox")}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex h-7 w-36 items-center gap-2 rounded-md bg-sidebar-accent px-2 text-xs text-sidebar-accent-foreground">
          <span className="flex size-3.5 items-center justify-center">
            <CategoryDot color={category.color as CategoryColor} />
          </span>
          <span className="min-w-0 truncate">{category.name}</span>
          <EyeOff className="size-3 shrink-0 text-muted-foreground" />
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground shadow-hairline">
          <MouseRightClick className="size-3.5" />
          {t("category.tip.rightClick")}
        </span>
      </div>
      <div className="absolute top-[70px] left-16 w-44 rounded-md bg-popover p-1 shadow-popover">
        <div className="relative flex h-6 items-center gap-1.5 rounded-sm bg-accent px-2 text-xs text-accent-foreground">
          <Inbox className="size-[1.15em]" />
          <span className="truncate">{t("category.showInInbox")}</span>
          <MousePointer className="absolute top-2.5 right-3 size-4 fill-background text-foreground" />
        </div>
        <div className="flex h-6 items-center gap-1.5 px-2 text-xs text-muted-foreground">
          <Trash2 className="size-[1.15em]" />
          <span className="truncate">{t("settings.categories.delete.button")}</span>
        </div>
      </div>
    </div>
  );
}
