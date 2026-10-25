import type { ImportResult } from "@terno/core/rpc";
import { formatList, t } from "@terno/i18n";

/** What a storage switch brought over, in the active locale (the snack after the reload). */
export function carriedText(r: Pick<ImportResult, "categories" | "filters" | "drafts" | "pending">): { message: string; description?: string } {
  const items = [t("web.carry.categories", { count: r.categories.added + r.categories.merged }), t("web.carry.filters", { count: r.filters.added + r.filters.existing })];
  if (r.drafts) items.push(t("web.carry.drafts", { count: r.drafts }));
  items.push(t("web.carry.settings"));
  const message = t("web.carry.done", { items: formatList(items) });
  const pending = [r.pending.drafts && t("web.carry.drafts", { count: r.pending.drafts }), r.pending.filters && t("web.carry.filters", { count: r.pending.filters })].filter((x): x is string => !!x);
  return pending.length ? { message, description: t("web.carry.pending", { items: formatList(pending) }) } : { message };
}
