import { Button } from "@terno/ui/components/button";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { snack } from "~/lib/snack";
import { useApp } from "~/state/app";
import { connectGmailWeb, preloadGoogle } from "./google";

/**
 * In the browser a Gmail account's access lasts an hour and isn't stored
 * (no refresh token without a server): after a reload or an hour, sync and
 * queued actions wait here for one click.
 */
export function GmailReconnect() {
  const accounts = useApp((s) => s.accounts);
  const waiting = accounts.filter((a) => a.kind === "gmail" && (a.syncState.status === "offline" || a.syncState.status === "error"));
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    if (waiting.length) void preloadGoogle().catch(() => {});
  }, [waiting.length]);
  if (!waiting.length) return null;
  return (
    <div data-testid="gmail-reconnect" className="mx-3 mt-2 space-y-1.5 rounded-lg border border-primary/25 bg-accent/50 p-2.5 text-xs">
      {waiting.map((a) => (
        <div key={a.id} className="flex items-center gap-2">
          <RefreshCw className="size-3.5 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 truncate text-accent-foreground">
            <span className="font-medium">{a.email}</span> espera que vuelvas a conectar Gmail
          </p>
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(a.id);
              try {
                await connectGmailWeb(a.email);
              } catch (error) {
                snack.error(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === a.id && <Loader2 className="animate-spin" />} Reconectar Gmail
          </Button>
        </div>
      ))}
    </div>
  );
}
