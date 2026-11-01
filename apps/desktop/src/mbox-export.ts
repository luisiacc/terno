/**
 * Plan 107: a folder's .mbox export, saved where the user picks. The save panel first (nothing is written before),
 * then the page appends each piece the backend gave it, then the file is renamed into place (mbox-files.ts).
 * Nothing here reaches the network.
 */
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { t } from "@terno/i18n";
import { abortWithPage, MboxFiles, mboxFileName } from "./mbox-files";

export interface MboxExportDeps {
  /** the main window's top frame, on the app's own URL */
  trusted(event: IpcMainInvokeEvent): boolean;
  /** the packaged smoke's export directory (testPdfDir), else null: no panel there */
  testDir: string | null;
}

export type MboxBeginResult = { status: "ready"; id: string } | { status: "cancelled" | "failed" };

export function registerMboxExport(deps: MboxExportDeps): void {
  const files = new MboxFiles();
  const watched = new WeakSet<WebContents>();
  const watch = (sender: WebContents) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    // a window that goes, reloads or crashes leaves no temp file behind
    abortWithPage(files, sender.id, sender);
  };
  ipcMain.handle("terno:export-begin", async (event, name: unknown): Promise<MboxBeginResult> => {
    if (!deps.trusted(event) || typeof name !== "string") return { status: "failed" };
    const file = mboxFileName(name.slice(0, 1000), t("folder.export.filter"));
    // watched from before the panel, so a page that ends while it's open or the file opens is heard (Codex code
    // review round 5 #5: cleanup ran before the export was registered, and the file was left open)
    watch(event.sender);
    const page = files.page(event.sender.id);
    let path = deps.testDir ? join(deps.testDir, file) : null;
    if (!path) {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options = { title: t("folder.export.saveTitle"), buttonLabel: t("common.save"), defaultPath: join(app.getPath("downloads"), file), filters: [{ name: t("folder.export.filter"), extensions: ["mbox"] }], properties: ["createDirectory" as const, "showOverwriteConfirmation" as const] };
      const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return { status: "cancelled" };
      path = choice.filePath;
      if (files.page(event.sender.id) !== page) return { status: "cancelled" };
    }
    try {
      return { status: "ready", id: await files.begin(event.sender.id, path, page) };
    } catch {
      return { status: "failed" };
    }
  });
  ipcMain.handle("terno:export-write", (event, id: unknown, chunk: unknown) => (deps.trusted(event) && typeof id === "string" && typeof chunk === "string" ? files.write(event.sender.id, id, chunk) : false));
  ipcMain.handle("terno:export-end", async (event, id: unknown) => {
    const name = deps.trusted(event) && typeof id === "string" ? await files.end(event.sender.id, id) : null;
    return name === null ? { status: "failed" } : { status: "saved", name };
  });
  ipcMain.handle("terno:export-abort", async (event, id: unknown) => {
    if (deps.trusted(event) && typeof id === "string") await files.abort(event.sender.id, id);
    return true;
  });
}
