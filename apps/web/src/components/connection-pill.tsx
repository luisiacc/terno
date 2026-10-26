import type { Account } from "@terno/core";
import { localeTag, t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { cn } from "@terno/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@terno/ui/components/tooltip";
import { Loader2, RotateCw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "~/rpc/connection";
import { useApp } from "~/state/app";

/** "25 sec", "3 min" in the user's language (Spanish: "25 s", "3 min") */
export function retryIn(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  // 62 s is "1 min", not "2 min"
  const [n, unit] = seconds < 60 ? [seconds, "second"] : [Math.round(seconds / 60), "minute"];
  return new Intl.NumberFormat(localeTag(), { style: "unit", unit, unitDisplay: "short" }).format(n);
}

/** Date.now(), once a second while `active` and the page is visible (nothing ticks otherwise) */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (timer) clearInterval(timer);
      timer = null;
      setNow(Date.now());
      if (document.visibilityState === "visible") timer = setInterval(() => setNow(Date.now()), 1000);
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [active]);
  return now;
}

/**
 * Plan 20: the sidebar says so, calmly, while an account can't reach its server (after a second
 * failure in a row, or at once when the device is offline): "Work is offline", "Retrying in 25 sec"
 * and a retry button; "Reconnecting…" while a retry runs. Nothing at all otherwise. It stays mounted
 * from offline through reconnecting, so the button keeps its focus.
 */
export function ConnectionPill() {
  const accounts = useApp((s) => s.accounts);
  const down = accounts.filter((a) => a.syncState.connection);
  if (!down.length) return null;
  return <Pill down={down} total={accounts.length} />;
}

function Pill({ down, total }: { down: Account[]; total: number }) {
  const retryAt = Math.min(...down.map((a) => (a.syncState.connection?.state === "offline" ? (a.syncState.connection.retryAt ?? Infinity) : Infinity)));
  const reconnectingNow = down.some((a) => a.syncState.connection?.state === "reconnecting");
  const now = useNow(Number.isFinite(retryAt) && !reconnectingNow);
  // the retry's time came and its pass hasn't said so yet: it's reconnecting
  const reconnecting = reconnectingNow || (Number.isFinite(retryAt) && retryAt <= now);
  // one account of several is that account's server, not the device
  const one = down.length === 1 && total > 1 ? down[0]!.displayName : null;
  const title = reconnecting ? t("connection.reconnecting") : one ? t("connection.accountOffline", { name: one }) : t("connection.offline");
  const when = !reconnecting && Number.isFinite(retryAt) ? t("connection.retryingIn", { time: retryIn(retryAt - now) }) : null;
  return (
    <div className="flex shrink-0 px-2 pt-1" data-testid="connection-pill" data-state={reconnecting ? "reconnecting" : "offline"}>
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-sidebar-border py-1 pr-1 pl-2.5 text-xs">
        {reconnecting ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden /> : <WifiOff className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0 flex-1 leading-tight">
          {/* a screen reader hears the state when it changes, never the countdown */}
          <p role="status" className="truncate font-medium text-sidebar-foreground" data-testid="connection-label">
            {title}
          </p>
          {when && (
            <p aria-hidden className="truncate text-muted-foreground" data-testid="connection-when">
              {when}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", reconnecting ? "text-muted-foreground" : "text-sidebar-foreground")}
                aria-label={t("connection.retryNow")}
                aria-disabled={reconnecting}
                data-testid="connection-retry"
                onClick={() => {
                  if (!reconnecting) void client.call("sync.now", {}).catch(() => {});
                }}
              />
            }
          >
            <RotateCw />
          </TooltipTrigger>
          <TooltipContent>{t("connection.retryNow")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
