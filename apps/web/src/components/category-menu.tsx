import type { Category } from "@terno/core";
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { t } from "@terno/i18n";
import { Forward, Inbox, Trash2 } from "@terno/ui/icons";
import { useState, type ReactElement } from "react";
import { setShowInInbox } from "~/lib/categorize";
import { setApp } from "~/state/app";
import { CategoryDeleteDialog } from "./category-delete-dialog";
import { CategoryForwardDialog } from "./category-forward-dialog";


/** A category's right-click menu (plan 83): whether its mail shows in the Inbox, where its new mail is forwarded (plan 116), and Delete…. */
export function CategoryMenu({ category, children }: { category: Category; children: ReactElement }) {
  // mounted from the first Delete… on, so the dialog can animate out after
  const [deleting, setDeleting] = useState<boolean | null>(null);
  const [forwarding, setForwarding] = useState<boolean | null>(null);
  // each opening starts from the saved addresses (a key per opening, so closing still animates)
  const [opened, setOpened] = useState(0);
  return (
    <>
      <ContextMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
        <ContextMenuTrigger data-context-menu render={children} />
        <ContextMenuContent className="w-52" data-testid={`category-menu-${category.id}`}>
          <ContextMenuCheckboxItem closeOnClick data-testid="category-menu-show-in-inbox" checked={category.showInInbox} onCheckedChange={(on) => void setShowInInbox(category.id, on)}>
            <Inbox />
            <span className="flex-1">{t("category.showInInbox")}</span>
          </ContextMenuCheckboxItem>
          <ContextMenuItem
            data-testid="category-menu-forward"
            onClick={() => {
              setOpened((n) => n + 1);
              setForwarding(true);
            }}
          >
            <Forward />
            <span className="flex-1">{t("category.forward.menu")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* a plain item, as in macOS menus: the confirmation is where it reads as destructive */}
          <ContextMenuItem data-testid="category-menu-delete" onClick={() => setDeleting(true)}>
            <Trash2 />
            <span className="flex-1">{t("settings.categories.delete.button")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {deleting !== null && (
        <CategoryDeleteDialog category={category} open={deleting} onOpenChange={setDeleting} />
      )}
      {forwarding !== null && (
        <CategoryForwardDialog key={opened} category={category} open={forwarding} onOpenChange={setForwarding} />
      )}
    </>
  );
}
