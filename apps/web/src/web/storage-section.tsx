import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unica/ui/components/select";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, SettingsGroup, SettingsRow } from "~/components/settings/parts";
import { client } from "~/rpc/connection";
import { switchStorage } from "./connect";
import { useWeb } from "./lifecycle";

const mib = (n: number | null) => (n === null ? "?" : `${Math.round(n / 2 ** 20)} MB`);

const ENGINES = [
  { value: "opfs-sqlite", label: "SQLite (OPFS)" },
  { value: "idb", label: "IndexedDB" },
] as const;
const engineLabel = (id: string | null) => ENGINES.find((e) => e.value === id)?.label ?? id ?? "?";

/** OPFS (its sync handles exist only inside the worker; the page can see the directory API); IndexedDB is everywhere. */
const opfsAvailable = () => typeof navigator.storage?.getDirectory === "function";

/** Ajustes → Datos on the web: whether the browser may evict the mailbox, and which engine holds it. */
export function StorageSection() {
  const persistence = useWeb((s) => s.persistence);
  const storage = useWeb((s) => s.storage);
  const [target, setTarget] = useState<string | null>(null);
  const state = persistence?.state ?? "unsupported";
  return (
    <SettingsGroup title="Almacenamiento en este navegador" testId="storage-section">
      <div data-persisted={persistence?.state} data-testid="storage-persistence">
        <SettingsRow
          label={state === "granted" ? "Persistente" : "Puede borrarse"}
          hint={
            state === "granted"
              ? "El navegador no borrará tu buzón para liberar espacio."
              : "El navegador puede borrar tu buzón si le falta espacio (o, en Safari, tras 7 días sin abrir Única). El correo se vuelve a descargar; tus categorías, filtros, ajustes y envíos pendientes no: expórtalos de vez en cuando."
          }
        >
          {() => (
            <span className="text-xs text-muted-foreground tabular-nums" data-testid="storage-usage">
              {mib(persistence?.usage ?? null)} de {mib(persistence?.quota ?? null)}
            </span>
          )}
        </SettingsRow>
      </div>
      <SettingsRow label="Motor" hint="Dónde guarda Única tu buzón en este navegador. Al cambiar, tus ajustes, categorías, filtros y borradores van contigo; el correo se descarga de nuevo.">
        {({ id: _id, ...a }) => (
          <Select value={storage ?? undefined} onValueChange={(v) => v !== storage && setTarget(v as string)} items={ENGINES.map((e) => ({ ...e }))}>
            <SelectTrigger {...a} size="sm" className="w-40" data-testid="storage-engine">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENGINES.map((e) => (
                <SelectItem key={e.value} value={e.value} disabled={e.value === "opfs-sqlite" && !opfsAvailable()} data-testid={`storage-engine-${e.value}`}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        testId="storage-switch-dialog"
        title={`¿Pasar a ${engineLabel(target)}?`}
        description={`Única se recarga y abre tu buzón en ${engineLabel(target)}: la primera vez, vacío; vuelve a conectar Gmail y el correo se descarga. Tus ajustes, categorías y filtros van contigo. El buzón de ${engineLabel(storage)} se queda donde está: puedes volver cuando quieras.`}
        confirm={`Pasar a ${engineLabel(target)}`}
        onConfirm={async () => {
          if (!target) return;
          try {
            await switchStorage(client, target);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        }}
      />
    </SettingsGroup>
  );
}
