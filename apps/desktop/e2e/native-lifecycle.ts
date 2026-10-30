import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, TestInfo } from "@playwright/test";

const directory = process.env.TERNO_NATIVE_TRACE_DIR;
let records = 0;
export function nativeLifecycle(event: string, details: unknown = null): void {
  if (!directory || records++ >= 5000) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, `worker-${process.pid}.jsonl`), JSON.stringify({ at: new Date().toISOString(), monotonic: performance.now(), pid: process.pid, event, details }) + "\n");
}

export function nativeDeadline(phase: string, info: TestInfo): void {
  nativeLifecycle(phase, { title: info.title, timeout: info.timeout, status: info.status, expectedStatus: info.expectedStatus, elapsed: info.duration, errors: info.errors });
}

export async function traceNative(app: ElectronApplication): Promise<void> {
  if (!directory) return;
  const child = app.process(), pid = child.pid!;
  nativeLifecycle("app-captured", { pid, birth: execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() });
  child.on("exit", (code, signal) => nativeLifecycle("app-process-exit", { pid, code, signal }));
  child.on("close", (code, signal) => nativeLifecycle("app-process-close", { pid, code, signal }));
  let stderr = 0;
  child.stderr?.on("data", (data: Buffer) => {
    if (stderr >= 1024 * 1024) return;
    const part = data.subarray(0, 1024 * 1024 - stderr); stderr += part.length;
    appendFileSync(join(directory, `app-${pid}.stderr.log`), part);
    nativeLifecycle("stderr", { pid, bytes: part.length, text: part.toString() });
  });
  app.on("close", () => nativeLifecycle("electron-application-close", { pid }));
  const context = app.context();
  context.on("close", () => nativeLifecycle("context-close", { pid }));
  const watch = (page: import("@playwright/test").Page) => {
    page.on("close", () => nativeLifecycle("page-close", { pid }));
    page.on("crash", () => nativeLifecycle("page-crash", { pid }));
  };
  context.pages().forEach(watch); context.on("page", watch);
  await app.evaluate(async ({ app: a, BrowserWindow, Menu }, directory) => {
    const { appendFileSync } = process.getBuiltinModule("fs");
    const { join } = process.getBuiltinModule("path");
    let records = 0;
    const record = (event: string, details: unknown = null) => {
      if (records++ < 1000) appendFileSync(join(directory, `main-${process.pid}.jsonl`), JSON.stringify({ at: new Date().toISOString(), event, details, pid: process.pid }) + "\n");
    };
    const quit = a.quit.bind(a), exit = a.exit.bind(a);
    a.quit = () => { record("app.quit-call", { stack: new Error().stack }); quit(); };
    a.exit = (code) => { record("app.exit-call", { code, stack: new Error().stack }); exit(code); };
    const visitMenu = (menu: Electron.Menu) => {
      for (const item of menu.items) {
        if (item.role === "quit") {
          const click = item.click.bind(item);
          item.click = (...args: unknown[]) => { record("quit-menu-click", { stack: new Error().stack }); Reflect.apply(click, item, args); };
        }
        if (item.submenu) visitMenu(item.submenu);
      }
    };
    const menu = Menu.getApplicationMenu(); if (menu) visitMenu(menu);
    const watch = (window: Electron.BrowserWindow) => {
      const id = window.id, contents = window.webContents;
      const events: NodeJS.EventEmitter = window;
      for (const event of ["close", "closed", "focus", "blur"] as const) events.on(event, () => record(`window-${event}`, { id }));
      contents.on("before-input-event", (_event, input) => {
        if (input.meta || input.control || input.key === "Meta" || input.key === "Control") record("modified-key", { id, type: input.type, key: input.key, code: input.code, meta: input.meta, control: input.control, shift: input.shift });
      });
      const close = window.close.bind(window), destroy = window.destroy.bind(window);
      window.close = () => { record("window.close-call", { id, stack: new Error().stack }); close(); };
      window.destroy = () => { record("window.destroy-call", { id, stack: new Error().stack }); destroy(); };
      contents.on("destroyed", () => record("contents-destroyed", { id }));
      contents.on("render-process-gone", (_event, details) => record("render-process-gone", { id, ...details }));
      contents.on("did-start-navigation", (_e, url, inPlace, main) => record("navigation", { id, url, inPlace, main }));
    };
    BrowserWindow.getAllWindows().forEach(watch);
    a.on("browser-window-created", (_e, window) => watch(window));
    a.on("before-quit", () => record("before-quit", { stack: new Error().stack }));
    a.on("will-quit", () => record("will-quit"));
    a.on("quit", (_e, code) => record("quit", { code }));
    a.on("child-process-gone", (_e, details) => record("child-process-gone", details));
    record("installed", { windows: BrowserWindow.getAllWindows().map((w) => w.id), processes: a.getAppMetrics().map(({ pid, type, name }) => ({ pid, type, name })) });
  }, directory);
}

export function preserveNativeProfile(profile: string, info: TestInfo): void {
  if (!directory || !existsSync(profile)) return;
  const target = join(directory, `synthetic-profile-${process.pid}-${info.testId.replace(/\W/g, "_")}`);
  mkdirSync(target, { recursive: true });
  for (const name of ["crashes", "diag", "logs", "terno.db", "terno.db-wal", "terno.db-shm"]) {
    const source = join(profile, name);
    if (existsSync(source)) cpSync(source, join(target, name), { recursive: true });
  }
  nativeLifecycle("synthetic-profile-preserved", { profile, target });
}
