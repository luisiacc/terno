import { type Category, type Filter } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { Pencil, Plus, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useState } from "react";
import { conditionText } from "~/lib/rule-text";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { ConfirmDialog, SettingsGroup } from "./parts";
import { CategoryForwardDialog } from "../category-forward-dialog";


// keys, read at render (in the current language)
const SOURCE = { manual: "filters.source.manual", ai: "filters.source.ai", learned: "filters.source.learned" } as const;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Opens the filter builder on a filter (or a new one); closing it comes back here. */
function edit(f: Filter | null) {
  setApp({
    dialog: "filters",
    filterPrefill: f
      ? { id: f.id, name: f.name, rule: f.rule, enabled: f.enabled, source: f.source, auto: f.auto, returnTo: "settings" }
      : { name: "", rule: { match: "all", conditions: [{ field: "from", op: "contains", value: "" }], actions: [{ type: "archive" }] }, returnTo: "settings" },
  });
}

function FilterItem({ filter, onChange }: { filter: Filter; onChange: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const name = filter.name;
  const accounts = useApp((s) => s.accounts);
  const email = (id: number) => accounts.find((a) => a.id === id)?.email ?? t("filters.cond.unknownAccount", { id });
  const summary = [filter.rule.conditions[0] ? conditionText(filter.rule.conditions[0], email) : null, filter.rule.conditions.length > 1 ? t("filters.cond.more", { n: filter.rule.conditions.length - 1 }) : null].filter(Boolean).join(" ");
  return (
    <div className="flex min-h-11 items-center gap-3 py-2" data-testid="settings-filter" data-filter-id={filter.id}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{filter.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {/* plan 90: Terno's own say so, not how the rule was written */}
          {t(filter.auto ? "filters.source.auto" : SOURCE[filter.source])} · {t("filters.hits", { count: filter.hits })} · {summary}
        </p>
      </div>
      <Switch
        aria-label={t("filters.enable", { name })}
        data-testid="settings-filter-enabled"
        checked={filter.enabled}
        onCheckedChange={async (enabled) => {
          try {
            await client.call("filters.save", { id: filter.id, name: filter.name, enabled, source: filter.source, rule: filter.rule });
            onChange();
          } catch (e) {
            snack.error(errorText(e));
          }
        }}
      />
      <Button variant="ghost" size="icon-sm" aria-label={t("filters.edit", { name })} data-testid="settings-filter-edit" onClick={() => edit(filter)}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive-ink" aria-label={t("filters.deleteNamed", { name })} data-testid="settings-filter-delete" onClick={() => setDeleting(true)}>
        <Trash2 />
      </Button>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        testId="settings-filter-delete-dialog"
        title={t("filters.delete.title", { name })}
        description={t("filters.delete.description")}
        confirm={t("filters.delete.confirm")}
        onConfirm={async () => {
          try {
            await client.call("filters.delete", { id: filter.id });
            snack.success(t("filters.deleted", { name }));
            onChange();
          } catch (e) {
            snack.error(errorText(e));
          }
        }}
      />
    </div>
  );
}

/** Plan 116: a category that forwards its new mail: on or off here, its addresses edited in its dialog. */
function CategoryForwardItem({ category }: { category: Category }) {
  const forward = category.forward!;
  const [editing, setEditing] = useState<number | null>(null);
  const to = forward.addresses.map((a) => a.name || a.email).join(", ");
  return (
    <div className="flex min-h-11 items-center gap-3 py-2" data-testid="settings-category-forward" data-category-id={category.id}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{category.name}</p>
        <p className="truncate text-xs text-muted-foreground">{t("filters.categoryForward.to", { to })}</p>
      </div>
      <Switch
        aria-label={t("filters.categoryForward.enable", { name: category.name })}
        data-testid="settings-category-forward-enabled"
        checked={forward.enabled}
        onCheckedChange={async (enabled) => {
          try {
            await client.call("categories.setForward", { categoryId: category.id, forward: { addresses: forward.addresses, enabled } });
          } catch (e) {
            snack.error(errorText(e));
          }
        }}
      />
      <Button variant="ghost" size="icon-sm" aria-label={t("filters.categoryForward.edit", { name: category.name })} data-testid="settings-category-forward-edit" onClick={() => setEditing((n) => (n ?? 0) + 1)}>
        <Pencil />
      </Button>
      {editing !== null && (
        <CategoryForwardDialog key={editing} category={category} open onOpenChange={(open) => !open && setEditing(null)} />
      )}
    </div>
  );
}

/** Plan 90: Terno's filters off at once; the undo token that turns back on exactly those (an edit meanwhile wins). */
async function turnAllOff(filters: Filter[]): Promise<number | null> {
  try {
    const r = await client.call("filters.setEnabled", { ids: filters.filter((f) => f.enabled).map((f) => f.id), enabled: false });
    // said, not offered: the dock is under this dialog, so the Undo sits where the button was
    snack.success(t("filters.auto.allOff", { count: r.changed }));
    return r.filterUndo;
  } catch (e) {
    snack.error(errorText(e));
    return null;
  }
}

/**
 * Ajustes → Filtros: the user's filters, then (plan 90) the ones Terno made
 * when they sorted mail; each on or off, edited in the builder (an edited
 * automatic one becomes theirs), removed with a confirmation.
 */
export function FiltersTab() {
  const [filters, setFilters] = useState<Filter[] | null>(null);
  const refresh = () => void client.call("filters.list", {}).then(setFilters, (e: unknown) => snack.error(errorText(e)));
  useEffect(refresh, []);
  // plan 116: categories that forward (the category list follows their changes)
  const forwarding = useApp((s) => s.categories).filter((c) => c.forward);
  const yours = filters?.filter((f) => !f.auto);
  const auto = filters?.filter((f) => f.auto) ?? [];
  const on = auto.filter((f) => f.enabled).length;
  /** "Turn all off" just ran: its Undo takes the button's place until something else changes */
  const [undoOff, setUndoOff] = useState<number | null>(null);
  return (
    <div data-testid="filters-tab">
      <SettingsGroup title={t("filters.group.yours")} footer={t("filters.footer")} testId="settings-filters-yours">
        {yours?.map((f) => <FilterItem key={f.id} filter={f} onChange={refresh} />)}
        {yours?.length === 0 && <p className="py-3 text-sm text-muted-foreground">{t("filters.empty")}</p>}
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-filter-new" onClick={() => edit(null)}>
            <Plus /> {t("filters.newFilter")}
          </Button>
        </div>
      </SettingsGroup>
      {forwarding.length > 0 && (
        <SettingsGroup title={t("filters.group.categoryForwards")} footer={t("filters.group.categoryForwardsFooter")} testId="settings-filters-category-forwards">
          {forwarding.map((c) => <CategoryForwardItem key={c.id} category={c} />)}
        </SettingsGroup>
      )}
      {auto.length > 0 && (
        <SettingsGroup
          testId="settings-filters-auto"
          title={
            <span className="flex items-center justify-between gap-2">
              {t("filters.group.auto")}
              {undoOff !== null ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="-my-1 font-normal"
                  data-testid="settings-filters-auto-undo"
                  aria-label={t("filters.auto.allOffUndo")}
                  onClick={() => {
                    const filterUndo = undoOff;
                    setUndoOff(null);
                    void client.call("similar.undo", { undoId: null, filterUndo }).then(refresh, (e: unknown) => snack.error(errorText(e)));
                  }}
                >
                  {t("common.undo")}
                </Button>
              ) : (
                on > 1 && (
                  <Button variant="ghost" size="xs" className="-my-1 font-normal" data-testid="settings-filters-auto-off" onClick={() => void turnAllOff(auto).then((u) => (setUndoOff(u), refresh()))}>
                    {t("filters.auto.turnAllOff")}
                  </Button>
                )
              )}
            </span>
          }
          footer={t("filters.group.autoFooter")}
        >
          {auto.map((f) => <FilterItem key={f.id} filter={f} onChange={() => (setUndoOff(null), refresh())} />)}
        </SettingsGroup>
      )}
    </div>
  );
}
