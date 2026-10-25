/**
 * The updater's Electron side: the controller's deps (files under
 * userData/updates/, the location probe, the lazily required engine
 * bundle), its IPC (trusted like printing and diagnostics) and the state
 * pushed to every window.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { captureError, log } from "@terno/core/diag";
import type { UnsupportedReason, UpdateState } from "@terno/core/updates";
import { TEST_BUILD } from "../test-build";
import { STARTUP_CHECK_DELAY_MS, UpdateController, type InstallShutdown } from "./controller";
import type { createEngine } from "./engine";
import { bundleOf, parsePending, parsePrefs, resolveFeed, signedFromCodesign, unsupportedReason, type UpdatePrefs } from "./policy";

export interface UpdatesMainDeps {
  trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean;
  windows(): Iterable<BrowserWindow>;
  localMode(): boolean;
  shutdown(): Promise<InstallShutdown>;
  onSendsIdle(cb: () => void): void;
  recover(): void;
}

/** codesign and the bundle's folder: can Squirrel replace this copy, and will it accept a signed update? */
async function probe(): Promise<UnsupportedReason | null> {
  const bundle = bundleOf(process.execPath);
  if (!app.isPackaged || !bundle) return unsupportedReason({ packaged: false, signed: null, translated: false, bundlePath: "", volumeReadOnly: false, parentWritable: false });
  const signed = await new Promise<boolean | null>((resolve) =>
    execFile("codesign", ["-dv", "--verbose=2", bundle], { timeout: 10_000 }, (_error, stdout, stderr) => resolve(signedFromCodesign(`${stdout}\n${stderr}`))),
  );
  const writable = await new Promise<NodeJS.ErrnoException | null>((resolve) => access(dirname(bundle), constants.W_OK, resolve));
  return unsupportedReason({
    packaged: true,
    signed,
    translated: app.runningUnderARM64Translation === true,
    bundlePath: bundle,
    volumeReadOnly: writable?.code === "EROFS",
    parentWritable: writable === null,
  });
}

export function startUpdates(deps: UpdatesMainDeps): UpdateController {
  const dir = join(app.getPath("userData"), "updates");
  const prefsFile = join(dir, "prefs.json");
  const pendingFile = join(dir, "pending.json");
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  // prefs go out asynchronously, one write at a time, the latest winning
  let prefsWrite: Promise<void> = Promise.resolve();
  const writePrefs = (p: UpdatePrefs) => {
    prefsWrite = prefsWrite.then(async () => {
      try {
        mkdirSync(dir, { recursive: true });
        await writeFile(prefsFile, JSON.stringify(p), { mode: 0o600 });
      } catch (error) {
        log.warn("update.failed", { stage: "other", errno: (error as { code?: string }).code });
      }
    });
  };

  const publish = (state: UpdateState) => {
    for (const w of deps.windows()) if (!w.isDestroyed()) w.webContents.send("terno:updates-event", state);
  };

  const controller = new UpdateController(
    {
      version: app.getVersion(),
      feed: resolveFeed(TEST_BUILD),
      testFeed: TEST_BUILD?.feed ?? null,
      checkDelayMs: TEST_BUILD?.checkDelayMs ?? STARTUP_CHECK_DELAY_MS,
      // its own bundle (dist/updater.cjs, electron-updater inside): main.cjs stays small and never loads it before the first check
      loadEngine: (o) => (require(join(__dirname, "updater.cjs")) as { createEngine: typeof createEngine }).createEngine(o),
      probe,
      prefs: { read: () => parsePrefs(readJson(prefsFile)), write: writePrefs },
      pending: {
        read: () => parsePending(readJson(pendingFile)),
        // just before quitting: synchronous, so it's on disk before Squirrel takes over
        write: (p) => {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(pendingFile, JSON.stringify(p), { mode: 0o600 });
          } catch (error) {
            log.warn("update.failed", { stage: "install", errno: (error as { code?: string }).code });
          }
        },
        clear: () => rmSync(pendingFile, { force: true }),
      },
      shutdown: deps.shutdown,
      onSendsIdle: deps.onSendsIdle,
      recover: deps.recover,
      publish,
      log: (code, fields) => log.info(code, fields as never),
      capture: (error, code, fields, expected) => void captureError(error, { code, fields: fields as never, expected }),
      newId: () => randomUUID(),
      now: Date.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    deps.localMode(),
  );

  ipcMain.handle("terno:updates-state", (e) => (deps.trusted(e) ? controller.view : null));
  ipcMain.handle("terno:updates-check", (e) => (deps.trusted(e) ? controller.check("manual") : null));
  ipcMain.handle("terno:updates-download", (e) => (deps.trusted(e) ? controller.download("manual") : null));
  ipcMain.handle("terno:updates-install", (e) => (deps.trusted(e) ? controller.install() : null));
  ipcMain.handle("terno:updates-prefs", (e, value: unknown) => {
    if (!deps.trusted(e) || !value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if ((v.mode !== "auto" && v.mode !== "manual") || (v.channel !== "stable" && v.channel !== "nightly")) return null;
    controller.setPrefs({ mode: v.mode, channel: v.channel });
    return controller.view;
  });
  ipcMain.on("terno:updates-seen", (e) => {
    if (deps.trusted(e)) controller.seen();
  });

  controller.start();
  return controller;
}
