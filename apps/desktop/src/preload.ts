import { contextBridge, ipcRenderer } from "electron";
import { MENU_COMMANDS, type MenuCommand } from "./print-commands";
import { clockShiftOf, shiftClock } from "./window-clock";
import { isMailLinkId, type OpenTarget } from "@terno/core/mail-link";

// plan 167: the demo's fixed clock, before any of the page's scripts run (main passes it only then)
const clockShift = clockShiftOf(process.argv);
if (clockShift !== null) contextBridge.executeInMainWorld({ func: shiftClock, args: [clockShift] });

/**
 * Sandboxed preload. Only two things cross into the page: a MessagePort to the
 * backend (handshake: the page asks, we hand over the latest port once) and a
 * few vetted desktop helpers (printing and diagnostics among them).
 */
let port: MessagePort | null = null;
let wanted = false;
const documentToken = crypto.randomUUID();

function deliver() {
  if (port && wanted) {
    window.postMessage("terno:backend-port", "*", [port]);
    port = null;
    wanted = false;
  }
}

ipcRenderer.on("terno:backend-port", (event) => {
  port = event.ports[0] ?? null;
  deliver();
});

window.addEventListener("message", (e) => {
  if (e.source === window && e.data === "terno:request-port") {
    wanted = true;
    deliver();
  }
});

contextBridge.exposeInMainWorld("ternoDesktop", {
  platform: process.platform,
  version: ipcRenderer.sendSync("terno:version") as string,
  openExternal: (url: string) => ipcRenderer.send("terno:open-external", String(url)),
  agentInfo: () => ipcRenderer.invoke("terno:agent-info"),
  // validated in main; main also remembers it for the next window's first frame
  setAppearance: (a: { themeSource: string; background: string; vibrancy: boolean }) =>
    ipcRenderer.send("terno:appearance", { themeSource: String(a?.themeSource), background: String(a?.background), vibrancy: a?.vibrancy === true }),
  // the print document and its options; main validates every field and owns the CSP, title and footer
  print: (job: unknown) => ipcRenderer.invoke("terno:print", job),
  showSaved: (exportId: string) => ipcRenderer.invoke("terno:show-saved", String(exportId)),
  // plan 107: a folder's .mbox: main shows the save panel, appends each piece to a temp file, renames it into place
  mboxExport: {
    begin: (name: string) => ipcRenderer.invoke("terno:export-begin", String(name)),
    write: (id: string, chunk: string) => ipcRenderer.invoke("terno:export-write", String(id), String(chunk)),
    end: (id: string) => ipcRenderer.invoke("terno:export-end", String(id)),
    abort: (id: string) => ipcRenderer.invoke("terno:export-abort", String(id)),
  },
  // diagnostics: main validates every batch (schema, size, rate) and owns files, reports and the export dialog
  diag: {
    info: () => ipcRenderer.sendSync("terno:diag-info") as unknown,
    push: (batch: unknown) => ipcRenderer.send("terno:diag", batch),
    state: () => ipcRenderer.invoke("terno:diag-state"),
    decide: (ids: string[], decision: "send" | "dismiss") => ipcRenderer.invoke("terno:diag-decide", Array.isArray(ids) ? ids.map(String) : [], String(decision)),
    preview: (target: string) => ipcRenderer.invoke("terno:diag-preview", String(target)),
    export: () => ipcRenderer.invoke("terno:diag-export"),
    showLogs: () => ipcRenderer.invoke("terno:diag-show-logs"),
    resetInstall: () => ipcRenderer.invoke("terno:diag-reset-install"),
    restartEngine: () => ipcRenderer.invoke("terno:engine-restart"),
    onChange: (listener: () => void) => {
      const relay = () => listener();
      ipcRenderer.on("terno:diag-event", relay);
      return () => ipcRenderer.removeListener("terno:diag-event", relay);
    },
  },
  // in-app updates: main owns the state, the policy and the install; the page draws and asks
  updates: {
    state: () => ipcRenderer.invoke("terno:updates-state"),
    check: () => ipcRenderer.invoke("terno:updates-check"),
    download: () => ipcRenderer.invoke("terno:updates-download"),
    install: () => ipcRenderer.invoke("terno:updates-install"),
    setPrefs: (p: { mode: string; channel: string }) => ipcRenderer.invoke("terno:updates-prefs", { mode: String(p?.mode), channel: String(p?.channel) }),
    seen: () => ipcRenderer.send("terno:updates-seen"),
    // plan 95: "Update Terno" (check if needed, download, restart once Squirrel has it)
    updateNow: () => ipcRenderer.invoke("terno:updates-now"),
    onState: (listener: (state: unknown) => void) => {
      const relay = (_e: unknown, state: unknown) => listener(state);
      ipcRenderer.on("terno:updates-event", relay);
      return () => ipcRenderer.removeListener("terno:updates-event", relay);
    },
  },
  // plan 95: the mailbox gate (being upgraded, or why it can't open); main decides, the page asks
  mailbox: {
    state: () => ipcRenderer.invoke("terno:mailbox-state"),
    retry: () => ipcRenderer.invoke("terno:mailbox-retry"),
    skipBackup: () => ipcRenderer.invoke("terno:mailbox-skip-backup"),
    restore: () => ipcRenderer.invoke("terno:mailbox-restore"),
    onState: (listener: (gate: unknown) => void) => {
      const relay = (_e: unknown, gate: unknown) => listener(gate);
      ipcRenderer.on("terno:mailbox-event", relay);
      return () => ipcRenderer.removeListener("terno:mailbox-event", relay);
    },
  },
  // before any quit or update: main asks, the page saves every draft and answers (main waits 5 s at most)
  onFlushDrafts: (flush: () => Promise<boolean>, acquire?: () => (() => void) | null) => {
    const leases = new Map<unknown, () => void>();
    const release = (_e: unknown, id: unknown, document: unknown) => { if (document === documentToken) { leases.get(id)?.(); leases.delete(id); } };
    const relay = (_e: unknown, id: unknown, hold: unknown, document: unknown) => {
      if (document !== documentToken) return;
      try {
        if (hold === true) {
          const lease = acquire?.();
          if (!lease) { ipcRenderer.send("terno:flush-done", id, false, documentToken); return; }
          leases.set(id, lease);
        }
        void flush().catch(() => false).then((saved) => ipcRenderer.send("terno:flush-done", id, saved === true, documentToken));
      } catch { ipcRenderer.send("terno:flush-done", id, false, documentToken); }
    };
    ipcRenderer.on("terno:flush-drafts", relay);
    ipcRenderer.on("terno:flush-release", release);
    ipcRenderer.send("terno:flush-ready", documentToken);
    return () => {
      ipcRenderer.removeListener("terno:flush-drafts", relay);
      ipcRenderer.removeListener("terno:flush-release", release);
      for (const lease of leases.values()) lease();
      leases.clear();
    };
  },
  onReloadRefused: (listener: (anyway: () => void) => void) => {
    const relay = (_event: unknown, id: unknown) => { if (Number.isSafeInteger(id)) listener(() => ipcRenderer.send("terno:reload-anyway", id)); };
    ipcRenderer.on("terno:reload-refused", relay);
    return () => ipcRenderer.removeListener("terno:reload-refused", relay);
  },
  // plan 41: a notification's click (a conversation id, or null for the Inbox); plan 201: a link's message (its
  // canonical Message-ID). Main holds it until the page listens.
  onOpen: (listener: (target: OpenTarget) => void) => {
    const relay = (_e: unknown, target: unknown) => {
      const t = target as { kind?: unknown; threadId?: unknown; id?: unknown } | null;
      if (t?.kind === "link") return isMailLinkId(t.id) ? listener({ kind: "link", id: t.id }) : undefined;
      const threadId = t?.kind === "thread" ? t.threadId : null;
      listener({ kind: "thread", threadId: Number.isSafeInteger(threadId) && ((threadId as number) > 0 || threadId === -1 /* plan 145: the brief, BRIEF_NOTICE_THREAD: opens Today */) ? (threadId as number) : null });
    };
    ipcRenderer.on("terno:open", relay);
    ipcRenderer.send("terno:open-ready");
    return () => ipcRenderer.removeListener("terno:open", relay);
  },
  // the Archivo and Ver menus' commands, whitelisted
  onCommand: (listener: (command: MenuCommand) => void) => {
    const relay = (_e: unknown, command: unknown) => {
      if (MENU_COMMANDS.includes(command as MenuCommand)) listener(command as MenuCommand);
    };
    ipcRenderer.on("terno:command", relay);
    return () => ipcRenderer.removeListener("terno:command", relay);
  },
});
