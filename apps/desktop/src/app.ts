import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  session,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { diagSession, log as diagLog } from "@terno/core/diag";
import { isLanguageSetting } from "@terno/i18n";
import { parseAppearance, windowVibrancy, type Appearance } from "./appearance";
import { BUILD_ID } from "./diag/build-info";
import { mainDiag } from "./diag/main";
import { RestartPolicy } from "./diag/supervisor";
import type { BackendToMain, MainToBackend } from "./ipc";
import { readLegacySecrets } from "./keychain-helper";
import { DB_FILE } from "./legacy-profile";
import { printLocalModeChanged, registerPrint } from "./print";
import { isTrustedSender, testPdfDir, testSmtpPort } from "./print-policy";
import { menuTemplate } from "./menu";
import { readLanguage, switchLanguage, writeLanguage } from "./locale";
import type { MenuCommand } from "./print-commands";
import { LEGACY_STORAGE_PENDING } from "./profile";
import { coordinateShutdown, type BackendOutcome, type ShutdownOutcome } from "./shutdown";
import type { UpdateController } from "./updates/controller";
import { startUpdates } from "./updates/main";

// V8 compile cache for the main bundle (t3code trick): faster subsequent boots.
try {
  (require("node:module") as { enableCompileCache?: (dir?: string) => void }).enableCompileCache?.();
} catch {
  /* older runtimes */
}

// main.ts named the app and set userData (profile.ts) before loading this
const isDev = Boolean(process.env.TERNO_DEV_URL);
const demo = process.env.TERNO_DEMO === "1" || process.argv.includes("--demo");

// Privileged scheme: standard + secure origin and, crucially, V8 code cache for renderer scripts (file:// has none).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const RENDERER_DIR = join(__dirname, "renderer");
const APP_ORIGIN = "app://terno";
/** the renderer's origin when the app was called Única (its localStorage moves once, see carryLegacyLocalStorage) */
const LEGACY_ORIGIN = "app://unica";
/** an empty page on either origin, to read or write its localStorage */
const STORAGE_PAGE = "/__storage-migration";
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
    if (url.pathname === STORAGE_PAGE) return new Response("<!doctype html><title></title>", { headers: { "Content-Type": "text/html", "Content-Security-Policy": CSP } });
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

// ───────────────────────────── local mode backstop ─────────────────────────────

/** Fail closed: until the backend reports the policy, the renderer is treated as in local mode. */
let localMode = true;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * The backend polices its own connections; this fences the renderer (remote
 * images, fonts, anything a mail or a bug could load). In local mode only
 * loopback is reachable over http(s)/ws(s); app:// and data: never hit the network.
 */
function installNetworkBackstop() {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
    let host = "";
    try {
      host = new URL(details.url).hostname;
    } catch {
      return callback({ cancel: true });
    }
    callback({ cancel: localMode && !isLoopbackHost(host) });
  });
}

// ───────────────────────────── backend utility process ─────────────────────────────

let backend: UtilityProcess | null = null;
let backendReady: Promise<void> = Promise.resolve();
let releaseReadyWaiters: () => void = () => {};
let clientSeq = 0;
let backendInstance = 0;
const restarts = new RestartPolicy();
const windows = new Set<BrowserWindow>();

function agentPaths() {
  const userData = app.getPath("userData");
  return { socketPath: join(userData, "agent.sock"), tokenPath: join(userData, "agent.token") };
}

function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : join(__dirname, "..", "resources");
}

/** Main's free-form lines: the log keeps that one happened (never its text); a dev build also prints it. */
function log(level: "info" | "warn" | "error", message: string) {
  diagLog[level]("log.message", { source: "main" });
  if (!app.isPackaged) process.stderr.write(`[main:${level}] ${message}\n`);
}

function startBackend() {
  const userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  const instance = ++backendInstance;
  const startedAt = Date.now();
  const child = utilityProcess.fork(join(__dirname, "backend.cjs"), [], { serviceName: "Terno Mail Engine", stdio: "inherit" });
  backend = child;
  restarts.started(startedAt);
  diagLog.info("backend.started", { attempt: restarts.attempt });
  let resolveReady!: () => void;
  backendReady = new Promise((r) => (resolveReady = r));
  releaseReadyWaiters = () => resolveReady();
  child.on("message", (msg: BackendToMain) => {
    switch (msg.type) {
      case "ready":
        resolveReady();
        mainDiag.setEngine("running");
        diagLog.info("backend.ready", { attempt: restarts.attempt, durationMs: Date.now() - startedAt });
        // migrations are done and the mailbox opened: an install that just happened counts as applied now
        updates?.backendReady();
        break;
      case "shutdown-result":
        if (shutdownWaiters.has(msg.id)) {
          shutdownWaiters.get(msg.id)!(msg.outcome);
          shutdownWaiters.delete(msg.id);
        } else if (msg.outcome !== "sending" && quitState === "running") {
          // it closed after main stopped waiting (an install put off on a timeout): a fresh backend takes over
          stopBackend();
          restartEngine();
        }
        break;
      case "sends-idle":
        for (const cb of sendsIdleWaiters.splice(0)) cb();
        break;
      case "diag":
        mainDiag.backendEntries(instance, msg.entries);
        break;
      case "diag-ring":
        mainDiag.backendRing(instance, msg.crumbs);
        break;
      case "diag-record":
        mainDiag.backendRecord(instance, msg.record);
        break;
      case "policy":
        localMode = msg.localMode;
        printLocalModeChanged(localMode);
        mainDiag.setPolicy(msg);
        updates?.setLocalMode(localMode);
        void followLanguage(msg.language);
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
          diagLog.warn("keychain.secret_failed", { op: msg.op, errorClass: error instanceof Error ? error.name : "Error" });
          child.postMessage({ type: "secret-result", id: msg.id, ok: false, error: String(error) } satisfies MainToBackend);
        }
        break;
      case "legacy-secrets":
        // sealed by Única: opened by the helper under the old name, sealed again by the backend
        readLegacySecrets(msg.blobs.map((b) => Uint8Array.from(b))).then(
          (values) => child.postMessage({ type: "secret-result", id: msg.id, ok: true, value: values } satisfies MainToBackend),
          (error: unknown) => child.postMessage({ type: "secret-result", id: msg.id, ok: false, error: String(error) } satisfies MainToBackend),
        );
        break;
    }
  });
  child.on("exit", (code) => {
    // nothing is sending any more, and a shutdown it didn't answer won't be
    for (const resolve of shutdownWaiters.values()) resolve("forced");
    shutdownWaiters.clear();
    for (const cb of sendsIdleWaiters.splice(0)) cb();
    // a deliberate stop (quit, restart) cleared `backend` first: nothing to record
    if (backend !== child) return;
    backend = null;
    // windows waiting for this backend stop waiting (they reconnect to the next one)
    releaseReadyWaiters();
    mainDiag.backendExited(instance, code, restarts.attempt);
    const delay = restarts.exited(Date.now());
    if (delay === null) {
      diagLog.error("backend.stopped", { attempt: restarts.attempt });
      mainDiag.setEngine("stopped");
      return;
    }
    mainDiag.setEngine("restarting");
    diagLog.info("backend.restart_scheduled", { attempt: restarts.attempt, delayMs: delay });
    setTimeout(() => {
      if (backend) return;
      startBackend();
      for (const w of windows) void connectWindow(w);
    }, delay);
  });
  child.postMessage({
    type: "init",
    dbPath: join(userData, DB_FILE),
    demo,
    dev: isDev,
    ...agentPaths(),
    version: app.getVersion(),
    diag: { session: diagSession(), build: BUILD_ID, channel: mainDiag.channel },
    testSmtpPort: testSmtpPort(process.env, app.isPackaged, demo) ?? undefined,
  } satisfies MainToBackend);
}

// ───────────────────────────── quitting: drafts, then the backend (shutdown.ts) ─────────────────────────────

/** running → stopping (the coordinated shutdown) → stopped (the backend closed; quitting goes through) */
let quitState: "running" | "stopping" | "stopped" = "running";
let shutdownSeq = 0;
const shutdownWaiters = new Map<number, (outcome: BackendOutcome) => void>();
const sendsIdleWaiters: (() => void)[] = [];
/** renderers that flush their drafts when asked (they say so once their page is up) */
const flushers = new Set<number>();
let flushSeq = 0;
const flushWaiters = new Map<string, () => void>();
let updates: UpdateController | null = null;

ipcMain.on("terno:flush-ready", (e) => {
  if (trusted(e)) flushers.add(e.sender.id);
});
ipcMain.on("terno:flush-done", (e, id: unknown) => {
  const key = `${e.sender.id}:${String(id)}`;
  flushWaiters.get(key)?.();
  flushWaiters.delete(key);
});

function flushWindows(): Promise<void>[] {
  return [...windows]
    .filter((w) => !w.isDestroyed() && flushers.has(w.webContents.id))
    .map(
      (w) =>
        new Promise<void>((resolve) => {
          const id = ++flushSeq;
          flushWaiters.set(`${w.webContents.id}:${id}`, resolve);
          w.webContents.send("terno:flush-drafts", id);
        }),
    );
}

function shutdownBackend(o: { deadlineMs: number; force: boolean }): Promise<BackendOutcome> | null {
  const child = backend;
  if (!child) return null;
  const id = ++shutdownSeq;
  return new Promise((resolve) => {
    shutdownWaiters.set(id, resolve);
    child.postMessage({ type: "shutdown", id, deadlineMs: o.deadlineMs, force: o.force } satisfies MainToBackend);
  });
}

/** The backend is done (closed, or given up on): it goes, deliberately (its exit is nothing to record). */
function stopBackend() {
  const child = backend;
  backend = null;
  child?.kill();
}

async function shutdown(force: boolean, trigger: "quit" | "restart"): Promise<ShutdownOutcome> {
  const started = Date.now();
  const r = await coordinateShutdown({ flushWindows, shutdownBackend, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, { force });
  if (r.draftsTimedOut) diagLog.warn("shutdown.drafts_timeout", { count: r.draftsTimedOut });
  diagLog.info("shutdown.done", { outcome: r.outcome, durationMs: Date.now() - started, trigger });
  // an update's restart never kills a backend that didn't answer (it may be mid-send): the install waits instead
  if (r.outcome === "closed" || r.outcome === "forced" || (r.outcome === "timeout" && force)) stopBackend();
  return r.outcome;
}

/** "Restart now": the shutdown not forced (a send in flight answers "sending" and the backend keeps running). */
async function shutdownForInstall(): Promise<ShutdownOutcome> {
  if (quitState !== "running") return "closed";
  quitState = "stopping";
  const outcome = await shutdown(false, "restart");
  quitState = outcome === "closed" ? "stopped" : "running";
  return outcome;
}

/** "Reintentar" after the engine stopped: a fresh series of attempts. */
function restartEngine() {
  restarts.reset();
  if (backend) return;
  diagLog.info("engine.restarted");
  startBackend();
  for (const w of windows) void connectWindow(w);
}

/** Gives the window's renderer a direct MessagePort to the backend. */
async function connectWindow(win: BrowserWindow) {
  await backendReady;
  if (!backend || win.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  backend.postMessage({ type: "port", clientId: `renderer-${++clientSeq}` } satisfies MainToBackend, [port1]);
  win.webContents.postMessage("terno:backend-port", null, [port2]);
}

// ───────────────────────────── renderer storage from Única ─────────────────────────────

/**
 * localStorage belongs to an origin, and the renderer moved from app://unica
 * to app://terno. In a profile that came from Única (profile.ts leaves a
 * marker), a hidden window reads what the old origin kept (the cached
 * appearance, first-run progress) and writes it under the new one without
 * overwriting anything; the old origin is cleared only after every key reads
 * back, and the marker goes (a failure retries on the next launch). The
 * renderer renames the keys themselves (theme.js).
 */
async function carryLegacyLocalStorage(): Promise<void> {
  const pending = join(app.getPath("userData"), LEGACY_STORAGE_PENDING);
  if (!existsSync(pending)) return;
  const done = () => rmSync(pending, { force: true });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL(`${LEGACY_ORIGIN}${STORAGE_PAGE}`);
    const entries = JSON.parse(await win.webContents.executeJavaScript("JSON.stringify(Object.entries(localStorage))")) as [string, string][];
    if (entries.length) {
      await win.loadURL(`${APP_ORIGIN}${STORAGE_PAGE}`);
      const verified = (await win.webContents.executeJavaScript(
        `(() => { const e = ${JSON.stringify(entries)}; for (const [k, v] of e) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); return e.every(([k]) => localStorage.getItem(k) !== null); })()`,
      )) as boolean;
      if (!verified) throw new Error("the copied keys didn't read back");
      await session.defaultSession.clearStorageData({ origin: LEGACY_ORIGIN, storages: ["localstorage"] });
      log("info", `moved ${entries.length} localStorage key(s) from ${LEGACY_ORIGIN} to ${APP_ORIGIN}`);
    }
    done();
  } catch (error) {
    diagLog.warn("legacy.storage_failed", { errorClass: error instanceof Error ? error.name : "Error" });
  } finally {
    win.destroy();
  }
}

// ───────────────────────────── appearance ─────────────────────────────

const appearancePath = () => join(app.getPath("userData"), "appearance.json");

/** Read once at launch so the first window opens with the right background and vibrancy (no flash). */
function readAppearance(): Appearance | null {
  try {
    return parseAppearance(JSON.parse(readFileSync(appearancePath(), "utf8")));
  } catch {
    return null;
  }
}

let appearance: Appearance | null = null;
let appearanceWrite: ReturnType<typeof setTimeout> | null = null;

function applyAppearanceTo(win: BrowserWindow, a: Appearance) {
  if (process.platform !== "darwin") {
    win.setBackgroundColor(a.background);
    return;
  }
  const vibrancy = windowVibrancy(true, a, nativeTheme.prefersReducedTransparency);
  win.setVibrancy(vibrancy ? "sidebar" : null);
  win.setBackgroundColor(vibrancy ? "#00000000" : a.background);
}

// the OS toggled reduced transparency (or the theme): every window follows at once
nativeTheme.on("updated", () => {
  if (!appearance) return;
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) applyAppearanceTo(win, appearance);
});

ipcMain.on("terno:appearance", (event, value: unknown) => {
  const next = parseAppearance(value);
  if (!next) return;
  const changed = JSON.stringify(next) !== JSON.stringify(appearance);
  appearance = next;
  if (nativeTheme.themeSource !== next.themeSource) nativeTheme.themeSource = next.themeSource;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) applyAppearanceTo(win, next);
  if (!changed) return;
  if (appearanceWrite) clearTimeout(appearanceWrite);
  appearanceWrite = setTimeout(() => {
    try {
      writeFileSync(appearancePath(), JSON.stringify(appearance));
    } catch (error) {
      diagLog.warn("appearance.save_failed", { errno: (error as { code?: string }).code });
    }
  }, 300);
});

// ───────────────────────────── windows ─────────────────────────────

function createWindow() {
  const isMac = process.platform === "darwin";
  const saved = appearance ?? readAppearance();
  if (saved && !appearance) {
    appearance = saved;
    nativeTheme.themeSource = saved.themeSource;
  }
  // named palettes render exactly: no vibrancy, the theme's own background from the first frame
  const vibrancy = windowVibrancy(isMac, saved, nativeTheme.prefersReducedTransparency);
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: "Terno",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    // centered on the 52 px toolbar row
    trafficLightPosition: { x: 20, y: 19 },
    vibrancy: vibrancy ? "sidebar" : undefined,
    visualEffectState: "followWindow",
    backgroundColor: vibrancy ? "#00000000" : (saved?.background ?? (nativeTheme.shouldUseDarkColors ? "#1c1d22" : "#fcfcfa")),
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

  // Every (re)load gets a fresh port: the previous one died with the old document (and its draft flusher with it).
  const contentsId = win.webContents.id;
  win.webContents.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      flushers.delete(contentsId);
      void connectWindow(win);
    }
  });
  win.on("closed", () => flushers.delete(contentsId));

  // Links never navigate the app window; vetted schemes open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://") && !(isDev && url.startsWith(process.env.TERNO_DEV_URL!))) event.preventDefault();
  });

  void win.loadURL(isDev ? process.env.TERNO_DEV_URL! : `${APP_ORIGIN}/`);
  return win;
}

/** Menu commands go to the focused Terno window's renderer, which applies them like their keys. */
function sendCommand(command: MenuCommand) {
  const win = BrowserWindow.getFocusedWindow() ?? [...windows][0];
  if (win && windows.has(win) && !win.isDestroyed()) win.webContents.send("terno:command", command);
}

function buildMenu() {
  // the window answers with its own snack (up to date, found, why not); with none open, the check just runs
  const checkForUpdates = () => {
    const win = BrowserWindow.getFocusedWindow() ?? [...windows][0];
    if (win && windows.has(win) && !win.isDestroyed()) sendCommand("updates.check");
    else void updates?.check("manual");
  };
  const template = menuTemplate({
    appName: app.getName(),
    dev: isDev,
    send: sendCommand,
    exportDiagnostics: () => void mainDiag.exportInteractive(BrowserWindow.getFocusedWindow()),
    showLogs: () => mainDiag.showLogs(),
    checkForUpdates,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────────── language ─────────────────────────────

/** The setting as main last saw it (locale.json until the backend reports). */
let language = readLanguage(app.getPath("userData"));
let languageSeq = 0;

/** Smoke tests pin the system's languages (dev builds and the demo mailbox only); the renderer gets the same. */
const pinnedLanguages = process.env.TERNO_TEST_LANGUAGES && (!app.isPackaged || demo) ? process.env.TERNO_TEST_LANGUAGES.split(",") : null;
if (pinnedLanguages) app.commandLine.appendSwitch("lang", pinnedLanguages[0]!);
const systemLanguages = () => pinnedLanguages ?? app.getPreferredSystemLanguages();

/** The backend reported the language setting: saved for the next start, and the menu rebuilt in it. */
async function followLanguage(next: unknown) {
  if (!isLanguageSetting(next) || next === language) return;
  language = next;
  writeLanguage(app.getPath("userData"), next);
  const mine = ++languageSeq;
  const changed = await switchLanguage(next, systemLanguages());
  if (changed && mine === languageSeq && app.isReady()) buildMenu();
}

ipcMain.on("terno:version", (e) => {
  e.returnValue = app.getVersion();
});
ipcMain.on("terno:open-external", (_e, url: string) => {
  if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
});
ipcMain.handle("terno:agent-info", () => {
  const res = resourcesDir();
  return { mcpCommand: join(res, "bin", "terno-mcp"), socketPath: agentPaths().socketPath, skillPath: join(res, "mcp", "SKILL.md") };
});

/** Only the app's own page, in one of Terno's windows, top frame (printing and diagnostics alike). */
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  return Boolean(win && windows.has(win) && frame) && isTrustedSender(frame!.url, frame === event.sender.mainFrame, isDev ? process.env.TERNO_DEV_URL! : null);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // the run marker and crash dumps belong to the instance that holds the lock
  mainDiag.open(app.getPath("userData"), { trusted, windows: () => windows, demo, restartEngine });
  app.on("second-instance", () => {
    const w = [...windows][0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(async () => {
    registerAppProtocol();
    installNetworkBackstop();
    registerPrint({
      trusted,
      localMode: () => localMode,
      testPdfDir: testPdfDir(process.env, app.isPackaged, demo),
    });
    await switchLanguage(language, systemLanguages());
    buildMenu();
    startBackend();
    // nothing runs before its startup delay (no engine loaded, no request)
    updates = startUpdates({
      trusted,
      windows: () => windows,
      localMode: () => localMode,
      shutdown: shutdownForInstall,
      onSendsIdle: (cb) => void sendsIdleWaiters.push(cb),
      recover: () => {
        quitState = "running";
        restartEngine();
      },
    });
    await carryLegacyLocalStorage();
    createWindow();
    app.on("activate", () => {
      if (windows.size === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // Every quit: drafts flushed, the backend closed cleanly (WAL checkpointed), then out. The windows go
  // at once; a send in flight may hold the process for up to SEND_DEADLINE_MS. With an update ready,
  // Squirrel installs it as the app exits (updates.quitting records it for the next run's check).
  app.on("before-quit", (event) => {
    if (quitState === "stopped") return;
    event.preventDefault();
    if (quitState === "stopping") return;
    quitState = "stopping";
    for (const w of windows) if (!w.isDestroyed()) w.hide();
    void shutdown(true, "quit").finally(() => {
      updates?.quitting();
      quitState = "stopped";
      app.quit();
    });
  });
}

