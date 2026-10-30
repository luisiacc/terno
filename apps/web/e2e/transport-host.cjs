const { app, BrowserWindow, ipcMain, MessageChannelMain } = require("electron");
const { join } = require("node:path");

// A finite test host, never the desktop application's main entry or a real profile.
app.setPath("userData", process.env.TRANSPORT_PROFILE);
app.setPath("sessionData", join(process.env.TRANSPORT_PROFILE, "session"));
app.setPath("crashDumps", join(process.env.TRANSPORT_PROFILE, "crashes"));
let win, active, epoch = 0, block = false;
const record = (entry) => { if (!win.isDestroyed()) win.webContents.send("transport:record", entry); };
const disconnect = () => {
  active?.port.close();
  active?.ws.close();
  active = null;
};
const open = () => new Promise((resolve, reject) => {
  const current = ++epoch;
  const { port1: port, port2 } = new MessageChannelMain();
  const ws = new WebSocket(`${process.env.TRANSPORT_BACKEND}?token=e2e`);
  active = { port, ws };
  port.on("message", ({ data: frame }) => {
    if (block && frame.t === "req" && frame.m === "drafts.save") {
      block = false;
      record({ epoch: current, kind: "blocked", frame });
      return;
    }
    record({ epoch: current, kind: "request", frame });
    ws.send(JSON.stringify(frame));
  });
  port.start();
  ws.onmessage = ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.t === "res") record({ epoch: current, kind: "response", frame });
    port.postMessage(frame);
  };
  ws.onclose = () => record({ epoch: current, kind: "ws-closed" });
  ws.onerror = () => { port.close(); port2.close(); reject(new Error("synthetic backend connection failed")); };
  ws.onopen = () => {
    win.webContents.postMessage("terno:backend-port", { epoch: current }, [port2]);
    resolve();
  };
});
ipcMain.handle("transport:block", () => { block = true; });
ipcMain.handle("transport:disconnect", disconnect);
ipcMain.handle("transport:replace", open);
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1440, height: 928, show: false, webPreferences: { preload: join(__dirname, "transport-preload.cjs"), contextIsolation: true, sandbox: true } });
  win.webContents.on("did-finish-load", () => {
    if (win.webContents.getURL() === "about:blank") return;
    disconnect();
    void open().catch((error) => { console.error(error); app.exit(1); });
  });
  void win.loadURL("about:blank");
});
app.on("window-all-closed", () => { disconnect(); app.quit(); });
