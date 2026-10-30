import type { AppSettings } from "@terno/core/rpc";
import { t } from "@terno/i18n";
import { Button } from "@terno/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@terno/ui/components/select";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { BUILD, DESKTOP_DIAG } from "~/lib/diag";
import { exportDiagnostics, openPreview, refreshDiag, showLogs, useDiag } from "~/state/diag";
import { SettingsGroup, SettingsRow, type SettingsUpdate } from "./parts";

const REPORTS = [
  { value: "ask", label: "common.ask" },
  { value: "always", label: "common.always" },
  { value: "never", label: "common.never" },
] as const;

const CHANNEL = { production: null, dev: "diag.channel.dev", test: "diag.channel.test", demo: "diag.channel.demo" } as const;

function reportsHint(settings: AppSettings, dsn: boolean): string {
  if (!dsn) return t("diag.settings.hint.noDsn");
  if (settings.errorReports === "always") return t("diag.settings.hint.always");
  if (settings.errorReports === "never") return t("diag.settings.hint.never");
  return t("diag.settings.hint.ask");
}

/** The build line: version, commit and channel, the way support asks for it. */
function BuildLine() {
  const [copied, setCopied] = useState(false);
  const key = CHANNEL[BUILD.channel];
  const channel = key ? t(key) : "";
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
        aria-label={t("diag.settings.copyVersion")}
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
  // plan 78: local mode doesn't decide reports; the user's choice here does
  const locked = !dsn;
  return (
    <SettingsGroup title={t("diag.settings.title")} testId="diagnostics-section" footer={<BuildLine />}>
      <SettingsRow label={t("diag.settings.reports")} hint={reportsHint(settings, dsn)} testId="error-reports-row">
        {({ id: _id, ...a }) => (
          <Select value={locked ? "never" : settings.errorReports} disabled={locked} onValueChange={(v) => void update({ errorReports: v as AppSettings["errorReports"] })} items={REPORTS.map((r) => ({ value: r.value, label: t(r.label) }))}>
            <SelectTrigger {...a} size="sm" className="w-32" data-testid="error-reports-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORTS.map((r) => (
                <SelectItem key={r.value} value={r.value} data-testid={`error-reports-${r.value}`}>
                  {t(r.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      <SettingsRow label={t("diag.settings.contains")} hint={t("diag.settings.containsHint")}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <Button {...a} variant="outline" size="sm" data-testid="report-sample" onClick={() => void openPreview("sample")}>
            {t("diag.settings.viewExample")}
          </Button>
        )}
      </SettingsRow>
      <SettingsRow label={t("diag.settings.logs")} hint={t("diag.settings.logsHint")}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <>
            {DESKTOP_DIAG && (
              <Button variant="ghost" size="sm" data-testid="show-logs" onClick={showLogs}>
                {t("common.show")}
              </Button>
            )}
            <Button {...a} variant="outline" size="sm" data-testid="export-diagnostics" onClick={() => void exportDiagnostics()}>
              {t("diag.export.button")}
            </Button>
          </>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
