import { DESIGN_PALETTE, type AiProviderId, type ThemeMode } from "@terno/core";
import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@terno/ui/components/dialog";
import { RadioCard, RadioDot, RadioGroup } from "@terno/ui/components/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@terno/ui/components/toggle-group";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { DESIGNS, designById } from "@terno/ui/designs/index";
import { builtinTheme, themesFor } from "@terno/ui/themes/registry";
import { cn } from "@terno/ui/lib/utils";
import { Columns2, Laptop, Moon, Rows3, Sun } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp, useApp } from "~/state/app";
import { baseId, reconcileSettings, resolveTheme, updateAppearance, useAppearance } from "~/lib/appearance";
import { designDescription, designName } from "~/lib/design";
import { OnboardingNudge } from "~/lib/web-parts";
import { AddAccountForm, EMPTY_ACCOUNT_DRAFT } from "./add-account-dialog";
import { ThemeCard } from "./settings/appearance-cards";
import { FirstRunPreview } from "./first-run-preview";
import { sampleMailbox } from "./first-run-sample";

const STEP_KEY = "terno:first-run";
const STEPS = ["layout", "look", "account"] as const;
type Step = (typeof STEPS)[number];

/** Where a reload picks up (never lose position); the old single-step values map onto the steps they were. */
function savedStep(): Step {
  const v = localStorage.getItem(STEP_KEY);
  return v === "look" ? "look" : v === "account" ? "account" : "layout";
}

/**
 * What's typed for the account while the setup is away (unmounted, as behind
 * Settings): it comes back with this. Memory only (a password may be in it),
 * dropped when the setup ends. `discovered`: the local-model discovery ran in
 * this session (coming back never runs it again over an AI chosen meanwhile).
 */
const kept = { draft: EMPTY_ACCOUNT_DRAFT, discovered: false };

/** A local server we found on this Mac, offered as the AI in local mode. */
type Found = { provider: AiProviderId; label: string; model: string };

async function findLocalModel(): Promise<Found | null> {
  const probes = [
    { provider: "ollama" as const, label: "Ollama" },
    { provider: "lmstudio" as const, label: "LM Studio" },
  ].map(async (p) => {
    const { models } = await client.call("ai.listModels", { provider: p.provider });
    const model = models.find((m) => m.loaded) ?? models[0];
    if (!model) throw new Error("no models");
    return { ...p, model: model.id };
  });
  return Promise.any(probes).catch(() => null);
}

function Choice({ value, mark, title, body, testId }: { value: string; mark: React.ReactNode; title: string; body: string; testId: string }) {
  return (
    <RadioCard value={value} data-testid={testId} className="w-full items-center gap-3 px-3 py-2.5">
      {mark}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{body}</span>
      </span>
      <RadioDot />
    </RadioCard>
  );
}

/**
 * Plan 98: a fresh install's setup, in one window: the layout, then the style
 * and colors, each with the whole app previewed in sample mail, then the
 * first account. Every pick applies at once (the app behind repaints too);
 * Skip keeps what's picked. The step survives a reload; what's typed for the
 * account survives Back (memory only).
 */
export function FirstRun() {
  const settings = useApp((s) => s.settings);
  const systemMode = useAppearance((s) => s.mode);
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<Step>(savedStep);
  /** which way the last step change went: the new step slides in from that side */
  const [forward, setForward] = useState(true);
  /** following the system, step 2 offers both modes' colors: the preview shows the one last picked in (the system's mode until then) */
  const [pickedMode, setPickedMode] = useState<ThemeMode | null>(null);
  const [draft, setDraft] = useState(() => kept.draft);
  /** a connection in flight: Back, Skip and Esc wait for it */
  const [busy, setBusy] = useState(false);
  const sample = useMemo(() => sampleMailbox(), []);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // a model already running on this Mac becomes the AI (no key, nothing leaves the machine), only while no AI is
  // chosen yet when discovery answers: a provider picked meanwhile is the user's (plan 97, Codex review)
  useEffect(() => {
    if (kept.discovered) return;
    kept.discovered = true;
    void findLocalModel().then(async (found) => {
      if (!found || (getApp().settings?.ai.provider ?? "none") !== "none") return;
      try {
        const next = await client.call("settings.update", { ai: { provider: found.provider, model: found.model } });
        setApp({ settings: reconcileSettings(next) });
      } catch (error) {
        snack.error(error instanceof Error ? error.message : String(error));
      }
    });
  }, []);

  useEffect(() => {
    kept.draft = draft;
  }, [draft]);

  // a new step is announced by its heading (focused without a ring: it isn't Tab's)
  useEffect(() => {
    if (moved.current) heading.current?.focus({ preventScroll: true });
  }, [step]);

  // the palette in use is in view (the default, GitHub, sits partway down the list)
  useEffect(() => {
    if (step === "look") document.querySelector("[data-testid=first-run-palettes] [aria-checked=true]")?.scrollIntoView({ block: "nearest" });
  }, [step, settings?.theme]);

  if (!settings) return null;

  const go = (next: Step) => {
    moved.current = true;
    setForward(STEPS.indexOf(next) > STEPS.indexOf(step));
    localStorage.setItem(STEP_KEY, next);
    setStep(next);
  };
  const done = () => {
    kept.draft = EMPTY_ACCOUNT_DRAFT;
    localStorage.setItem(STEP_KEY, "done");
    setOpen(false);
  };
  const index = STEPS.indexOf(step);
  const design = designById(settings.design);
  const following = settings.theme === "system";
  const previewMode = step === "look" && following ? (pickedMode ?? systemMode) : systemMode;
  const theme = resolveTheme(settings, previewMode);
  /** the modes whose colors step 2 offers: both while following the system, else the one chosen */
  const modes: ThemeMode[] = following ? ["light", "dark"] : [settings.theme as ThemeMode];
  const pick = (patch: Partial<AppSettings>) => void updateAppearance(patch);

  const titles: Record<Step, [string, string]> = {
    layout: [t("firstRun.layout.title"), t("firstRun.layout.description")],
    look: [t("firstRun.look.title"), t("firstRun.look.description")],
    account: [t("firstRun.account.title"), t("firstRun.account.description")],
  };

  const body = {
    layout: (
      <RadioGroup aria-label={t("firstRun.layout.label")} value={settings.layout} onValueChange={(layout) => pick({ layout: layout as AppSettings["layout"] })}>
        <Choice testId="first-run-layout-split" value="split" mark={<Columns2 className="size-5 shrink-0" />} title={t("settings.general.layout.split")} body={t("firstRun.layout.split.body")} />
        <Choice testId="first-run-layout-list" value="list" mark={<Rows3 className="size-5 shrink-0" />} title={t("settings.general.layout.list")} body={t("firstRun.layout.list.body")} />
      </RadioGroup>
    ),
    look: (
      // the styles stay put and the palettes scroll (the one in use scrolled into view); a window too short for a row of them scrolls as a whole
      <div className="flex min-h-full flex-col">
        <h3 className="type-section-label mb-1.5 shrink-0 text-muted-foreground">{t("firstRun.look.style")}</h3>
        <RadioGroup aria-label={t("firstRun.look.style")} aria-describedby="first-run-design-description" value={settings.design} onValueChange={(design) => pick({ design: design as AppSettings["design"] })} className="grid shrink-0 grid-cols-3 gap-2">
          {DESIGNS.map((d) => (
            // the chosen one clicked again is a choice too: it cancels a switch still waiting for its faces (Codex code review #2)
            <RadioCard key={d.id} value={d.id} onClick={() => settings.design === d.id && pick({ design: d.id })} data-testid={`first-run-design-${d.id}`} className="flex-col items-center gap-1.5 px-2 pt-2.5 pb-2">
              {/* the style's own type, in its own design */}
              <span data-design={d.id} aria-hidden className="flex h-10 w-14 items-center justify-center rounded-lg bg-background text-xl text-foreground shadow-hairline" style={{ fontFamily: "var(--type-list-title-family)", fontWeight: "var(--type-list-title-weight)", fontStyle: "var(--type-list-title-style)" }}>
                {/* i18n-ignore: aria-hidden typography specimen, identical in every language */}
                Aa
              </span>
              <span className="text-sm font-medium">{designName(d.id)}</span>
            </RadioCard>
          ))}
        </RadioGroup>
        <p id="first-run-design-description" className="mt-2 min-h-8 shrink-0 text-xs text-muted-foreground">
          {designDescription(design.id)}
        </p>
        <div className="mt-4 mb-1 flex shrink-0 items-center justify-between gap-2">
          <h3 className="type-section-label text-muted-foreground">{t("firstRun.look.colors")}</h3>
          {/* the appearance itself (Settings' Mode): System follows the Mac, Light and Dark stay put */}
          <ToggleGroup aria-label={t("firstRun.look.mode")} variant="segmented" value={[settings.theme]} onValueChange={(v: string[]) => v[0] && pick({ theme: v[0] as AppSettings["theme"] })} data-testid="first-run-look-mode">
            <ToggleGroupItem value="system" data-testid="first-run-look-system" className="gap-1.5">
              <Laptop aria-hidden />
              {t("settings.appearance.system")}
            </ToggleGroupItem>
            <ToggleGroupItem value="light" data-testid="first-run-look-light" className="gap-1.5">
              <Sun aria-hidden />
              {t("settings.appearance.light")}
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" data-testid="first-run-look-dark" className="gap-1.5">
              <Moon aria-hidden />
              {t("settings.appearance.dark")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <p className="mb-2 shrink-0 text-xs text-muted-foreground">{t(following ? "firstRun.look.modeHint" : settings.theme === "light" ? "firstRun.look.modeHint.light" : "firstRun.look.modeHint.dark")}</p>
        {/* the cards' edges on the column's line, room around them for the chosen edge and the focus ring */}
        <div className="hairline-t -mx-1.5 min-h-32 flex-1 basis-0 overflow-y-auto px-1.5 pt-2 pb-1" data-testid="first-run-palettes">
          {modes.map((m) => {
            const slot = m === "light" ? "lightTheme" : "darkTheme";
            const chosen = settings[slot] === DESIGN_PALETTE ? DESIGN_PALETTE : resolveTheme(settings, m).id;
            const own = builtinTheme(design.palette[m])!;
            const choose = (id: string) => {
              setPickedMode(m);
              pick({ [slot]: id });
            };
            const label = t(m === "light" ? "settings.appearance.lightTheme" : "settings.appearance.darkTheme");
            return (
              <section key={m} aria-label={label} className="mb-3 last:mb-0">
                {following && <h4 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h4>}
                <RadioGroup aria-label={label} value={chosen} onValueChange={(id) => choose(id as string)} className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-2" data-testid={`first-run-palettes-${m}`}>
                  <ThemeCard theme={own} base={own.id} name={t("settings.appearance.styleColors")} testId={`theme-card-design-${m}`} value={DESIGN_PALETTE} />
                  {themesFor(m).map((p) => (
                    <ThemeCard key={p.id} theme={p} base={p.id} value={p.id} />
                  ))}
                </RadioGroup>
              </section>
            );
          })}
        </div>
      </div>
    ),
    account: (
      <div className="grid gap-4">
        <AddAccountForm draft={draft} onDraft={setDraft} onBusy={setBusy} onDone={done} />
        {OnboardingNudge && (
          <Suspense>
            <OnboardingNudge />
          </Suspense>
        )}
      </div>
    ),
  } satisfies Record<Step, React.ReactNode>;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && done()}>
      <DialogContent
        showCloseButton={false}
        initialFocus={heading}
        data-testid="first-run"
        data-step={step}
        className="h-[min(860px,92vh)] w-[min(1360px,96vw)] max-w-none grid-cols-[380px_minmax(0,1fr)] grid-rows-1 gap-0 overflow-hidden p-0 sm:max-w-none max-[760px]:grid-cols-1"
      >
        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between px-6 pt-6">
            {/* decorative: the title names the step */}
            <TernoMark className="size-6 text-foreground" data-testid="first-run-mark" />
            <div className="flex items-center gap-1" aria-hidden>
              {STEPS.map((s, i) => (
                <span key={s} className={cn("h-1.5 rounded-full transition-[width,background-color] duration-base ease-motion", i === index ? "w-4 bg-foreground" : "w-1.5 bg-muted-foreground/40")} />
              ))}
            </div>
          </div>
          {/* keyed by step: the new one comes in (one --motion-base fade and a 6 px slide from the side it came from); nothing fades out */}
          <div key={step} className={cn("flex min-h-0 flex-1 flex-col animate-in fade-in-0 duration-base ease-motion", forward ? "slide-in-from-right-1.5" : "slide-in-from-left-1.5")}>
            <div className="shrink-0 px-6 pt-5 pb-1">
              <p className="sr-only">{t("firstRun.step", { n: index + 1, total: STEPS.length })}</p>
              {index === 0 && <p className="mb-1 text-sm text-muted-foreground">{t("firstRun.welcome")}</p>}
              <DialogTitle ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
                {titles[step][0]}
              </DialogTitle>
              <DialogDescription className="mt-1.5">{titles[step][1]}</DialogDescription>
            </div>
            <div className={cn("min-h-0 flex-1 px-6 pt-4 pb-5", step === "look" ? "flex flex-col overflow-y-auto" : "overflow-y-auto")}>{body[step]}</div>
          </div>
          <div className="hairline-t flex shrink-0 items-center gap-2 px-6 pt-4 pb-6">
            <Button variant="ghost" className="-ml-2.5 text-muted-foreground" disabled={busy} onClick={done} data-testid="first-run-skip">
              {t("firstRun.skip")}
            </Button>
            <span className="flex-1" />
            {index > 0 && (
              <Button variant="ghost" disabled={busy} onClick={() => go(STEPS[index - 1]!)} data-testid="first-run-back">
                {t("firstRun.back")}
              </Button>
            )}
            {index < STEPS.length - 1 && (
              <Button onClick={() => go(STEPS[index + 1]!)} data-testid="first-run-continue">
                {t("common.continue")}
              </Button>
            )}
          </div>
        </div>
        <div className="relative min-h-0 bg-tint p-6 max-[760px]:hidden">
          {/* each choice comes in the same way the steps do: one --motion-base fade (colors swap in one frame underneath) */}
          <div key={`${settings.layout} ${design.id} ${theme.id} ${previewMode}`} className="size-full animate-in fade-in-0 duration-base ease-motion">
            <FirstRunPreview design={design} theme={theme} base={baseId(theme, settings)} mode={previewMode} layout={settings.layout} density={settings.density} sample={sample} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
