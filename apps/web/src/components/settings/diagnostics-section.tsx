import type { AppSettings } from "@terno/core/rpc";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { BUILD, DESKTOP_DIAG, WEB } from "~/lib/diag";
import { exportDiagnostics, openPreview, refreshDiag, showLogs, useDiag } from "~/state/diag";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const REPORTS = [
  { value: "ask", label: "Ask" },
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
] as const;

const CHANNEL = { production: "", dev: "development", test: "test", demo: "demo" } as const;
const HERE = WEB ? "this browser" : "this Mac";

function reportsHint(settings: AppSettings, dsn: boolean): string {
  if (settings.localMode) return `Local mode sends nothing outside ${HERE}: errors are kept here, and you can export them.`;
  if (!dsn) return "This build of Terno doesn't send reports: errors are kept on this computer, and you can export them.";
  if (settings.errorReports === "always") return "Sent automatically and anonymously: the kind of error and where it happened, never your mail.";
  if (settings.errorReports === "never") return "Never sent. Errors are kept on this computer.";
  return "Terno asks before sending each one. Reports are anonymous and never include your mail.";
}

/** The build line: version, commit and channel, the way support asks for it. */
function BuildLine() {
  const [copied, setCopied] = useState(false);
  const channel = CHANNEL[BUILD.channel];
  const text = `Terno ${BUILD.version} (${BUILD.sha}${channel ? `, ${channel}` : ""})`;
  return (
    <span className="flex items-center gap-1.5" data-testid="build-line">
      <span className="tabular-nums select-text">
        Terno {BUILD.version} · {BUILD.sha}
        {channel && ` · ${channel}`}
      </span>
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Copy version"
        data-testid="build-copy"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

/** Settings → General → Diagnostics: whether reports may go, what one holds, and the logs. */
export function DiagnosticsSection({ settings, update }: { settings: AppSettings; update: SettingsUpdate }) {
  const dsn = useDiag((s) => s.view?.reporting.dsn ?? false);
  useEffect(() => void refreshDiag(), []);
  const locked = settings.localMode || !dsn;
  return (
    <SettingsGroup title="Diagnostics" testId="diagnostics-section" footer={<BuildLine />}>
      <SettingsRow label="Error reports" hint={reportsHint(settings, dsn)} testId="error-reports-row">
        {({ id: _id, ...a }) => (
          <Select value={locked ? "never" : settings.errorReports} disabled={locked} onValueChange={(v) => void update({ errorReports: v as AppSettings["errorReports"] })} items={REPORTS.map((r) => ({ ...r }))}>
            <SelectTrigger {...a} size="sm" className="w-32" data-testid="error-reports-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORTS.map((r) => (
                <SelectItem key={r.value} value={r.value} data-testid={`error-reports-${r.value}`}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      <SettingsRow label="What a report contains" hint="The kind of error, where it happened in Terno's code and your last actions, as codes.">
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <Button {...a} variant="outline" size="sm" data-testid="report-sample" onClick={() => void openPreview("sample")}>
            View Example
          </Button>
        )}
      </SettingsRow>
      <SettingsRow label="Logs" hint="To look into a problem or send it to support. Scrubbed: none of your mail and none of your keys.">
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <>
            {DESKTOP_DIAG && (
              <Button variant="ghost" size="sm" data-testid="show-logs" onClick={showLogs}>
                Show
              </Button>
            )}
            <Button {...a} variant="outline" size="sm" data-testid="export-diagnostics" onClick={() => void exportDiagnostics()}>
              Export…
            </Button>
          </>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
