import type { Category } from "@terno/core";
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { t } from "@terno/i18n";
import { Inbox, Trash2 } from "lucide-react";
import { lazy, Suspense, useState, type ReactElement } from "react";
import { setShowInInbox } from "~/lib/categorize";
import { setApp } from "~/state/app";

const CategoryDeleteDialog = lazy(() => import("./category-delete-dialog").then((m) => ({ default: m.CategoryDeleteDialog })));

/** A category's right-click menu (plan 83): whether its mail shows in the Inbox, and Delete…. Settings → Categories has both too. */
export function CategoryMenu({ category, children }: { category: Category; children: ReactElement }) {
  // mounted from the first Delete… on, so the dialog can animate out after
  const [deleting, setDeleting] = useState<boolean | null>(null);
  return (
    <>
      <ContextMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent className="w-52" data-testid={`category-menu-${category.id}`}>
          <ContextMenuCheckboxItem closeOnClick data-testid="category-menu-show-in-inbox" checked={category.showInInbox} onCheckedChange={(on) => void setShowInInbox(category.id, on)}>
            <Inbox />
            <span className="flex-1">{t("category.showInInbox")}</span>
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          {/* a plain item, as in macOS menus: the confirmation is where it reads as destructive */}
          <ContextMenuItem data-testid="category-menu-delete" onClick={() => setDeleting(true)}>
            <Trash2 />
            <span className="flex-1">{t("settings.categories.delete.button")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {deleting !== null && (
        <Suspense fallback={null}>
          <CategoryDeleteDialog category={category} open={deleting} onOpenChange={setDeleting} />
        </Suspense>
      )}
    </>
  );
}
