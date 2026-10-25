/**
 * The only commands main sends the renderer (the Archivo and Ver menus); the
 * preload drops anything else. A module of its own with no imports: the
 * sandboxed preload can require nothing but electron.
 */
export const PRINT_COMMANDS = ["thread.print", "thread.exportPdf"] as const;
export type PrintCommand = (typeof PRINT_COMMANDS)[number];
export const MENU_COMMANDS = [...PRINT_COMMANDS, "list.toggleUnread", "updates.check"] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];
