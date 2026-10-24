import { CUSTOM_PREFIX, customThemeSchema, MAX_CUSTOM_THEMES, THEME_TOKENS, type CustomTheme, type ThemeMode } from "@unica/core";
import type { AppSettings } from "@unica/core/rpc";
import { Button } from "@unica/ui/components/button";
import { Textarea } from "@unica/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@unica/ui/components/toggle-group";
import { contrastFailures } from "@unica/ui/themes/contrast";
import { builtinTheme, resolveCustomTheme, themesFor, type Theme } from "@unica/ui/themes/registry";
import { cn } from "@unica/ui/lib/utils";
import { Check, Copy, Pencil, Trash2, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { resolvedMode, resolveTheme, updateAppearance, useAppearance } from "~/lib/appearance";
import { ConfirmDialog, SettingsGroup, SettingsRow, type RowA11y } from "./parts";

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
          <div key={i} className={cn("relative mx-0.5 flex h-[18px] shrink-0 flex-col justify-center gap-0.5 rounded-sm pr-1.5 pl-2", i === 1 ? "bg-row-selected" : "hairline-b")}>
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

function ThemeCard({ theme, base, selected, onSelect, note }: { theme: Theme; base: string; selected: boolean; onSelect: () => void; note?: string }) {
  return (
    <button
      type="button"
      data-testid={`theme-card-${theme.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn("flex flex-col gap-1.5 rounded-lg p-1.5 text-left hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", selected && "bg-accent text-accent-foreground hover:bg-accent")}
    >
      <ThemePreview theme={theme} base={base} />
      <span className="flex w-[132px] items-center gap-1 text-xs">
        <span className="truncate font-medium">{theme.name}</span>
        {selected && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
      </span>
      {note && <span className="w-[132px] text-2xs text-muted-foreground">{note}</span>}
    </button>
  );
}

/** Validates an imported theme file; errors block, contrast problems only warn. */
export function parseThemeFile(text: string, existing: readonly CustomTheme[], editing?: string): { theme: CustomTheme; warnings: string[] } | { error: string } {
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
  if (editing !== undefined && r.data.id !== editing) return { error: `El id no se puede cambiar: es «${editing}».` };
  if (editing === undefined && existing.some((t) => t.id === r.data.id)) return { error: `Ya tienes un tema con el id «${r.data.id}».` };
  if (editing === undefined && existing.length >= MAX_CUSTOM_THEMES) return { error: `Puedes tener hasta ${MAX_CUSTOM_THEMES} temas propios.` };
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

/** A custom theme's JSON, edited in place: validated like an import (same id), warnings shown, saved on Guardar. */
function ThemeEditor({ theme, all, onDone }: { theme: CustomTheme; all: readonly CustomTheme[]; onDone: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(theme, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const save = async () => {
    const result = parseThemeFile(text, all, theme.id);
    if ("error" in result) return setError(result.error);
    setBusy(true);
    const next = await updateAppearance({ customThemes: all.map((t) => (t.id === theme.id ? result.theme : t)) });
    setBusy(false);
    if (!next) return setError("No se pudo guardar el tema.");
    toast.success(result.warnings.length ? `«${result.theme.name}» guardado, con ${result.warnings.length} avisos de contraste` : `«${result.theme.name}» guardado`);
    onDone();
  };
  return (
    <div className="space-y-2 pb-3" data-testid="theme-editor">
      <label htmlFor={id} className="sr-only">
        JSON de {theme.name}
      </label>
      <Textarea
        id={id}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="max-h-72 min-h-40 bg-background font-mono text-xs dark:bg-input/30"
        data-testid="theme-editor-json"
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive" data-testid="theme-editor-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancelar
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save()} data-testid="theme-editor-save">
          Guardar
        </Button>
      </div>
    </div>
  );
}

function CustomThemeItem({ theme, all }: { theme: CustomTheme; all: readonly CustomTheme[] }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const name = `«${theme.name}»`;
  return (
    <div data-testid={`custom-theme-${theme.id}`}>
      <div className="flex min-h-11 items-center gap-2 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{theme.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {theme.mode === "light" ? "Claro" : "Oscuro"} · basado en {builtinTheme(theme.extends)?.name ?? theme.extends}
          </p>
        </div>
        <Button variant="ghost" size="sm" aria-expanded={editing} aria-label={`Editar ${name}`} data-testid={`theme-edit-${CUSTOM_PREFIX}${theme.id}`} onClick={() => setEditing((e) => !e)}>
          <Pencil /> Editar
        </Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Borrar ${name}`} data-testid={`theme-delete-${CUSTOM_PREFIX}${theme.id}`} onClick={() => setDeleting(true)}>
          <Trash2 />
        </Button>
      </div>
      {editing && <ThemeEditor theme={theme} all={all} onDone={() => setEditing(false)} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        testId="theme-delete-dialog"
        title={`¿Borrar ${name}?`}
        description="Si lo estás usando, Única vuelve al tema incluido de ese modo. Exporta antes el tema si quieres conservarlo."
        confirm="Borrar tema"
        onConfirm={() => void updateAppearance({ customThemes: all.filter((t) => t.id !== theme.id) })}
      />
    </div>
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

  const grid = (m: ThemeMode, a: RowA11y) => {
    const selected = resolveTheme(settings, m).id;
    const custom = settings.customThemes.filter((t) => t.mode === m);
    const note = m !== active ? `Se aplicará en modo ${MODE_LABEL[m]}` : undefined;
    return (
      <div role="group" aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} className="-mx-1.5 flex flex-wrap gap-1" data-testid={`theme-grid-${m}`}>
        {themesFor(m).map((t) => (
          <ThemeCard key={t.id} theme={t} base={t.id} selected={selected === t.id} onSelect={() => pick(m, t.id)} note={selected === t.id ? note : undefined} />
        ))}
        {custom.map((c) => {
          const t = resolveCustomTheme(c);
          return <ThemeCard key={t.id} theme={t} base={builtinTheme(c.extends)?.id ?? c.extends} selected={selected === t.id} onSelect={() => pick(m, t.id)} note={selected === t.id ? note : undefined} />;
        })}
      </div>
    );
  };

  return (
    <div data-testid="appearance-tab">
      <SettingsGroup>
        <SettingsRow label="Modo" hint="«Sistema» sigue al de tu equipo y usa el tema claro o el oscuro de abajo.">
          {(a) => (
            <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="outline" size="sm" value={[settings.theme]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ theme: v[0] as AppSettings["theme"] })} data-testid="mode-toggle">
              <ToggleGroupItem value="system" data-testid="mode-system">Sistema</ToggleGroupItem>
              <ToggleGroupItem value="light" data-testid="mode-light">Claro</ToggleGroupItem>
              <ToggleGroupItem value="dark" data-testid="mode-dark">Oscuro</ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
        <SettingsRow stacked label="Tema claro">
          {(a) => grid("light", a)}
        </SettingsRow>
        <SettingsRow stacked label="Tema oscuro">
          {(a) => grid("dark", a)}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Movimiento y correo">
        <SettingsRow stacked label="Animaciones" hint={reduced ? "Tu equipo pide reducir el movimiento: no se anima nada." : "Duración de las animaciones. Si el sistema pide reducir el movimiento, no se anima nada."}>
          {(a) => (
            <div className="flex items-center gap-4">
              <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="outline" size="sm" value={[String(settings.motionMs)]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ motionMs: Number(v[0]) as AppSettings["motionMs"] })} data-testid="motion-toggle">
                <ToggleGroupItem value="0" data-testid="motion-0">Sin animación</ToggleGroupItem>
                <ToggleGroupItem value="50" data-testid="motion-50">50 ms</ToggleGroupItem>
                <ToggleGroupItem value="75" data-testid="motion-75">75 ms</ToggleGroupItem>
                <ToggleGroupItem value="100" data-testid="motion-100">100 ms</ToggleGroupItem>
              </ToggleGroup>
              <MotionDemo ms={settings.motionMs} />
            </div>
          )}
        </SettingsRow>
        <SettingsRow stacked label="Correo HTML" hint="«Según el tema» usa los colores del tema en correos sin colores propios; los correos diseñados se muestran sobre papel claro.">
          {(a) => (
            <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="outline" size="sm" value={[settings.htmlMailAppearance]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ htmlMailAppearance: v[0] as AppSettings["htmlMailAppearance"] })} data-testid="mail-appearance-toggle">
              <ToggleGroupItem value="auto" data-testid="mail-auto">Según el tema</ToggleGroupItem>
              <ToggleGroupItem value="paper" data-testid="mail-paper">Siempre papel</ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Temas propios" testId="custom-themes" footer="Un archivo JSON con id, name, mode, extends (un tema incluido) y tokens (#hex u oklch).">
        {settings.customThemes.map((t) => (
          <CustomThemeItem key={t.id} theme={t} all={settings.customThemes} />
        ))}
        <div className="py-2.5">
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
              tabIndex={-1}
              aria-hidden
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
            <div role="status" className="mt-2 text-xs" data-testid="theme-import-result">
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
        </div>
      </SettingsGroup>
    </div>
  );
}
