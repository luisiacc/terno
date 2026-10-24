/**
 * The only commands main sends the renderer (the Archivo menu); the preload
 * drops anything else. A module of its own with no imports: the sandboxed
 * preload can require nothing but electron.
 */
export const PRINT_COMMANDS = ["thread.print", "thread.exportPdf"] as const;
export type PrintCommand = (typeof PRINT_COMMANDS)[number];
