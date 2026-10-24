/** A print job for main (apps/desktop/src/print-policy.ts validates it). */
export interface DesktopPrintJob {
  html: string;
  action: "print" | "pdf";
  paper: "letter" | "a4";
  subject: string;
  headers: boolean;
  remote: string[];
}

export type DesktopPrintResult =
  | { status: "submitted" | "cancelled" }
  | { status: "saved"; exportId: string; name: string }
  | { status: "failed"; reason: "no-printers" | "error" };

export interface DesktopBridge {
  platform: string;
  version: string;
  openExternal(url: string): void;
  agentInfo(): Promise<{ mcpCommand: string; socketPath: string; skillPath: string }>;
  /** native theme source, window background (#rrggbb) and sidebar vibrancy; older shells don't have it */
  setAppearance?(appearance: { themeSource: "system" | "light" | "dark"; background: string; vibrancy: boolean }): void;
  /** prints in a hidden window (the system dialog) or exports a PDF after a save panel */
  print?(job: DesktopPrintJob): Promise<DesktopPrintResult>;
  /** reveals a PDF this session exported, by the id its export returned */
  showSaved?(exportId: string): Promise<boolean>;
  /** the Archivo menu's commands */
  onCommand?(listener: (command: "thread.print" | "thread.exportPdf") => void): () => void;
}

declare global {
  interface Window {
    ternoDesktop?: DesktopBridge;
  }
}
