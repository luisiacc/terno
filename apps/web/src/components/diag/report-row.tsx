import type { PendingReport } from "@terno/core/diag";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { LifeBuoy, X } from "lucide-react";
import { useState } from "react";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { decideReports, exportDiagnostics, openPreview, useDiag } from "~/state/diag";
import { reconcileSettings } from "~/lib/appearance";

const TITLE = {
  unclean_exit: "diag.row.uncleanExit",
  crash: "diag.row.crash",
  renderer_gone: "diag.row.rendererGone",
  backend_exit: "diag.row.backendExit",
  child_gone: "diag.row.problem",
  error: "diag.row.problem",
} as const satisfies Record<PendingReport["kind"], string>;

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
  const title = many ? t("diag.row.problems", { count: shown.length }) : t(TITLE[first.kind]);
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
    <div data-testid="report-row" data-offer={offer} role="status" className="mx-3 mt-1 mb-1 flex items-start gap-2.5 rounded-[calc(var(--radius-lg)+2px)] bg-tint p-2.5 text-xs">
      <LifeBuoy className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground" data-testid="report-row-title">
          {title}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {t(offer === "ask" ? "diag.row.ask" : offer === "sent" ? "diag.row.sent" : "diag.row.local")}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {offer === "ask" && (
            <>
              <Button size="xs" variant="outline" disabled={busy} data-testid="report-send" onClick={() => void send()}>
                {t("common.send")}
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} data-testid="report-always" onClick={() => void always()}>
                {t("common.always")}
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
                {t("diag.whatGetsSent")}
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-later" onClick={dismiss}>
                {t("diag.row.notNow")}
              </Button>
            </>
          )}
          {offer === "sent" && (
            <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
              {t("diag.whatWasSent")}
            </Button>
          )}
          {offer === "local" && (
            <>
              <Button size="xs" variant="outline" data-testid="report-export" onClick={() => void exportDiagnostics()}>
                {t("diag.exportButton")}
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
                {t("diag.row.details")}
              </Button>
            </>
          )}
        </div>
      </div>
      <button type="button" aria-label={t("common.dismiss")} data-testid="report-close" className="text-muted-foreground hover:text-foreground" onClick={dismiss}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
