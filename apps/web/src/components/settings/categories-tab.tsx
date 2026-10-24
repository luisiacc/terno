import { CATEGORY_COLORS, type Category, type CategoryColor, type CategoryModelStats } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { CategoryDot } from "@terno/ui/components/category-dot";
import { Input } from "@terno/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Switch } from "@terno/ui/components/switch";
import { cn } from "@terno/ui/lib/utils";
import { ChevronDown, ChevronRight, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { getApp, setApp, setCategories, useApp } from "~/state/app";
import { ColorPicker, CommitInput, ConfirmDialog, SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const MODES = [
  { value: "off", label: "Desactivada" },
  { value: "suggest", label: "Solo sugerir" },
  { value: "auto", label: "Automática" },
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
    toast.error(errorText(e));
  }
}

function statsLine(s: CategoryModelStats | undefined): React.ReactNode {
  if (!s) return "…";
  return (
    <>
      {`${s.examples} ${s.examples === 1 ? "ejemplo" : "ejemplos"}`}
      {s.autoPrecision !== null && ` · acierta ${Math.round(s.autoPrecision * 100)}% (${s.kept + s.reverted})`}
      {s.pendingSuggestions ? ` · ${s.pendingSuggestions} por revisar` : ""}
      {s.paused && <span className="font-medium text-destructive-ink"> · En pausa: demasiadas correcciones</span>}
    </>
  );
}

function CategoryItem({ category, stats, index, count, autoMode }: { category: Category; stats: CategoryModelStats | undefined; index: number; count: number; autoMode: boolean }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const panel = useId();
  const name = `«${category.name}»`;
  return (
    <div data-testid={`category-stats-${category.id}`} data-category-id={category.id}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((o) => !o)}
          data-testid="category-toggle"
          className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded-md py-2.5 pl-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <CategoryDot color={category.color as CategoryColor} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium" data-testid="category-name">
              {category.name}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{statsLine(stats)}</span>
          </span>
          <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-fast", open && "rotate-90")} />
        </button>
        <span className="text-xs text-muted-foreground" aria-hidden>
          Añadir sola
        </span>
        <Switch
          data-testid={`category-auto-${category.id}`}
          aria-label={`Añadir sola a ${name}`}
          title={autoMode ? "Añadir sola" : "Activa la categorización automática para que pueda añadir sola"}
          checked={category.autoApply}
          disabled={!autoMode}
          onCheckedChange={(on) => void updateCategory(category.id, { autoApply: on }).catch((e) => toast.error(errorText(e)))}
        />
      </div>
      <div id={panel} hidden={!open}>
        {open && (
          <div className="hairline-divide pb-1 pl-5" data-testid="category-editor">
            <SettingsRow labelFor label="Nombre">
              {(a) => (
                <CommitInput
                  a11y={a}
                  className="w-56"
                  maxLength={60}
                  data-testid="category-rename"
                  value={category.name}
                  validate={(v) => (v.trim() ? null : "Escribe un nombre.")}
                  onCommit={(v) => updateCategory(category.id, { name: v.trim() })}
                />
              )}
            </SettingsRow>
            <SettingsRow label="Orden" hint={`${index + 1} de ${count} en la barra lateral.`}>
              {() => (
                <span className="flex gap-1">
                  <Button variant="outline" size="sm" className="aria-disabled:opacity-50" aria-label={`Subir ${name}`} aria-disabled={index === 0 || undefined} data-testid="category-up" onClick={() => index > 0 && void move(category.id, -1)}>
                    <ChevronUp /> Subir
                  </Button>
                  <Button variant="outline" size="sm" className="aria-disabled:opacity-50" aria-label={`Bajar ${name}`} aria-disabled={index === count - 1 || undefined} data-testid="category-down" onClick={() => index < count - 1 && void move(category.id, 1)}>
                    <ChevronDown /> Bajar
                  </Button>
                </span>
              )}
            </SettingsRow>
            <SettingsRow label="Color">
              {(a) => <ColorPicker a11y={a} name={`category-color-${category.id}`} testId="category-color" value={category.color} onChange={(color) => updateCategory(category.id, { color }).catch((e: unknown) => { toast.error(errorText(e)); throw e; })} />}
            </SettingsRow>
            <SettingsRow label="Borrar la categoría" hint="Sus conversaciones no se borran: solo dejan de estar en ella. Lo aprendido para ella se pierde.">
              {({ id: _id, "aria-labelledby": _l, ...a }) => (
                <>
                  <Button {...a} variant="ghost" size="sm" className="text-destructive-ink" data-testid="category-delete" onClick={() => setDeleting(true)}>
                    <Trash2 /> Borrar…
                  </Button>
                  <ConfirmDialog
                    open={deleting}
                    onOpenChange={setDeleting}
                    testId="category-delete-dialog"
                    title={`¿Borrar ${name}?`}
                    description="Sus conversaciones siguen en tu correo y en sus otras categorías. Lo que Terno aprendió para esta categoría se pierde."
                    confirm="Borrar categoría"
                    onConfirm={async () => {
                      try {
                        await client.call("categories.delete", { id: category.id });
                        // its list or its Revisar view, if open, goes back to the inbox
                        setCategories(getApp().categories.filter((c) => c.id !== category.id));
                        toast.success(`${name} borrada`);
                      } catch (e) {
                        toast.error(errorText(e));
                      }
                    }}
                  />
                </>
              )}
            </SettingsRow>
          </div>
        )}
      </div>
    </div>
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
      toast.success(`«${c.name}» creada`);
    } catch (e) {
      toast.error(errorText(e));
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
        Nueva categoría
      </label>
      <Input id={inputId} className="h-7 flex-1 bg-background dark:bg-input/30" maxLength={60} placeholder="Nueva categoría" value={name} onChange={(e) => setName(e.target.value)} data-testid="category-new" />
      <Button type="submit" size="sm" variant="outline" disabled={!name.trim()} data-testid="category-create">
        <Plus /> Crear
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
  const noAi = settings.ai.provider === "none";

  return (
    <div data-testid="categories-tab">
      <SettingsGroup>
        <SettingsRow label="Categorización inteligente" hint="Aprende de cómo archivas. Sin IA ni red: todo ocurre en este Mac.">
          {({ id: _id, ...a }) => (
            <Select value={settings.autoCategorize} onValueChange={(v) => void update({ autoCategorize: v as AppSettings["autoCategorize"] })} items={MODES.map((m) => ({ ...m }))}>
              <SelectTrigger {...a} size="sm" className="w-36" data-testid="auto-categorize-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value} data-testid={`auto-categorize-${m.value}`}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
        <SettingsRow
          label="Pedir ayuda a la IA"
          hint={noAi ? "Conecta una IA en Ajustes → IA para usarla aquí." : "Para los correos dudosos: solo sugiere, nunca añade sola. Usa la IA de Ajustes → IA (en modo local, solo modelos de este Mac)."}
        >
          {(a) => <Switch {...a} data-testid="ai-categorize-switch" checked={settings.aiCategorize} disabled={noAi && !settings.aiCategorize} onCheckedChange={(on) => void update({ aiCategorize: on })} />}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Categorías"
        testId="categories-list"
        footer={settings.autoCategorize === "auto" ? "El interruptor de cada una deja que Terno la añada por su cuenta cuando está seguro." : "Con la categorización en «Automática», cada categoría puede añadirse sola."}
      >
        {categories.map((c, i) => (
          <CategoryItem key={c.id} category={c} stats={stats.find((s) => s.categoryId === c.id)} index={i} count={categories.length} autoMode={settings.autoCategorize === "auto"} />
        ))}
        <NewCategory />
      </SettingsGroup>
    </div>
  );
}
