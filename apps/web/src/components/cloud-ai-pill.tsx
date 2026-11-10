import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Cloud } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { choiceLabel, providerLabel, providerName, routeOf } from "~/lib/ai";
import { routedByKeys } from "@terno/core";
import { setApp, useApp } from "~/state/app";

/**
 * While the chosen AI runs off this machine (a cloud service, or a server elsewhere): which one, since what you ask
 * it about goes there. Nothing otherwise (plan 97: there's no "local" to announce, Terno keeps mail here anyway).
 */
export function CloudAiPill() {
  const ai = useApp((s) => s.settings?.ai);
  if (!ai || ai.provider === "none" || ai.local) return null;
  // plan 168: on keys, where drafting goes now, which needn't be the one stored; either, before a key is saved
  const routed = routedByKeys(ai.provider) ? routeOf("writing", ai).provider : null;
  const label = t("sidebar.cloudAi", { provider: routed === null ? providerName(ai) : routed === "none" ? choiceLabel("keys") : providerLabel(routed) });
  const tip = t("sidebar.cloudTip");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="cloud-ai-pill"
            aria-label={t("sidebar.pillLabel", { label, tip })}
            onClick={() => setApp({ dialog: "settings", settingsTab: "ai" })}
            className="flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-full border border-sidebar-border px-2 text-2xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Cloud className="size-3" />
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
