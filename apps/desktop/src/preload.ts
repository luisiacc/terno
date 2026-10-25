import { contextBridge, ipcRenderer } from "electron";
import { PRINT_COMMANDS, type PrintCommand } from "./print-commands";

/**
 * Sandboxed preload. Only two things cross into the page: a MessagePort to the
 * backend (handshake: the page asks, we hand over the latest port once) and a
 * few vetted desktop helpers (printing and diagnostics among them).
 */
let port: MessagePort | null = null;
let wanted = false;

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
  // the Archivo menu's commands, whitelisted
  onCommand: (listener: (command: PrintCommand) => void) => {
    const relay = (_e: unknown, command: unknown) => {
      if (PRINT_COMMANDS.includes(command as PrintCommand)) listener(command as PrintCommand);
    };
    ipcRenderer.on("terno:command", relay);
    return () => ipcRenderer.removeListener("terno:command", relay);
  },
});
