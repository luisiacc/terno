import { type Category, type CategoryColor, type CategoryModelStats } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button, GHOST_DANGER_PRESS } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@terno/ui/components/collapsible";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useEffect, useId, useState } from "react";
import { providerLabel, routeOf } from "~/lib/ai";
import { snack } from "~/lib/snack";
import { deleteCategory, setShowInInbox } from "~/lib/categorize";
import { offerTip } from "~/lib/tips";
import { reorderCategories } from "~/lib/reorder";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { reopenedRows } from "~/lib/settings-place";
import { ColorPicker, CommitInput, ConfirmDialog, findAttrs, SettingsGroup, SettingsNote, SettingsRow, type SettingsUpdate } from "./parts";

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

/** Moves a category one place, as the sidebar's ⌥↑ ⌥↓ do (plan 169: at once, the backend's order wins, back on failure). */
async function move(id: number, by: -1 | 1) {
  const ids = getApp().categories.map((c) => c.id);
  const i = ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  await reorderCategories(ids);
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

function CategoryItem({ category, stats, index, count, autoMode, defaultOpen }: { category: Category; stats: CategoryModelStats | undefined; index: number; count: number; autoMode: boolean; /** plan 246: open when Settings was left */ defaultOpen: boolean }) {
  const [deleting, setDeleting] = useState(false);
  const name = category.name;
  return (
    <Collapsible defaultOpen={defaultOpen} data-testid={`category-stats-${category.id}`} data-category-id={category.id} data-setting-scope={`category:${category.id}`}>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger data-testid="category-toggle" data-setting-open className="-ml-2 min-w-0 flex-1 rounded-md py-2.5 pl-2">
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
          {...findAttrs("category.autoAdd")}
          aria-label={t("settings.categories.autoAddTo", { name })}
          title={autoMode ? t("settings.categories.autoAdd") : t("settings.categories.autoAdd.off")}
          checked={category.autoApply}
          disabled={!autoMode}
          onCheckedChange={(on) => void updateCategory(category.id, { autoApply: on }).catch((e) => snack.error(errorText(e)))}
        />
      </div>
      <CollapsiblePanel>
        <div className="hairline-divide pb-1 pl-5" data-testid="category-editor">
          <SettingsRow find="category.name" labelFor label={t("account.name")}>
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
          <SettingsRow find="category.showInInbox" label={t("settings.categories.showInInbox")} hint={t("settings.categories.showInInbox.hint")}>
            {(a) => <Switch {...a} data-testid="category-show-in-inbox" checked={category.showInInbox} onCheckedChange={(on) => void setShowInInbox(category.id, on)} />}
          </SettingsRow>
          <SettingsRow find="category.order" label={t("settings.categories.order")} hint={t("settings.categories.order.hint", { position: index + 1, total: count })}>
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
          <SettingsRow find="category.color" label={t("settings.color")}>
            {(a) => <ColorPicker a11y={a} name={`category-color-${category.id}`} testId="category-color" value={category.color} onChange={(color) => updateCategory(category.id, { color }).catch((e: unknown) => { snack.error(errorText(e)); throw e; })} />}
          </SettingsRow>
          <SettingsRow find="category.delete" label={t("settings.categories.delete")} hint={t("settings.categories.delete.hint")}>
            {({ id: _id, "aria-labelledby": _l, ...a }) => (
              <>
                <Button {...a} variant="ghost" size="sm" className={cn("text-destructive-ink", GHOST_DANGER_PRESS)} data-testid="category-delete" onClick={() => setDeleting(true)}>
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
  const create = async () => {
    const value = name.trim();
    if (!value) return;
    try {
      const c = await client.call("categories.create", { name: value });
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
      {...findAttrs("categories.new")}
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

/** Ajustes → Categorías: what the engine may do, and each category: name, color, order, auto-filing, removal. */
export function CategoriesTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const categories = useApp((s) => s.categories);
  const [stats, setStats] = useState<CategoryModelStats[]>([]);
  useEffect(() => {
    void client.call("categorize.stats", {}).then(setStats).catch(() => {});
  }, [categories]);
  // plan 168: where categorizing really goes (JEV with a usable key, else the provider routing picks), as the backend sends it
  const categorizer = routeOf("categorize", settings.ai).provider;
  const noAi = categorizer === "none";
  // plan 134: said once, on the first look after it happened; it stays for that visit
  const [widened] = useState(settings.aiCategorizeWidened);
  // plan 246: come back to, the categories open when Settings was left
  const [reopen] = useState(reopenedRows);
  useEffect(() => {
    if (settings.aiCategorizeWidened) void update({ aiCategorizeWidened: false });
  }, [settings.aiCategorizeWidened, update]);

  return (
    <div data-testid="categories-tab">
      <SettingsGroup>
        <SettingsRow find="categories.smart" label={t("settings.categories.smart")} hint={t("settings.categories.smart.hint")}>
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
        <SettingsRow find="categories.askAi"
          label={t("settings.categories.askAi")}
          hint={noAi ? t("settings.categories.askAi.noAi") : t("settings.categories.askAi.hint", { provider: providerLabel(categorizer, settings.ai) })}
        >
          {(a) => <Switch {...a} data-testid="ai-categorize-switch" checked={settings.aiCategorize} disabled={noAi && !settings.aiCategorize} onCheckedChange={(on) => void update({ aiCategorize: on })} />}
        </SettingsRow>
        {widened && !settings.aiCategorize && <SettingsNote testId="ai-categorize-widened">{t("settings.categories.askAi.widened")}</SettingsNote>}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.tab.categories")}
        testId="categories-list"
        footer={settings.autoCategorize === "auto" ? t("settings.categories.footer.auto") : t("settings.categories.footer")}
      >
        {categories.map((c, i) => (
          <CategoryItem key={c.id} category={c} stats={stats.find((s) => s.categoryId === c.id)} index={i} count={categories.length} autoMode={settings.autoCategorize === "auto"} defaultOpen={reopen.has(`category:${c.id}`)} />
        ))}
        <NewCategory />
      </SettingsGroup>
      <KeptSenders categories={categories} />
    </div>
  );
}

/**
 * Plan 282: the senders Terno asks about rather than files ("Don't file … automatically", from Put away's box), each
 * with the way back. Shown only when there's one.
 */
function KeptSenders({ categories }: { categories: Category[] }) {
  const [kept, setKept] = useState<{ categoryId: number; sender: string; at: number }[]>([]);
  useEffect(() => {
    void client.call("putAway.kept", {}).then((r) => setKept(r?.senders ?? [])).catch(() => {});
  }, [categories]);
  if (kept.length === 0) return null;
  return (
    <SettingsGroup title={t("putAway.kept.title")} testId="kept-senders" footer={t("putAway.kept.hint")}>
      {kept.map((k) => {
        const category = categories.find((c) => c.id === k.categoryId);
        return (
          <SettingsRow key={`${k.categoryId}:${k.sender}`} find={false} testId="kept-sender" label={<span className="inline-flex min-w-0 items-center gap-2">{category && <CategoryDot color={category.color as CategoryColor} />}<span className="truncate">{k.sender}</span><span className="text-muted-foreground">· {category?.name ?? ""}</span></span>}>
            {() => (
              <Button
                variant="ghost"
                size="sm"
                data-testid="kept-sender-remove"
                aria-label={t("putAway.kept.remove", { sender: k.sender })}
                onClick={async () => {
                  try {
                    await client.call("putAway.removeKept", { categoryId: k.categoryId, sender: k.sender });
                    setKept((list) => list.filter((x) => x !== k));
                  } catch (error) {
                    snack.error(t("putAway.kept.removeFailed", { sender: k.sender, error: errorText(error) }));
                  }
                }}
              >
                {t("putAway.kept.removeShort")}
              </Button>
            )}
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}
