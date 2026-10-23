import { CUSTOM_PREFIX, customThemeSchema, MAX_CUSTOM_THEMES, THEME_TOKENS, type CustomTheme, type ThemeMode } from "@unica/core";
import type { AppSettings } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@unica/ui/components/toggle-group";
import { contrastFailures } from "@unica/ui/themes/contrast";
import { builtinTheme, resolveCustomTheme, themesFor, type Theme } from "@unica/ui/themes/registry";
import { cn } from "@unica/ui/lib/utils";
import { Check, Copy, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { resolvedMode, resolveTheme, updateAppearance, useAppearance } from "~/lib/appearance";

const MODE_LABEL: Record<ThemeMode, string> = { light: "claro", dark: "oscuro" };

/**
 * A 132×84 live mini-mock of the app in a theme: sidebar, three rows (one
 * unread), the selected row with its rail and a primary pill. Tokens only,
 * inside its own [data-theme], so any theme renders next to any other.
 */
function ThemePreview({ theme, base }: { theme: Theme; base: string }) {
  // custom themes: their full token map, set through React's style (CSSOM), never as CSS text
  const style = theme.id.startsWith(CUSTOM_PREFIX) ? (Object.fromEntries(THEME_TOKENS.map((k) => [`--${k}`, theme.tokens[k]])) as React.CSSProperties) : undefined;
  return (
    <div data-theme={base} style={style} className="flex h-[84px] w-[132px] overflow-hidden rounded-md border border-border bg-background font-sans text-foreground" aria-hidden>
      <div className="flex w-8 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-1.5">
        <span className="h-2 rounded-sm bg-primary" />
        <span className="h-1 w-4 rounded-full bg-muted-foreground" />
        <span className="h-1 w-3 rounded-full bg-muted-foreground" />
        <span className="mt-1 size-1.5 rounded-full bg-cat-amber" />
        <span className="size-1.5 rounded-full bg-cat-emerald" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col bg-pane">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn("relative flex h-[18px] shrink-0 flex-col justify-center gap-0.5 border-b border-border pr-1.5 pl-2.5", i === 1 && "bg-row-selected")}>
            {i === 1 && <span className="absolute inset-y-0 left-0 w-0.5 bg-row-rail" />}
            {i === 0 && <span className="absolute top-1/2 left-1 size-1 -translate-y-1/2 rounded-full bg-unread" />}
            <span className={cn("h-1 rounded-full", i === 1 ? "w-10 bg-row-selected-foreground" : "w-9 bg-foreground")} />
            <span className="h-0.5 w-14 rounded-full bg-muted-foreground" />
          </div>
        ))}
        <div className="flex flex-1 items-center justify-end px-1.5">
          <span className="h-2 w-7 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ theme, base, selected, onSelect, onDelete, note }: { theme: Theme; base: string; selected: boolean; onSelect: () => void; onDelete?: () => void; note?: string }) {
  return (
    <div className="relative">
      <button
        type="button"
        data-testid={`theme-card-${theme.id}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn("flex flex-col gap-1.5 rounded-lg p-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", selected && "bg-accent text-accent-foreground hover:bg-accent")}
      >
        <ThemePreview theme={theme} base={base} />
        <span className="flex w-[132px] items-center gap-1 text-xs">
          <span className="truncate font-medium">{theme.name}</span>
          {selected && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
        </span>
        {note && <span className="w-[132px] text-2xs text-muted-foreground">{note}</span>}
      </button>
      {onDelete && (
        <button type="button" aria-label={`Borrar ${theme.name}`} data-testid={`theme-delete-${theme.id}`} onClick={onDelete} className="absolute top-2.5 right-2.5 rounded-md bg-popover p-1 text-muted-foreground shadow-sm hover:text-destructive">
          <Trash2 className="size-3" />
        </button>
      )}
    </div>
  );
}

function Section({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="border-b border-border py-4 last:border-0" data-testid={testId}>
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Validates an imported theme file; errors block, contrast problems only warn. */
export function parseThemeFile(text: string, existing: readonly CustomTheme[]): { theme: CustomTheme; warnings: string[] } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "El archivo no es JSON válido." };
  }
  const r = customThemeSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    return { error: `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}` };
  }
  if (existing.some((t) => t.id === r.data.id)) return { error: `Ya tienes un tema con el id «${r.data.id}».` };
  if (existing.length >= MAX_CUSTOM_THEMES) return { error: `Puedes tener hasta ${MAX_CUSTOM_THEMES} temas propios.` };
  const warnings = contrastFailures(resolveCustomTheme(r.data)).map((f) => `${f.pair}: ${f.ratio}:1 (mínimo ${f.min}:1)`);
  return { theme: r.data, warnings };
}

function MotionDemo({ ms }: { ms: number }) {
  const [right, setRight] = useState(false);
  return (
    <button type="button" onClick={() => setRight((r) => !r)} aria-label="Probar la animación" data-testid="motion-demo" className="relative h-5 w-16 rounded-full bg-muted">
      <span
        className="absolute top-1 left-1 size-3 rounded-full bg-primary transition-transform duration-slow ease-motion"
        style={{ transform: right ? "translateX(44px)" : undefined }}
        data-ms={ms}
      />
    </button>
  );
}

export function AppearanceTab({ settings }: { settings: AppSettings }) {
  const mode = useAppearance((s) => s.mode);
  const reduced = useAppearance((s) => s.reducedMotion);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<{ error?: string; warnings?: string[]; name?: string } | null>(null);
  const active = resolvedMode(settings.theme);

  const pick = (m: ThemeMode, id: string) => void updateAppearance(m === "light" ? { lightTheme: id } : { darkTheme: id });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 32 * 1024) return setImported({ error: "El archivo es demasiado grande (máx. 32 KB)." });
    const result = parseThemeFile(await file.text(), settings.customThemes);
    if ("error" in result) return setImported({ error: result.error });
    const next = await updateAppearance({ customThemes: [...settings.customThemes, result.theme] });
    if (next) setImported({ warnings: result.warnings, name: result.theme.name });
  };

  const exportCurrent = () => {
    const t = resolveTheme(settings, mode);
    const base = t.id.startsWith(CUSTOM_PREFIX) ? (settings.customThemes.find((c) => `${CUSTOM_PREFIX}${c.id}` === t.id)?.extends ?? t.id) : t.id;
    const slug = t.id.replace(CUSTOM_PREFIX, "").slice(0, 33);
    const json: CustomTheme = { id: `${slug}-copia`, name: `${t.name} (copia)`.slice(0, 40), mode: t.mode, extends: base as CustomTheme["extends"], tokens: t.tokens };
    void navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(
      () => toast.success("Tema copiado como JSON"),
      () => toast.error("No se pudo copiar"),
    );
  };

  const remove = (id: string) => void updateAppearance({ customThemes: settings.customThemes.filter((t) => t.id !== id) });

  const grid = (m: ThemeMode) => {
    const selected = resolveTheme(settings, m).id;
    const custom = settings.customThemes.filter((t) => t.mode === m);
    const note = m !== active ? `Se aplicará en modo ${MODE_LABEL[m]}` : undefined;
    return (
      <div className="-mx-1.5 flex flex-wrap gap-1" data-testid={`theme-grid-${m}`}>
        {themesFor(m).map((t) => (
          <ThemeCard key={t.id} theme={t} base={t.id} selected={selected === t.id} onSelect={() => pick(m, t.id)} note={selected === t.id ? note : undefined} />
        ))}
        {custom.map((c) => {
          const t = resolveCustomTheme(c);
          return <ThemeCard key={t.id} theme={t} base={builtinTheme(c.extends)?.id ?? c.extends} selected={selected === t.id} onSelect={() => pick(m, t.id)} onDelete={() => remove(c.id)} note={selected === t.id ? note : undefined} />;
        })}
      </div>
    );
  };

  return (
    <div data-testid="appearance-tab">
      <Section title="Modo">
        <ToggleGroup variant="outline" size="sm" value={[settings.theme]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ theme: v[0] as AppSettings["theme"] })} data-testid="mode-toggle">
          <ToggleGroupItem value="system" data-testid="mode-system">Sistema</ToggleGroupItem>
          <ToggleGroupItem value="light" data-testid="mode-light">Claro</ToggleGroupItem>
          <ToggleGroupItem value="dark" data-testid="mode-dark">Oscuro</ToggleGroupItem>
        </ToggleGroup>
      </Section>
      <Section title="Tema claro">{grid("light")}</Section>
      <Section title="Tema oscuro">{grid("dark")}</Section>
      <Section title="Animaciones" hint={reduced ? "Tu Mac pide reducir el movimiento: no se anima nada." : "Duración de las animaciones. Si el sistema pide reducir el movimiento, no se anima nada."}>
        <div className="flex items-center gap-4">
          <ToggleGroup variant="outline" size="sm" value={[String(settings.motionMs)]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ motionMs: Number(v[0]) as AppSettings["motionMs"] })} data-testid="motion-toggle">
            <ToggleGroupItem value="0" data-testid="motion-0">Sin animación</ToggleGroupItem>
            <ToggleGroupItem value="50" data-testid="motion-50">50 ms</ToggleGroupItem>
            <ToggleGroupItem value="75" data-testid="motion-75">75 ms</ToggleGroupItem>
            <ToggleGroupItem value="100" data-testid="motion-100">100 ms</ToggleGroupItem>
          </ToggleGroup>
          <MotionDemo ms={settings.motionMs} />
        </div>
      </Section>
      <Section title="Correo HTML" hint="«Según el tema» usa los colores del tema en correos sin colores propios; los correos diseñados se muestran sobre papel claro.">
        <ToggleGroup variant="outline" size="sm" value={[settings.htmlMailAppearance]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ htmlMailAppearance: v[0] as AppSettings["htmlMailAppearance"] })} data-testid="mail-appearance-toggle">
          <ToggleGroupItem value="auto" data-testid="mail-auto">Según el tema</ToggleGroupItem>
          <ToggleGroupItem value="paper" data-testid="mail-paper">Siempre papel</ToggleGroupItem>
        </ToggleGroup>
      </Section>
      <Section title="Temas propios" hint="Un archivo JSON con id, name, mode, extends (un tema incluido) y tokens (#hex u oklch).">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} data-testid="theme-import">
            <Upload /> Importar tema…
          </Button>
          <Button variant="ghost" size="sm" onClick={exportCurrent} data-testid="theme-export">
            <Copy /> Exportar tema actual
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="theme-import-input"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {imported?.error && (
          <p role="alert" className="mt-2 text-xs text-destructive" data-testid="theme-import-error">
            {imported.error}
          </p>
        )}
        {imported?.name && (
          <div className="mt-2 text-xs" data-testid="theme-import-result">
            <p className="text-success">Importado: {imported.name}</p>
            {imported.warnings && imported.warnings.length > 0 && (
              <div className="mt-1 text-muted-foreground" data-testid="theme-import-warnings">
                <p>Contraste insuficiente en {imported.warnings.length} {imported.warnings.length === 1 ? "par" : "pares"} (no impide usarlo):</p>
                <ul className="mt-0.5 list-disc pl-4">
                  {imported.warnings.slice(0, 6).map((w) => (
                    <li key={w} className="font-mono text-2xs">
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
