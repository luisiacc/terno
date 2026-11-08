import { formatAddressList, isValidEmail, parseAddressList, type Address, checkPattern, sameRule, filterIssueKey, filterRuleSchema, describeCondition, patternTemplate, PATTERN_FIELDS, capFilterName, LEARNED_FILTER_NAME, type CategoryColor, type Condition, type Filter, type FilterAction, type FilterRule, type LearnedProposal, type ThreadSummary } from "@terno/core";
import { Badge } from "@terno/ui/components/badge";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { CloseButton } from "@terno/ui/components/close-button";
import { Spinner } from "@terno/ui/components/spinner";
import { Dialog, DialogContent, DialogTitle } from "@terno/ui/components/dialog";
import { Input } from "@terno/ui/components/input";
import { NumberField } from "@terno/ui/components/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { Textarea } from "@terno/ui/components/textarea";
import { cn } from "@terno/ui/lib/utils";
import { Archive, Check, Folder as FolderIcon, Forward, MailCheck, OctagonAlert, Plus, Sparkles, Star, Tag, Trash2, Wand2 } from "@terno/ui/icons";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { t, type TextKey } from "@terno/i18n";
import { richT } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { applyFilter } from "~/lib/filters";
import { aiReady, errorHelp, privacyLine } from "~/lib/ai";
import { listDate } from "~/lib/format";
import { client } from "~/rpc/connection";
import { learnedRule } from "~/lib/learned";
import { describeRule, ruleMisses, sensedOp, withSensedOp, type SensedOp } from "~/lib/rule-words";
import { getApp, setApp, useApp } from "~/state/app";
import { ConfirmDialog } from "./settings/parts";
import { AI_CARD, AI_GLYPH, AI_HEADER, AI_TITLE } from "./ai-card";
import { AiProvenance } from "./ai-provenance";
import { imeKey } from "~/lib/ime-escape";
import { RecipientInput } from "./recipient-input";

type Field = Condition["field"];

const fields = (): { value: Field; label: string }[] => [
  { value: "from", label: t("filters.field.from") },
  { value: "fromDomain", label: t("filters.field.fromDomain") },
  { value: "subject", label: t("filters.field.subject") },
  { value: "body", label: t("filters.field.body") },
  { value: "text", label: t("filters.field.text") },
  { value: "opening", label: t("filters.field.opening") },
  { value: "recipients", label: t("filters.field.recipients") },
  { value: "listId", label: t("filters.field.listId") },
  { value: "hasAttachment", label: t("filters.field.hasAttachment") },
  { value: "account", label: t("filters.field.account") },
  { value: "ageDays", label: t("filters.field.ageDays") },
];

/**
 * plan 89: a word field only mentions; a pattern only where the field allows one (never the body). Plan 161: each
 * operator with its "not" beside it, as Mail and Gmail say it, instead of a separate toggle; a word field and the
 * start of mail only ever turn true, so they have no "not".
 */
const textOps = (field: Field): { value: SensedOp; label: string }[] =>
  field === "text"
    ? [{ value: "contains", label: t("filters.op.mentions") }]
    : field === "opening"
    ? [{ value: "matches", label: t("filters.op.matches") }]
    : [
        { value: "contains", label: t("filters.op.contains") },
        { value: "not:contains", label: t("filters.op.notContains") },
        { value: "equals", label: t("filters.op.equals") },
        { value: "not:equals", label: t("filters.op.notEquals") },
        { value: "startsWith", label: t("filters.op.startsWith") },
        { value: "not:startsWith", label: t("filters.op.notStartsWith") },
        { value: "endsWith", label: t("filters.op.endsWith") },
        { value: "not:endsWith", label: t("filters.op.notEndsWith") },
        ...((PATTERN_FIELDS as readonly string[]).includes(field) ? [{ value: "matches", label: t("filters.op.matches") }, { value: "not:matches", label: t("filters.op.notMatches") }] : []),
      ];
const attachmentOps = (): { value: SensedOp; label: string }[] => [
  { value: "is", label: t("filters.attach.has") },
  { value: "not:is", label: t("filters.attach.hasNot") },
];
const accountOps = (): { value: SensedOp; label: string }[] => [
  { value: "is", label: t("filters.op.equals") },
  { value: "not:is", label: t("filters.op.notEquals") },
];
/** a "not" an older rule holds on an age: still shown, and kept, as what it is */
const ageOps = (negated: boolean): { value: SensedOp; label: string }[] => [
  { value: "gt", label: t("filters.age.gt") },
  { value: "lt", label: t("filters.age.lt") },
  ...(negated ? [{ value: "not:gt", label: t("filters.age.notGt") }, { value: "not:lt", label: t("filters.age.notLt") }] : []),
];

/** An operator menu over a condition's operator and its sense. */
function OpSelect({ c, ops, onChange, className }: { c: Condition; ops: { value: SensedOp; label: string }[]; onChange: (c: Condition) => void; className: string }) {
  return (
    <Select value={sensedOp(c)} onValueChange={(v) => onChange(withSensedOp(c, v as SensedOp))} items={ops}>
      <SelectTrigger size="sm" className={className} data-testid="condition-op" aria-label={t("filters.op.label")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ops.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const PATTERN_ISSUES = {
  syntax: "filters.invalid.pattern.syntax",
  length: "filters.invalid.pattern.length",
  unsupported: "filters.invalid.pattern.unsupported",
  complex: "filters.invalid.pattern.complex",
} as const satisfies Record<NonNullable<ReturnType<typeof checkPattern>>, TextKey>;

/** Plan 128: "Move to" a folder of one account. One that isn't there says so: the mail it would move stays in the Inbox. */
function FolderAction({ action, rule, onChange }: { action: { accountId: number; folder: string } | undefined; rule: FilterRule; onChange: (to: { accountId: number; folder: string } | null) => void }) {
  const folders = useApp((s) => s.folders);
  const accounts = useApp((s) => s.accounts);
  const options = useMemo(() => {
    const email = new Map(accounts.map((a) => [a.id, a.email]));
    return folders
      .filter((f) => f.selectable && email.has(f.accountId))
      .map((f) => ({ value: JSON.stringify([f.accountId, f.key]), label: accounts.length > 1 ? `${email.get(f.accountId)!} · ${f.path.join(" / ")}` : f.path.join(" / ") }));
  }, [folders, accounts]);
  if (!action && options.length === 0) return null;
  const value = action ? JSON.stringify([action.accountId, action.folder]) : "none";
  const gone = action !== undefined && !options.some((o) => o.value === value);
  const items = [{ value: "none", label: t("filters.noFolder") }, ...options, ...(gone ? [{ value, label: t("filters.folderGone") }] : [])];
  const account = action && accounts.find((a) => a.id === action.accountId);
  const oneAccount = rule.match === "all" && rule.conditions.some((c) => c.field === "account" && c.value === action?.accountId && !c.negate);
  return (
    <div className="space-y-1.5">
      <Select
        value={value}
        onValueChange={(v) => {
          if (v === "none") return onChange(null);
          const [accountId, folder] = JSON.parse(v as string) as [number, string];
          onChange({ accountId, folder });
        }}
        items={items}
      >
        <SelectTrigger size="sm" className={cn("h-7 max-w-full text-xs", action && "border-primary/40 bg-primary/10")} data-testid="action-folder-select" aria-label={t("filters.moveToFolder")}>
          <FolderIcon className="size-3.5" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {gone ? (
        <p className="text-xs text-destructive" data-testid="filter-folder-gone">{t("filters.folderGoneHelp")}</p>
      ) : (
        action && account && !oneAccount && <p className="text-xs text-muted-foreground" data-testid="filter-folder-account">{t("filters.folderAccountOnly", { account: account.email })}</p>
      )}
    </div>
  );
}

const ACTIONS: { type: Exclude<FilterAction["type"], "addCategory" | "forward" | "moveToFolder">; label: `filters.action.${string}` & TextKey; icon: typeof Archive }[] = [
  { type: "archive", label: "filters.action.archive", icon: Archive },
  { type: "trash", label: "filters.action.trash", icon: Trash2 },
  { type: "spam", label: "filters.action.spam", icon: OctagonAlert },
  { type: "markRead", label: "filters.action.markRead", icon: MailCheck },
  { type: "star", label: "filters.action.star", icon: Star },
];
const EXCLUSIVE = new Set(["archive", "trash", "spam", "moveToFolder"]);

interface Draft {
  id?: number;
  name: string;
  enabled: boolean;
  source: Filter["source"];
  rule: FilterRule;
  /** plan 90: Terno made it; what it was when loaded (an edit of either makes it the user's) */
  auto?: { name: string; rule: FilterRule };
}

/** A filter loaded into the builder. */
const draftOf = (f: Pick<Filter, "name" | "enabled" | "source" | "rule"> & { id?: number; auto?: boolean }): Draft => ({
  id: f.id,
  name: f.name,
  enabled: f.enabled,
  source: f.source,
  rule: f.rule,
  auto: f.auto ? { name: f.name, rule: f.rule } : undefined,
});

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
    case "opening":
      return { field, op: "matches", value: "" };
    default:
      return { field, op: "contains", value: "" };
  }
}

function ConditionRow({ c, onChange, onRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove?: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const issueId = useId();
  const FIELDS = fields();
  const TEXT_OPS = textOps(c.field);
  const pattern = c.field !== "hasAttachment" && c.field !== "account" && c.field !== "ageDays" && c.op === "matches" ? c.value : null;
  // checked as it's typed (an empty value is just "fill in", like any other field)
  const issue = pattern?.trim() ? checkPattern(pattern.trim()) : null;
  const template = pattern ? patternTemplate(pattern.trim()) : null;
  return (
    <div className="flex flex-col gap-1">
    <div className="flex items-center gap-1.5" data-testid="condition-row">
      <Select value={c.field} onValueChange={(f) => onChange(defaultCondition(f as Field, accounts[0]?.id ?? 1))} items={FIELDS}>
        {/* plan 161, pass 2: as wide as its name ("Subject and first lines" says what it covers), never under the others' */}
        <SelectTrigger size="sm" className="w-auto min-w-36 shrink-0" data-testid="condition-field" aria-label={t("filters.field.label")}>
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
      {c.field === "hasAttachment" ? (
        <OpSelect c={c} ops={attachmentOps()} onChange={onChange} className="flex-1" />
      ) : c.field === "account" ? (
        <>
          <OpSelect c={c} ops={accountOps()} onChange={onChange} className="w-28" />
          <Select value={String(c.value)} onValueChange={(v) => onChange({ ...c, value: Number(v) })} items={accounts.map((a) => ({ value: String(a.id), label: a.email }))}>
            <SelectTrigger size="sm" className="flex-1" aria-label={t("filters.field.account")}>
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
        </>
      ) : c.field === "ageDays" ? (
        <div className="flex flex-1 items-center gap-1.5 text-sm">
          <OpSelect c={c} ops={ageOps(Boolean(c.negate))} onChange={onChange} className="w-32" />
          <NumberField aria-label={t("filters.age.days")} min={0} format={{ useGrouping: false }} className="h-7 w-28" value={c.value} onValueChange={(days) => onChange({ ...c, value: Math.max(0, days ?? 0) })} />
          <span className="text-muted-foreground">{t("settings.days")}</span>
        </div>
      ) : (
        <>
          <OpSelect c={c} ops={TEXT_OPS} onChange={onChange} className="w-40" />
          <Input
            data-testid="condition-value"
            className={cn("h-7 flex-1", pattern !== null && "font-mono text-xs")}
            value={c.value}
            aria-invalid={issue ? true : undefined}
            aria-describedby={pattern !== null ? issueId : undefined}
            placeholder={pattern !== null ? t("filters.placeholder.pattern") : c.field === "from" ? t("filters.placeholder.from") : c.field === "fromDomain" ? t("filters.placeholder.domain") : t("filters.placeholder.text")}
            onChange={(e) => onChange({ ...c, value: e.target.value })}
          />
        </>
      )}
      {onRemove && (
        <CloseButton label={t("filters.removeCondition")} onClick={onRemove} className="mx-0.5" />
      )}
    </div>
      {pattern !== null && (
        // the pattern's issue, else what a generated one reads as, else how to write one
        <p id={issueId} data-testid="condition-pattern-help" className={cn("pl-1 text-xs", issue ? "text-destructive-ink" : "text-muted-foreground")}>
          {issue ? t(PATTERN_ISSUES[issue]) : template !== null ? t("filters.pattern.template", { template }) : t("filters.pattern.help")}
        </p>
      )}
    </div>
  );
}

/** Plan 116: the addresses a filter forwards new mail to (its "Forward to" action). */
function ForwardTo({ to, onChange, paused }: { to: readonly Address[]; onChange: (to: Address[]) => void; paused: boolean }) {
  const accountId = useApp((s) => s.accounts[0]?.id ?? 0);
  const id = useId();
  const [value, setValue] = useState(() => formatAddressList(to));
  const invalid = parseAddressList(value).find((a) => !isValidEmail(a.email));
  return (
    <div className="space-y-1.5" data-testid="filter-forward">
      <div className="flex min-w-0 items-start gap-2 rounded-lg border border-input px-2.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring dark:bg-input/30">
      <label htmlFor={id} className="sr-only">{t("filters.action.forward")}</label>
      <RecipientInput
        id={id}
        testId="filter-forward-to"
        label={t("filters.action.forward")}
        placeholder={t("filters.forward.placeholder")}
        value={value}
        onChange={(v) => {
          setValue(v);
          // every address shown, a wrong one too: the rule's check refuses it, so Save never drops one quietly
          onChange(parseAddressList(v));
        }}
        accountId={accountId}
        others={[]}
        className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      </div>
      {invalid && <p role="alert" className="text-xs text-destructive-ink">{t("category.forward.invalid", { address: invalid.email })}</p>}
      <p className="text-xs text-muted-foreground">{t(paused ? "filters.forward.paused" : "filters.forward.note")}</p>
    </div>
  );
}

/** What the AI's rule does, and a calm word when it plainly isn't what was asked (plan 161). */
/**
 * The rule AI built, in a line. Pass 3: folded, it's the heading that names what was built (focus goes there when it
 * arrives), and the review hint runs on after it rather than taking a line of its own, so the matches fit a small window.
 */
function AiSaid({ said, misses, heading }: { said: string; misses: boolean; heading?: React.Ref<HTMLHeadingElement> }) {
  if (heading)
    return (
      <>
        <div>
          <h3 ref={heading} tabIndex={-1} className="inline font-normal text-foreground outline-none" data-testid="ai-explanation">{said}</h3>
          {!misses && <span className="text-muted-foreground"> {t("filters.ai.review")}</span>}
        </div>
        {misses && <p role="status" className="mt-1 text-destructive-ink" data-testid="ai-unclear">{t("filters.ai.unclear")}</p>}
      </>
    );
  return (
    <>
      <p className="text-foreground" data-testid="ai-explanation">{said}</p>
      {misses ? (
        <p role="status" className="mt-1 text-destructive-ink" data-testid="ai-unclear">{t("filters.ai.unclear")}</p>
      ) : (
        <p className="mt-1 text-muted-foreground">{t("filters.ai.review")}</p>
      )}
    </>
  );
}

/**
 * `note`: plan 161, what a sentence's preview found and where, beside a count that looks everywhere. `onCount`: pass 2,
 * the count as it stands (null while it isn't known), for Save and apply to repeat.
 */
function Preview({ rule, note, onCount }: { rule: FilterRule; note?: string | null; onCount?: (count: number | null) => void }) {
  const parsed = useMemo(() => filterRuleSchema.safeParse(rule), [rule]);
  const [state, setState] = useState<{ count: number; sample: ThreadSummary[] } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!parsed.success) {
      setState(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const r = await client.call("filters.preview", { rule: parsed.data, limit: 6 });
        setState(r);
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [parsed.success ? JSON.stringify(parsed.data) : null]);
  const ready = !loading && state !== null && parsed.success;
  useEffect(() => onCount?.(ready ? state.count : null), [ready, state, onCount]);

  return (
    // pass 2: no timing on show (the capture's "counted" is data-ready, set exactly when "2 ms" used to be)
    <div className="rounded-lg border border-border bg-muted/30" data-testid="filter-preview" data-ready={ready || undefined}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">
          {!parsed.success
            ? t("filters.preview.incomplete")
            : state
              ? richT("filters.preview.matches", { count: state.count, n: (n) => <span data-testid="preview-count">{n}</span> })
              : t("filters.preview.calculating")}
          {/* plan 162: the sample says it's a sample */}
          {state && state.count > state.sample.length && <span className="font-normal text-muted-foreground" data-testid="preview-shown"> · {t("filters.preview.newestShown", { count: state.sample.length })}</span>}
        </span>
        {loading && <Spinner className="size-3.5 text-muted-foreground" aria-hidden />}
      </div>
      {note && <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground" data-testid="filter-preview-note">{note}</p>}
      <ul className="divide-y divide-border/60">
        {state?.sample.map((th) => (
          <li key={th.id} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
            <span className="w-32 shrink-0 truncate font-medium">{th.fromName}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{th.subject}</span>
            <span className="shrink-0 text-muted-foreground tabular">{listDate(th.lastDate)}</span>
          </li>
        ))}
        {state && state.count === 0 && <li className="px-3 py-3 text-center text-xs text-muted-foreground">{t("filters.preview.none")}</li>}
      </ul>
    </div>
  );
}

/**
 * Plan 161: an unsaved rule AI built isn't lost to Esc, the × or a click outside: closing keeps it, and Rules opens on it
 * again, request and all, until it's saved or New starts another. In memory only: a model's rule, never a setting.
 */
type Unsaved = { key: number; draft: Draft; prompt: string; built: string };
/** Pass 2 (Codex review): every unsaved AI rule, each its own row, and the one the builder showed when Rules closed. */
const kept: { current: { list: Unsaved[]; open: number | null } | null } = { current: null };
let unsavedKeys = 0;

const keptOpen = (): Unsaved | null => kept.current?.list.find((u) => u.key === kept.current?.open) ?? null;

export function FiltersDialog() {
  const open = useApp((s) => s.dialog === "filters");
  const categories = useApp((s) => s.categories);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [proposals, setProposals] = useState<LearnedProposal[]>([]);
  // "Crear filtro desde este remitente…" opens the builder with its rule
  const [draft, setDraft] = useState<Draft>(() => {
    const prefill = getApp().filterPrefill;
    // a rule prefilled from elsewhere opens; the unsaved ones stay as their rows
    if (prefill && kept.current) kept.current = { ...kept.current, open: null };
    return prefill ? draftOf({ ...prefill, enabled: prefill.enabled ?? true, source: prefill.source ?? "manual" }) : (keptOpen()?.draft ?? emptyDraft());
  });
  // a filter (or a new one) loaded into the builder: fields that keep text of their own (Forward to) start again from it
  const [loads, setLoads] = useState(0);
  const loadsRef = useRef(0);
  loadsRef.current = loads;
  const load = (d: Draft) => {
    setDraft(d);
    setLoads((n) => n + 1);
    setAttempted(false);
  };
  // opened from Ajustes → Filtros: closing goes back there
  const [returnTo] = useState(() => getApp().filterPrefill?.returnTo ?? null);
  const [note] = useState(() => getApp().filterPrefill?.note ?? null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (getApp().filterPrefill) setApp({ filterPrefill: null });
  }, []);
  const [prompt, setPrompt] = useState(() => keptOpen()?.prompt ?? "");
  // pass 2: unsaved AI rules not in the builder, each a row at the list's top until it's saved or discarded; and which one
  // the builder holds now
  const [parked, setParked] = useState<Unsaved[]>(() => (kept.current?.list ?? []).filter((u) => u.key !== kept.current?.open));
  const [aiKey, setAiKey] = useState<number | null>(() => keptOpen()?.key ?? null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [focusPrompt, setFocusPrompt] = useState(false);
  // pass 3: where focus goes when a rule arrives (its line, a heading), and back to when Esc folds the request again
  const builtRef = useRef<HTMLHeadingElement>(null);
  const editRequestRef = useRef<HTMLButtonElement>(null);
  const [focusBuilt, setFocusBuilt] = useState<"rule" | "edit" | null>(null);
  const form = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [matches, setMatches] = useState<number | null>(null);
  // the request the rule on screen was built from: its words are checked against the rule (plan 161), and (plan 162)
  // quoted over it
  const [built, setBuilt] = useState<string | null>(() => keptOpen()?.built ?? null);
  // once a rule is built, the box is one line, so the rule and its matches fit a small window; Edit request opens it
  const [folded, setFolded] = useState(() => keptOpen() !== null);
  const [generating, setGenerating] = useState(false);
  const setExplanation = (none: null) => {
    setBuilt(none);
    setFolded(false);
  };
  const ai = useApp((s) => s.settings?.ai);
  // pass 2: Edit request puts the caret at the end of the request, once the box is open
  useEffect(() => {
    if (!focusPrompt || folded) return;
    setFocusPrompt(false);
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusPrompt, folded]);
  useEffect(() => {
    if (!focusBuilt || !folded) return;
    setFocusBuilt(null);
    (focusBuilt === "rule" ? builtRef.current : editRequestRef.current)?.focus({ preventScroll: focusBuilt === "edit" });
  }, [focusBuilt, folded]);
  const [saving, setSaving] = useState(false);
  // what's wrong with a rule waits until the user tries to save it: a new one is simply not written yet
  const [attempted, setAttempted] = useState(false);

  const refresh = async () => {
    setFilters(await client.call("filters.list", {}));
    setProposals(await client.call("learning.proposals", {}));
  };
  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const valid = filterRuleSchema.safeParse(draft.rule);
  const rule = draft.rule;
  const accounts = useApp((s) => s.accounts);
  const folders = useApp((s) => s.folders);
  // plan 161: the AI's rule said from its fields as they stand (an edit changes the line), and checked against the request
  const said = built !== null && draft.source === "ai" && valid.success ? describeRule(valid.data, {
    accountEmail: (id) => accounts.find((a) => a.id === id)?.email ?? t("filters.cond.unknownAccount", { id }),
    category: (id) => categories.find((c) => c.id === id)?.name ?? "?",
    folder: (accountId, folder) => folders.find((f) => f.accountId === accountId && f.key === folder)?.path.join(" / ") ?? folder,
  }) : null;
  const misses = said !== null && built !== null && valid.success && ruleMisses(built, valid.data);
  // the rule AI built, not saved yet, in the builder now
  const aiDraft: Unsaved | null = draft.source === "ai" && draft.id === undefined && built !== null && aiKey !== null ? { key: aiKey, draft, prompt, built } : null;
  /** what's in the builder makes way for another rule: an unsaved AI rule is kept, as a draft row (pass 2) */
  const leaving = () => {
    if (aiDraft) setParked((held) => [...held.filter((u) => u.key !== aiDraft.key), aiDraft]);
    setAiKey(null);
  };
  const openUnsaved = (u: Unsaved) => {
    leaving();
    setParked((held) => held.filter((x) => x.key !== u.key));
    load(u.draft);
    setPrompt(u.prompt);
    setBuilt(u.built);
    setFolded(true);
    setAiKey(u.key);
  };
  const discardUnsaved = (u: Unsaved) => {
    setParked((held) => held.filter((x) => x.key !== u.key));
    if (aiDraft?.key === u.key) {
      setAiKey(null);
      load(emptyDraft());
      setExplanation(null);
      setPrompt("");
    }
  };
  /**
   * Pass 3: Esc steps back a level before it closes, as in Ask and the actions: the request opened again over a built rule
   * folds back to the rule; the caret in one of the rule's text fields goes to the rule's row in the list (New, for one
   * not in it yet). Anywhere else Esc closes, keeping an unsaved AI rule (the capture's one Esc after a11 is that).
   */
  const escapeStep = (target: Element | null): (() => void) | null => {
    if (!folded && said !== null)
      return () => {
        setFolded(true);
        setFocusBuilt("edit");
      };
    if (target && form.current?.contains(target) && target.matches("input, textarea, [contenteditable=true]"))
      return () => (list.current?.querySelector<HTMLElement>(":scope [data-current] > button") ?? list.current?.querySelector<HTMLElement>("[data-testid=new-filter]"))?.focus();
    return null;
  };
  // in the order they were made
  const unsavedRows = [...parked, ...(aiDraft ? [aiDraft] : [])].sort((a, b) => a.key - b.key);
  const setRule = (r: FilterRule) => setDraft((d) => ({ ...d, rule: r }));
  const hasAction = (type: string) => rule.actions.some((a) => a.type === type);
  const toggleAction = (type: Exclude<FilterAction["type"], "addCategory" | "forward" | "moveToFolder">) => {
    if (hasAction(type)) setRule({ ...rule, actions: rule.actions.filter((a) => a.type !== type) });
    else setRule({ ...rule, actions: [...rule.actions.filter((a) => !(EXCLUSIVE.has(type) && EXCLUSIVE.has(a.type))), { type }] });
  };
  const categoryAction = rule.actions.find((a) => a.type === "addCategory") as { type: "addCategory"; categoryId: number } | undefined;
  const forwardAction = rule.actions.find((a) => a.type === "forward") as { type: "forward"; to: Address[] } | undefined;
  const folderAction = rule.actions.find((a) => a.type === "moveToFolder") as { type: "moveToFolder"; accountId: number; folder: string } | undefined;
  const setFolder = (to: { accountId: number; folder: string } | null) => setRule({ ...rule, actions: [...rule.actions.filter((a) => !EXCLUSIVE.has(a.type)), ...(to ? [{ type: "moveToFolder" as const, ...to }] : [])] });
  const setForward = (to: Address[] | null) => setRule({ ...rule, actions: [...rule.actions.filter((a) => a.type !== "forward"), ...(to ? [{ type: "forward" as const, to }] : [])] });

  const generate = async () => {
    if (prompt.trim().length < 3) return;
    setGenerating(true);
    // asked again (Edit request), the rule on screen stays until the new one is in: a failure, or Rules closing meanwhile,
    // doesn't lose it (Codex review)
    if (!aiDraft) setExplanation(null);
    try {
      const out = await client.call("filters.generate", { prompt });
      setDraft({ id: undefined, name: out.name, enabled: true, source: "ai", rule: out.rule });
      setBuilt(prompt);
      setFolded(true);
      // pass 3: focus on what was built, not left on the dialog (a program's focus: no ring)
      setFocusBuilt("rule");
      // asked again from the same request, it's the same unsaved rule; otherwise a new one beside the others (Codex review)
      setAiKey((held) => (aiDraft && held === aiDraft.key ? held : ++unsavedKeys));
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
    if (!valid.success) return setAttempted(true);
    setSaving(true);
    // what's saved is this rule: another opened while Save is out keeps the builder, and its unsaved row (Codex review)
    const savingKey = aiDraft?.key ?? null;
    const loadedAt = loadsRef.current;
    try {
      const name = draft.name.trim() || describeCondition(rule.conditions[0]!);
      // plan 90: an automatic filter the user changed is theirs now (turning it on or off isn't a change)
      // compared as rules (key order, padding and case don't make an edit)
      const adopted = draft.auto && (draft.auto.name !== name || !sameRule(draft.auto.rule, valid.data));
      const f = await client.call("filters.save", { id: draft.id, name, enabled: draft.enabled, source: draft.source, rule: valid.data, ...(adopted ? { auto: false } : {}) });
      // plan 89: applying runs in the background (its own progress snack); the dialog is free at once
      // saved, it's an ordinary rule: its unsaved row goes, the others stay
      if (savingKey !== null) setParked((held) => held.filter((u) => u.key !== savingKey));
      if (applyExisting) void applyFilter(f.id, f.name);
      else snack.success(t("filters.saved"));
      if (loadsRef.current === loadedAt) {
        setAiKey(null);
        load(draftOf(f));
      }
      await refresh();
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return;
        const list = [...parked, ...(aiDraft ? [aiDraft] : [])];
        kept.current = list.length ? { list, open: aiDraft?.key ?? null } : null;
        setApp(returnTo === "settings" ? { dialog: "settings", settingsTab: "filters" } : { dialog: null });
      }}
    >
      <DialogContent
        movable="filters"
        onKeyDown={(e) => {
          // a field's own Esc (a suggestion list) and an input method's go first; a portal's (a select, a confirm) bubbles
          // here through React and is its own
          if (e.key !== "Escape" || e.defaultPrevented || imeKey(e.nativeEvent) || !e.currentTarget.contains(e.target as Node)) return;
          const step = escapeStep(e.target as Element);
          if (!step) return;
          // the popup's own Esc (merged after this one) and the document's both stand down
          (e as unknown as { preventBaseUIHandler(): void }).preventBaseUIHandler();
          e.preventDefault();
          e.stopPropagation();
          step();
        }}
        className="flex h-[min(760px,92vh)] max-w-[min(1040px,94vw)] gap-0 overflow-hidden p-0 sm:max-w-[min(1040px,94vw)]" data-testid="filters-dialog" closeClassName="top-4 end-4">
        <DialogTitle className="sr-only">{t("settings.tab.filters")}</DialogTitle>
        <aside ref={list} className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
          <div data-dialog-handle className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="text-sm font-semibold">{t("settings.tab.filters")}</h2>
            <Button
              size="xs"
              variant="outline"
              data-testid="new-filter"
              onClick={() => {
                leaving();
                load(emptyDraft());
                setExplanation(null);
                setPrompt("");
              }}
            >
              <Plus /> {t("filters.new")}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {/* pass 2: an AI rule not saved yet is a row of its own, so Esc, New or another rule never loses it */}
            {unsavedRows.map((u) => (
              <div key={u.key} data-testid="filter-unsaved" data-open={u.key === aiDraft?.key ? true : undefined} data-current={u.key === aiDraft?.key || undefined} className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted", u.key === aiDraft?.key && "bg-muted")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => u.key !== aiDraft?.key && openUnsaved(u)}>
                  <span className="block truncate">{u.draft.name.trim() || describeCondition(u.draft.rule.conditions[0]!)}</span>
                  <span className="text-2xs text-muted-foreground">{t("filters.unsaved")}</span>
                </button>
                <CloseButton label={t("filters.unsavedDiscard")} data-testid="filter-unsaved-discard" onClick={() => discardUnsaved(u)} />
              </div>
            ))}
            {/* plan 90: the user's, then Terno's under a heading of their own */}
            {[...filters.filter((f) => !f.auto), ...filters.filter((f) => f.auto)].map((f, i, all) => (
              <Fragment key={f.id}>
              {f.auto && !all[i - 1]?.auto && <p data-testid="filters-auto-heading" className="mt-4 mb-1 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{t("filters.group.auto")}</p>}
              <div data-testid="filter-item" data-auto={f.auto || undefined} data-current={draft.id === f.id || undefined} className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted", draft.id === f.id && "bg-muted")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (leaving(), load(draftOf(f)), setExplanation(null))}>
                  <span className="block truncate">{f.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {f.auto ? t("filters.source.auto") : f.source === "ai" ? t("filters.source.aiShort") : f.source === "learned" ? t("filters.source.learned") : t("filters.source.manual")} · {t("filters.hits", { count: f.hits })}
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
              </Fragment>
            ))}
            {filters.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{t("filters.empty")}</p>}
            {proposals.length > 0 && (
              <>
                <p className="mt-4 mb-1 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">{t("filters.suggested")}</p>
                {proposals.map((p) => (
                  <div key={p.key} className="rounded-md px-2 py-1.5 text-xs" data-testid="proposal-item">
                    {/* plan 159: the rule whole, in the words the list's offer uses: never cut */}
                    <p className="wrap-anywhere" data-testid="proposal-rule">{learnedRule(p)}</p>
                    <div className="mt-1 flex gap-1">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={async () => {
                          await client.call("learning.accept", { key: p.key, name: capFilterName(t(LEARNED_FILTER_NAME[p.action], { value: p.value })) });
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
          {/* the form starts below the close, on the sidebar list's first line (the close sits on its header's); the 4 px left over keeps a first control's focus ring from clipping */}
          <div data-dialog-handle className="h-11 shrink-0" />
          {/* pass 3: 16 px between sections, not 20, so at 1100x700 the matches show under a built rule */}
          <div ref={form} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6 pt-1">
            {/* only offered once an AI can really run (a model, and its key when it needs one); otherwise it could only fail */}
            {aiReady(ai) && (
              // pass 2: the shared AI card (ai-card.ts), its one attribution in the header, not a look of its own
              <div className={cn(AI_CARD, "px-4 pb-3.5")} data-testid="ai-box" data-folded={folded && said !== null ? true : undefined}>
                {folded && said !== null ? (
                  // plan 161: built, the box is the rule in a line: what it does, said from its fields
                  <>
                    {/* plan 162: what was asked, quoted, so the rule under it can be checked against it (it was hidden) */}
                    <div className={AI_HEADER}>
                      <Sparkles aria-hidden className={AI_GLYPH} />
                      <span className="flex min-w-0 items-baseline gap-1" data-testid="ai-request">
                        <span className={cn(AI_TITLE, "shrink-0")}>{t("filters.ai.fromRequest")}</span>
                        {/* the request this rule was built from, not the field's words since (Edit request, then Esc, keeps an unsent edit) */}
                        <span className="min-w-0 truncate text-foreground" title={built ?? ""}>“{(built ?? "").trim()}”</span>
                      </span>
                      <Button ref={editRequestRef} variant="ghost" size="xs" className="-me-1.5 ml-auto shrink-0 font-normal text-muted-foreground hover:text-foreground" data-testid="ai-edit-request" onClick={() => (setFolded(false), setFocusPrompt(true))}>{t("filters.ai.editRequest")}</Button>
                    </div>
                    {/* the rule in words, and who wrote it at the line's end: the one control every AI surface has */}
                    <div className="flex items-start gap-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <AiSaid said={said} misses={misses} heading={builtRef} />
                      </div>
                      <AiProvenance model="" at={0} lines={[t("filters.ai.provenance")]} testId="ai-provenance" labelTestId="ai-provenance-label" className="-me-1.5 -mt-1 shrink-0" />
                    </div>
                  </>
                ) : (
                  <>
                    <label className={AI_HEADER} htmlFor="ai-prompt">
                      <Sparkles aria-hidden className={AI_GLYPH} />
                      <span className={AI_TITLE}>{t("filters.ai.label")}</span>
                    </label>
                    <div className="flex gap-2">
                      <Textarea
                        ref={promptRef}
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
                      <Button data-testid="ai-generate" onClick={generate} loading={generating} disabled={prompt.trim().length < 3} className="self-end">
                        <Wand2 /> {t("filters.ai.create")}
                      </Button>
                    </div>
                    <p className="mt-2 text-2xs text-muted-foreground" data-testid="ai-privacy-notice">
                      {privacyLine(ai)}
                    </p>
                    {said !== null && (
                      <div className="mt-2 text-xs">
                        <AiSaid said={said} misses={misses} />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* pass 3: the name's label beside its field, a line less above the matches */}
            <div className="flex items-center gap-3">
              <label className="shrink-0 text-xs font-medium text-muted-foreground" htmlFor="filter-name">
                {t("filters.name")}
              </label>
              <Input id="filter-name" data-testid="filter-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("filters.name.placeholder")} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span>{t("filters.match.before")}</span>
                <Select value={rule.match} onValueChange={(m) => setRule({ ...rule, match: m as "all" | "any" })} items={[{ value: "all", label: t("filters.match.all") }, { value: "any", label: t("filters.match.any") }]}>
                  <SelectTrigger size="sm" className="w-24" aria-label={t("filters.match.label")}>
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
                    {/* plan 161: chosen says so with a check, not only a fill (Graphite's sat at 1.2:1) */}
                    {hasAction(type) ? <Check className="size-3.5" data-testid="action-chosen" /> : <Icon className="size-3.5" />} {t(label)}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="action-toggle-forward"
                  aria-pressed={Boolean(forwardAction)}
                  onClick={() => setForward(forwardAction ? null : [])}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                    forwardAction ? "border-primary/40 bg-primary/10 text-accent-foreground" : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {forwardAction ? <Check className="size-3.5" data-testid="action-chosen" /> : <Forward className="size-3.5" />} {t("filters.action.forward")}
                </button>
                <Select
                  value={categoryAction ? String(categoryAction.categoryId) : "none"}
                  onValueChange={(v) =>
                    setRule({ ...rule, actions: [...rule.actions.filter((a) => a.type !== "addCategory"), ...(v === "none" ? [] : [{ type: "addCategory" as const, categoryId: Number(v) }])] })
                  }
                  items={[{ value: "none", label: t("filters.noCategory") }, ...categories.map((c) => ({ value: String(c.id), label: c.name }))]}
                >
                  <SelectTrigger size="sm" className={cn("h-7 text-xs", categoryAction && "border-primary/40 bg-primary/10")} data-testid="action-category-select" aria-label={t("filters.category.label")}>
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
              <FolderAction action={folderAction} rule={rule} onChange={setFolder} />
              {forwardAction && <ForwardTo key={loads} to={forwardAction.to} onChange={(to) => setForward(to)} paused={Boolean(filters.find((f) => f.id === draft.id)?.forwardPaused)} />}
              {attempted && !valid.success && <p role="alert" className="text-xs text-destructive-ink" data-testid="filter-invalid">{t(filterIssueKey(valid.error.issues))}</p>}
            </div>

            <Preview rule={rule} note={note} onCount={setMatches} />
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-3">
            {/* the AI card says who wrote it while it shows the rule; a saved AI rule says it here */}
            {draft.source !== "manual" && !(draft.source === "ai" && said !== null) && <Badge variant="secondary">{draft.source === "ai" ? t("filters.source.ai") : t("filters.source.learned")}</Badge>}
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
                    load(emptyDraft());
                    void refresh();
                  }}
                />
              </>
            )}
            {/* the owner's call (2026-11-08): Save is the main button, for every rule, by hand or by AI; applying it to mail
                already here is the second choice, its consequence in its words */}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" className="text-foreground" data-testid="filter-save-apply" disabled={saving} onClick={() => save(true)}>
                {/* pass 2: the consequence in its words: how many it will touch, once counted */}
                {matches ? t("filters.saveApplyCount", { count: matches }) : t("filters.saveApply")}
              </Button>
              <Button data-testid="filter-save" disabled={saving} onClick={() => save(false)}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
