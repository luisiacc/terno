import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

for (const design of ["macos", "lumen", "atelier"] as const) {
  test(`uncertainty: actual startup keeps dirty mailbox data and offers keyboard Reload (${design}) @design`, async ({ page }, info) => {
    const name = `uncertain-ui-${design}-${crypto.randomUUID()}`;
    const palettes = design === "macos" ? { light: "terno-light", dark: "terno-dark" } : { light: `${design}-light`, dark: `${design}-dark` };
    // An admission sentinel, not a complete user mailbox or a corruption-repair fixture.
    await page.goto("/favicon.svg");
    await page.evaluate(async ({ name, design, palettes }) => {
      localStorage.setItem("terno:appearance", JSON.stringify({ v: 2, design, ...palettes, mode: "light", motion: 0, vibrancy: { light: false, dark: false } }));
      const open = indexedDB.open(`terno-${name}`, 10);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("meta").put(undefined, "uncertainWrite");
        open.result.createObjectStore("drafts").put({ id: 7, body_text: "synthetic retained body" }, 7);
      };
      await new Promise<void>((resolve, reject) => { open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error); });
    }, { name, design, palettes });
    const image = () => page.evaluate(async (name) => {
      const open = indexedDB.open(`terno-${name}`);
      const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      try {
        const names = Array.from(db.objectStoreNames), tx = db.transaction(names);
        const ended = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        const rows = await Promise.all(names.map(async (name) => {
          const store = tx.objectStore(name), keys = store.getAllKeys(), values = store.getAll();
          const [savedKeys, savedValues] = await Promise.all([
            new Promise<IDBValidKey[]>((resolve, reject) => { keys.onsuccess = () => resolve(keys.result); keys.onerror = () => reject(keys.error); }),
            new Promise<unknown[]>((resolve, reject) => { values.onsuccess = () => resolve(values.result); values.onerror = () => reject(values.error); }),
          ]);
          return { name, keys: savedKeys, values: savedValues };
        }));
        await ended; return { version: db.version, rows };
      } finally { db.close(); }
    }, name);
    const before = await image();
    try {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((mode) => { const a = JSON.parse(localStorage.getItem("terno:appearance")!); a.mode = mode; localStorage.setItem("terno:appearance", JSON.stringify(a)); }, theme);
        await page.goto(`/?mailbox=${name}&storage=idb&demo=0`);
        const fatal = page.getByTestId("web-fatal"), reload = fatal.getByRole("button", { name: "Reload", exact: true });
        await expect(fatal).toHaveAccessibleName("Couldn’t safely open your mailbox");
        await expect(fatal).toContainText("A local save may be incomplete. Your local data has been kept.");
        await expect(fatal).toContainText("Don’t clear this browser’s storage.");
        await expect(fatal).not.toContainText("synthetic retained body");
        await expect(page.getByTestId("thread-row")).toHaveCount(0);
        await expect(page.locator("html")).toHaveAttribute("data-design", design);
        await expect(page.locator("html")).toHaveAttribute("data-theme", palettes[theme]);
        expect(await page.locator("#root").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
        await fatal.focus(); await page.keyboard.press("Tab"); await expect(reload).toBeFocused();
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        const dir = process.env.TERNO_IDB_UNCERTAINTY_SHOTS;
        if (dir) mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: dir ? join(dir, `${design}-${theme}.png`) : info.outputPath(`${design}-${theme}.png`), fullPage: true });
        expect(await image()).toEqual(before);
        await Promise.all([page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame() }), page.keyboard.press("Enter")]);
        await expect(fatal).toHaveAccessibleName("Couldn’t safely open your mailbox");
        expect(await image()).toEqual(before);
      }
    } finally {
      await page.goto("/favicon.svg");
      await page.evaluate(async (name) => {
        const remove = indexedDB.deleteDatabase(`terno-${name}`);
        await new Promise<void>((resolve, reject) => { remove.onsuccess = () => resolve(); remove.onerror = () => reject(remove.error); });
      }, name);
    }
  });
}
