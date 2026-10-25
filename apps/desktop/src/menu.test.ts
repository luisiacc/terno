import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenu, viewMenu } from "./menu";

describe("main: the app menu", () => {
  it("has Check for Updates… right under About, and keeps Quit", () => {
    let checked = 0;
    const items = appMenu("Terno", () => checked++).submenu as MenuItemConstructorOptions[];
    expect(items[0]!.role).toBe("about");
    expect(items[1]!.label).toBe("Check for Updates…");
    (items[1]!.click as () => void)();
    expect(checked).toBe(1);
    expect(items.at(-1)!.role).toBe("quit");
  });
});
import { MENU_COMMANDS } from "./print-commands";

describe("main: the Ver menu", () => {
  it("leads with Mail's message filter on ⌘L, a whitelisted command; dev tools only in development", () => {
    const sent: string[] = [];
    const items = viewMenu((c) => sent.push(c), false).submenu as MenuItemConstructorOptions[];
    expect([items[0]!.label, items[0]!.accelerator]).toEqual(["Filter by Unread", "CmdOrCtrl+L"]);
    (items[0]!.click as () => void)();
    expect(sent).toEqual(["list.toggleUnread"]);
    for (const c of sent) expect(MENU_COMMANDS).toContain(c);
    expect(items.find((i) => i.role === "toggleDevTools")!.visible).toBe(false);
    expect((viewMenu(() => {}, true).submenu as MenuItemConstructorOptions[]).find((i) => i.role === "toggleDevTools")!.visible).toBe(true);
    // no other item claims ⌘L
    expect(items.filter((i) => i.accelerator === "CmdOrCtrl+L")).toHaveLength(1);
  });
});
