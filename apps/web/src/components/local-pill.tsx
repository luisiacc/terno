import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Cloud, LaptopMinimalCheck } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { providerName } from "~/lib/ai";
import { setApp, useApp } from "~/state/app";

/**
 * Says where data goes: "Local" (Terno keeps its copy of your mail here, plan 97), or, while a cloud AI is
 * chosen, that one: what you ask it about leaves this Mac for it.
 */
export function LocalPill() {
  const ai = useApp((s) => s.settings?.ai);
  const cloudAi = ai && ai.provider !== "none" && !ai.local ? ai : null;
  const label = cloudAi ? t("sidebar.cloudAi", { provider: providerName(cloudAi) }) : t("sidebar.local");
  const tip = cloudAi ? t("sidebar.cloudTip") : import.meta.env.VITE_TARGET === "web" ? t("sidebar.localTip.web") : t("sidebar.localTip.desktop");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="local-pill"
            data-local={!cloudAi || undefined}
            aria-label={t("sidebar.pillLabel", { label, tip })}
            onClick={() => setApp({ dialog: "settings", settingsTab: cloudAi ? "ai" : "general" })}
            className="flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-full border border-sidebar-border px-2 text-2xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground data-local:border-sidebar-primary/30 data-local:text-sidebar-primary-ink"
          >
            {cloudAi ? <Cloud className="size-3" /> : <LaptopMinimalCheck className="size-3" />}
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
