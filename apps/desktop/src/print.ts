/**
 * Printing and PDF export. The renderer sends its fitted print document; a
 * hidden window on its own in-memory session loads it (JS off, no preload, no
 * backend port) from memory and either opens the system print dialog or
 * renders a PDF that is written atomically where the user chose. One job at a
 * time; the session forgets each job when it ends.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent, type Session } from "electron";
import { footerTemplate, parsePrintJob, PDF_MARGINS, PDF_PAGE, pdfFileName, printCsp, printOutcome, requestAllowed, withHead, type PrintJob, type PrintResult } from "./print-policy";

const PARTITION = "terno-print";
const SCHEME = "terno-print";
/** For loading the document only: the system dialog stays up as long as the user needs. */
const LOAD_TIMEOUT_MS = 20_000;

export interface PrintDeps {
  /** the main window's top frame, on the app's own URL */
  trusted(event: IpcMainInvokeEvent): boolean;
  /** main's local-mode policy, read on every request */
  localMode(): boolean;
  /** the packaged smoke's export directory (testPdfDir), else null */
  testPdfDir: string | null;
  log(level: "info" | "warn" | "error", message: string): void;
}

/** The job being rendered: immutable, looked up by its random URL. */
let active: { url: string; doc: Uint8Array<ArrayBuffer>; csp: string; remote: ReadonlySet<string> } | null = null;
let activeWindow: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** "Mostrar en Finder" may only show a file an export of this session wrote. */
const exported = new Map<string, string>();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

let printSession: Session | null = null;
/** One handler and one filter for the partition, registered once (they read `active`, never a per-job closure). */
function sessionFor(deps: PrintDeps): Session {
  if (printSession) return printSession;
  // no "persist:" prefix: in memory only
  const ses = session.fromPartition(PARTITION);
  ses.protocol.handle(SCHEME, (request) => {
    const job = active;
    if (!job || request.url !== job.url) return new Response(null, { status: 404 });
    return new Response(job.doc, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": job.csp, "X-Content-Type-Options": "nosniff" } });
  });
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !requestAllowed(details, active, deps.localMode()) }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  printSession = ses;
  return ses;
}

/** Loads the job into a fresh hidden window; listeners go on before it navigates. */
async function load(job: PrintJob, deps: PrintDeps): Promise<BrowserWindow> {
  const ses = sessionFor(deps);
  const csp = printCsp(job.remote.length > 0);
  // content only names no subject, not even in the PDF's metadata
  const doc = withHead(job.html, { csp, title: job.headers ? job.subject.trim() || "Correo" : "Correo" });
  active = { url: `${SCHEME}://job/${randomUUID()}`, doc: new TextEncoder().encode(doc), csp, remote: new Set(job.remote) };
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webgl: false, spellcheck: false, backgroundThrottling: false },
  });
  activeWindow = win;
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event) => event.preventDefault());
  const url = active.url;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the print document didn't load in time")), LOAD_TIMEOUT_MS);
    wc.once("did-finish-load", () => (clearTimeout(timer), resolve()));
    // subframes can't exist (no frames in the sanitized page); a blocked image is not a failed load
    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => isMainFrame && (clearTimeout(timer), reject(new Error(`${description} (${code})`))));
    win.loadURL(url).catch(() => {});
  });
  return win;
}

/** Forgets the job: window, document buffer, and anything the session kept. */
async function finish(win: BrowserWindow | null): Promise<void> {
  if (win && !win.isDestroyed()) win.destroy();
  activeWindow = null;
  active = null;
  await printSession?.clearStorageData().catch(() => {});
  await printSession?.clearCache().catch(() => {});
}

async function printJob(job: PrintJob, deps: PrintDeps): Promise<PrintResult> {
  let win: BrowserWindow | null = null;
  try {
    win = await load(job, deps);
    const wc = win.webContents;
    // the system dialog keeps its own paper choice (the page asks for ours through @page)
    return await new Promise<PrintResult>((resolve) => wc.print({ silent: false, printBackground: true }, (ok, reason) => resolve(printOutcome(ok, reason))));
  } catch (error) {
    deps.log("warn", `print failed: ${error}`);
    return { status: "failed", reason: "error" };
  } finally {
    await finish(win);
  }
}

async function renderPdf(job: PrintJob, deps: PrintDeps): Promise<Buffer> {
  let win: BrowserWindow | null = null;
  try {
    win = await load(job, deps);
    return await win.webContents.printToPDF({
      pageSize: PDF_PAGE[job.paper],
      margins: PDF_MARGINS,
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: job.headers,
      headerTemplate: "<span></span>",
      footerTemplate: job.headers ? footerTemplate(job.subject) : "<span></span>",
    });
  } finally {
    await finish(win);
  }
}

/** A private, exclusive temp file next to the target, renamed into place; never left behind. */
async function writeAtomically(path: string, data: Buffer): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function exportPdf(event: IpcMainInvokeEvent, job: PrintJob, deps: PrintDeps): Promise<PrintResult> {
  const name = `${pdfFileName(job.subject)}.pdf`;
  let path = deps.testPdfDir ? join(deps.testPdfDir, name) : null;
  if (!path) {
    // the panel first: nothing renders until the user picked where it goes
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: join(app.getPath("downloads"), name), filters: [{ name: "PDF", extensions: ["pdf"] }], properties: ["createDirectory" as const, "showOverwriteConfirmation" as const] };
    const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return { status: "cancelled" };
    path = choice.filePath;
  }
  const target = path;
  return serialized(async () => {
    try {
      await writeAtomically(target, await renderPdf(job, deps));
    } catch (error) {
      deps.log("warn", `PDF export failed: ${error}`);
      return { status: "failed", reason: "error" } as const;
    }
    const exportId = randomUUID();
    exported.set(exportId, target);
    if (exported.size > 20) exported.delete(exported.keys().next().value!);
    return { status: "saved", exportId, name: basename(target) } as const;
  });
}

export function registerPrint(deps: PrintDeps): void {
  ipcMain.handle("terno:print", async (event, value: unknown): Promise<PrintResult> => {
    const job = deps.trusted(event) ? parsePrintJob(value) : null;
    if (!job) return { status: "failed", reason: "error" };
    return job.action === "pdf" ? exportPdf(event, job, deps) : serialized(() => printJob(job, deps));
  });
  ipcMain.handle("terno:show-saved", (event, exportId: unknown) => {
    const path = deps.trusted(event) && typeof exportId === "string" ? exported.get(exportId) : undefined;
    if (path) shell.showItemInFolder(path);
    return Boolean(path);
  });
}

/** Local mode turned on mid-job: new requests are already refused; stop the ones in flight too. */
export function printLocalModeChanged(localMode: boolean): void {
  if (localMode && activeWindow && !activeWindow.isDestroyed() && activeWindow.webContents.isLoading()) activeWindow.webContents.stop();
}
