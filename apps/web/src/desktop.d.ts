import type { Channel, DiagView, ReportEvent } from "@terno/core/diag";
import type { UpdateChannel, UpdateMode, UpdateState } from "@terno/core/updates";

/** Diagnostics through main (apps/desktop/src/diag/main.ts validates and owns everything). */
export interface DesktopDiag {
  info(): { version: string; sha: string; build: string; channel: Channel; session: string; dsn: boolean } | null;
  /** log entries, the breadcrumb mirror and records, batched */
  push(batch: { entries?: unknown[]; crumbs?: unknown[]; records?: unknown[]; dropped?: number }): void;
  state(): Promise<DiagView | null>;
  decide(ids: string[], decision: "send" | "dismiss"): Promise<{ sent: number }>;
  /** a record's exact report, or "sample" */
  preview(target: string): Promise<{ event: ReportEvent; host: string | null } | null>;
  export(): Promise<{ status: "saved" | "cancelled" | "failed"; name?: string }>;
  showLogs(): Promise<boolean>;
  resetInstall(): Promise<string | null>;
  restartEngine(): Promise<boolean>;
  onChange(listener: () => void): () => void;
}

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
  /** the menu's commands (Archivo, Ver) */
  onCommand?(listener: (command: "thread.print" | "thread.exportPdf" | "list.toggleUnread" | "updates.check" | "nav.back" | "nav.forward") => void): () => void;
  /** older shells don't have it */
  diag?: DesktopDiag;
  /** in-app updates (main owns the state and the install); older shells don't have it */
  updates?: DesktopUpdates;
  /** before a quit or an update main asks the page to save its drafts, and waits for the promise (5 s at most) */
  onFlushDrafts?(flush: () => Promise<boolean>): () => void;
}

/** In-app updates through main (apps/desktop/src/updates/main.ts validates every call). */
export interface DesktopUpdates {
  state(): Promise<UpdateState | null>;
  /** a manual check (one grant, local mode included) */
  check(): Promise<UpdateState | null>;
  /** a manual download (the second grant) */
  download(): Promise<UpdateState | null>;
  /** drafts flushed, the backend closed, then Squirrel swaps and relaunches (a send in flight defers it) */
  install(): Promise<UpdateState | null>;
  setPrefs(prefs: { mode: UpdateMode; channel: UpdateChannel }): Promise<UpdateState | null>;
  /** "Terno updated to …" was shown */
  seen(): void;
  onState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    ternoDesktop?: DesktopBridge;
  }
}
