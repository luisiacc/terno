/**
 * Themes: every built-in applies (attribute + painted token), theme.js paints
 * before React on reload, system mode follows the OS, HTML mail follows the
 * auto/paper rules, custom themes import (or are refused), and a visual
 * baseline per theme.
 */
import { BUILTIN_THEMES } from "@unica/core";
import { formatOklch, parseColor, toHex } from "../../../packages/ui/src/themes/color";
import { builtinTheme, THEMES } from "../../../packages/ui/src/themes/registry";
import type { Page } from "@playwright/test";
import { expect, openRow, stabilize, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

async function openAppearance(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-appearance").click();
  await expect(page.getByTestId("appearance-tab")).toBeVisible();
}

const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe("themes", () => {
  test("every built-in theme applies from its card and paints its registry values", async ({ app: page }) => {
    await openAppearance(page);
    for (const mode of ["light", "dark"] as const) {
      await page.getByTestId(`mode-${mode}`).click();
      await expect(page.locator("html")).toHaveClass(mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      for (const t of THEMES.filter((x) => x.mode === mode)) {
        await page.getByTestId(`theme-card-${t.id}`).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", t.id);
        await expect(page.getByTestId(`theme-card-${t.id}`)).toHaveAttribute("aria-pressed", "true");
        // the build minifies values (oklch(99% .002 85)): compare the colors, not the spelling
        expect(toHex(await cssVar(page, "--background")), t.id).toBe(toHex(t.tokens.background));
        expect(toHex(await cssVar(page, "--primary")), t.id).toBe(toHex(t.tokens.primary));
        expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe(mode);
      }
    }
    // the other mode's grid says when its choice applies
    await expect(page.getByTestId("theme-grid-light")).toContainText("Se aplicará en modo claro");
  });

  test("after a reload the theme is painted before React mounts", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { theme: "dark", darkTheme: "nord" }, ctx);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
    // the next load: theme.js reads the cache applyAppearance wrote
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        (window as unknown as { __atDcl: unknown }).__atDcl = { theme: document.documentElement.dataset.theme, dark: document.documentElement.classList.contains("dark"), motion: document.documentElement.dataset.motion };
      });
    });
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    expect(await page.evaluate(() => (window as unknown as { __atDcl: unknown }).__atDcl)).toEqual({ theme: "nord", dark: true, motion: "off" });
  });

  test("system mode follows the OS", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { theme: "system", lightTheme: "github-light", darkTheme: "tokyo-night" }, ctx);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "tokyo-night");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
    // an explicit mode ignores the OS
    await server.backend.server.invoke("settings.update", { theme: "light" }, ctx);
    await page.reload();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
  });

  test("HTML mail: uncolored mail takes the theme, designed mail sits on paper", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { theme: "dark", darkTheme: "dracula" }, ctx);
    const dracula = builtinTheme("dracula")!.tokens;
    // one thread without colors of its own (the demo's newsletters all set some)
    const plain = Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id"));
    server.backend.db.run("UPDATE messages SET body_html = ? WHERE thread_id = ?", "<p>Hola, <b>sin colores</b>: <a href='https://x.test'>enlace</a></p>", plain);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const bodyBg = async () => {
      const frame = page.frameLocator("iframe[title='Contenido del correo']");
      await expect(frame.locator("body")).toBeVisible();
      return frame.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor);
    };
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

    await openRow(page, 0);
    await expect(page.locator("iframe[data-mail=themed]").first()).toBeVisible();
    expect(await bodyBg()).toBe(rgb(toHex(dracula.background)));

    // a designed newsletter keeps its colors on the light paper card
    await openRow(page, 2);
    await expect(page.locator("iframe[data-mail=paper]")).toBeVisible();
    expect(await bodyBg()).toBe(rgb(toHex(dracula["mail-paper"])));

    // "Siempre papel": the plain one too
    await openAppearance(page);
    await page.getByTestId("mail-paper").click();
    await page.keyboard.press("Escape");
    await openRow(page, 0);
    await expect(page.locator("iframe[data-mail=paper]").first()).toBeVisible();
    expect(await bodyBg()).toBe(rgb(toHex(dracula["mail-paper"])));
  });

  test("designed mail is recognized from its parsed styles, whatever the quoting", async ({ app: page, server }) => {
    const cases: [string, boolean][] = [
      [`<p style="font-family:'Arial',sans-serif;color:#111">Hola</p>`, true],
      [`<p style='font-family:"Helvetica Neue";color: rgb(17,17,17)'>Hola</p>`, true],
      [`<div style="padding:4px;background:#eee url(cid:x)">x</div>`, true],
      [`<div style="BACKGROUND-COLOR: white">x</div>`, true],
      [`<table bgcolor="#ffffff"><tr><td>x</td></tr></table>`, true],
      [`<font color="red">x</font>`, true],
      [`<p style="font-family:'Arial';font-weight:bold;margin:0">sin colores</p>`, false],
      [`<p style="border-color:red;font-family:'color:red'">x</p>`, false],
      [`<p>color: red; background: blue (texto, no estilo)</p>`, false],
      [`<p title="color:red">x</p>`, false],
    ];
    const results = await page.evaluate((list) => list.map(([html]) => (window as unknown as { __unica: { hasOwnColors(h: string): boolean } }).__unica.hasOwnColors(html)), cases);
    expect(results).toEqual(cases.map(([, expected]) => expected));

    // and in the reader: dark text from an ordinary inline style lands on the paper card, not on a dark theme
    await server.backend.server.invoke("settings.update", { theme: "dark", darkTheme: "dracula" }, ctx);
    const thread = Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id"));
    server.backend.db.run("UPDATE messages SET body_html = ? WHERE thread_id = ?", `<p style="font-family:'Arial',sans-serif;color:#111">Texto oscuro</p>`, thread);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openRow(page, 0);
    await expect(page.locator("iframe[data-mail=paper]").first()).toBeVisible();
  });

  test("a custom theme imports, applies and can be deleted; invalid files are refused", async ({ app: page }) => {
    await openAppearance(page);
    const input = page.getByTestId("theme-import-input");
    await input.setInputFiles({ name: "malo.json", mimeType: "application/json", buffer: Buffer.from("{ no es json") });
    await expect(page.getByTestId("theme-import-error")).toContainText("JSON");
    const evil = { id: "malo", name: "Malo", mode: "dark", extends: "dracula", tokens: { background: "red;}body{display:none" } };
    await input.setInputFiles({ name: "malo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(evil)) });
    await expect(page.getByTestId("theme-import-error")).toContainText("tokens.background");

    // low contrast on purpose: imported with warnings, not blocked
    const rosa = { id: "rosa", name: "Rosa", mode: "dark", extends: "dracula", tokens: { primary: "#ff79c6", "muted-foreground": "oklch(0.45 0.02 280)" } };
    await input.setInputFiles({ name: "rosa.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(rosa)) });
    await expect(page.getByTestId("theme-import-result")).toContainText("Rosa");
    await expect(page.getByTestId("theme-import-warnings")).toContainText("muted-foreground");
    await page.getByTestId("mode-dark").click();
    await page.getByTestId("theme-card-custom:rosa").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
    const pink = formatOklch(parseColor("#ff79c6"));
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).toBe(pink);
    // the preview card carries the same tokens
    expect(await page.getByTestId("theme-card-custom:rosa").locator("[data-theme]").evaluate((el) => getComputedStyle(el).getPropertyValue("--primary").trim())).toBe(pink);

    // deleting the theme in use falls back to the mode's default
    await page.getByTestId("theme-delete-custom:rosa").click();
    await expect(page.getByTestId("theme-card-custom:rosa")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "unica-dark");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).toBe("");
  });
});

test.describe("visual: every theme", () => {
  test.use({ deviceScaleFactor: 1 });

  for (const { id, mode } of BUILTIN_THEMES) {
    test(`inbox in ${id}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", mode === "light" ? { theme: "light", lightTheme: id } : { theme: "dark", darkTheme: id }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-theme", id);
      await expect(page.getByTestId("message").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
      await expect(page).toHaveScreenshot(`inbox-${id}.png`);
    });
  }

  for (const id of ["solarized-light", "dracula", "nord"] as const) {
    test(`HTML reader in ${id}`, async ({ app: page, server }) => {
      const mode = builtinTheme(id)!.mode;
      await server.backend.server.invoke("settings.update", mode === "light" ? { theme: "light", lightTheme: id } : { theme: "dark", darkTheme: id }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openRow(page, 2);
      await expect(page.frameLocator("iframe[title='Contenido del correo']").locator("h1")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
      await expect(page).toHaveScreenshot(`reader-${id}.png`);
    });
  }

  for (const mode of ["light", "dark"] as const) {
    test(`Apariencia tab in ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openAppearance(page);
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
      await expect(page.getByTestId("settings-dialog")).toHaveScreenshot(`settings-appearance-${mode}.png`);
    });
  }
});
