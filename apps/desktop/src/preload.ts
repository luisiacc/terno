import { contextBridge, ipcRenderer } from "electron";
import { MENU_COMMANDS, type MenuCommand } from "./print-commands";

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
    onState: (listener: (state: unknown) => void) => {
      const relay = (_e: unknown, state: unknown) => listener(state);
      ipcRenderer.on("terno:updates-event", relay);
      return () => ipcRenderer.removeListener("terno:updates-event", relay);
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
  // the Archivo and Ver menus' commands, whitelisted
  onCommand: (listener: (command: MenuCommand) => void) => {
    const relay = (_e: unknown, command: unknown) => {
      if (MENU_COMMANDS.includes(command as MenuCommand)) listener(command as MenuCommand);
    };
    ipcRenderer.on("terno:command", relay);
    return () => ipcRenderer.removeListener("terno:command", relay);
  },
});
