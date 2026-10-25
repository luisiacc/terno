import type { Condition, Filter } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { t, type TextKey } from "@terno/i18n";
import { useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { ConfirmDialog, SettingsGroup } from "./parts";

// keys, read at render (in the current language)
const SOURCE = { manual: "filters.source.manual", ai: "filters.source.ai", learned: "filters.source.learned" } as const;
const FIELD = {
  from: "filters.field.from",
  fromDomain: "filters.field.fromDomain",
  subject: "filters.field.subject",
  body: "filters.field.body",
  recipients: "filters.field.recipients",
  listId: "filters.field.listIdShort",
  hasAttachment: "filters.field.hasAttachment",
  account: "filters.field.account",
  ageDays: "filters.field.ageDays",
} as const satisfies Record<Condition["field"], string>;
/** each text operator, said plainly and negated */
const OP: Record<string, readonly [`filters.op.${string}` & TextKey, `filters.op.${string}` & TextKey]> = {
  contains: ["filters.op.contains", "filters.op.notContains"],
  equals: ["filters.op.equals", "filters.op.notEquals"],
  startsWith: ["filters.op.startsWith", "filters.op.notStartsWith"],
  endsWith: ["filters.op.endsWith", "filters.op.notEndsWith"],
};

/** One line for a condition, in the builder's words. */
function conditionText(c: Condition, accountEmail: (id: number) => string): string {
  const not = Boolean(c.negate);
  if (c.field === "hasAttachment") return c.value !== not ? t("filters.cond.withAttachments") : t("filters.cond.withoutAttachments");
  if (c.field === "account") return t(not ? "filters.cond.notInAccount" : "filters.cond.inAccount", { email: accountEmail(c.value) });
  if (c.field === "ageDays") {
    const key = c.op === "gt" ? (not ? "filters.cond.notOlderThan" : "filters.cond.olderThan") : not ? "filters.cond.notNewerThan" : "filters.cond.newerThan";
    return t(key, { count: c.value });
  }
  const op = OP[c.op];
  return t("filters.cond.text", { field: t(FIELD[c.field]), op: op ? t(op[not ? 1 : 0]) : not ? t("filters.cond.notOp", { op: c.op }) : c.op, value: c.value });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Opens the filter builder on a filter (or a new one); closing it comes back here. */
function edit(f: Filter | null) {
  setApp({
    dialog: "filters",
    filterPrefill: f
      ? { id: f.id, name: f.name, rule: f.rule, enabled: f.enabled, source: f.source, returnTo: "settings" }
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
          {t(SOURCE[filter.source])} · {t("filters.hits", { count: filter.hits })} · {summary}
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

/** Ajustes → Filtros: every filter, on or off, edited in the builder, removed with a confirmation. */
export function FiltersTab() {
  const [filters, setFilters] = useState<Filter[] | null>(null);
  const refresh = () => void client.call("filters.list", {}).then(setFilters, (e: unknown) => snack.error(errorText(e)));
  useEffect(refresh, []);
  return (
    <div data-testid="filters-tab">
      <SettingsGroup title={t("settings.tab.filters")} footer={t("filters.footer")}>
        {filters?.map((f) => <FilterItem key={f.id} filter={f} onChange={refresh} />)}
        {filters?.length === 0 && <p className="py-3 text-sm text-muted-foreground">{t("filters.empty")}</p>}
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-filter-new" onClick={() => edit(null)}>
            <Plus /> {t("filters.newFilter")}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
