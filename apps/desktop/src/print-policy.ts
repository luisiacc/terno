/**
 * The print job's rules, kept apart from Electron so they're unit-tested in
 * Node: what the renderer may ask for, what the print window may load, the
 * page geometry and footer, and the Archivo menu's commands.
 */
import type { MenuItemConstructorOptions } from "electron";

/** The only commands main sends the renderer; the preload drops anything else. */
export const PRINT_COMMANDS = ["thread.print", "thread.exportPdf"] as const;
export type PrintCommand = (typeof PRINT_COMMANDS)[number];

export interface PrintJob {
  /** the renderer's fitted, sanitized page; main adds its own CSP and title */
  html: string;
  action: "print" | "pdf";
  paper: "letter" | "a4";
  /** the conversation's subject: the PDF's file name, and with headers its title and footer */
  subject: string;
  /** printed with headers; content only gets no footer, and "Correo" as its PDF title */
  headers: boolean;
  /** remote images the renderer kept (approved messages only): the print window may load these, nothing else */
  remote: string[];
}

export type PrintResult =
  | { status: "submitted" | "cancelled" }
  | { status: "saved"; exportId: string; name: string }
  | { status: "failed"; reason: "no-printers" | "error" };

export const MAX_HTML_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE = 2000;
const MAX_URL = 4096;
const MAX_SUBJECT = 2000;

export function parsePrintJob(value: unknown): PrintJob | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.html !== "string" || v.html.length > MAX_HTML_BYTES || Buffer.byteLength(v.html) > MAX_HTML_BYTES) return null;
  if ((v.action !== "print" && v.action !== "pdf") || (v.paper !== "letter" && v.paper !== "a4")) return null;
  if (typeof v.subject !== "string" || typeof v.headers !== "boolean" || !Array.isArray(v.remote) || v.remote.length > MAX_REMOTE) return null;
  const remote: string[] = [];
  for (const u of v.remote) {
    if (typeof u !== "string" || u.length > MAX_URL) return null;
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    remote.push(url.href);
  }
  return { html: v.html, action: v.action, paper: v.paper, subject: v.subject.slice(0, MAX_SUBJECT), headers: v.headers, remote };
}

/** Only the app's own page, in the window's top frame, may print. */
export function isTrustedSender(frameUrl: string, isTopFrame: boolean, devUrl: string | null): boolean {
  return isTopFrame && (frameUrl.startsWith("app://terno/") || (devUrl !== null && devUrl !== "" && frameUrl.startsWith(devUrl)));
}

/**
 * What the print window may load: its job's exact document, and, outside
 * local mode, the job's approved images. Everything else is cancelled
 * (redirects come back through here, so they meet the same list).
 */
export function requestAllowed(req: { url: string; resourceType: string }, job: { url: string; remote: ReadonlySet<string> } | null, localMode: boolean): boolean {
  if (!job) return false;
  if (req.url === job.url) return req.resourceType === "mainFrame";
  return !localMode && req.resourceType === "image" && job.remote.has(req.url);
}

/** The window's own policy: no scripts, no frames, images from data: (and the web only if some were approved). */
export function printCsp(remote: boolean): string {
  return `default-src 'none'; img-src data:${remote ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Main's CSP and title go first in <head>: the first <title> is the document's (and the PDF's). */
export function withHead(html: string, o: { csp: string; title: string }): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${esc(o.csp)}"><title>${esc(o.title)}</title>`;
  const at = /<head[^>]*>/i.exec(html);
  return at ? html.slice(0, at.index + at[0].length) + head + html.slice(at.index + at[0].length) : `<!doctype html><head>${head}</head>${html}`;
}

/** The same rule as the renderer's: no path or reserved characters, capped, "Correo" when nothing is left. */
export function pdfFileName(subject: string): string {
  const clean = subject
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what a file name can't hold
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return [...clean].slice(0, 80).join("").trim() || "Correo";
}

/** The renderer's page geometry (mm), in the inches Electron's PDF options take. */
const MM = 1 / 25.4;
export const PDF_MARGINS = { top: 18 * MM, bottom: 18 * MM, left: 16 * MM, right: 16 * MM };
export const PDF_PAGE = { letter: "Letter", a4: "A4" } as const;

/** "Subject … N / M" in 8pt grey, aligned with the page's text; the subject escaped and cut short. */
export function footerTemplate(subject: string): string {
  const chars = [...(subject.trim() || "(sin asunto)")];
  const s = chars.length > 90 ? `${chars.slice(0, 89).join("").trimEnd()}…` : chars.join("");
  return `<div style="box-sizing:border-box;width:100%;padding:0 16mm;display:flex;gap:12pt;justify-content:space-between;font:8pt -apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:#86868b"><span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(s)}</span><span style="white-space:nowrap;font-variant-numeric:tabular-nums"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}

/** Electron's print callback as what the user did: sent to the printer (not "printed": that's the printer's), cancelled, or failed. */
export function printOutcome(success: boolean, reason: string): PrintResult {
  if (success) return { status: "submitted" };
  if (/cancel/i.test(reason)) return { status: "cancelled" };
  return { status: "failed", reason: /no printers/i.test(reason) ? "no-printers" : "error" };
}

/** The packaged smoke saves without a panel; only a dev build or the demo mailbox honors it, never real mail in a release. */
export function testPdfDir(env: Record<string, string | undefined>, packaged: boolean, demo: boolean): string | null {
  const dir = env.TERNO_TEST_PDF_DIR;
  return dir && (!packaged || demo) ? dir : null;
}

/** Archivo: each item sends a command to the renderer, which decides like it does for the key (the menu never prints the app window). */
export function fileMenu(send: (command: PrintCommand) => void): MenuItemConstructorOptions {
  return {
    label: "Archivo",
    submenu: [
      { id: "print", label: "Imprimir…", accelerator: "CmdOrCtrl+P", click: () => send("thread.print") },
      { id: "export-pdf", label: "Exportar como PDF…", accelerator: "CmdOrCtrl+Shift+P", click: () => send("thread.exportPdf") },
    ],
  };
}
