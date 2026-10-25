import type { Condition, Filter } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Switch } from "@terno/ui/components/switch";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { ConfirmDialog, SettingsGroup } from "./parts";

const SOURCE = { manual: "Manual", ai: "Creado con IA", learned: "Aprendido" } as const;
const FIELD: Record<Condition["field"], string> = { from: "Remitente", fromDomain: "Dominio", subject: "Asunto", body: "Contenido", recipients: "Destinatarios", listId: "Lista", hasAttachment: "Adjuntos", account: "Cuenta", ageDays: "Antigüedad" };
const OP: Record<string, string> = { contains: "contiene", equals: "es", startsWith: "empieza con", endsWith: "termina con" };

/** One line for a condition, in the builder's words. */
function conditionText(c: Condition, accountEmail: (id: number) => string): string {
  const not = c.negate ? "no " : "";
  if (c.field === "hasAttachment") return c.value !== Boolean(c.negate) ? "con adjuntos" : "sin adjuntos";
  if (c.field === "account") return `${not}en ${accountEmail(c.value)}`;
  if (c.field === "ageDays") return `${not}${c.op === "gt" ? "de hace más de" : "de hace menos de"} ${c.value} días`;
  return `${FIELD[c.field]} ${not}${OP[c.op] ?? c.op} «${c.value}»`;
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
  const name = `«${filter.name}»`;
  const accounts = useApp((s) => s.accounts);
  const email = (id: number) => accounts.find((a) => a.id === id)?.email ?? `la cuenta ${id}`;
  const summary = [filter.rule.conditions[0] ? conditionText(filter.rule.conditions[0], email) : null, filter.rule.conditions.length > 1 ? `y ${filter.rule.conditions.length - 1} más` : null].filter(Boolean).join(" ");
  return (
    <div className="flex min-h-11 items-center gap-3 py-2" data-testid="settings-filter" data-filter-id={filter.id}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{filter.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {SOURCE[filter.source]} · {filter.hits} {filter.hits === 1 ? "aplicado" : "aplicados"} · {summary}
        </p>
      </div>
      <Switch
        aria-label={`Activar ${name}`}
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
      <Button variant="ghost" size="icon-sm" aria-label={`Editar ${name}`} data-testid="settings-filter-edit" onClick={() => edit(filter)}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive-ink" aria-label={`Eliminar ${name}`} data-testid="settings-filter-delete" onClick={() => setDeleting(true)}>
        <Trash2 />
      </Button>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        testId="settings-filter-delete-dialog"
        title={`¿Eliminar ${name}?`}
        description="Deja de aplicarse al correo nuevo. Lo que ya hizo (archivar, categorías…) se queda como está."
        confirm="Eliminar filtro"
        onConfirm={async () => {
          try {
            await client.call("filters.delete", { id: filter.id });
            snack.success(`${name} eliminado`);
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
      <SettingsGroup title="Filtros" footer="Se aplican al correo nuevo de todas tus cuentas, en este orden. Los cambios no tocan lo que ya hicieron.">
        {filters?.map((f) => <FilterItem key={f.id} filter={f} onChange={refresh} />)}
        {filters?.length === 0 && <p className="py-3 text-sm text-muted-foreground">Aún no tienes filtros.</p>}
        <div className="py-1.5">
          <Button variant="ghost" size="sm" className="-mx-2" data-testid="settings-filter-new" onClick={() => edit(null)}>
            <Plus /> Nuevo filtro…
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
