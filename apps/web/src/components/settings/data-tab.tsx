import { Button } from "@terno/ui/components/button";
import { Download, Upload } from "lucide-react";
import { t } from "@terno/i18n";
import { useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { downloadExport, importFile, importSummary } from "~/lib/backup";
import { SettingsGroup, SettingsRow } from "./parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ajustes → Datos: a copy of what can't be re-synced, and bringing one back (where the mailbox lives: Storage). */
export function DataTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div data-testid="data-tab">
      <SettingsGroup title={t("settings.data.backup")} footer={t("settings.data.backup.footer")}>
        <SettingsRow label={t("settings.data.export")} hint={t("settings.data.export.hint")}>
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
        <SettingsRow label={t("settings.data.import")} hint={t("settings.data.import.hint")} error={error} errorTestId="data-import-error">
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
    </div>
  );
}
