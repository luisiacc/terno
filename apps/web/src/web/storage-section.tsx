import { Button } from "@unica/ui/components/button";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { client } from "~/rpc/connection";
import { useWeb } from "./lifecycle";

const mib = (n: number | null) => (n === null ? "?" : `${Math.round(n / 2 ** 20)} MB`);

/** Settings → General on the web: whether the browser may evict the mailbox, and a copy of what can't be re-synced. */
export function StorageSection() {
  const persistence = useWeb((s) => s.persistence);
  const storage = useWeb((s) => s.storage);
  const [busy, setBusy] = useState(false);
  const exportData = async () => {
    setBusy(true);
    try {
      const dump = await client.call("app.export", {});
      const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `unica-export-${new Date(dump.exportedAt).toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const state = persistence?.state ?? "unsupported";
  return (
    <div data-testid="storage-section" data-persisted={persistence?.state} className="my-3 rounded-xl border border-border p-3">
      <p className="text-sm font-medium">Almacenamiento en este navegador</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {state === "granted"
          ? "Persistente: el navegador no borrará tu buzón para liberar espacio."
          : "El navegador puede borrar tu buzón si le falta espacio (o, en Safari, tras 7 días sin abrir Única). El correo se vuelve a descargar; tus categorías, filtros, ajustes y envíos pendientes no: expórtalos de vez en cuando."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {storage === "idb" ? "IndexedDB" : "SQLite (OPFS)"} · {mib(persistence?.usage ?? null)} de {mib(persistence?.quota ?? null)}
      </p>
      <Button size="sm" variant="outline" className="mt-2.5" disabled={busy} onClick={() => void exportData()}>
        <Download /> Exportar
      </Button>
    </div>
  );
}
