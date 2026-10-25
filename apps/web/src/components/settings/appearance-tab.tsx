import { CUSTOM_PREFIX, customThemeSchema, MAX_CUSTOM_THEMES, THEME_TOKENS, type CustomTheme, type ThemeMode } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Textarea } from "@terno/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { contrastFailures } from "@terno/ui/themes/contrast";
import { builtinTheme, resolveCustomTheme, themesFor, type Theme } from "@terno/ui/themes/registry";
import { cn } from "@terno/ui/lib/utils";
import { Check, Copy, Pencil, Trash2, Upload } from "lucide-react";
import { t } from "@terno/i18n";
import { useId, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { resolvedMode, resolveTheme, updateAppearance, useAppearance } from "~/lib/appearance";
import { ConfirmDialog, SettingsGroup, SettingsRow, type RowA11y } from "./parts";

/** Under a theme picked for the mode not showing now. */
const APPLIES_IN = { light: "settings.appearance.appliesLight", dark: "settings.appearance.appliesDark" } as const satisfies Record<ThemeMode, string>;

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
      {note && <span className="w-[132px] text-2xs">{note}</span>}
    </button>
  );
}

/** Validates an imported theme file; errors block, contrast problems only warn. */
export function parseThemeFile(text: string, existing: readonly CustomTheme[], editing?: string): { theme: CustomTheme; warnings: string[] } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: t("settings.file.invalidJson") };
  }
  const r = customThemeSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    return { error: `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}` };
  }
  if (editing !== undefined && r.data.id !== editing) return { error: t("settings.appearance.idFixed", { id: editing }) };
  if (editing === undefined && existing.some((c) => c.id === r.data.id)) return { error: t("settings.appearance.idTaken", { id: r.data.id }) };
  if (editing === undefined && existing.length >= MAX_CUSTOM_THEMES) return { error: t("settings.appearance.tooMany", { max: MAX_CUSTOM_THEMES }) };
  const warnings = contrastFailures(resolveCustomTheme(r.data)).map((f) => t("settings.appearance.contrastWarning", { pair: f.pair, ratio: f.ratio, min: f.min }));
  return { theme: r.data, warnings };
}

function MotionDemo({ ms }: { ms: number }) {
  const [right, setRight] = useState(false);
  return (
    <button type="button" onClick={() => setRight((r) => !r)} aria-label={t("settings.appearance.tryMotion")} data-testid="motion-demo" className="relative h-5 w-16 rounded-full bg-muted">
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
    const next = await updateAppearance({ customThemes: all.map((c) => (c.id === theme.id ? result.theme : c)) });
    setBusy(false);
    if (!next) return setError(t("settings.appearance.saveFailed"));
    snack.success(result.warnings.length ? t("settings.appearance.savedWarnings", { name: result.theme.name, count: result.warnings.length }) : t("settings.appearance.saved", { name: result.theme.name }));
    onDone();
  };
  return (
    <div className="space-y-2 pb-3" data-testid="theme-editor">
      <label htmlFor={id} className="sr-only">
        {t("settings.appearance.json", { name: theme.name })}
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
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive-ink" data-testid="theme-editor-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save()} data-testid="theme-editor-save">
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function CustomThemeItem({ theme, all }: { theme: CustomTheme; all: readonly CustomTheme[] }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div data-testid={`custom-theme-${theme.id}`}>
      <div className="flex min-h-11 items-center gap-2 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{theme.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t(theme.mode === "light" ? "settings.appearance.basedOnLight" : "settings.appearance.basedOnDark", { base: builtinTheme(theme.extends)?.name ?? theme.extends })}
          </p>
        </div>
        <Button variant="ghost" size="sm" aria-expanded={editing} aria-label={t("settings.appearance.editTheme", { name: theme.name })} data-testid={`theme-edit-${CUSTOM_PREFIX}${theme.id}`} onClick={() => setEditing((e) => !e)}>
          <Pencil /> {t("common.edit")}
        </Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive-ink" aria-label={t("settings.appearance.deleteTheme", { name: theme.name })} data-testid={`theme-delete-${CUSTOM_PREFIX}${theme.id}`} onClick={() => setDeleting(true)}>
          <Trash2 />
        </Button>
      </div>
      {editing && <ThemeEditor theme={theme} all={all} onDone={() => setEditing(false)} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        testId="theme-delete-dialog"
        title={t("settings.appearance.delete.title", { name: theme.name })}
        description={t("settings.appearance.delete.description")}
        confirm={t("settings.appearance.delete.confirm")}
        onConfirm={() => void updateAppearance({ customThemes: all.filter((c) => c.id !== theme.id) })}
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
    if (file.size > 32 * 1024) return setImported({ error: t("settings.file.tooLarge", { max: "32 KB" }) });
    const result = parseThemeFile(await file.text(), settings.customThemes);
    if ("error" in result) return setImported({ error: result.error });
    const next = await updateAppearance({ customThemes: [...settings.customThemes, result.theme] });
    if (next) setImported({ warnings: result.warnings, name: result.theme.name });
  };

  const exportCurrent = () => {
    const theme = resolveTheme(settings, mode);
    const base = theme.id.startsWith(CUSTOM_PREFIX) ? (settings.customThemes.find((c) => `${CUSTOM_PREFIX}${c.id}` === theme.id)?.extends ?? theme.id) : theme.id;
    const slug = theme.id.replace(CUSTOM_PREFIX, "").slice(0, 33);
    const json: CustomTheme = { id: `${slug}-copia`, name: t("settings.appearance.copyName", { name: theme.name }).slice(0, 40), mode: theme.mode, extends: base as CustomTheme["extends"], tokens: theme.tokens };
    void navigator.clipboard.writeText(JSON.stringify(json, null, 2)).then(
      () => snack.success(t("settings.appearance.copied")),
      () => snack.error(t("settings.copyFailed")),
    );
  };

  const grid = (m: ThemeMode, a: RowA11y) => {
    const selected = resolveTheme(settings, m).id;
    const custom = settings.customThemes.filter((c) => c.mode === m);
    const note = m !== active ? t(APPLIES_IN[m]) : undefined;
    return (
      <div role="group" aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} className="-mx-1.5 flex flex-wrap gap-1" data-testid={`theme-grid-${m}`}>
        {themesFor(m).map((theme) => (
          <ThemeCard key={theme.id} theme={theme} base={theme.id} selected={selected === theme.id} onSelect={() => pick(m, theme.id)} note={selected === theme.id ? note : undefined} />
        ))}
        {custom.map((c) => {
          const theme = resolveCustomTheme(c);
          return <ThemeCard key={theme.id} theme={theme} base={builtinTheme(c.extends)?.id ?? c.extends} selected={selected === theme.id} onSelect={() => pick(m, theme.id)} note={selected === theme.id ? note : undefined} />;
        })}
      </div>
    );
  };

  return (
    <div data-testid="appearance-tab">
      <SettingsGroup>
        <SettingsRow label={t("settings.appearance.mode")} hint={t("settings.appearance.mode.hint")}>
          {(a) => (
            <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="outline" size="sm" value={[settings.theme]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ theme: v[0] as AppSettings["theme"] })} data-testid="mode-toggle">
              <ToggleGroupItem value="system" data-testid="mode-system">{t("settings.appearance.system")}</ToggleGroupItem>
              <ToggleGroupItem value="light" data-testid="mode-light">{t("settings.appearance.light")}</ToggleGroupItem>
              <ToggleGroupItem value="dark" data-testid="mode-dark">{t("settings.appearance.dark")}</ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
        <SettingsRow stacked label={t("settings.appearance.lightTheme")}>
          {(a) => grid("light", a)}
        </SettingsRow>
        <SettingsRow stacked label={t("settings.appearance.darkTheme")}>
          {(a) => grid("dark", a)}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.motionMail")}>
        <SettingsRow stacked label={t("settings.appearance.motion")} hint={reduced ? t("settings.appearance.motion.reduced") : t("settings.appearance.motion.hint")}>
          {(a) => (
            <div className="flex items-center gap-4">
              <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="outline" size="sm" value={[String(settings.motionMs)]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ motionMs: Number(v[0]) as AppSettings["motionMs"] })} data-testid="motion-toggle">
                <ToggleGroupItem value="0" data-testid="motion-0">{t("settings.appearance.motion.none")}</ToggleGroupItem>
                <ToggleGroupItem value="50" data-testid="motion-50">50 ms</ToggleGroupItem>
                <ToggleGroupItem value="75" data-testid="motion-75">75 ms</ToggleGroupItem>
                <ToggleGroupItem value="100" data-testid="motion-100">100 ms</ToggleGroupItem>
              </ToggleGroup>
              <MotionDemo ms={settings.motionMs} />
            </div>
          )}
        </SettingsRow>
        <SettingsRow stacked label={t("settings.appearance.htmlMail")} hint={t("settings.appearance.htmlMail.hint")}>
          {(a) => (
            <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="outline" size="sm" value={[settings.htmlMailAppearance]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ htmlMailAppearance: v[0] as AppSettings["htmlMailAppearance"] })} data-testid="mail-appearance-toggle">
              <ToggleGroupItem value="auto" data-testid="mail-auto">{t("settings.appearance.htmlMail.auto")}</ToggleGroupItem>
              <ToggleGroupItem value="paper" data-testid="mail-paper">{t("settings.appearance.htmlMail.paper")}</ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.appearance.custom")} testId="custom-themes" footer={t("settings.appearance.custom.footer")}>
        {settings.customThemes.map((c) => (
          <CustomThemeItem key={c.id} theme={c} all={settings.customThemes} />
        ))}
        <div className="py-2.5">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} data-testid="theme-import">
              <Upload /> {t("settings.appearance.import")}
            </Button>
            <Button variant="ghost" size="sm" onClick={exportCurrent} data-testid="theme-export">
              <Copy /> {t("settings.appearance.export")}
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
            <p role="alert" className="mt-2 text-xs text-destructive-ink" data-testid="theme-import-error">
              {imported.error}
            </p>
          )}
          {imported?.name && (
            <div role="status" className="mt-2 text-xs" data-testid="theme-import-result">
              <p className="text-success-ink">{t("settings.appearance.imported", { name: imported.name })}</p>
              {imported.warnings && imported.warnings.length > 0 && (
                <div className="mt-1 text-muted-foreground" data-testid="theme-import-warnings">
                  <p>{t("settings.appearance.importWarnings", { count: imported.warnings.length })}</p>
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
