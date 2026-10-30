const { contextBridge, ipcRenderer } = require("electron");

// Match the shipped preload's port/wanted handoff; observations never start or consume the port.
let port = null, wanted = false;
function deliver() {
  if (port && wanted) {
    window.postMessage("terno:backend-port", "*", [port]);
    port = null;
    wanted = false;
  }
}
ipcRenderer.on("terno:backend-port", (event, { epoch }) => {
  window.postMessage({ type: "transport:epoch", epoch }, "*");
  port = event.ports[0] ?? null;
  deliver();
});
window.addEventListener("message", (event) => {
  if (event.source === window && event.data === "terno:request-port") {
    wanted = true;
    deliver();
  }
});
ipcRenderer.on("transport:record", (_event, record) => window.postMessage({ type: "transport:record", record }, "*"));
contextBridge.exposeInMainWorld("ternoDesktop", { platform: process.platform, version: "test", openExternal() {}, async agentInfo() { throw new Error("not used"); } });
contextBridge.exposeInMainWorld("__transportHost", {
  blockSave: () => ipcRenderer.invoke("transport:block"),
  disconnect: () => ipcRenderer.invoke("transport:disconnect"),
  replace: () => ipcRenderer.invoke("transport:replace"),
});
