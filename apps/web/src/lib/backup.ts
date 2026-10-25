import type { ImportResult } from "@terno/core/rpc";
import { formatList, t } from "@terno/i18n";
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
  if (file.size > 50 * 2 ** 20) throw new Error(t("settings.file.tooLarge", { max: "50 MB" }));
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(t("settings.file.invalidJson"));
  }
  const format = (data as { format?: unknown } | null)?.format;
  // "unica-export": files exported when the app was called Única
  if (format !== "terno-export" && format !== "unica-export") throw new Error(t("settings.data.notExport"));
  const result = await client.call("app.import", { data: data as never });
  // the drafts it brought show at once (the backend's event does the same for other windows)
  await loadDrafts();
  const boot = await client.call("app.bootstrap", {});
  adoptSettings(boot.settings);
  setApp({ categories: boot.categories });
  return result;
}

/** One line for a snack: what came in, what waits for its account, what was left out. */
export function importSummary(r: ImportResult): string {
  const items = [
    t("settings.data.summary.categories", { count: r.categories.added }),
    t("settings.data.summary.filters", { count: r.filters.added }),
    r.drafts ? t("settings.data.summary.drafts", { count: r.drafts }) : null,
    r.settings ? t("settings.data.summary.settings") : null,
  ].filter((x) => x !== null);
  const sentences = [t("settings.data.summary", { items: formatList(items) })];
  if (r.pending.drafts + r.pending.filters) {
    const waiting = formatList([t("settings.data.summary.drafts", { count: r.pending.drafts }), t("settings.data.summary.filters", { count: r.pending.filters })]);
    sentences.push(t("settings.data.summary.waiting", { items: waiting }));
  }
  if (r.filters.skipped.length) sentences.push(t("settings.data.summary.skipped", { names: formatList(r.filters.skipped) }));
  return sentences.join(" ");
}
