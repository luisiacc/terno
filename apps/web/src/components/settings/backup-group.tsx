import { Button } from "@terno/ui/components/button";
import { Download, Upload } from "@terno/ui/icons";
import { t } from "@terno/i18n";
import { useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { downloadExport, importFile, importSummary } from "~/lib/backup";
import { SettingsGroup, SettingsRow } from "./parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Storage → Backup: a copy of what can't be downloaded again, and bringing one back (plan 294: Data's section joined Storage). */
export function BackupGroup() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsGroup title={t("settings.data.backup")} footer={t("settings.data.backup.footer")} testId="storage-backup">
      <SettingsRow find="storage.export" label={t("settings.data.export")} hint={t("settings.data.export.hint")}>
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <Button
            {...a}
            variant="outline"
            size="sm"
            disabled={busy !== null}
            data-testid="data-export"
            onClick={async () => {
              setBusy("export");
              try {
                await downloadExport();
              } catch (e) {
                snack.error(errorText(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            <Download /> {t("settings.data.export")}
          </Button>
        )}
      </SettingsRow>
      <SettingsRow find="storage.import" label={t("settings.data.import")} hint={t("settings.data.import.hint")} error={error} errorTestId="data-import-error">
        {({ id: _id, "aria-labelledby": _l, ...a }) => (
          <>
            <Button {...a} variant="outline" size="sm" disabled={busy !== null} data-testid="data-import" onClick={() => fileRef.current?.click()}>
              <Upload /> {t("settings.data.import.button")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              tabIndex={-1}
              aria-hidden
              data-testid="data-import-input"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBusy("import");
                setError(null);
                try {
                  snack.success(importSummary(await importFile(file)));
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(null);
                }
              }}
            />
          </>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
