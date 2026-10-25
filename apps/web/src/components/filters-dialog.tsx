import { filterRuleSchema, describeCondition, type CategoryColor, type Condition, type Filter, type FilterAction, type FilterRule, type LearnedProposal, type ThreadSummary } from "@terno/core";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Dialog, DialogContent, DialogTitle } from "@terno/ui/components/dialog";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Textarea } from "@terno/ui/components/textarea";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Loader2, MailCheck, OctagonAlert, Plus, Sparkles, Star, Tag, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t, type TextKey } from "@terno/i18n";
import { richT } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { errorHelp, privacyLine } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { reloadList } from "~/state/list";
import { ConfirmDialog } from "./settings/parts";

type Field = Condition["field"];

const fields = (): { value: Field; label: string }[] => [
  { value: "from", label: t("filters.field.from") },
  { value: "fromDomain", label: t("filters.field.fromDomain") },
  { value: "subject", label: t("filters.field.subject") },
  { value: "body", label: t("filters.field.body") },
  { value: "recipients", label: t("filters.field.recipients") },
  { value: "listId", label: t("filters.field.listId") },
  { value: "hasAttachment", label: t("filters.field.hasAttachment") },
  { value: "account", label: t("filters.field.account") },
  { value: "ageDays", label: t("filters.field.ageDays") },
];

const textOps = () => [
  { value: "contains", label: t("filters.op.contains") },
  { value: "equals", label: t("filters.op.equals") },
  { value: "startsWith", label: t("filters.op.startsWith") },
  { value: "endsWith", label: t("filters.op.endsWith") },
];

const ACTIONS: { type: Exclude<FilterAction["type"], "addCategory">; label: `filters.action.${string}` & TextKey; icon: typeof Archive }[] = [
  { type: "archive", label: "filters.action.archive", icon: Archive },
  { type: "trash", label: "filters.action.trash", icon: Trash2 },
  { type: "spam", label: "filters.action.spam", icon: OctagonAlert },
  { type: "markRead", label: "filters.action.markRead", icon: MailCheck },
  { type: "star", label: "filters.action.star", icon: Star },
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
  const FIELDS = fields();
  const TEXT_OPS = textOps();
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
        title={t("filters.negate")}
      >
        {c.negate ? t("filters.negate.no") : t("filters.negate.yes")}
      </button>
      {c.field === "hasAttachment" ? (
        <span className="flex-1 text-sm text-muted-foreground">{t("filters.hasAttachment")}</span>
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
          <Select value={c.op} onValueChange={(op) => onChange({ ...c, op: op as "gt" | "lt" })} items={[{ value: "gt", label: t("filters.age.gt") }, { value: "lt", label: t("filters.age.lt") }]}>
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gt">{t("filters.age.gt")}</SelectItem>
              <SelectItem value="lt">{t("filters.age.lt")}</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" min={0} className="h-7 w-20" value={c.value} onChange={(e) => onChange({ ...c, value: Math.max(0, Number(e.target.value) || 0) })} />
          <span className="text-muted-foreground">{t("settings.days")}</span>
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
          <Input data-testid="condition-value" className="h-7 flex-1" value={c.value} placeholder={c.field === "from" ? t("filters.placeholder.from") : c.field === "fromDomain" ? t("filters.placeholder.domain") : t("filters.placeholder.text")} onChange={(e) => onChange({ ...c, value: e.target.value })} />
        </>
      )}
      {onRemove && (
        <Button variant="ghost" size="icon-xs" aria-label={t("filters.removeCondition")} onClick={onRemove} className="text-muted-foreground">
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
    const timer = setTimeout(async () => {
      const started = performance.now();
      try {
        const r = await client.call("filters.preview", { rule: parsed.data, limit: 6 });
        setState({ ...r, ms: performance.now() - started });
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [parsed.success ? JSON.stringify(parsed.data) : null]);

  return (
    <div className="rounded-lg border border-border bg-muted/30" data-testid="filter-preview">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">
          {!parsed.success
            ? t("filters.preview.incomplete")
            : state
              ? richT("filters.preview.matches", { count: state.count, n: (n) => <span data-testid="preview-count">{n}</span> })
              : t("filters.preview.calculating")}
        </span>
        {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : state && <span data-testid="preview-ms" className="font-mono text-2xs text-muted-foreground">{Math.round(state.ms)} ms</span>}
      </div>
      <ul className="divide-y divide-border/60">
        {state?.sample.map((th) => (
          <li key={th.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
            <span className="w-32 shrink-0 truncate font-medium">{th.fromName}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{th.subject}</span>
            <span className="font-mono text-2xs text-muted-foreground">{listDate(th.lastDate)}</span>
          </li>
        ))}
        {state && state.count === 0 && <li className="px-3 py-3 text-center text-xs text-muted-foreground">{t("filters.preview.none")}</li>}
      </ul>
    </div>
  );
}

export function FiltersDialog() {
  const open = useApp((s) => s.dialog === "filters");
  const categories = useApp((s) => s.categories);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [proposals, setProposals] = useState<LearnedProposal[]>([]);
  // "Crear filtro desde este remitente…" opens the builder with its rule
  const [draft, setDraft] = useState<Draft>(() => {
    const prefill = getApp().filterPrefill;
    return prefill ? { ...emptyDraft(), id: prefill.id, name: prefill.name, rule: prefill.rule, enabled: prefill.enabled ?? true, source: prefill.source ?? "manual" } : emptyDraft();
  });
  // opened from Ajustes → Filtros: closing goes back there
  const [returnTo] = useState(() => getApp().filterPrefill?.returnTo ?? null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (getApp().filterPrefill) setApp({ filterPrefill: null });
  }, []);
  const [prompt, setPrompt] = useState("");
  const [explanation, setExplanation] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const ai = useApp((s) => s.settings?.ai);
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
      const kind = (error as { details?: { aiErrorKind?: Parameters<typeof errorHelp>[0] } }).details?.aiErrorKind;
      if (kind === "cancelled") return;
      const help = ai ? errorHelp(kind, ai) : null;
      snack.error(error instanceof Error ? error.message : String(error), {
        description: help ?? undefined,
        action: kind === "not_configured" || kind === "blocked" ? { label: t("filters.aiSettings"), onClick: () => setApp({ dialog: "settings", settingsTab: "ai" }) } : undefined,
      });
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
        snack.success(t("filters.applied", { count: r.affectedThreads }));
        void reloadList({ keepSelection: true });
      } else snack.success(t("filters.saved"));
      setDraft({ ...draft, id: f.id, name: f.name });
      await refresh();
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setApp(returnTo === "settings" ? { dialog: "settings", settingsTab: "filters" } : { dialog: null })}>
      <DialogContent className="flex h-[min(760px,88vh)] max-w-[min(1040px,94vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(1040px,94vw)]" data-testid="filters-dialog">
        <DialogTitle className="sr-only">{t("settings.tab.filters")}</DialogTitle>
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="text-sm font-semibold">{t("settings.tab.filters")}</h2>
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
              <Plus /> {t("filters.new")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {filters.map((f) => (
              <div key={f.id} data-testid="filter-item" className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted", draft.id === f.id && "bg-muted")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (setDraft({ id: f.id, name: f.name, enabled: f.enabled, source: f.source, rule: f.rule }), setExplanation(null))}>
                  <span className="block truncate">{f.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {f.source === "ai" ? t("filters.source.aiShort") : f.source === "learned" ? t("filters.source.learned") : t("filters.source.manual")} · {t("filters.hits", { count: f.hits })}
                  </span>
                </button>
                <Switch
                  size="sm"
                  aria-label={t("filters.enable", { name: f.name })}
                  checked={f.enabled}
                  onCheckedChange={async (enabled) => {
                    await client.call("filters.save", { id: f.id, name: f.name, enabled, source: f.source, rule: f.rule });
                    void refresh();
                  }}
                />
              </div>
            ))}
            {filters.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{t("filters.empty")}</p>}
            {proposals.length > 0 && (
              <>
                <p className="mt-4 mb-1 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{t("filters.suggested")}</p>
                {proposals.map((p) => (
                  <div key={p.key} className="rounded-md px-2 py-1.5 text-xs" data-testid="proposal-item">
                    <p className="truncate">
                      {t(p.action === "archive" ? "filters.action.archive" : p.action === "trash" ? "filters.action.trash" : "filters.action.spam")}: <span className="font-medium">{p.value}</span>
                    </p>
                    <div className="mt-1 flex gap-1">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={async () => {
                          await client.call("learning.accept", { key: p.key });
                          snack.success(t("filters.created"));
                          void refresh();
                        }}
                      >
                        {t("filters.create")}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={async () => (await client.call("learning.dismiss", { key: p.key }), void refresh())}>
                        {t("filters.ignore")}
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
                <Sparkles className="size-4 text-primary" /> {t("filters.ai.label")}
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
                  placeholder={t("filters.ai.placeholder")}
                  className="min-h-16 flex-1 resize-none bg-background"
                />
                <Button data-testid="ai-generate" onClick={generate} disabled={generating || prompt.trim().length < 3} className="self-end">
                  {generating ? <Loader2 className="animate-spin" /> : <Wand2 />} {t("filters.ai.create")}
                </Button>
              </div>
              {ai && (
                <p className="mt-2 text-2xs text-muted-foreground" data-testid="ai-privacy-notice">
                  {privacyLine(ai)}
                </p>
              )}
              {explanation && (
                <p className="mt-2 text-xs text-accent-foreground" data-testid="ai-explanation">
                  {explanation} {t("filters.ai.review")}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="filter-name">
                {t("filters.name")}
              </label>
              <Input id="filter-name" data-testid="filter-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("filters.name.placeholder")} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span>{t("filters.match.before")}</span>
                <Select value={rule.match} onValueChange={(m) => setRule({ ...rule, match: m as "all" | "any" })} items={[{ value: "all", label: t("filters.match.all") }, { value: "any", label: t("filters.match.any") }]}>
                  <SelectTrigger size="sm" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.match.all")}</SelectItem>
                    <SelectItem value="any">{t("filters.match.any")}</SelectItem>
                  </SelectContent>
                </Select>
                <span>{t("filters.match.after")}</span>
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
                  <Plus /> {t("filters.addCondition")}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm">{t("filters.then")}</p>
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
                    <Icon className="size-3.5" /> {t(label)}
                  </button>
                ))}
                <Select
                  value={categoryAction ? String(categoryAction.categoryId) : "none"}
                  onValueChange={(v) =>
                    setRule({ ...rule, actions: [...rule.actions.filter((a) => a.type !== "addCategory"), ...(v === "none" ? [] : [{ type: "addCategory" as const, categoryId: Number(v) }])] })
                  }
                  items={[{ value: "none", label: t("filters.noCategory") }, ...categories.map((c) => ({ value: String(c.id), label: c.name }))]}
                >
                  <SelectTrigger size="sm" className={cn("h-7 text-xs", categoryAction && "border-primary/40 bg-primary/10")} data-testid="action-category-select">
                    <Tag className="size-3.5" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("filters.noCategory")}</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        <CategoryDot color={c.color as CategoryColor} /> {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!valid.success && <p className="text-xs text-destructive" data-testid="filter-invalid">{valid.error.issues[0]?.message.replace(/^Too small.*/, t("filters.incomplete"))}</p>}
            </div>

            <Preview rule={rule} />
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-3">
            {draft.source !== "manual" && <Badge variant="secondary">{draft.source === "ai" ? t("filters.source.ai") : t("filters.source.learned")}</Badge>}
            {draft.id && (
              <>
                <Button variant="ghost" size="sm" className="text-destructive" data-testid="filter-delete" onClick={() => setDeleting(true)}>
                  <Trash2 /> {t("filters.delete.button")}
                </Button>
                <ConfirmDialog
                  open={deleting}
                  onOpenChange={setDeleting}
                  testId="filter-delete-dialog"
                  title={draft.name ? t("filters.delete.title", { name: draft.name }) : t("filters.delete.titleUnnamed")}
                  description={t("filters.delete.description")}
                  confirm={t("filters.delete.confirm")}
                  onConfirm={async () => {
                    await client.call("filters.delete", { id: draft.id! });
                    setDraft(emptyDraft());
                    void refresh();
                  }}
                />
              </>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" data-testid="filter-save" disabled={!valid.success || saving} onClick={() => save(false)}>
                {t("common.save")}
              </Button>
              <Button data-testid="filter-save-apply" disabled={!valid.success || saving} onClick={() => save(true)}>
                {t("filters.saveApply")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
