import type { ImportResult } from "@terno/core/rpc";
import { client } from "~/rpc/connection";
import { setApp } from "~/state/app";
import { adoptSettings } from "./appearance";
import { loadDrafts } from "./drafts";

/** Downloads what the mailbox can't re-sync (categories, filters, settings without secrets, drafts, pending sends) as JSON. */
export async function downloadExport(): Promise<void> {
  const dump = await client.call("app.export", {});
  const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `terno-export-${new Date(dump.exportedAt).toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads an export file and brings it in; the app shows the result at once. */
export async function importFile(file: File): Promise<ImportResult> {
  if (file.size > 50 * 2 ** 20) throw new Error("El archivo es demasiado grande (máx. 50 MB).");
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("El archivo no es JSON válido.");
  }
  const format = (data as { format?: unknown } | null)?.format;
  // "unica-export": files exported when the app was called Única
  if (format !== "terno-export" && format !== "unica-export") throw new Error("No es una exportación de Terno.");
  const result = await client.call("app.import", { data: data as never });
  // the drafts it brought show at once (the backend's event does the same for other windows)
  await loadDrafts();
  const boot = await client.call("app.bootstrap", {});
  adoptSettings(boot.settings);
    setApp({ categories: boot.categories });
  return result;
}

/** One line for a snack. */
export function importSummary(r: ImportResult): string {
  const parts = [
    `${r.categories.added} ${r.categories.added === 1 ? "categoría nueva" : "categorías nuevas"}`,
    `${r.filters.added} ${r.filters.added === 1 ? "filtro" : "filtros"}`,
    r.drafts ? `${r.drafts} ${r.drafts === 1 ? "borrador" : "borradores"}` : null,
    r.settings ? "tus ajustes" : null,
  ].filter(Boolean);
  const waiting = r.pending.drafts + r.pending.filters;
  return `Importado: ${parts.join(", ")}.${waiting ? ` ${r.pending.drafts} borradores y ${r.pending.filters} filtros entran cuando conectes sus cuentas.` : ""}${r.filters.skipped.length ? ` Sin importar (su categoría no está en el archivo): ${r.filters.skipped.join(", ")}.` : ""}`;
}
