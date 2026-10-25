import { Button } from "@terno/ui/components/button";
import { Download, Upload } from "lucide-react";
import { Suspense, useRef, useState } from "react";
import { snack } from "~/lib/snack";
import { downloadExport, importFile, importSummary } from "~/lib/backup";
import { StorageSection } from "~/lib/web-parts";
import { SettingsGroup, SettingsRow } from "./parts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ajustes → Datos: a copy of what can't be re-synced, bringing one back, and (web) where the mailbox lives. */
export function DataTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div data-testid="data-tab">
      <SettingsGroup title="Copia de seguridad" footer="Lleva tus categorías, filtros, ajustes (nunca contraseñas ni claves) y borradores. El correo no: se vuelve a descargar de tus cuentas.">
        <SettingsRow label="Exportar" hint="Un archivo JSON con lo que no se puede volver a descargar.">
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
              <Download /> Exportar
            </Button>
          )}
        </SettingsRow>
        <SettingsRow label="Importar" hint="Suma una exportación a lo que ya tienes: las categorías con el mismo nombre se juntan y nada se borra." error={error} errorTestId="data-import-error">
          {({ id: _id, "aria-labelledby": _l, ...a }) => (
            <>
              <Button {...a} variant="outline" size="sm" disabled={busy !== null} data-testid="data-import" onClick={() => fileRef.current?.click()}>
                <Upload /> Importar…
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
      {StorageSection && (
        <Suspense>
          <StorageSection />
        </Suspense>
      )}
    </div>
  );
}
