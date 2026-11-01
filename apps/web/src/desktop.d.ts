import type { MailboxGate } from "@terno/core/mailbox";
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
  /** plan 99: the build carries Terno's Google client; older shells don't say */
  googleBuiltIn?: boolean;
  openExternal(url: string): void;
  agentInfo(): Promise<{ mcpCommand: string; socketPath: string; skillPath: string }>;
  /** native theme source, window background (#rrggbb) and sidebar vibrancy; older shells don't have it */
  setAppearance?(appearance: { themeSource: "system" | "light" | "dark"; background: string; vibrancy: boolean }): void;
  /** prints in a hidden window (the system dialog) or exports a PDF after a save panel */
  print?(job: DesktopPrintJob): Promise<DesktopPrintResult>;
  /** reveals a PDF this session exported, by the id its export returned */
  showSaved?(exportId: string): Promise<boolean>;
  /** plan 107: a folder's .mbox, written by main (older shells don't have it) */
  mboxExport?: DesktopMboxExport;
  /** the menu's commands (Archivo, Ver) */
  onCommand?(listener: (command: "thread.print" | "thread.exportPdf" | "list.toggleUnread" | "updates.check" | "nav.back" | "nav.forward") => void): () => void;
  /** plan 41: a notification's click opens this conversation (null: the Inbox); older shells don't have it */
  onOpenThread?(listener: (threadId: number | null) => void): () => void;
  /** older shells don't have it */
  diag?: DesktopDiag;
  /** in-app updates (main owns the state and the install); older shells don't have it */
  updates?: DesktopUpdates;
  /** plan 95: the mailbox gate; older shells don't have it */
  mailbox?: DesktopMailbox;
  /** before a quit or an update main asks the page to save its drafts, and waits for the promise (5 s at most) */
  onFlushDrafts?(flush: () => Promise<boolean>, acquire?: () => (() => void) | null): () => void;
  /** A refused native reload; the action is bound to that exact disclosed window/document request. */
  onReloadRefused?(listener: (anyway: () => void) => void): () => void;
}

/** Plan 107: an .mbox export's file through main (apps/desktop/src/mbox-export.ts): the save panel, then appends, then the rename. */
export interface DesktopMboxExport {
  /** the save panel for `<name>.mbox`, then a temp file beside the target */
  begin(name: string): Promise<{ status: "ready"; id: string } | { status: "cancelled" | "failed" }>;
  /** false: the file can't be written (it's gone) */
  write(id: string, chunk: string): Promise<boolean>;
  /** renamed into place */
  end(id: string): Promise<{ status: "saved"; name: string } | { status: "failed" }>;
  /** the temp file is deleted */
  abort(id: string): Promise<boolean>;
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
  /** plan 95: "Update Terno": a check if needed, the download, then the restart once Squirrel has it (older shells don't have it) */
  updateNow?(): Promise<UpdateState | null>;
  onState(listener: (state: UpdateState) => void): () => void;
}

/** Plan 95: the mailbox gate through main (apps/desktop/src/mailbox/host.ts refuses what doesn't apply). */
export interface DesktopMailbox {
  state(): Promise<MailboxGate | null>;
  /** Try Again: a fresh start of the mail engine */
  retry(): Promise<boolean>;
  /** Update Without a Backup (only where the backup is what failed or didn't fit) */
  skipBackup(): Promise<boolean>;
  /** Restore the backup over a damaged mailbox */
  restore(): Promise<boolean>;
  onState(listener: (gate: MailboxGate) => void): () => void;
}

declare global {
  interface Window {
    ternoDesktop?: DesktopBridge;
  }
}
