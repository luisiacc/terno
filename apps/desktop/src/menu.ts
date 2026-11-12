import { t } from "@terno/i18n";
import type { BaseWindow, MenuItemConstructorOptions } from "electron";
import type { MenuCommand, PrintCommand } from "./print-commands";

/**
 * The menu bar, in the active locale, kept apart from Electron so it's
 * unit-tested in Node. The App, Edit and Window menus are written out item
 * by item: a whole-menu role (appMenu, editMenu, windowMenu) generates
 * Electron's English labels, so every item keeps its role (its behavior)
 * and gets a label from the catalog. Rebuilt when the language changes.
 */
export interface MenuActions {
  appName: string;
  /** process.platform: macOS gets its app and Window menus; elsewhere the menu bar sits in the window (plan 189) */
  platform: NodeJS.Platform;
  dev: boolean;
  send: (command: MenuCommand) => void;
  reload: (ignoreCache: boolean, focusedWindow?: BaseWindow) => void;
  exportDiagnostics: () => void;
  showLogs: () => void;
  checkForUpdates: () => void;
}

/** The app menu as macOS draws it, with "Check for Updates…" under About (as in every Mac app). */
export function appMenu(appName: string, checkForUpdates: () => void): MenuItemConstructorOptions {
  return {
    label: appName,
    submenu: [
      { role: "about", label: t("menu.about", { app: appName }) },
      { id: "check-for-updates", label: t("menu.checkForUpdates"), click: checkForUpdates },
      { type: "separator" },
      { role: "services", label: t("menu.services") },
      { type: "separator" },
      { role: "hide", label: t("menu.hide", { app: appName }) },
      { role: "hideOthers", label: t("menu.hideOthers") },
      { role: "unhide", label: t("menu.showAll") },
      { type: "separator" },
      { role: "quit", label: t("menu.quit", { app: appName }) },
    ],
  };
}

/**
 * Archivo / File: each item sends a command to the renderer, which decides like it does for the key (the menu never
 * prints the app window). Off macOS there's no app menu, so Quit ends File, as on Linux and Windows.
 */
export function fileMenu(send: (command: PrintCommand) => void, quit?: { appName: string }): MenuItemConstructorOptions {
  return {
    label: t("menu.file"),
    submenu: [
      { id: "print", label: t("menu.print"), accelerator: "CmdOrCtrl+P", click: () => send("thread.print") },
      { id: "export-pdf", label: t("menu.exportPdf"), accelerator: "CmdOrCtrl+Shift+P", click: () => send("thread.exportPdf") },
      ...(quit ? ([{ type: "separator" }, { role: "quit", label: t("menu.quit", { app: quit.appName }) }] as const) : []),
    ],
  };
}

/** Edit; macOS adds Paste and Match Style and its Speech submenu, which do nothing elsewhere. */
export function editMenu(mac = true): MenuItemConstructorOptions {
  if (!mac) {
    return {
      label: t("menu.edit"),
      submenu: [
        { role: "undo", label: t("menu.undo") },
        { role: "redo", label: t("menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "delete", label: t("menu.delete") },
        { role: "selectAll", label: t("menu.selectAll") },
      ],
    };
  }
  return {
    label: t("menu.edit"),
    submenu: [
      { role: "undo", label: t("menu.undo") },
      { role: "redo", label: t("menu.redo") },
      { type: "separator" },
      { role: "cut", label: t("menu.cut") },
      { role: "copy", label: t("menu.copy") },
      { role: "paste", label: t("menu.paste") },
      { role: "pasteAndMatchStyle", label: t("menu.pasteAndMatchStyle") },
      { role: "delete", label: t("menu.delete") },
      { role: "selectAll", label: t("menu.selectAll") },
      { type: "separator" },
      {
        label: t("menu.speech"),
        submenu: [
          { role: "startSpeaking", label: t("menu.startSpeaking") },
          { role: "stopSpeaking", label: t("menu.stopSpeaking") },
        ],
      },
    ],
  };
}

/**
 * Ver / View: Mail's message filter first (View → Filter), sent to the
 * renderer, which decides like it does for the header button (no key: ⌘L is
 * the composer's link); then the window's own items.
 */
export function viewMenu(send: (command: MenuCommand) => void, dev: boolean, reload: (ignoreCache: boolean, focusedWindow?: BaseWindow) => void): MenuItemConstructorOptions {
  return {
    label: t("menu.view"),
    submenu: [
      { id: "unread-filter", label: t("menu.filterUnread"), click: () => send("list.toggleUnread") },
      { type: "separator" },
      // plan 24: the List layout's Back and Forward (the renderer decides; nothing in Split). The accelerators also reach a mail's frame.
      { id: "nav-back", label: t("menu.back"), accelerator: "CmdOrCtrl+[", click: () => send("nav.back") },
      { id: "nav-forward", label: t("menu.forward"), accelerator: "CmdOrCtrl+]", click: () => send("nav.forward") },
      { type: "separator" },
      { id: "native-reload", label: t("menu.reload"), accelerator: "CmdOrCtrl+R", click: (_item, window) => reload(false, window) },
      { id: "native-force-reload", label: t("menu.reload"), accelerator: "CmdOrCtrl+Shift+R", visible: false, acceleratorWorksWhenHidden: true, click: (_item, window) => reload(true, window) },
      { role: "toggleDevTools", label: t("menu.devTools"), visible: dev },
      { type: "separator" },
      { role: "resetZoom", label: t("menu.actualSize") },
      { role: "zoomIn", label: t("menu.zoomIn") },
      { role: "zoomOut", label: t("menu.zoomOut") },
      { type: "separator" },
      { role: "togglefullscreen", label: t("menu.fullScreen") },
    ],
  };
}

/** The Window menu: its role keeps macOS's window list and behaviors. */
export function windowMenu(): MenuItemConstructorOptions {
  return {
    role: "window",
    label: t("menu.window"),
    submenu: [{ role: "minimize", label: t("menu.minimize") }, { role: "zoom", label: t("menu.zoom") }, { type: "separator" }, { role: "front", label: t("menu.front") }],
  };
}

/**
 * Help: diagnostics for a problem report (macOS puts the menu's search field here too). Off macOS it also holds
 * what the app menu would: Check for Updates… first, About last.
 */
export function helpMenu(o: { exportDiagnostics: () => void; showLogs: () => void }, app?: { appName: string; checkForUpdates: () => void }): MenuItemConstructorOptions {
  const diagnostics: MenuItemConstructorOptions[] = [
    { id: "export-diagnostics", label: t("menu.exportDiagnostics"), click: o.exportDiagnostics },
    { id: "show-logs", label: t("menu.showLogs"), click: o.showLogs },
  ];
  return {
    role: "help",
    label: t("menu.help"),
    submenu: app
      ? [
          { id: "check-for-updates", label: t("menu.checkForUpdates"), click: app.checkForUpdates },
          { type: "separator" },
          ...diagnostics,
          { type: "separator" },
          { role: "about", label: t("menu.about", { app: app.appName }) },
        ]
      : diagnostics,
  };
}

export function menuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  if (a.platform !== "darwin") return [fileMenu(a.send, a), editMenu(false), viewMenu(a.send, a.dev, a.reload), helpMenu(a, a)];
  return [appMenu(a.appName, a.checkForUpdates), fileMenu(a.send), editMenu(), viewMenu(a.send, a.dev, a.reload), windowMenu(), helpMenu(a)];
}
