import type { PendingReport } from "@terno/core/diag";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Announcement } from "@terno/ui/components/announcement";
import { LifeBuoy } from "@terno/ui/icons";
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
 * "ask". What it offers follows the policy (plan 78: local mode too): ask to
 * send, say it was sent, offer Send again for one that couldn't go, or (no
 * DSN, "never") keep it here with an export.
 */
export function ReportRow() {
  const view = useDiag((s) => s.view);
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const policy = view.reporting.offer;
  // crashes always say so; an ordinary error only asks (it was logged either way), or offers Send again when it couldn't go
  const shown = view.pending.filter((p) => p.fatal || p.kind !== "error" || policy === "ask" || (p.failed && policy !== "local"));
  if (!shown.length) return null;
  // "sent" only when it really went: one that couldn't go offers Send again
  const offer = policy === "sent" && !shown.every((p) => p.sent) ? "retry" : policy;
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
    <Announcement
      data-testid="report-row"
      data-offer={offer}
      role="status"
      icon={<LifeBuoy />}
      title={title}
      titleProps={{ "data-testid": "report-row-title" }}
      description={t(offer === "ask" ? "diag.row.ask" : offer === "sent" ? "diag.row.sent" : offer === "retry" ? "diag.row.notSent" : "diag.row.local")}
      onClose={dismiss}
      closeLabel={t("common.dismiss")}
      closeProps={{ "data-testid": "report-close" }}
      actions={
        <>
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
          {offer === "retry" && (
            <>
              <Button size="xs" variant="outline" disabled={busy} data-testid="report-send" onClick={() => void send()}>
                {t("common.send")}
              </Button>
              <Button size="xs" variant="ghost" data-testid="report-preview" onClick={() => void openPreview(first.id)}>
                {t("diag.whatGetsSent")}
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
        </>
      }
    />
  );
}
