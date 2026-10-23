import { filterRuleSchema, describeCondition, type CategoryColor, type Condition, type Filter, type FilterAction, type FilterRule, type LearnedProposal, type ThreadSummary } from "@unica/core";
import { Badge } from "@unica/ui/components/badge";
import { Button } from "@unica/ui/components/button";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Dialog, DialogContent, DialogTitle } from "@unica/ui/components/dialog";
import { Input } from "@unica/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { Switch } from "@unica/ui/components/switch";
import { Textarea } from "@unica/ui/components/textarea";
import { cn } from "@unica/ui/lib/utils";
import { Archive, Loader2, MailCheck, OctagonAlert, Plus, Sparkles, Star, Tag, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { listDate } from "~/lib/format";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";

type Field = Condition["field"];

const FIELDS: { value: Field; label: string }[] = [
  { value: "from", label: "Remitente" },
  { value: "fromDomain", label: "Dominio" },
  { value: "subject", label: "Asunto" },
  { value: "body", label: "Contenido" },
  { value: "recipients", label: "Destinatarios" },
  { value: "listId", label: "Lista de correo" },
  { value: "hasAttachment", label: "Adjuntos" },
  { value: "account", label: "Cuenta" },
  { value: "ageDays", label: "Antigüedad" },
];

const TEXT_OPS = [
  { value: "contains", label: "contiene" },
  { value: "equals", label: "es" },
  { value: "startsWith", label: "empieza con" },
  { value: "endsWith", label: "termina con" },
];

const ACTIONS: { type: Exclude<FilterAction["type"], "addCategory">; label: string; icon: typeof Archive }[] = [
  { type: "archive", label: "Archivar", icon: Archive },
  { type: "trash", label: "Borrar", icon: Trash2 },
  { type: "spam", label: "Spam", icon: OctagonAlert },
  { type: "markRead", label: "Marcar leído", icon: MailCheck },
  { type: "star", label: "Destacar", icon: Star },
];
const EXCLUSIVE = new Set(["archive", "trash", "spam"]);

interface Draft {
  id?: number;
  name: string;
  enabled: boolean;
  source: Filter["source"];
  rule: FilterRule;
}

const emptyDraft = (): Draft => ({
  name: "",
  enabled: true,
  source: "manual",
  rule: { match: "all", conditions: [{ field: "from", op: "contains", value: "" }], actions: [{ type: "archive" }] },
});

function defaultCondition(field: Field, accountId: number): Condition {
  switch (field) {
    case "hasAttachment":
      return { field, op: "is", value: true };
    case "account":
      return { field, op: "is", value: accountId };
    case "ageDays":
      return { field, op: "gt", value: 30 };
    default:
      return { field, op: "contains", value: "" };
  }
}

function ConditionRow({ c, onChange, onRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove?: () => void }) {
  const accounts = useApp((s) => s.accounts);
  return (
    <div className="flex items-center gap-1.5" data-testid="condition-row">
      <Select value={c.field} onValueChange={(f) => onChange(defaultCondition(f as Field, accounts[0]?.id ?? 1))} items={FIELDS}>
        <SelectTrigger size="sm" className="w-36" data-testid="condition-field">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELDS.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={() => onChange({ ...c, negate: !c.negate || undefined } as Condition)}
        className={cn("h-7 rounded-md border px-2 text-xs transition-colors", c.negate ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-transparent text-muted-foreground hover:bg-muted")}
        title="Negar condición"
      >
        {c.negate ? "no" : "sí"}
      </button>
      {c.field === "hasAttachment" ? (
        <span className="flex-1 text-sm text-muted-foreground">tiene archivos adjuntos</span>
      ) : c.field === "account" ? (
        <Select value={String(c.value)} onValueChange={(v) => onChange({ ...c, value: Number(v) })} items={accounts.map((a) => ({ value: String(a.id), label: a.email }))}>
          <SelectTrigger size="sm" className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : c.field === "ageDays" ? (
        <div className="flex flex-1 items-center gap-1.5 text-sm">
          <Select value={c.op} onValueChange={(op) => onChange({ ...c, op: op as "gt" | "lt" })} items={[{ value: "gt", label: "más de" }, { value: "lt", label: "menos de" }]}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gt">más de</SelectItem>
              <SelectItem value="lt">menos de</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" min={0} className="h-7 w-20" value={c.value} onChange={(e) => onChange({ ...c, value: Math.max(0, Number(e.target.value) || 0) })} />
          <span className="text-muted-foreground">días</span>
        </div>
      ) : (
        <>
          <Select value={c.op} onValueChange={(op) => onChange({ ...c, op } as Condition)} items={TEXT_OPS}>
            <SelectTrigger size="sm" className="w-32" data-testid="condition-op">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEXT_OPS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input data-testid="condition-value" className="h-7 flex-1" value={c.value} placeholder={c.field === "from" ? "news@tienda.com" : c.field === "fromDomain" ? "tienda.com" : "texto"} onChange={(e) => onChange({ ...c, value: e.target.value })} />
        </>
      )}
      {onRemove && (
        <Button variant="ghost" size="icon-xs" aria-label="Quitar condición" onClick={onRemove} className="text-muted-foreground">
          <X />
        </Button>
      )}
    </div>
  );
}

function Preview({ rule }: { rule: FilterRule }) {
  const parsed = useMemo(() => filterRuleSchema.safeParse(rule), [rule]);
  const [state, setState] = useState<{ count: number; sample: ThreadSummary[]; ms: number } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!parsed.success) {
      setState(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      const started = performance.now();
      try {
        const r = await client.call("filters.preview", { rule: parsed.data, limit: 6 });
        setState({ ...r, ms: performance.now() - started });
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [parsed.success ? JSON.stringify(parsed.data) : null]);

  return (
    <div className="rounded-lg border border-border bg-muted/30" data-testid="filter-preview">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">
          {!parsed.success ? "Completa las condiciones para ver coincidencias" : state ? (
            <>
              Coincide con <span data-testid="preview-count">{state.count}</span> conversaciones
            </>
          ) : (
            "Calculando…"
          )}
        </span>
        {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : state && <span data-testid="preview-ms" className="font-mono text-2xs text-muted-foreground">{Math.round(state.ms)} ms</span>}
      </div>
      <ul className="divide-y divide-border/60">
        {state?.sample.map((t) => (
          <li key={t.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
            <span className="w-32 shrink-0 truncate font-medium">{t.fromName}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{t.subject}</span>
            <span className="font-mono text-2xs text-muted-foreground">{listDate(t.lastDate)}</span>
          </li>
        ))}
        {state && state.count === 0 && <li className="px-3 py-3 text-center text-xs text-muted-foreground">Ningún correo actual coincide (se aplicará a los nuevos)</li>}
      </ul>
    </div>
  );
}

export function FiltersDialog() {
  const open = useApp((s) => s.dialog === "filters");
  const categories = useApp((s) => s.categories);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [proposals, setProposals] = useState<LearnedProposal[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [prompt, setPrompt] = useState("");
  const [explanation, setExplanation] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setFilters(await client.call("filters.list", {}));
    setProposals(await client.call("learning.proposals", {}));
  };
  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const valid = filterRuleSchema.safeParse(draft.rule);
  const rule = draft.rule;
  const setRule = (r: FilterRule) => setDraft((d) => ({ ...d, rule: r }));
  const hasAction = (type: string) => rule.actions.some((a) => a.type === type);
  const toggleAction = (type: Exclude<FilterAction["type"], "addCategory">) => {
    if (hasAction(type)) setRule({ ...rule, actions: rule.actions.filter((a) => a.type !== type) });
    else setRule({ ...rule, actions: [...rule.actions.filter((a) => !(EXCLUSIVE.has(type) && EXCLUSIVE.has(a.type))), { type }] });
  };
  const categoryAction = rule.actions.find((a) => a.type === "addCategory") as { type: "addCategory"; categoryId: number } | undefined;

  const generate = async () => {
    if (prompt.trim().length < 3) return;
    setGenerating(true);
    setExplanation(null);
    try {
      const out = await client.call("filters.generate", { prompt });
      setDraft({ id: undefined, name: out.name, enabled: true, source: "ai", rule: out.rule });
      setExplanation(out.explanation);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setGenerating(false);
    }
  };

  const save = async (applyExisting: boolean) => {
    if (!valid.success) return;
    setSaving(true);
    try {
      const f = await client.call("filters.save", { id: draft.id, name: draft.name.trim() || describeCondition(rule.conditions[0]!), enabled: draft.enabled, source: draft.source, rule: valid.data });
      if (applyExisting) {
        const r = await client.call("filters.apply", { id: f.id });
        toast.success(`Filtro aplicado a ${r.affectedThreads} conversaciones`);
        void reloadList({ keepSelection: true });
      } else toast.success("Filtro guardado");
      setDraft({ ...draft, id: f.id, name: f.name });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp({ dialog: null })}>
      <DialogContent className="flex h-[min(760px,88vh)] max-w-[min(1040px,94vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(1040px,94vw)]" data-testid="filters-dialog">
        <DialogTitle className="sr-only">Filtros</DialogTitle>
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="text-sm font-semibold">Filtros</h2>
            <Button
              size="xs"
              variant="outline"
              data-testid="new-filter"
              onClick={() => {
                setDraft(emptyDraft());
                setExplanation(null);
                setPrompt("");
              }}
            >
              <Plus /> Nuevo
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {filters.map((f) => (
              <div key={f.id} data-testid="filter-item" className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted", draft.id === f.id && "bg-muted")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (setDraft({ id: f.id, name: f.name, enabled: f.enabled, source: f.source, rule: f.rule }), setExplanation(null))}>
                  <span className="block truncate">{f.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {f.source === "ai" ? "IA" : f.source === "learned" ? "Aprendido" : "Manual"} · {f.hits} aplicado{f.hits === 1 ? "" : "s"}
                  </span>
                </button>
                <Switch
                  size="sm"
                  checked={f.enabled}
                  onCheckedChange={async (enabled) => {
                    await client.call("filters.save", { id: f.id, name: f.name, enabled, source: f.source, rule: f.rule });
                    void refresh();
                  }}
                />
              </div>
            ))}
            {filters.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Aún no tienes filtros.</p>}
            {proposals.length > 0 && (
              <>
                <p className="mt-4 mb-1 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">Sugeridos por tu uso</p>
                {proposals.map((p) => (
                  <div key={p.key} className="rounded-md px-2 py-1.5 text-xs" data-testid="proposal-item">
                    <p className="truncate">
                      {p.action === "archive" ? "Archivar" : p.action === "trash" ? "Borrar" : "Spam"}: <span className="font-medium">{p.value}</span>
                    </p>
                    <div className="mt-1 flex gap-1">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={async () => {
                          await client.call("learning.accept", { key: p.key });
                          toast.success("Filtro creado");
                          void refresh();
                        }}
                      >
                        Crear
                      </Button>
                      <Button size="xs" variant="ghost" onClick={async () => (await client.call("learning.dismiss", { key: p.key }), void refresh())}>
                        Ignorar
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
            <div className="rounded-xl border border-primary/25 bg-gradient-to-br from-accent/80 to-transparent p-4">
              <label className="mb-2 flex items-center gap-1.5 text-sm font-medium" htmlFor="ai-prompt">
                <Sparkles className="size-4 text-primary" /> Describe el filtro y la IA lo arma
              </label>
              <div className="flex gap-2">
                <Textarea
                  id="ai-prompt"
                  data-testid="ai-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
                  }}
                  placeholder="Ej.: archiva los recibos de uber.com y ponlos en Facturas"
                  className="min-h-16 flex-1 resize-none bg-background"
                />
                <Button data-testid="ai-generate" onClick={generate} disabled={generating || prompt.trim().length < 3} className="self-end">
                  {generating ? <Loader2 className="animate-spin" /> : <Wand2 />} Crear con IA
                </Button>
              </div>
              {explanation && (
                <p className="mt-2 text-xs text-accent-foreground" data-testid="ai-explanation">
                  {explanation} Revisa y ajusta abajo antes de guardar.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="filter-name">
                Nombre
              </label>
              <Input id="filter-name" data-testid="filter-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Recibos de Uber" />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span>Si se cumplen</span>
                <Select value={rule.match} onValueChange={(m) => setRule({ ...rule, match: m as "all" | "any" })} items={[{ value: "all", label: "todas" }, { value: "any", label: "alguna" }]}>
                  <SelectTrigger size="sm" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">todas</SelectItem>
                    <SelectItem value="any">alguna</SelectItem>
                  </SelectContent>
                </Select>
                <span>las condiciones:</span>
              </div>
              <div className="space-y-1.5 rounded-lg border border-border p-2.5">
                {rule.conditions.map((c, i) => (
                  <ConditionRow
                    key={i}
                    c={c}
                    onChange={(next) => setRule({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? next : x)) })}
                    onRemove={rule.conditions.length > 1 ? () => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) }) : undefined}
                  />
                ))}
                <Button variant="ghost" size="xs" className="text-muted-foreground" data-testid="add-condition" onClick={() => setRule({ ...rule, conditions: [...rule.conditions, { field: "subject", op: "contains", value: "" }] })}>
                  <Plus /> Añadir condición
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm">Entonces:</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {ACTIONS.map(({ type, label, icon: Icon }) => (
                  <button
                    key={type}
                    type="button"
                    data-testid={`action-toggle-${type}`}
                    aria-pressed={hasAction(type)}
                    onClick={() => toggleAction(type)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                      hasAction(type) ? "border-primary/40 bg-primary/10 text-accent-foreground" : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="size-3.5" /> {label}
                  </button>
                ))}
                <Select
                  value={categoryAction ? String(categoryAction.categoryId) : "none"}
                  onValueChange={(v) =>
                    setRule({ ...rule, actions: [...rule.actions.filter((a) => a.type !== "addCategory"), ...(v === "none" ? [] : [{ type: "addCategory" as const, categoryId: Number(v) }])] })
                  }
                  items={[{ value: "none", label: "Sin categoría" }, ...categories.map((c) => ({ value: String(c.id), label: c.name }))]}
                >
                  <SelectTrigger size="sm" className={cn("h-7 text-xs", categoryAction && "border-primary/40 bg-primary/10")} data-testid="action-category-select">
                    <Tag className="size-3.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin categoría</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        <CategoryDot color={c.color as CategoryColor} /> {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!valid.success && <p className="text-xs text-destructive" data-testid="filter-invalid">{valid.error.issues[0]?.message.replace(/^Too small.*/, "Completa todos los campos y elige al menos una acción.")}</p>}
            </div>

            <Preview rule={rule} />
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-3">
            {draft.source !== "manual" && <Badge variant="secondary">{draft.source === "ai" ? "Creado con IA" : "Aprendido"}</Badge>}
            {draft.id && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={async () => {
                  await client.call("filters.delete", { id: draft.id! });
                  setDraft(emptyDraft());
                  void refresh();
                }}
              >
                <Trash2 /> Eliminar
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" data-testid="filter-save" disabled={!valid.success || saving} onClick={() => save(false)}>
                Guardar
              </Button>
              <Button data-testid="filter-save-apply" disabled={!valid.success || saving} onClick={() => save(true)}>
                Guardar y aplicar a existentes
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
