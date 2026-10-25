import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "./print-commands";

/** The app menu as macOS draws it, with "Check for Updates…" under About (as in every Mac app). */
export function appMenu(name: string, checkForUpdates: () => void): MenuItemConstructorOptions {
  return {
    label: name,
    submenu: [
      { role: "about" },
      { id: "check-for-updates", label: "Check for Updates…", click: checkForUpdates },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

/**
 * Ver: Mail's message filter first (View → Filter), sent to the renderer,
 * which decides like it does for ⌘L; then the window's own items.
 */
export function viewMenu(send: (command: MenuCommand) => void, dev: boolean): MenuItemConstructorOptions {
  return {
    label: "Ver",
    submenu: [
      { id: "unread-filter", label: "Filter by Unread", accelerator: "CmdOrCtrl+L", click: () => send("list.toggleUnread") },
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools", visible: dev },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}
