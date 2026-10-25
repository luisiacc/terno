import { Button } from "@terno/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@terno/ui/components/dialog";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { closePreview, decideReports, resetInstallId, useDiag } from "~/state/diag";

/**
 * "Ver qué se envía": the report exactly as it would leave (the same object
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
  const title = sample ? "What an error report looks like" : pending?.sent ? "What was sent" : goes ? "What gets sent" : "Report details";
  const lead = sample
    ? "An example, built exactly like real ones."
    : pending?.sent
      ? "The exact report that was sent."
      : goes
        ? "The exact report, as it would leave."
        : view?.reporting.localMode
          ? "Nothing leaves this computer in local mode; this is what a report would contain."
          : !preview.host
            ? "This build of Terno doesn't send reports; this is what one would contain."
            : "Reports are off; this is what one would contain.";
  return (
    <Dialog open onOpenChange={(o) => !o && closePreview()}>
      <DialogContent className="max-h-[min(720px,90vh)] grid-rows-[auto_minmax(0,1fr)_auto_auto] sm:max-w-[640px]" data-testid="report-preview-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {lead} It only carries the kind of error, where it happened in Terno's code and your last actions as codes: never your mail, addresses, subjects, file names or keys.
            {goes ? ` Destination: ${preview.host}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <pre
          className="min-h-0 overflow-auto rounded-[10px] bg-tint px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground select-text"
          data-testid="report-preview-json"
          tabIndex={0}
          aria-label="Report as JSON"
        >
          {json}
        </pre>
        <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <p className="min-w-0">
            Install ID <span className="font-mono text-foreground">{preview.event.user.id.slice(0, 8)}…</span> · random, never tied to your email.
          </p>
          <Button size="xs" variant="ghost" className="shrink-0" data-testid="report-reset-install" onClick={() => void resetInstallId()}>
            Reset
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
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
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
              Send
            </Button>
          )}
          <Button data-testid="report-preview-close" onClick={closePreview}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
