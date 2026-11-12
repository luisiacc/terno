import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocale, setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { LOCALE_FILE, readLanguage, switchLanguage, writeLanguage } from "./locale";
import { appMenu, fileMenu, menuTemplate, viewMenu } from "./menu";
import { MENU_COMMANDS, PRINT_COMMANDS } from "./print-commands";

afterEach(() => setLocale("en", en));

const actions = { appName: "Terno", platform: "darwin" as NodeJS.Platform, dev: false, send: () => {}, reload: () => {}, exportDiagnostics: () => {}, showLogs: () => {}, checkForUpdates: () => {} };
const sub = (item: MenuItemConstructorOptions) => item.submenu as MenuItemConstructorOptions[];
/** every label in the menu bar, nested items included */
const labels = (items: MenuItemConstructorOptions[]): string[] => items.flatMap((i) => [...(i.label ? [i.label] : []), ...(Array.isArray(i.submenu) ? labels(i.submenu) : [])]);

describe("main: the menu bar", () => {
  it("has Check for Updates… right under About, and keeps Quit", () => {
    let checked = 0;
    const items = sub(appMenu("Terno", () => checked++));
    expect(items[0]!.role).toBe("about");
    expect(items[1]!.label).toBe("Check for Updates…");
    (items[1]!.click as () => void)();
    expect(checked).toBe(1);
    expect(items.at(-1)!.role).toBe("quit");
  });

  it("leads View with Mail's message filter, a whitelisted command with no key (⌘L is the composer's link); dev tools only in development", () => {
    const sent: string[] = [];
    const items = sub(viewMenu((c) => sent.push(c), false, () => {}));
    expect([items[0]!.label, items[0]!.accelerator]).toEqual(["Filter by Unread", undefined]);
    (items[0]!.click as () => void)();
    expect(sent).toEqual(["list.toggleUnread"]);
    for (const c of sent) expect(MENU_COMMANDS).toContain(c);
    expect(items.find((i) => i.role === "toggleDevTools")!.visible).toBe(false);
    expect(sub(viewMenu(() => {}, true, () => {})).find((i) => i.role === "toggleDevTools")!.visible).toBe(true);
    // nothing in the menu claims ⌘L, or a draft's ⌘L would never reach the editor
    expect(items.filter((i) => i.accelerator === "CmdOrCtrl+L")).toHaveLength(0);
  });

  it("View has Back (⌘[) and Forward (⌘]) for the List layout, both whitelisted commands (plan 24)", () => {
    const sent: string[] = [];
    const items = sub(viewMenu((c) => sent.push(c), false, () => {}));
    const back = items.find((i) => i.id === "nav-back")!;
    const forward = items.find((i) => i.id === "nav-forward")!;
    expect([back.label, back.accelerator, forward.label, forward.accelerator]).toEqual(["Back", "CmdOrCtrl+[", "Forward", "CmdOrCtrl+]"]);
    (back.click as () => void)();
    (forward.click as () => void)();
    expect(sent).toEqual(["nav.back", "nav.forward"]);
    for (const c of sent) expect(MENU_COMMANDS).toContain(c);
  });

  it("File prints and exports through the renderer's commands", () => {
    const sent: string[] = [];
    const menu = fileMenu((c) => sent.push(c));
    expect(menu.label).toBe("File");
    expect(sub(menu).map((i) => [i.label, i.accelerator])).toEqual([
      ["Print…", "CmdOrCtrl+P"],
      ["Export as PDF…", "CmdOrCtrl+Shift+P"],
    ]);
    for (const i of sub(menu)) (i.click as () => void)();
    expect(sent).toEqual(["thread.print", "thread.exportPdf"]);
    for (const c of sent) expect(PRINT_COMMANDS).toContain(c);
  });

  it("ordinary and cache-bypass reload use guarded callbacks rather than native roles", () => {
    const requests: boolean[] = [];
    const items = sub(viewMenu(() => {}, false, (ignoreCache) => requests.push(ignoreCache)));
    const reload = items.find((i) => i.id === "native-reload")!;
    const force = items.find((i) => i.id === "native-force-reload")!;
    expect(items.some((i) => i.role === "reload" || i.role === "forceReload")).toBe(false);
    expect(reload.accelerator).toBe("CmdOrCtrl+R");
    expect(force.accelerator).toBe("CmdOrCtrl+Shift+R");
    (reload.click as () => void)(); (force.click as () => void)();
    expect(requests).toEqual([false, true]);
  });

  it("labels every item, nested ones included, so no Electron default (English) shows; roles keep their behavior", () => {
    const template = menuTemplate(actions);
    const walk = (items: MenuItemConstructorOptions[]) => {
      for (const i of items) {
        if (i.type === "separator") continue;
        expect(i.label, JSON.stringify(i.role)).toBeTruthy();
        // a whole-menu role would generate its own (English) children
        expect(["appMenu", "editMenu", "windowMenu", "fileMenu", "viewMenu"]).not.toContain(i.role);
        if (Array.isArray(i.submenu)) walk(i.submenu);
      }
    };
    walk(template);
    expect(template.map((m) => m.label)).toEqual(["Terno", "File", "Edit", "View", "Window", "Help"]);
    expect(sub(template[2]!).slice(0, 2).map((i) => [i.role, i.label])).toEqual([
      ["undo", "Undo"],
      ["redo", "Redo"],
    ]);
    expect(template[4]!.role).toBe("window");
    expect(template[5]!.role).toBe("help");
  });

  it("is Spanish once the locale is, nested items included", async () => {
    await switchLanguage("es", []);
    const all = labels(menuTemplate(actions));
    expect(all).toEqual(expect.arrayContaining(["Archivo", "Edición", "Deshacer", "Ver", "Filtrar por no leídos", "Ventana", "Ayuda", "Exportar diagnóstico…", "Salir de Terno", "Iniciar locución", "Buscar actualizaciones…"]));
    // nothing English left that Spanish says differently
    const english = new Set(labels((await (async () => (setLocale("en", en), menuTemplate(actions)))())));
    await switchLanguage("es", []);
    expect(all.filter((l) => english.has(l) && !["Terno", "Zoom"].includes(l))).toEqual([]);
  });
});

describe("plan 189: the menu bar on Linux, drawn inside the window", () => {
  const linux = { ...actions, platform: "linux" as NodeJS.Platform };
  /** every role in a menu, nested ones included */
  const roles = (items: MenuItemConstructorOptions[]): string[] => items.flatMap((i) => [...(i.role ? [i.role] : []), ...(Array.isArray(i.submenu) ? roles(i.submenu) : [])]);

  it("has no app or Window menu, and none of macOS's own items (they'd do nothing there)", () => {
    const template = menuTemplate(linux);
    expect(template.map((m) => m.label)).toEqual(["File", "Edit", "View", "Help"]);
    const all = roles(template);
    for (const mac of ["services", "hide", "hideOthers", "unhide", "startSpeaking", "stopSpeaking", "pasteAndMatchStyle", "front", "zoom", "window"]) expect(all).not.toContain(mac);
    expect(labels(template)).not.toContain("Speech");
  });

  it("ends File with Quit, and Help holds Check for Updates… first and About last, every item labelled", () => {
    let checked = 0;
    const template = menuTemplate({ ...linux, checkForUpdates: () => checked++ });
    const file = sub(template[0]!);
    expect([file.at(-1)!.role, file.at(-1)!.label]).toEqual(["quit", "Quit Terno"]);
    expect(file.slice(0, 2).map((i) => i.id)).toEqual(["print", "export-pdf"]);
    const help = sub(template[3]!);
    expect(help[0]!.label).toBe("Check for Updates…");
    (help[0]!.click as () => void)();
    expect(checked).toBe(1);
    expect(help.map((i) => i.id).filter(Boolean)).toEqual(["check-for-updates", "export-diagnostics", "show-logs"]);
    expect([help.at(-1)!.role, help.at(-1)!.label]).toEqual(["about", "About Terno"]);
    const walk = (items: MenuItemConstructorOptions[]) => {
      for (const i of items) {
        if (i.type === "separator") continue;
        expect(i.label, JSON.stringify(i.role)).toBeTruthy();
        if (Array.isArray(i.submenu)) walk(i.submenu);
      }
    };
    walk(template);
  });

  it("is Spanish once the locale is", async () => {
    await switchLanguage("es", []);
    expect(labels(menuTemplate(linux))).toEqual(expect.arrayContaining(["Archivo", "Salir de Terno", "Ayuda", "Buscar actualizaciones…", "Acerca de Terno"]));
  });
});

describe("main: the language", () => {
  it("comes from locale.json until the backend reports; garbage or none is System", () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-locale-"));
    try {
      expect(readLanguage(dir)).toBe("system");
      writeLanguage(dir, "es");
      expect(readLanguage(dir)).toBe("es");
      writeFileSync(join(dir, LOCALE_FILE), "{nope");
      expect(readLanguage(dir)).toBe("system");
      writeFileSync(join(dir, LOCALE_FILE), JSON.stringify({ language: "fr" }));
      expect(readLanguage(dir)).toBe("system");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("System follows the system's languages; only a real change reports a change", async () => {
    expect(await switchLanguage("system", ["fr-FR"])).toBe(false);
    expect(getLocale()).toBe("en");
    expect(await switchLanguage("system", ["es-MX", "en-US"])).toBe(true);
    expect(getLocale()).toBe("es");
    expect(await switchLanguage("es", [])).toBe(false);
    expect(await switchLanguage("en", ["es-MX"])).toBe(true);
    expect(getLocale()).toBe("en");
  });
});
