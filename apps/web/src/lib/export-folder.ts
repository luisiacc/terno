import type { FolderView } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { formatBytes } from "./format";
import { snack } from "./snack";

/**
 * Plan 107: a folder's .mbox, rebuilt by the backend from this computer's copy and written as it comes, so the
 * page holds one piece at a time. Where it goes is asked first (nothing is read before): the desktop's save panel
 * through main, else the browser's file picker (Chromium), else Blob parts (spilled to disk by the browser) up to
 * BLOB_MAX, then a download. A loading snack shows the progress and cancels it.
 */

export interface FolderExportTarget {
  accountId: number;
  folder: string | null;
  view: FolderView | null;
}

/** where Blob parts stop: past it, the export says so and keeps nothing */
export const BLOB_MAX = 512 * 1024 * 1024;
/** past this many messages a Blob export says its limit up front (a guess: bytes aren't known before) */
const BLOB_WARN_MESSAGES = 5000;

interface Sink {
  /** "blob": capped at BLOB_MAX */
  kind: "desktop" | "picker" | "blob";
  write(text: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

class ExportError extends Error {}

/** the file name as the user sees the folder (main and the picker clean it further) */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what a file name can't hold
const fileName = (label: string) => `${label.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ").trim() || t("folder.export.filter")}.mbox`;

interface SavePicker {
  showSaveFilePicker?: (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;
}

/** where it goes; null: the user cancelled the panel */
async function openSink(label: string): Promise<Sink | null> {
  const desktop = typeof window !== "undefined" ? window.ternoDesktop?.mboxExport : undefined;
  if (desktop) {
    const r = await desktop.begin(label);
    if (r.status === "cancelled") return null;
    if (r.status !== "ready") throw new ExportError(t("folder.export.writeFailed"));
    const id = r.id;
    return {
      kind: "desktop",
      write: async (text) => {
        if (!(await desktop.write(id, text))) throw new ExportError(t("folder.export.writeFailed"));
      },
      close: async () => {
        if ((await desktop.end(id)).status !== "saved") throw new ExportError(t("folder.export.writeFailed"));
      },
      abort: async () => void (await desktop.abort(id)),
    };
  }
  const picker = (globalThis as SavePicker).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName: fileName(label), types: [{ description: t("folder.export.filter"), accept: { "application/mbox": [".mbox"] } }] });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return null;
      throw error;
    }
    const writable = await handle.createWritable();
    return {
      kind: "picker",
      write: (text) => writable.write(text),
      close: () => writable.close(),
      // the browser drops what it had written aside
      abort: () => writable.abort().catch(() => {}),
    };
  }
  let parts: Blob[] = [];
  let size = 0;
  return {
    kind: "blob",
    write: async (text) => {
      const part = new Blob([text]);
      size += part.size;
      if (size > BLOB_MAX) throw new ExportError(t("folder.export.tooLarge", { name: label, limit: formatBytes(BLOB_MAX) }));
      parts.push(part);
    },
    close: async () => {
      const url = URL.createObjectURL(new Blob(parts, { type: "application/mbox" }));
      parts = [];
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName(label);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    abort: async () => {
      parts = [];
    },
  };
}

/** the export running now: a new one ends it */
let running: { cancel(): void } | null = null;
let seq = 0;

/** Exports `target` (shown as `label`) to a file the user picks. Resolves when it's saved, cancelled or failed (the snack says which). */
export async function exportFolder(target: FolderExportTarget, label: string): Promise<void> {
  running?.cancel();
  const snackId = `folder-export-${++seq}`;
  let cancelled = false;
  let exportId: string | null = null;
  let sink: Sink | null = null;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (exportId) void client.call("folders.exportCancel", { exportId }).catch(() => {});
    void sink?.abort();
    snack(t("folder.export.cancelled"), { id: snackId });
  };
  const self = { cancel };
  running = self;
  try {
    // the panel or picker first, while the click still counts as the user's
    sink = await openSink(label);
    if (!sink) return;
    // cancelled (or superseded) while the panel or file was opening: what it opened goes too (Codex code review round 2 #9)
    if (cancelled) return void sink.abort().catch(() => {});
    const action = { label: t("common.cancel"), name: t("folder.export.cancelName"), onClick: cancel };
    snack.loading(t("folder.export.starting", { name: label }), { id: snackId, action });
    const start = await client.call("folders.exportStart", { accountId: target.accountId, folder: target.folder, view: target.view });
    exportId = start.exportId;
    // cancelled while it started: the session it opened ends too
    if (cancelled) return void client.call("folders.exportCancel", { exportId }).catch(() => {});
    const name = label || start.name;
    if (start.total === 0) {
      void client.call("folders.exportCancel", { exportId }).catch(() => {});
      await sink.abort();
      snack(t("folder.export.empty", { name }), { id: snackId });
      return;
    }
    const limit = sink.kind === "blob" && start.total > BLOB_WARN_MESSAGES ? t("folder.export.browserLimit", { limit: formatBytes(BLOB_MAX) }) : undefined;
    snack.loading(t("folder.export.progress", { name, done: 0, total: start.total }), { id: snackId, action, description: limit });
    for (;;) {
      const r = await client.call("folders.exportNext", { exportId });
      if (cancelled) return;
      if (r.text) await sink.write(r.text);
      if (cancelled) return;
      if (r.finished) {
        await sink.close();
        // cancelled while it was being saved: the cancel said so, never a success after it (Codex code review round 2 #8)
        if (cancelled) return;
        const missing = [
          r.missingAttachments ? t("folder.export.missingAttachments", { count: r.missingAttachments }) : "",
          r.partialBodies ? t("folder.export.partialBodies", { count: r.partialBodies }) : "",
        ].filter(Boolean);
        snack.success(t("folder.export.done", { count: r.done }), { id: snackId, description: missing.join(" ") || undefined, duration: missing.length ? 8000 : undefined });
        return;
      }
      snack.progress(snackId, t("folder.export.progress", { name, done: r.done, total: r.total }));
    }
  } catch (error) {
    if (cancelled) return;
    cancelled = true;
    if (exportId) void client.call("folders.exportCancel", { exportId }).catch(() => {});
    await sink?.abort().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    snack.error(error instanceof ExportError ? message : t("folder.export.failed", { name: label, error: message }), { id: snackId });
  } finally {
    if (running === self) running = null;
  }
}
