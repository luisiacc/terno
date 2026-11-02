import type { Category, CategoryColor } from "@terno/core";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { t } from "@terno/i18n";
import { EyeOff, Inbox, Trash2 } from "@terno/ui/icons";
import { richT } from "~/lib/i18n";
import { strong, Tip } from "./tip";
import { TipMenu, TipMenuItem, TipPicture, TipRightClick, TipRow } from "./tip-picture";

/**
 * Plan 113: beside the first category you make, how its mail stays out of the Inbox and how to bring it back: the row
 * with its eye-off mark, a right-click, and the menu's Show in Inbox under the pointer.
 */
export default function CategoryInboxTip({ category }: { category: Category }) {
  return (
    <Tip
      id="category-inbox"
      anchor={`#app-sidebar [data-drop-target="${category.id}"]`}
      ended={category.showInInbox}
      title={t("category.tip.title", { category: category.name })}
      body={richT("category.tip.body", { category: category.name, b: strong })}
      picture={
        <TipPicture className="h-[132px]">
          <TipRow icon={<Inbox className="size-3.5" />} label={t("view.inbox")} />
          <div className="flex items-center justify-between gap-2">
            <TipRow
              active
              className="w-36"
              icon={<CategoryDot color={category.color as CategoryColor} />}
              label={category.name}
              note={<EyeOff className="size-3 shrink-0 text-muted-foreground" />}
            />
            <TipRightClick />
          </div>
          <TipMenu className="absolute top-[70px] left-16">
            <TipMenuItem pointer icon={<Inbox />} label={t("category.showInInbox")} />
            <TipMenuItem icon={<Trash2 />} label={t("settings.categories.delete.button")} />
          </TipMenu>
        </TipPicture>
      }
    />
  );
}
