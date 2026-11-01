import type { AiProviderId } from "@terno/core";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@terno/ui/components/dialog";
import { TernoMark } from "@terno/ui/brand/terno-mark";
import { t } from "@terno/i18n";
import { Suspense, useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
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

/** Fresh install, no accounts: a welcome that adds the first mailbox. Local mode is the default; Settings changes it. */
export function FirstRun() {
  const [open, setOpen] = useState(true);

  // a model already running on this Mac becomes the AI, as local mode expects (no key, nothing leaves the machine)
  useEffect(() => {
    void findLocalModel().then(async (found) => {
      if (!found || getApp().settings?.localMode === false) return;
      try {
        const settings = await client.call("settings.update", { ai: { provider: found.provider, model: found.model } });
        setApp({ settings: reconcileSettings(settings) });
      } catch (error) {
        snack.error(error instanceof Error ? error.message : String(error));
      }
    });
  }, []);

  const done = () => {
    localStorage.setItem(STEP_KEY, "done");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && done()}>
      {/* a centred welcome, Apple-style: the mark, one line, one clear action ("Not now" and Esc close it) */}
      <DialogContent className="justify-items-center gap-0 px-6 pt-8 pb-6 text-center sm:max-w-sm" showCloseButton={false} data-testid="first-run">
        {/* decorative: the title names Terno */}
        <TernoMark className="size-10 text-foreground" data-testid="first-run-mark" />
        <DialogTitle className="mt-4 text-lg font-semibold tracking-tight">{t("firstRun.welcome")}</DialogTitle>
        <DialogDescription className="mt-1.5">{t("firstRun.addAccount")}</DialogDescription>
        {OnboardingNudge && (
          <div className="mt-5 w-full text-left">
            <Suspense>
              <OnboardingNudge />
            </Suspense>
          </div>
        )}
        <div className="mt-6 grid w-full gap-1.5">
          <Button
            size="lg"
            data-testid="first-run-add-account"
            onClick={() => {
              done();
              setApp({ dialog: "addAccount" });
            }}
          >
            {t("account.addTitle")}
          </Button>
          <Button variant="ghost" size="lg" className="text-muted-foreground" onClick={done}>
            {t("firstRun.notNow")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
