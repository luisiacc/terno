import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { richT } from "~/lib/i18n";
import { closePreview, decideReports, resetInstallId, useDiag } from "~/state/diag";

/**
 * "What gets sent": the report exactly as it would leave (the same object
 * the transport sends), where it would go, and the install id it carries
 * (random, resettable here).
 */
export function ReportPreview() {
  const preview = useDiag((s) => s.preview);
  const view = useDiag((s) => s.view);
  const [copied, setCopied] = useState(false);
  if (!preview) return null;
  const json = JSON.stringify(preview.event, null, 2);
  const pending = view?.pending.find((p) => p.id === preview.target);
  const canSend = pending && !pending.sent && view?.reporting.offer === "ask";
  const sample = preview.target === "sample";
  // only call it "sent" when it can be: local mode, "never" or a build without a DSN keep everything here
  const goes = Boolean(preview.host) && view?.reporting.offer !== "local";
  const title = t(sample ? "diag.preview.sampleTitle" : pending?.sent ? "diag.whatWasSent" : goes ? "diag.whatGetsSent" : "diag.preview.detailsTitle");
  const lead = t(
    sample
      ? "diag.preview.sample"
      : pending?.sent
        ? "diag.preview.sent"
        : goes
          ? "diag.preview.goes"
          : view?.reporting.localMode
            ? "diag.preview.localMode"
            : !preview.host
              ? "diag.preview.noDsn"
              : "diag.preview.off",
  );
  return (
    <Dialog open onOpenChange={(o) => !o && closePreview()}>
      <DialogContent className="max-h-[min(720px,90vh)] grid-rows-[auto_minmax(0,1fr)_auto_auto] sm:max-w-[640px]" data-testid="report-preview-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {lead} {t("diag.preview.carries")}
            {goes && preview.host ? ` ${t("diag.preview.destination", { host: preview.host })}` : ""}
          </DialogDescription>
        </DialogHeader>
        <pre
          className="min-h-0 overflow-auto rounded-[10px] bg-tint px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground select-text"
          data-testid="report-preview-json"
          tabIndex={0}
          aria-label={t("diag.preview.json")}
        >
          {json}
        </pre>
        <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <p className="min-w-0">
            {richT("diag.preview.installId", { id: preview.event.user.id.slice(0, 8), code: (id) => <span className="font-mono text-foreground">{id}</span> })}
          </p>
          <Button size="xs" variant="ghost" className="shrink-0" data-testid="report-reset-install" onClick={() => void resetInstallId()}>
            {t("common.reset")}
          </Button>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="report-copy"
            onClick={() => {
              void navigator.clipboard.writeText(json).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check /> : <Copy />} {t(copied ? "common.copied" : "common.copy")}
          </Button>
          {canSend && (
            <Button
              variant="outline"
              data-testid="report-preview-send"
              onClick={() => {
                closePreview();
                void decideReports([preview.target], "send");
              }}
            >
              {t("common.send")}
            </Button>
          )}
          <Button data-testid="report-preview-close" onClick={closePreview}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
