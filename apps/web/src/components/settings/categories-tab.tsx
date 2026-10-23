import type { CategoryColor, CategoryModelStats } from "@unica/core";
import type { AppSettings } from "@unica/core/rpc";
import { CategoryDot } from "@unica/ui/components/category-dot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { Switch } from "@unica/ui/components/switch";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { setApp, useApp } from "~/state/app";

const MODES = [
  { value: "off", label: "Desactivada" },
  { value: "suggest", label: "Solo sugerir" },
  { value: "auto", label: "Automática" },
] as const;

/** Settings → Categorías: what the engine may do, per category, and how well it has done. */
export function CategoriesTab({ settings }: { settings: AppSettings }) {
  const categories = useApp((s) => s.categories);
  const [stats, setStats] = useState<CategoryModelStats[]>([]);
  const refresh = () => void client.call("categorize.stats", {}).then(setStats).catch(() => {});
  useEffect(refresh, [categories]);

  const setMode = async (mode: AppSettings["autoCategorize"]) => {
    try {
      setApp({ settings: await client.call("settings.update", { autoCategorize: mode }) });
    } catch (e) {
      toast.error(String(e));
    }
  };
  const setAuto = async (id: number, autoApply: boolean) => {
    const c = await client.call("categories.update", { id, autoApply });
    setApp({ categories: useApp.getState().categories.map((x) => (x.id === c.id ? c : x)) });
    refresh();
  };

  return (
    <div className="py-3" data-testid="categories-tab">
      <div className="flex items-center justify-between gap-6 border-b border-border pb-3">
        <div>
          <p className="text-sm font-medium" id="auto-categorize-label">Categorización inteligente</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Aprende de cómo archivas. Sin IA ni red: todo ocurre en este Mac.</p>
        </div>
        <Select value={settings.autoCategorize} onValueChange={(v) => void setMode(v as AppSettings["autoCategorize"])} items={MODES.map((m) => ({ ...m }))}>
          <SelectTrigger size="sm" className="w-36" data-testid="auto-categorize-select" aria-labelledby="auto-categorize-label">
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
      </div>
      <div className="flex items-center justify-between gap-6 border-b border-border py-3">
        <div>
          <p className="text-sm font-medium" id="ai-categorize-label">Pedir ayuda a la IA</p>
          <p className="mt-0.5 text-xs text-muted-foreground" id="ai-categorize-hint">
            {settings.ai.provider === "none"
              ? "Conecta una IA en Ajustes → IA para usarla aquí."
              : "Para los correos dudosos: solo sugiere, nunca añade sola. Usa la IA de Ajustes → IA (en modo local, solo modelos de este Mac)."}
          </p>
        </div>
        <Switch
          data-testid="ai-categorize-switch"
          aria-labelledby="ai-categorize-label"
          aria-describedby="ai-categorize-hint"
          checked={settings.aiCategorize}
          disabled={settings.ai.provider === "none" && !settings.aiCategorize}
          onCheckedChange={(on) => void client.call("settings.update", { aiCategorize: on }).then((next) => setApp({ settings: next }))}
        />
      </div>
      <ul className="divide-y divide-border">
        {categories.map((c) => {
          const s = stats.find((x) => x.categoryId === c.id);
          return (
            <li key={c.id} className="flex items-center gap-3 py-2.5 text-sm" data-testid={`category-stats-${c.id}`}>
              <CategoryDot color={c.color as CategoryColor} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.name}</p>
                <p className="text-xs text-muted-foreground">
                  {s ? `${s.examples} ${s.examples === 1 ? "ejemplo" : "ejemplos"}` : "…"}
                  {s?.autoPrecision !== null && s?.autoPrecision !== undefined && ` · acierta ${Math.round(s.autoPrecision * 100)}% (${s.kept + s.reverted})`}
                  {s?.pendingSuggestions ? ` · ${s.pendingSuggestions} por revisar` : ""}
                  {s?.paused && <span className="ml-1 font-medium text-destructive">· En pausa: demasiadas correcciones</span>}
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Añadir sola
                <Switch
                  data-testid={`category-auto-${c.id}`}
                  checked={c.autoApply}
                  disabled={settings.autoCategorize !== "auto"}
                  onCheckedChange={(on) => void setAuto(c.id, on)}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
