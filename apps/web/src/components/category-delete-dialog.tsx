import type { Category } from "@terno/core";
import { t } from "@terno/i18n";
import { deleteCategory } from "~/lib/categorize";
import { ConfirmDialog } from "./settings/parts";

/** The sidebar menu's Delete… confirmation, the same as Settings → Categories'. Lazy: out of the entry chunk. */
export function CategoryDeleteDialog({ category, open, onOpenChange }: { category: Category; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      testId="category-delete-dialog"
      title={t("settings.categories.delete.title", { name: category.name })}
      description={t("settings.categories.delete.description")}
      confirm={t("settings.categories.delete.confirm")}
      onConfirm={async () => {
        if (!(await deleteCategory(category.id, category.name))) return;
        // its sidebar row, which the dialog gave focus back to, is gone: focus lands on the Inbox, not the page
        requestAnimationFrame(() => {
          if (document.activeElement === document.body || !document.activeElement?.isConnected) document.querySelector<HTMLElement>("[data-testid=nav-inbox]")?.focus();
        });
      }}
    />
  );
}
