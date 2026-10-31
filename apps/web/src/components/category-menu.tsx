import type { Category } from "@terno/core";
import { ContextMenu, ContextMenuCheckboxItem, ContextMenuContent, ContextMenuTrigger } from "@terno/ui/components/context-menu";
import { t } from "@terno/i18n";
import { Inbox } from "lucide-react";
import type { ReactElement } from "react";
import { setShowInInbox } from "~/lib/categorize";
import { setApp } from "~/state/app";

/** A category's right-click menu (plan 83): whether its mail shows in the Inbox. Settings → Categories has the same switch. */
export function CategoryMenu({ category, children }: { category: Category; children: ReactElement }) {
  return (
    <ContextMenu onOpenChange={(open) => setApp({ menuOpen: open })}>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-52" data-testid={`category-menu-${category.id}`}>
        <ContextMenuCheckboxItem closeOnClick data-testid="category-menu-show-in-inbox" checked={category.showInInbox} onCheckedChange={(on) => void setShowInInbox(category.id, on)}>
          <Inbox />
          <span className="flex-1">{t("category.showInInbox")}</span>
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
