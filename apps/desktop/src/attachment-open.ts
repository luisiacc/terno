/**
 * Plan 212: an attachment opened in the app the OS picks for it (Preview, for a PDF or an image on macOS), from a
 * private copy, not the Downloads folder. The page hands the bytes it read from the store; main checks, writes, marks
 * and opens them (opened-attachments.ts). Terno itself reaches nothing here.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { AttachmentOpener } from "./opened-attachments";

export interface AttachmentOpenDeps {
  /** the main window's top frame, on the app's own URL */
  trusted(event: IpcMainInvokeEvent): boolean;
  /** the packaged smoke's export directory (testPdfDir), else null: there the copy is written and never opened */
  testDir: string | null;
}

/** the mark a download carries on macOS: from the internet, by Terno (Office opens it in Protected View) */
function quarantine(path: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Terno;`;
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path], { timeout: 5000 }, (error) => (error ? reject(error) : resolve()));
  });
}

export function registerAttachmentOpen(deps: AttachmentOpenDeps): void {
  const opener = new AttachmentOpener({
    root: deps.testDir ? join(deps.testDir, "Opened Attachments") : join(app.getPath("userData"), "Opened Attachments"),
    quarantine,
    openPath: deps.testDir ? async () => "" : (path) => shell.openPath(path),
    now: Date.now,
  });
  ipcMain.handle("terno:open-attachment", (event, name: unknown, bytes: unknown) => (deps.trusted(event) ? opener.open(name, bytes) : { status: "failed" as const }));
}
