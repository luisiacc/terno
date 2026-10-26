import type { AiProviderId } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@terno/ui/components/dialog";
import { cn } from "@terno/ui/lib/utils";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { Cloud, LaptopMinimalCheck } from "lucide-react";
import { t } from "@terno/i18n";
import { Suspense, useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { reconcileSettings } from "~/lib/appearance";
import { OnboardingNudge } from "~/lib/web-parts";

const STEP_KEY = "terno:first-run";

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

/** Fresh install, no accounts: choose Local or Connected, then add the first mailbox (the Terno account). */
export function FirstRun() {
  const [step, setStep] = useState<"mode" | "account" | null>(() => (localStorage.getItem(STEP_KEY) === "account" ? "account" : "mode"));
  const [choice, setChoice] = useState<"local" | "connected">("local");
  const [found, setFound] = useState<Found | null>(null);

  useEffect(() => {
    void findLocalModel().then(setFound);
  }, []);

  const go = (next: "account" | "done") => {
    localStorage.setItem(STEP_KEY, next);
    setStep(next === "done" ? null : next);
  };

  const confirmMode = async () => {
    try {
      const settings = await client.call("settings.update", choice === "local" ? { localMode: true, ...(found ? { ai: { provider: found.provider, model: found.model } } : {}) } : { localMode: false });
      setApp({ settings: reconcileSettings(settings) });
      go("account");
    } catch (error) {
      snack.error(error instanceof Error ? error.message : String(error));
    }
  };

  const card = (value: "local" | "connected", icon: React.ReactNode, title: string, body: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={choice === value}
      data-testid={`first-run-${value}`}
      onClick={() => setChoice(value)}
      className={cn("flex w-full gap-3 rounded-xl border p-4 text-left transition-colors", choice === value ? "border-primary bg-accent/60" : "border-border hover:bg-muted/60")}
    >
      <span className="mt-0.5 text-primary">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{body}</span>
      </span>
    </button>
  );

  return (
    <Dialog open={step !== null} onOpenChange={(o) => !o && go("done")}>
      <DialogContent className="sm:max-w-lg" data-testid="first-run">
        {step === "mode" ? (
          <>
            {/* the first thing a new user sees: the mark, quietly, above the welcome (decorative: the title names Terno) */}
            <TernoMark className="size-7 text-foreground" data-testid="first-run-mark" />
            <DialogTitle>{t("firstRun.welcome")}</DialogTitle>
            <DialogDescription>{t("firstRun.step1")}</DialogDescription>
            {OnboardingNudge && (
              <Suspense>
                <OnboardingNudge />
              </Suspense>
            )}
            <div className="space-y-2" role="radiogroup" aria-label={t("firstRun.mode")}>
              {card(
                "local",
                <LaptopMinimalCheck className="size-5" />,
                t("firstRun.local"),
                <>
                  {import.meta.env.VITE_TARGET === "web" ? t("firstRun.local.web") : t("firstRun.local.desktop")}
                  {found && (
                    <span className="mt-1 block text-foreground" data-testid="first-run-found">
                      {t("firstRun.found", { app: found.label, model: found.model })}
                    </span>
                  )}
                </>,
              )}
              {card("connected", <Cloud className="size-5" />, t("firstRun.connected"), t("firstRun.connected.body"))}
            </div>
            <div className="flex justify-end">
              <Button data-testid="first-run-next" onClick={() => void confirmMode()}>
                {t("common.continue")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>{t("firstRun.addAccount")}</DialogTitle>
            <DialogDescription>{t("firstRun.step2")}</DialogDescription>
            <p className="rounded-lg border border-primary/25 bg-accent/50 px-3 py-2 text-sm text-accent-foreground">
              {t("account.ownerFirst")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => go("done")}>
                {t("firstRun.notNow")}
              </Button>
              <Button
                data-testid="first-run-add-account"
                onClick={() => {
                  go("done");
                  setApp({ dialog: "addAccount" });
                }}
              >
                {t("account.addTitle")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
