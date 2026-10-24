import { contextBridge, ipcRenderer } from "electron";

/**
 * Sandboxed preload. Only two things cross into the page: a MessagePort to the
 * backend (handshake: the page asks, we hand over the latest port once) and a
 * few vetted desktop helpers.
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
});
