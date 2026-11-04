import { CUSTOM_PREFIX, DESIGN_PALETTE, customThemeSchema, MAX_CUSTOM_THEMES, type CustomTheme, type ThemeMode } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { RadioCard, RadioDot, RadioGroup } from "@terno/ui/components/radio-group";
import { Textarea } from "@terno/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { contrastFailures } from "@terno/ui/themes/contrast";
import { builtinTheme, resolveCustomTheme, themeName, themesFor } from "@terno/ui/themes/registry";
import { cn } from "@terno/ui/lib/utils";
import { Copy, Pencil, Play, Trash2, Upload } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useId, useRef, useState } from "react";
import { ThemeCard } from "./appearance-cards";
import { snack } from "~/lib/snack";
import { DESIGNS, designById, type DesignDefinition } from "@terno/ui/designs/index";
import { designDescription, designName } from "~/lib/design";
import { viewLabel } from "~/lib/format";
import { resolvedMode, resolveTheme, updateAppearance, useAppearance } from "~/lib/appearance";
import { ConfirmDialog, SettingsGroup, SettingsRow, type RowA11y, type SettingsUpdate } from "./parts";
import { SenderPictures } from "./sender-pictures";

/** Under a theme picked for the mode not showing now. */
const APPLIES_IN = { light: "settings.appearance.appliesLight", dark: "settings.appearance.appliesDark" } as const satisfies Record<ThemeMode, string>;

/**
 * A design's live mini-mock (plan 15): its own fonts, radii and variants in
 * its own colors (the current mode), nested in its own [data-design] and
 * [data-theme], so every style shows next to the others whatever is applied.
 */
function DesignPreview({ design, mode }: { design: DesignDefinition; mode: ThemeMode }) {
  const v = design.variants;
  const title = { fontFamily: "var(--type-list-title-family)", fontWeight: "var(--type-list-title-weight)", fontStyle: "var(--type-list-title-style)", letterSpacing: "var(--type-list-title-tracking)" } as const;
  const section = { fontFamily: "var(--type-section-label-family)", fontWeight: "var(--type-section-label-weight)", fontStyle: "var(--type-section-label-style)" } as const;
  return (
    <div data-design={design.id} data-theme={design.palette[mode]} aria-hidden className="flex h-[132px] w-full overflow-hidden rounded-lg border border-border bg-background font-sans text-foreground">
      <div className="flex w-[30%] shrink-0 flex-col gap-1 bg-sidebar p-1.5">
        {v.compose === "sidebar-pill" && <span className="h-3 rounded-full bg-primary" />}
        {v.compose === "sidebar-outline" && <span className="h-3 rounded-[3px] bg-card shadow-hairline" />}
        {v.compose === "sidebar-row" && <span className="h-1 w-4/5 rounded-full bg-muted-foreground" />}
        <span className="mt-0.5 h-2 rounded-[calc(var(--nav-radius)*0.4)] bg-sidebar-accent" />
        <span className="h-1 w-4/5 rounded-full bg-muted-foreground" />
        <span className="h-1 w-3/5 rounded-full bg-muted-foreground" />
        <span className="mt-1 truncate text-[8px] leading-none text-muted-foreground" style={section}>
          {t("sidebar.categories")}
        </span>
        <span className="size-1.5 rounded-full bg-cat-amber" />
        <span className="size-1.5 rounded-full bg-cat-emerald" />
        <span className="size-1.5 rounded-full bg-cat-indigo" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 bg-pane p-2">
        <div className="flex items-center justify-between">
          <span className="truncate text-[13px] leading-none" style={title}>
            {viewLabel("inbox")}
          </span>
          {v.compose === "list-header" && <span className="size-2 rounded-[2px] border border-muted-foreground" />}
        </div>
        {v.quickFilters === "chips" && (
          <div className="flex gap-0.5">
            <span className="h-2 w-4 rounded-full bg-primary" />
            <span className="h-2 w-5 rounded-full bg-muted" />
            <span className="h-2 w-5 rounded-full bg-muted" />
          </div>
        )}
        {/* more than fit: the list runs on past the mock's edge, as a real one does */}
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={cn("relative flex shrink-0 items-center gap-1.5 rounded-[calc(var(--row-radius)*0.5)] px-1", design.avatar.row ? "h-[22px]" : "h-[16px]", i === 1 && "bg-row-selected")}>
            {design.avatar.row > 0 && <span className={cn("shrink-0 rounded-full", design.avatar.row > 40 ? "size-4" : "size-3.5", ["bg-cat-rose/30", "bg-cat-indigo/30", "bg-cat-emerald/30"][i % 3])} />}
            {!design.avatar.row && i === 0 && <span className="absolute left-0 size-1 rounded-full bg-unread" />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn("h-1 rounded-full", i === 1 ? "w-1/2 bg-row-selected-foreground" : "w-2/5 bg-foreground")} />
              <span className="h-0.5 w-5/6 rounded-full bg-muted-foreground" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A design as one of the styles: a radio card (in the Style `RadioGroup`, whose value is the design's id). */
function StyleCard({ design, mode }: { design: DesignDefinition; mode: ThemeMode }) {
  return (
    <RadioCard value={design.id} data-testid={`design-card-${design.id}`} className="min-w-0 flex-col gap-1.5 p-1.5">
      <DesignPreview design={design} mode={mode} />
      <span className="flex items-center gap-1 px-0.5 text-sm">
        <span className="truncate font-medium">{designName(design.id)}</span>
        <RadioDot className="invisible ml-auto group-data-checked/radio:visible" />
      </span>
      <span className="px-0.5 text-xs text-muted-foreground">{designDescription(design.id)}</span>
    </RadioCard>
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

/**
 * Shows the chosen speed: the dot crosses its track when pressed and whenever a speed is picked (`plays` counts
 * those), at the speed the app now uses. A labeled button, so it says what it is.
 */
function MotionDemo({ ms, plays }: { ms: number; plays: number }) {
  const [presses, setPresses] = useState(0);
  const right = (presses + plays) % 2 === 1;
  return (
    <button
      type="button"
      onClick={() => setPresses((p) => p + 1)}
      data-testid="motion-demo"
      data-side={right ? "right" : "left"}
      className="flex h-7 items-center gap-2 rounded-md pr-2.5 pl-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Play aria-hidden className="size-3 fill-current" />
      {t("settings.appearance.tryMotion")}
      {/* a dot on a line (not a pill: that reads as a switch) */}
      <span aria-hidden className="relative ml-1 h-3 w-12">
        <span className="absolute inset-x-1.5 top-1/2 h-px -translate-y-1/2 bg-border" />
        <span
          className="absolute top-0 left-0 size-3 rounded-full bg-primary transition-transform duration-slow ease-motion"
          style={{ transform: right ? "translateX(36px)" : undefined }}
          data-ms={ms}
        />
      </span>
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
            {t(theme.mode === "light" ? "settings.appearance.basedOnLight" : "settings.appearance.basedOnDark", { base: (() => { const b = builtinTheme(theme.extends); return b ? themeName(b) : theme.extends; })() })}
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

export function AppearanceTab({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const mode = useAppearance((s) => s.mode);
  const reduced = useAppearance((s) => s.reducedMotion);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<{ error?: string; warnings?: string[]; name?: string } | null>(null);
  const active = resolvedMode(settings.theme);
  /** speeds picked here: each plays the preview once */
  const [motionPlays, setMotionPlays] = useState(0);

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
    const chosen = m === "light" ? settings.lightTheme : settings.darkTheme;
    // "Style colors" is its own choice: the design's palette listed below isn't selected along with it
    const selected = chosen === DESIGN_PALETTE ? DESIGN_PALETTE : resolveTheme(settings, m).id;
    const custom = settings.customThemes.filter((c) => c.mode === m);
    const note = m !== active ? t(APPLIES_IN[m]) : undefined;
    const own = builtinTheme(designById(settings.design).palette[m])!;
    // the palette chosen before designs: offered first, one click away (never applied by itself)
    const prevId = m === "light" ? settings.previousLightTheme : settings.previousDarkTheme;
    const prevCustom = prevId?.startsWith(CUSTOM_PREFIX) ? settings.customThemes.find((c) => `${CUSTOM_PREFIX}${c.id}` === prevId && c.mode === m) : undefined;
    const prevTheme = !prevId || prevId === own.id ? undefined : prevCustom ? resolveCustomTheme(prevCustom) : builtinTheme(prevId);
    const prevBase = prevCustom ? (builtinTheme(prevCustom.extends)?.id ?? prevCustom.extends) : prevTheme?.id;
    return (
      <RadioGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} value={selected} onValueChange={(id) => pick(m, id as string)} className="grid grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-2" data-testid={`theme-grid-${m}`}>
        <ThemeCard theme={own} base={own.id} name={t("settings.appearance.styleColors")} testId={`theme-card-design-${m}`} value={DESIGN_PALETTE} note={selected === DESIGN_PALETTE ? note : undefined} />
        {prevTheme && prevBase && <ThemeCard key={`previous-${prevTheme.id}`} theme={prevTheme} base={prevBase} testId={`theme-card-previous-${m}`} value={prevTheme.id} note={t("settings.appearance.previous")} />}
        {themesFor(m)
          .filter((theme) => theme.id !== prevTheme?.id)
          .map((theme) => (
            <ThemeCard key={theme.id} theme={theme} base={theme.id} value={theme.id} note={selected === theme.id ? note : undefined} />
          ))}
        {custom.filter((c) => `${CUSTOM_PREFIX}${c.id}` !== prevTheme?.id).map((c) => {
          const theme = resolveCustomTheme(c);
          return <ThemeCard key={theme.id} theme={theme} base={builtinTheme(c.extends)?.id ?? c.extends} value={theme.id} note={selected === theme.id ? note : undefined} />;
        })}
      </RadioGroup>
    );
  };

  return (
    <div data-testid="appearance-tab">
      <SettingsGroup>
        <SettingsRow stacked label={t("settings.appearance.style")} hint={t("settings.appearance.style.hint")}>
          {(a) => (
            <RadioGroup
              aria-labelledby={a["aria-labelledby"]}
              aria-describedby={a["aria-describedby"]}
              value={settings.design}
              onValueChange={(id) => void updateAppearance({ design: id as DesignDefinition["id"] })}
              // the chosen style chosen again (clicked, or arrowed back onto) is a choice too: it cancels a switch still
              // waiting for its faces (Codex code review #2, second pass #3)
              onReselect={(id) => void updateAppearance({ design: id as DesignDefinition["id"] })}
              // two across, each half the row: fixed-width cards left a hole beside the last column
              className="grid grid-cols-2 gap-2"
              data-testid="design-grid"
            >
              {DESIGNS.map((d) => (
                <StyleCard key={d.id} design={d} mode={mode} />
              ))}
            </RadioGroup>
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow label={t("settings.appearance.mode")} hint={t("settings.appearance.mode.hint")}>
          {(a) => (
            <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="segmented" value={[settings.theme]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ theme: v[0] as AppSettings["theme"] })} data-testid="mode-toggle">
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
              <ToggleGroup
                aria-labelledby={a["aria-labelledby"]}
                aria-describedby={a["aria-describedby"]}
                variant="segmented"
                value={[String(settings.motionMs)]}
                onValueChange={(v: string[]) => {
                  if (!v[0]) return;
                  // the preview plays once the new speed is in place
                  void updateAppearance({ motionMs: Number(v[0]) as AppSettings["motionMs"] }).then(() => requestAnimationFrame(() => setMotionPlays((n) => n + 1)));
                }}
                data-testid="motion-toggle"
              >
                <ToggleGroupItem value="0" data-testid="motion-0">{t("settings.appearance.motion.none")}</ToggleGroupItem>
                <ToggleGroupItem value="50" data-testid="motion-50">50 ms</ToggleGroupItem>
                <ToggleGroupItem value="75" data-testid="motion-75">75 ms</ToggleGroupItem>
                <ToggleGroupItem value="100" data-testid="motion-100">100 ms</ToggleGroupItem>
              </ToggleGroup>
              <MotionDemo ms={settings.motionMs} plays={motionPlays} />
            </div>
          )}
        </SettingsRow>
        <SettingsRow stacked label={t("settings.appearance.htmlMail")} hint={t("settings.appearance.htmlMail.hint")}>
          {(a) => (
            <ToggleGroup aria-labelledby={a["aria-labelledby"]} aria-describedby={a["aria-describedby"]} variant="segmented" value={[settings.htmlMailAppearance]} onValueChange={(v: string[]) => v[0] && void updateAppearance({ htmlMailAppearance: v[0] as AppSettings["htmlMailAppearance"] })} data-testid="mail-appearance-toggle">
              <ToggleGroupItem value="auto" data-testid="mail-auto">{t("settings.appearance.htmlMail.auto")}</ToggleGroupItem>
              <ToggleGroupItem value="paper" data-testid="mail-paper">{t("settings.appearance.htmlMail.paper")}</ToggleGroupItem>
            </ToggleGroup>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SenderPictures settings={settings} update={update} />

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
