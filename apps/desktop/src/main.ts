import { existsSync, mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import type { BackendToMain, MainToBackend } from "./ipc";

// V8 compile cache for the main bundle (t3code trick): faster subsequent boots.
try {
  (require("node:module") as { enableCompileCache?: (dir?: string) => void }).enableCompileCache?.();
} catch {
  /* older runtimes */
}

const isDev = Boolean(process.env.UNICA_DEV_URL);
const demo = process.env.UNICA_DEMO === "1" || process.argv.includes("--demo");
app.setName("Única");
// ASCII profile path (also what the MCP sidecar looks for)
app.setPath("userData", process.env.UNICA_USER_DATA ?? join(app.getPath("appData"), "Unica"));

// Privileged scheme: standard + secure origin and, crucially, V8 code cache for renderer scripts (file:// has none).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const RENDERER_DIR = join(__dirname, "renderer");
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http: cid:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' about: data:",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = normalize(join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response("forbidden", { status: 403 });
    const target = existsSync(file) ? file : join(RENDERER_DIR, "index.html");
    const res = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(res.headers);
    headers.set("Content-Type", MIME[extname(target)] ?? headers.get("Content-Type") ?? "application/octet-stream");
    headers.set("Content-Security-Policy", CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(res.body, { status: 200, headers });
  });
}

// ───────────────────────────── backend utility process ─────────────────────────────

let backend: UtilityProcess | null = null;
let backendReady: Promise<void> = Promise.resolve();
let clientSeq = 0;
const windows = new Set<BrowserWindow>();

function agentPaths() {
  const userData = app.getPath("userData");
  return { socketPath: join(userData, "agent.sock"), tokenPath: join(userData, "agent.token") };
}

function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : join(__dirname, "..", "resources");
}

function log(level: string, message: string) {
  const line = `[${new Date().toISOString()}] [backend:${level}] ${message}\n`;
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

function startBackend() {
  const userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  const child = utilityProcess.fork(join(__dirname, "backend.cjs"), [], { serviceName: "Única Mail Engine", stdio: "inherit" });
  backend = child;
  let resolveReady!: () => void;
  backendReady = new Promise((r) => (resolveReady = r));
  child.on("message", (msg: BackendToMain) => {
    switch (msg.type) {
      case "ready":
        resolveReady();
        break;
      case "fatal":
        log("error", msg.message);
        break;
      case "log":
        log(msg.level, msg.message);
        break;
      case "open-external":
        if (/^https:\/\//i.test(msg.url)) void shell.openExternal(msg.url);
        break;
      case "secret":
        try {
          if (!safeStorage.isEncryptionAvailable()) throw new Error("Keychain encryption unavailable");
          const value = msg.op === "encrypt" ? [...safeStorage.encryptString(msg.plain)] : safeStorage.decryptString(Buffer.from(msg.blob));
          child.postMessage({ type: "secret-result", id: msg.id, ok: true, value } satisfies MainToBackend);
        } catch (error) {
          child.postMessage({ type: "secret-result", id: msg.id, ok: false, error: String(error) } satisfies MainToBackend);
        }
        break;
    }
  });
  child.on("exit", (code) => {
    if (backend !== child) return;
    log("error", `backend exited (${code}); restarting`);
    backend = null;
    setTimeout(() => {
      startBackend();
      for (const w of windows) void connectWindow(w);
    }, 500);
  });
  child.postMessage({
    type: "init",
    dbPath: join(userData, "unica.db"),
    demo,
    dev: isDev,
    ...agentPaths(),
    version: app.getVersion(),
  } satisfies MainToBackend);
}

/** Gives the window's renderer a direct MessagePort to the backend. */
async function connectWindow(win: BrowserWindow) {
  await backendReady;
  if (!backend || win.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  backend.postMessage({ type: "port", clientId: `renderer-${++clientSeq}` } satisfies MainToBackend, [port1]);
  win.webContents.postMessage("unica:backend-port", null, [port2]);
}

// ───────────────────────────── windows ─────────────────────────────

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: "Única",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 15 },
    vibrancy: isMac ? "sidebar" : undefined,
    visualEffectState: "followWindow",
    backgroundColor: isMac ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1c1d22" : "#fcfcfa",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // render at full speed while hidden so first paint is ready when shown (t3code)
      backgroundThrottling: false,
    },
  });
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  win.once("ready-to-show", () => {
    win.show();
    win.webContents.setBackgroundThrottling(true);
  });

  // Every (re)load gets a fresh port: the previous one died with the old document.
  win.webContents.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) void connectWindow(win);
  });

  // Links never navigate the app window; vetted schemes open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://") && !(isDev && url.startsWith(process.env.UNICA_DEV_URL!))) event.preventDefault();
  });

  void win.loadURL(isDev ? process.env.UNICA_DEV_URL! : "app://unica/");
  return win;
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "Ver",
      submenu: [{ role: "reload" }, { role: "toggleDevTools", visible: isDev }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on("unica:version", (e) => {
  e.returnValue = app.getVersion();
});
ipcMain.on("unica:open-external", (_e, url: string) => {
  if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
});
ipcMain.handle("unica:agent-info", () => {
  const res = resourcesDir();
  return { mcpCommand: join(res, "bin", "unica-mcp"), socketPath: agentPaths().socketPath, skillPath: join(res, "mcp", "SKILL.md") };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = [...windows][0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(() => {
    registerAppProtocol();
    buildMenu();
    startBackend();
    createWindow();
    app.on("activate", () => {
      if (windows.size === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    const child = backend;
    backend = null;
    child?.kill();
  });
}

