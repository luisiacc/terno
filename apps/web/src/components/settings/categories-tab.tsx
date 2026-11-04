import { CATEGORY_COLORS, JEV_DEFAULT_MODEL, type Category, type CategoryColor, type CategoryModelStats } from "@terno/core";
import type { AiTestResult, AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { ChevronDown, ChevronUp, CircleCheck, Plus, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useId, useState } from "react";
import { providerLabel } from "~/lib/ai";
import { reconcileSettings } from "~/lib/appearance";
import { localized } from "~/lib/i18n";
import { snack } from "~/lib/snack";
import { deleteCategory, setShowInInbox } from "~/lib/categorize";
import { offerTip } from "~/lib/tips";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { ColorPicker, CommitInput, ConfirmDialog, SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

const modes = () =>
  [
    { value: "off", label: t("settings.categories.mode.off") },
    { value: "suggest", label: t("settings.categories.mode.suggest") },
    { value: "auto", label: t("settings.categories.mode.auto") },
  ] as const;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function replace(next: Category) {
  setApp((s) => ({ categories: s.categories.map((c) => (c.id === next.id ? next : c)) }));
}

async function updateCategory(id: number, patch: { name?: string; color?: CategoryColor; autoApply?: boolean }) {
  replace(await client.call("categories.update", { id, ...patch }));
}

/** Moves a category one place; the list changes at once and the backend's order follows (and wins). */
async function move(id: number, by: -1 | 1) {
  const list = getApp().categories;
  const i = list.findIndex((c) => c.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  setApp({ categories: next });
  try {
    setApp({ categories: await client.call("categories.reorder", { ids: next.map((c) => c.id) }) });
  } catch (e) {
    setApp({ categories: list });
    snack.error(errorText(e));
  }
}

function statsLine(s: CategoryModelStats | undefined): React.ReactNode {
  if (!s) return "…";
  return (
    <>
      {t("settings.categories.examples", { count: s.examples })}
      {s.autoPrecision !== null && ` · ${t("settings.categories.precision", { percent: Math.round(s.autoPrecision * 100), total: s.kept + s.reverted })}`}
      {s.pendingSuggestions ? ` · ${t("settings.categories.toReview", { n: s.pendingSuggestions })}` : ""}
      {s.paused && <span className="font-medium text-destructive-ink"> · {t("settings.categories.paused")}</span>}
    </>
  );
}

function CategoryItem({ category, stats, index, count, autoMode }: { category: Category; stats: CategoryModelStats | undefined; index: number; count: number; autoMode: boolean }) {
  const [deleting, setDeleting] = useState(false);
  const name = category.name;
  return (
    <Collapsible data-testid={`category-stats-${category.id}`} data-category-id={category.id}>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger data-testid="category-toggle" className="-ml-2 min-w-0 flex-1 rounded-md py-2.5 pl-2">
          <CategoryDot color={category.color as CategoryColor} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium" data-testid="category-name">
              {category.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {statsLine(stats)}
              {!category.showInInbox && ` · ${t("category.hiddenFromInboxBadge")}`}
            </span>
          </span>
        </CollapsibleTrigger>
        <span className="text-xs text-muted-foreground" aria-hidden>
          {t("settings.categories.autoAdd")}
        </span>
        <Switch
          data-testid={`category-auto-${category.id}`}
          aria-label={t("settings.categories.autoAddTo", { name })}
          title={autoMode ? t("settings.categories.autoAdd") : t("settings.categories.autoAdd.off")}
          checked={category.autoApply}
          disabled={!autoMode}
          onCheckedChange={(on) => void updateCategory(category.id, { autoApply: on }).catch((e) => snack.error(errorText(e)))}
        />
      </div>
      <CollapsiblePanel>
        <div className="hairline-divide pb-1 pl-5" data-testid="category-editor">
          <SettingsRow labelFor label={t("account.name")}>
            {(a) => (
              <CommitInput
                a11y={a}
                className="w-56"
                maxLength={60}
                data-testid="category-rename"
                value={category.name}
                validate={(v) => (v.trim() ? null : t("settings.nameEmpty"))}
                onCommit={(v) => updateCategory(category.id, { name: v.trim() })}
              />
            )}
          </SettingsRow>
          <SettingsRow label={t("settings.categories.showInInbox")} hint={t("settings.categories.showInInbox.hint")}>
            {(a) => <Switch {...a} data-testid="category-show-in-inbox" checked={category.showInInbox} onCheckedChange={(on) => void setShowInInbox(category.id, on)} />}
          </SettingsRow>
          <SettingsRow label={t("settings.categories.order")} hint={t("settings.categories.order.hint", { position: index + 1, total: count })}>
            {() => (
              <span className="flex gap-1">
                <Button variant="outline" size="sm" className="aria-disabled:opacity-50" aria-label={t("settings.categories.moveUpNamed", { name })} aria-disabled={index === 0 || undefined} data-testid="category-up" onClick={() => index > 0 && void move(category.id, -1)}>
                  <ChevronUp /> {t("settings.categories.moveUp")}
                </Button>
                <Button variant="outline" size="sm" className="aria-disabled:opacity-50" aria-label={t("settings.categories.moveDownNamed", { name })} aria-disabled={index === count - 1 || undefined} data-testid="category-down" onClick={() => index < count - 1 && void move(category.id, 1)}>
                  <ChevronDown /> {t("settings.categories.moveDown")}
                </Button>
              </span>
            )}
          </SettingsRow>
          <SettingsRow label={t("settings.color")}>
            {(a) => <ColorPicker a11y={a} name={`category-color-${category.id}`} testId="category-color" value={category.color} onChange={(color) => updateCategory(category.id, { color }).catch((e: unknown) => { snack.error(errorText(e)); throw e; })} />}
          </SettingsRow>
          <SettingsRow label={t("settings.categories.delete")} hint={t("settings.categories.delete.hint")}>
            {({ id: _id, "aria-labelledby": _l, ...a }) => (
              <>
                <Button {...a} variant="ghost" size="sm" className="text-destructive-ink" data-testid="category-delete" onClick={() => setDeleting(true)}>
                  <Trash2 /> {t("settings.categories.delete.button")}
                </Button>
                <ConfirmDialog
                  open={deleting}
                  onOpenChange={setDeleting}
                  testId="category-delete-dialog"
                  title={t("settings.categories.delete.title", { name })}
                  description={t("settings.categories.delete.description")}
                  confirm={t("settings.categories.delete.confirm")}
                  onConfirm={() => void deleteCategory(category.id, name)}
                />
              </>
            )}
          </SettingsRow>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function NewCategory() {
  const [name, setName] = useState("");
  const inputId = useId();
  const categories = useApp((s) => s.categories);
  const create = async () => {
    const value = name.trim();
    if (!value) return;
    try {
      const c = await client.call("categories.create", { name: value, color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]! });
      setApp((s) => ({ categories: s.categories.some((x) => x.id === c.id) ? s.categories : [...s.categories, c] }));
      setName("");
      snack.success(t("settings.categories.created", { name: c.name }));
      if (!c.showInInbox) offerTip("category-inbox", c.id);
    } catch (e) {
      snack.error(errorText(e));
    }
  };
  return (
    <form
      className="flex items-center gap-2 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {t("settings.categories.new")}
      </label>
      <Input id={inputId} className="h-7 flex-1 bg-background dark:bg-input/30" maxLength={60} placeholder={t("settings.categories.new")} value={name} onChange={(e) => setName(e.target.value)} data-testid="category-new" />
      <Button type="submit" size="sm" variant="outline" disabled={!name.trim()} data-testid="category-create">
        <Plus /> {t("settings.categories.create")}
      </Button>
    </form>
  );
}

/** Plan 134: the key that makes categorization run on JEV. Never prefilled; the backend only says it's saved and its last 4. */
function JevKeyRow({ saved, hint }: { saved: boolean; hint: string | null }) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const save = async (value: string) => {
    try {
      setApp({ settings: reconcileSettings(await client.call("ai.setKey", { provider: "jev", value })) });
      setKey("");
      setTest(null);
      snack.success(value ? t("ai.key.savedSnack") : t("ai.key.removedSnack"));
    } catch (error) {
      snack.error(errorText(error));
    }
  };
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await client.call("ai.test", { provider: "jev", model: JEV_DEFAULT_MODEL }));
    } finally {
      setTesting(false);
    }
  };
  return (
    <SettingsRow stacked labelFor={!saved} label={t("settings.categories.jev")} hint={t("settings.categories.jev.hint")} testId="jev-key-row">
      {(a) =>
        saved ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="jev-key-saved">
              <span className="text-success-ink">{hint ? t("ai.key.savedHint", { hint }) : t("ai.key.saved")}</span>
              <Button variant="outline" size="xs" loading={testing} data-testid="jev-key-test" onClick={() => void runTest()}>
                {t("ai.test")}
              </Button>
              <Button variant="ghost" size="xs" aria-label={t("ai.key.remove", { provider: "JEV" })} data-testid="jev-key-remove" onClick={() => void save("")}>
                {t("common.remove")}
              </Button>
              <span role="status" aria-live="polite" className="text-xs">
                {test?.ok && (
                  <span className="flex items-center gap-1.5 text-success-ink" data-testid="jev-key-test-result">
                    <CircleCheck className="size-3.5" aria-hidden /> {t("ai.test.connected")}
                  </span>
                )}
              </span>
            </div>
            {test && !test.ok && (
              <p role="alert" className="text-xs text-destructive-ink" data-testid="jev-key-test-error">
                {localized(test.error?.message, test.error?.i18n)}
              </p>
            )}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void save(key.trim());
            }}
          >
            <Input {...a} data-testid="jev-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className="h-7 bg-background dark:bg-input/30" />
            <Button type="submit" size="sm" disabled={!key.trim()} data-testid="jev-key-save">
              {t("common.save")}
            </Button>
          </form>
        )
      }
    </SettingsRow>
  );
}

/** Ajustes → Categorías: what the engine may do, and each category: name, color, order, auto-filing, removal. */
export function CategoriesTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const categories = useApp((s) => s.categories);
  const [stats, setStats] = useState<CategoryModelStats[]>([]);
  useEffect(() => {
    void client.call("categorize.stats", {}).then(setStats).catch(() => {});
  }, [categories]);
  const jev = settings.ai.keys.jev;
  const noAi = settings.ai.provider === "none" && !jev?.hasKey;
  // plan 134: said once, on the first look after it happened; it stays for that visit
  const [widened] = useState(settings.aiCategorizeWidened);
  useEffect(() => {
    if (settings.aiCategorizeWidened) void update({ aiCategorizeWidened: false });
  }, [settings.aiCategorizeWidened, update]);

  return (
    <div data-testid="categories-tab">
      <SettingsGroup>
        <SettingsRow label={t("settings.categories.smart")} hint={t("settings.categories.smart.hint")}>
          {({ id: _id, ...a }) => (
            <Select value={settings.autoCategorize} onValueChange={(v) => void update({ autoCategorize: v as AppSettings["autoCategorize"] })} items={modes().map((m) => ({ ...m }))}>
              <SelectTrigger {...a} size="sm" className="w-36" data-testid="auto-categorize-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modes().map((m) => (
                  <SelectItem key={m.value} value={m.value} data-testid={`auto-categorize-${m.value}`}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
        <SettingsRow
          label={t("settings.categories.askAi")}
          hint={noAi ? t("settings.categories.askAi.noAi") : t("settings.categories.askAi.hint", { provider: jev?.hasKey ? "JEV" : providerLabel(settings.ai.provider, settings.ai) })}
        >
          {(a) => <Switch {...a} data-testid="ai-categorize-switch" checked={settings.aiCategorize} disabled={noAi && !settings.aiCategorize} onCheckedChange={(on) => void update({ aiCategorize: on })} />}
        </SettingsRow>
        {widened && !settings.aiCategorize && <SettingsNote testId="ai-categorize-widened">{t("settings.categories.askAi.widened")}</SettingsNote>}
        <JevKeyRow saved={!!jev?.hasKey} hint={jev?.keyHint ?? null} />
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.tab.categories")}
        testId="categories-list"
        footer={settings.autoCategorize === "auto" ? t("settings.categories.footer.auto") : t("settings.categories.footer")}
      >
        {categories.map((c, i) => (
          <CategoryItem key={c.id} category={c} stats={stats.find((s) => s.categoryId === c.id)} index={i} count={categories.length} autoMode={settings.autoCategorize === "auto"} />
        ))}
        <NewCategory />
      </SettingsGroup>
    </div>
  );
}
