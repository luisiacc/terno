import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "./print-commands";

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
