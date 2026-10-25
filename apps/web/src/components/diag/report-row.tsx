import type { PendingReport } from "@terno/core/diag";
import { Button } from "@terno/ui/components/button";
import { LifeBuoy, X } from "lucide-react";
import { useState } from "react";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { decideReports, exportDiagnostics, openPreview, useDiag } from "~/state/diag";
import { reconcileSettings } from "~/lib/appearance";

const TITLE: Record<PendingReport["kind"], string> = {
  unclean_exit: "Terno quit unexpectedly",
  crash: "Terno quit because of an error",
  renderer_gone: "Terno's window closed because of an error",
  backend_exit: "The mail engine restarted after an error",
  child_gone: "Terno ran into a problem",
  error: "Terno ran into a problem",
};

/**
 * The one quiet place a problem shows up: after a crash or an unclean exit
 * (on the next start), or in place for an unexpected error when reports are
 * "ask". What it offers follows the policy: ask to send, say it was sent, or
 * (local mode, no DSN, "never") keep it here with an export.
 */
export function ReportRow() {
  const view = useDiag((s) => s.view);
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const policy = view.reporting.offer;
  // crashes always say so; an ordinary error only asks (it was logged either way)
  const shown = view.pending.filter((p) => p.fatal || p.kind !== "error" || policy === "ask");
  if (!shown.length) return null;
  // "sent" only when it really went (a send that failed is still here, for export)
  const offer = policy === "sent" && !shown.every((p) => p.sent) ? "local" : policy;
  const first = shown[0]!;
  const ids = shown.map((p) => p.id);
  const many = shown.length > 1;
  const title = many ? `Terno ran into ${shown.length} problems` : TITLE[first.kind];
  const dismiss = () => void decideReports(ids, "dismiss");
  const send = async () => {
    setBusy(true);
    await decideReports(ids, "send").finally(() => setBusy(false));
  };
  const always = async () => {
    setBusy(true);
    try {
      setApp({ settings: reconcileSettings(await client.call("settings.update", { errorReports: "always" })) });
      await decideReports(ids, "send");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="report-row" data-offer={offer} role="status" className="mx-3 mt-1 mb-1 flex items-start gap-2.5 rounded-[10px] bg-tint p-2.5 text-xs">
      <LifeBuoy className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground" data-testid="report-row-title">
          {title}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {offer === "ask" ? "Send an anonymous report? It never includes your mail." : offer === "sent" ? "An anonymous report was sent, without any of your mail." : "The details were saved on this computer. You can export them for support."}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {offer === "ask" && (
            <>
              <Button size="xs" variant="outline" disabled={busy} data-testid="report-send" onClick={() => void send()}>
                Send
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} data-testid="report-always" onClick={() => void always()}>
                Always
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
                What gets sent
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-later" onClick={dismiss}>
                Not now
              </Button>
            </>
          )}
          {offer === "sent" && (
            <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
              What was sent
            </Button>
          )}
          {offer === "local" && (
            <>
              <Button size="xs" variant="outline" data-testid="report-export" onClick={() => void exportDiagnostics()}>
                Export Diagnostics…
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
                Details
              </Button>
            </>
          )}
        </div>
      </div>
      <button type="button" aria-label="Dismiss" data-testid="report-close" className="text-muted-foreground hover:text-foreground" onClick={dismiss}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
