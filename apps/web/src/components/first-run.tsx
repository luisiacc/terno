import type { AiProviderId } from "@unica/core";
import { Button } from "@unica/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@unica/ui/components/dialog";
import { cn } from "@unica/ui/lib/utils";
import { Cloud, LaptopMinimalCheck } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { reconcileSettings } from "~/lib/appearance";
import { OnboardingNudge } from "~/lib/web-parts";

const STEP_KEY = "unica:first-run";

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

/** Fresh install, no accounts: choose Local or Connected, then add the first mailbox (the Única account). */
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
      toast.error(error instanceof Error ? error.message : String(error));
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
            <DialogTitle>Bienvenido a Única</DialogTitle>
            <DialogDescription>Paso 1 de 2 · ¿Cómo quieres usarla? Puedes cambiarlo cuando quieras en Ajustes.</DialogDescription>
            {OnboardingNudge && (
              <Suspense>
                <OnboardingNudge />
              </Suspense>
            )}
            <div className="space-y-2" role="radiogroup" aria-label="Modo">
              {card(
                "local",
                <LaptopMinimalCheck className="size-5" />,
                "Local (recomendado)",
                <>
                  {import.meta.env.VITE_TARGET === "web"
                    ? "Única solo se conecta con Google (tu correo) y con IA de este equipo."
                    : "Nada sale de este Mac salvo el correo con tus servidores. La IA usa modelos de este Mac."}
                  {found && (
                    <span className="mt-1 block text-foreground" data-testid="first-run-found">
                      Encontramos {found.label} con {found.model}
                    </span>
                  )}
                </>,
              )}
              {card("connected", <Cloud className="size-5" />, "Conectado", "Además podrás usar IA en la nube (Claude, OpenAI…) con tu propia API key y cargar imágenes remotas cuando lo pidas.")}
            </div>
            <div className="flex justify-end">
              <Button data-testid="first-run-next" onClick={() => void confirmMode()}>
                Continuar
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle>Añade tu primera cuenta</DialogTitle>
            <DialogDescription>Paso 2 de 2</DialogDescription>
            <p className="rounded-lg border border-primary/25 bg-accent/50 px-3 py-2 text-sm text-accent-foreground">
              El primer correo que conectes será tu cuenta Única: con él iniciarás sesión y te facturaremos.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => go("done")}>
                Ahora no
              </Button>
              <Button
                data-testid="first-run-add-account"
                onClick={() => {
                  go("done");
                  setApp({ dialog: "addAccount" });
                }}
              >
                Añadir cuenta
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
