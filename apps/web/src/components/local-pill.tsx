import { Tooltip, TooltipContent, TooltipTrigger } from "@unica/ui/components/tooltip";
import { Cloud, LaptopMinimalCheck } from "lucide-react";
import { providerName } from "~/lib/ai";
import { setApp, useApp } from "~/state/app";

/** Says where data may go: "Local" while local mode is on, or which cloud AI is active when it is off. */
export function LocalPill() {
  const localMode = useApp((s) => s.settings?.localMode ?? false);
  const ai = useApp((s) => s.settings?.ai);
  const cloudAi = !localMode && ai && ai.provider !== "none" && !ai.local ? ai : null;
  if (!localMode && !cloudAi) return null;
  const label = localMode ? "Local" : `IA: ${providerName(cloudAi!)} (nube)`;
  const tip = localMode ? "Nada sale de este Mac salvo el correo con tus servidores" : "La IA usa un servicio en la nube. Ajustes → General para activar el modo local.";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="local-pill"
            data-local={localMode || undefined}
            aria-label={`${label}. ${tip}`}
            onClick={() => setApp({ dialog: "settings", settingsTab: "general" })}
            className="flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-full border border-sidebar-border px-2 text-2xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground data-local:border-sidebar-primary/30 data-local:text-sidebar-primary"
          >
            {localMode ? <LaptopMinimalCheck className="size-3" /> : <Cloud className="size-3" />}
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
