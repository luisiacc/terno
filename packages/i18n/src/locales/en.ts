/**
 * English: the source of truth. Every other locale is checked against this
 * file (keys, placeholders, tags). Flat keys, prefixed by area; sentence
 * case except macOS menu items (title case).
 *
 * - `{name}`: a value (numbers are formatted for the locale)
 * - `{ one: "…#…", other: "…#…" }`: a plural, one full sentence per category; `#` is the count
 * - `<b>…</b>`: rich text, rendered by rich()/richT() callbacks
 */
const en = {
  // ── common
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.done": "Done",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.edit": "Edit",
  "common.undo": "Undo",
  "common.retry": "Retry",
  "common.ok": "OK",
  "common.continue": "Continue",
  "common.back": "Back",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.reset": "Reset",
  "common.show": "Show",
  "common.view": "View",
  "common.dismiss": "Dismiss",
  "common.loading": "Loading…",
  "common.add": "Add",
  "common.apply": "Apply",
  "common.change": "Change",
  "common.connect": "Connect",
  "common.reconnect": "Reconnect",
  "common.send": "Send",
  "common.open": "Open",
  "common.search": "Search",
  "common.settings": "Settings",
  "common.always": "Always",
  "common.never": "Never",
  "common.ask": "Ask",
  "common.on": "On",
  "common.off": "Off",
  "common.noSubject": "(no subject)",
  "common.conversations": { one: "# conversation", other: "# conversations" },
  "common.messages": { one: "# message", other: "# messages" },

  // ── views and dates (lib/format.ts)
  "view.inbox": "Inbox",
  "view.starred": "Starred",
  "view.sent": "Sent",
  "view.archive": "Archive",
  "view.spam": "Spam",
  "view.trash": "Trash",
  "view.all": "All Mail",
  "date.yesterday": "Yesterday",
  "unit.days": { one: "day", other: "days" },

  // ── language (settings → general)
  "language.label": "Language",
  "language.hint": "The language of Terno’s menus, buttons and messages.",
  "language.system": "System ({language})",

  // ── app shell
  // @app

  // ── settings
  // @settings

  // ── list, reader, sidebar, menus, categories
  // @list

  // ── compose
  // @compose

  // ── palette, shortcuts, snack
  // @palette

  // ── print
  // @print

  // ── diagnostics
  // @diag

  // ── desktop menus (title case in English, macOS HIG)
  "menu.about": "About {app}",
  "menu.services": "Services",
  "menu.hide": "Hide {app}",
  "menu.hideOthers": "Hide Others",
  "menu.showAll": "Show All",
  "menu.quit": "Quit {app}",
  "menu.file": "File",
  "menu.print": "Print…",
  "menu.exportPdf": "Export as PDF…",
  "menu.edit": "Edit",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.pasteAndMatchStyle": "Paste and Match Style",
  "menu.delete": "Delete",
  "menu.selectAll": "Select All",
  "menu.speech": "Speech",
  "menu.startSpeaking": "Start Speaking",
  "menu.stopSpeaking": "Stop Speaking",
  "menu.view": "View",
  "menu.filterUnread": "Filter by Unread",
  "menu.reload": "Reload",
  "menu.devTools": "Toggle Developer Tools",
  "menu.actualSize": "Actual Size",
  "menu.zoomIn": "Zoom In",
  "menu.zoomOut": "Zoom Out",
  "menu.fullScreen": "Toggle Full Screen",
  "menu.window": "Window",
  "menu.minimize": "Minimize",
  "menu.zoom": "Zoom",
  "menu.front": "Bring All to Front",
  "menu.help": "Help",
  "menu.exportDiagnostics": "Export Diagnostics…",
  "menu.showLogs": "Show Logs",

  // ── desktop (dialogs, save panels)
  // @desktop

  // ── backend and providers (errors shown to the user)
  // @backend

  // ── web (storage, gate, onboarding)
  // @web

  // ── ui components
  // @ui
} as const;

export default en;
