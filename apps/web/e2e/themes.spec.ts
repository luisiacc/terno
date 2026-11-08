/**
 * Themes: every built-in applies (attribute + painted token), theme.js paints
 * before React on reload, system mode follows the OS, HTML mail follows the
 * auto/paper rules, custom themes import (or are refused). A palette is only its tokens (themes.generated.css has no other
 * rule per theme), so every token of every palette is read off the page; baselines keep a few palettes with HTML mail.
 */
import { formatOklch, parseColor, toHex } from "../../../packages/ui/src/themes/color";
import { builtinTheme, THEMES } from "../../../packages/ui/src/themes/registry";
import type { Page } from "@playwright/test";
import { expect, openRow, stabilize, test, fresh, scenario } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

// baselines are at twice the pixels; everything else draws at one (plan 139)
test.use({ deviceScaleFactor: 2 });

const ctx = { clientId: "setup", origin: "dev" as const };

async function openAppearance(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-appearance").click();
  await expect(page.getByTestId("appearance-tab")).toBeVisible();
}

test.describe("the Appearance choices", () => {
  test("the Appearance cards fill their row and keep their names; the sidebar and menus under reduced transparency", async ({ app: page }) => {
    // fixed-width cards in a wrapping row left a hole beside the last column
    await scenario("the style and color cards fill their row, their previews fill the cards", async () => {
      await openAppearance(page);
      for (const id of ["design-grid", "theme-grid-light", "theme-grid-dark"]) {
        const grid = page.getByTestId(id);
        await grid.scrollIntoViewIfNeeded();
        const { gridRight, right, overflow } = await grid.evaluate((el) => {
          const cards = [...el.querySelectorAll<HTMLElement>("[role=radio]")];
          return {
            gridRight: el.getBoundingClientRect().right,
            right: Math.max(...cards.map((c) => c.getBoundingClientRect().right)),
            // a card's content past its edge, or a preview short of it
            overflow: cards.filter((c) => {
              const preview = c.querySelector<HTMLElement>("[aria-hidden]")!;
              return c.scrollWidth > c.clientWidth || c.clientWidth - preview.getBoundingClientRect().width > 14;
            }).length,
          };
        });
        expect(Math.abs(gridRight - right), id).toBeLessThan(1);
        expect(overflow, id).toBe(0);
      }
    });
    // Codex review: a fixed three columns left a narrow window's color names cut off ("Catppuccin L…")
    await scenario("in a narrow window, the color cards drop a column and keep their names whole", async () => {
      await fresh(page);
      await page.setViewportSize({ width: 640, height: 800 });
      await openAppearance(page);
      const cut = await page.getByTestId("theme-grid-light").evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>("[role=radio] .truncate")].filter((name) => name.scrollWidth > name.clientWidth).map((name) => name.textContent),
      );
      expect(cut).toEqual([]);
    });
    await scenario("the vibrancy sidebar turns opaque when the OS asks for reduced transparency", async () => {
      await fresh(page);
      const cdp = await page.context().newCDPSession(page);
      const sidebarAlpha = () =>
        page.getByTestId("sidebar").evaluate((el) => {
          const m = getComputedStyle(el).backgroundColor.match(/\/\s*([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\)/);
          return m ? Number(m[1] ?? m[2]) : 1;
        });
      // what theme.js / applyAppearance set on macOS desktop
      await page.evaluate(() => document.documentElement.setAttribute("data-vibrancy", ""));
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "no-preference" }] });
      expect(await sidebarAlpha()).toBeLessThan(1);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
      expect(await sidebarAlpha()).toBe(1);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    });
    // plan 118: menus are solid (they were glass until then), whatever the OS asks for
    await scenario("menus are solid, with or without reduced transparency", async () => {
      await fresh(page);
      const cdp = await page.context().newCDPSession(page);
      const menuLook = async () => {
        await page.getByTestId("thread-row").first().click({ button: "right" });
        const popup = page.locator("[data-slot=context-menu-content]");
        await expect(popup).toBeVisible();
        const look = await popup.evaluate((el) => {
          const s = getComputedStyle(el);
          return { filter: s.backdropFilter, background: s.backgroundColor };
        });
        await page.keyboard.press("Escape");
        await expect(popup).toHaveCount(0);
        return look;
      };
      for (const value of ["no-preference", "reduce"]) {
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value }] });
        const look = await menuLook();
        expect(look.filter, value).toBe("none");
        // opaque: no alpha below 1 in the painted color
        expect(look.background, value).not.toMatch(/\/\s*0?\.\d|rgba\(.*,\s*0?\.\d+\)/);
      }
    });
  });

});


test.describe("themes", () => {
  test("every built-in theme applies from its card and paints its registry values", async ({ app: page }) => {
    await openAppearance(page);
    for (const mode of ["light", "dark"] as const) {
      await page.getByTestId(`mode-${mode}`).click();
      await expect(page.locator("html")).toHaveClass(mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      for (const t of THEMES.filter((x) => x.mode === mode)) {
        await page.getByTestId(`theme-card-${t.id}`).click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", t.id);
        await expect(page.getByTestId(`theme-card-${t.id}`)).toHaveAttribute("aria-checked", "true");
        // the build minifies values (oklch(99% .002 85)): compare the colors, not the spelling
        const names = Object.keys(t.tokens);
        const painted = await page.evaluate((names) => names.map((n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim()), names);
        for (const [i, name] of names.entries()) expect.soft(toHex(painted[i]!), `${t.id} --${name}`).toBe(toHex(t.tokens[name as keyof typeof t.tokens]));
        expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe(mode);
      }
    }
    // the other mode's grid says when its choice applies
    await expect(page.getByTestId("theme-grid-light")).toContainText("Applies in light mode");
  });

  test("a theme's first frame on a reload, and system mode following the OS", async ({ app: page, server }) => {
    await scenario("after a reload the theme is painted before React mounts", async () => {
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
    await scenario("system mode follows the OS", async () => {
      await page.reload();
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
  });

  test("HTML mail: uncolored takes the theme, designed sits on paper, from its parsed styles", async ({ app: page, server }) => {
    await scenario("HTML mail: uncolored mail takes the theme, designed mail sits on paper", async () => {
      await server.backend.server.invoke("settings.update", { theme: "dark", darkTheme: "dracula" }, ctx);
      const dracula = builtinTheme("dracula")!.tokens;
      // one thread without colors of its own, and one designed (a dark band behind white text)
      const plain = Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id"));
      sqlDb(server.backend.store).run("UPDATE message_bodies SET body_html = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)", "<p>Hola, <b>sin colores</b>: <a href='https://x.test'>enlace</a></p>", plain);
      const designed = Number(await page.locator("[data-testid=thread-row]").nth(2).getAttribute("data-thread-id"));
      sqlDb(server.backend.store).run("UPDATE message_bodies SET body_html = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)", "<div style='background:#1a1a2e;color:#fff;padding:24px'><h1>Boletín</h1></div><p>Debajo</p>", designed);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const bodyBg = async () => {
        const frame = page.frameLocator("iframe[title='Message content']");
        await expect(frame.locator("body")).toBeVisible();
        return frame.locator("body").evaluate((b) => getComputedStyle(b).backgroundColor);
      };
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

      await openRow(page, 0);
      await expect(page.locator("iframe[data-mail=themed]").first()).toBeVisible();
      expect(await bodyBg()).toBe(rgb(toHex(dracula.background)));
      // the frame is its own document: it smooths text like the app (grayscale on macOS), not the subpixel default
      expect(await page.frameLocator("iframe[title='Message content']").locator("body").evaluate((b) => getComputedStyle(b).getPropertyValue("-webkit-font-smoothing"))).toBe("antialiased");

      // a designed newsletter keeps its colors on the light paper card
      await openRow(page, 2);
      await expect(page.locator("iframe[data-mail=paper]")).toBeVisible();
      expect(await bodyBg()).toBe(rgb(toHex(dracula["mail-paper"])));

      // "Always paper": the plain one too
      await openAppearance(page);
      await page.getByTestId("mail-paper").click();
      await page.keyboard.press("Escape");
      await openRow(page, 0);
      await expect(page.locator("iframe[data-mail=paper]").first()).toBeVisible();
      expect(await bodyBg()).toBe(rgb(toHex(dracula["mail-paper"])));
    });
    await scenario("designed mail is told from simple mail by its parsed styles, whatever the quoting", async () => {
      await fresh(page);
      // designed: a surface (a background that isn't a white page, a picture behind) or text in a hue; simple: greys on white, a link's own color
      const cases: [string, boolean][] = [
        [`<p style="font-family:'Arial',sans-serif;color:#111">Hola</p>`, false],
        [`<p style='font-family:"Helvetica Neue";color: rgb(17,17,17)'>Hola</p>`, false],
        [`<div style="BACKGROUND-COLOR: white">x</div>`, false],
        [`<div style="background:#fff;padding:8px">x</div>`, false],
        [`<table bgcolor="#ffffff"><tr><td>x</td></tr></table>`, false],
        [`<p style="color:#888;font-size:12px"><a href="https://x.test/u" style="color:#1a73e8">Darse de baja</a></p>`, false],
        [`<div style="padding:4px;background:#eee url(cid:x)">x</div>`, true],
        [`<div style="background-color:#1a1a2e">x</div>`, true],
        [`<table bgcolor="#f0e6d2"><tr><td>x</td></tr></table>`, true],
        [`<font color="red">x</font>`, true],
        [`<span style="color:#d00">x</span>`, true],
        // a color it insists on outranks any sheet: such mail keeps its paper
        [`<p style="color:#111 !important">x</p>`, true],
        // drawn art paints fills and strokes no color rule reaches
        [`<div style="background:#fff"><svg width="10" height="10"><rect width="10" height="10" fill="#000"/></svg></div>`, true],
        [`<p style="font-family:'Arial';font-weight:bold;margin:0">sin colores</p>`, false],
        [`<p style="border-color:red;font-family:'color:red'">x</p>`, false],
        [`<p>color: red; background: blue (texto, no estilo)</p>`, false],
        [`<p title="color:red">x</p>`, false],
      ];
      const results = await page.evaluate((list) => list.map(([html]) => (window as unknown as { __terno: { mailDesign(h: string): { designed: boolean } } }).__terno.mailDesign(html).designed), cases);
      expect(results).toEqual(cases.map(([, expected]) => expected));

      // and in the reader, in a dark theme: a simple mail's dark text takes the theme's ink, its grey footer the theme's quiet
      // ink and its white page the theme's (never a light slab in a dark reader); a designed one keeps its paper
      await server.backend.server.invoke("settings.update", { theme: "dark", darkTheme: "dracula", htmlMailAppearance: "auto" }, ctx);
      const thread = Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id"));
      const designed = Number(await page.locator("[data-testid=thread-row]").nth(1).getAttribute("data-thread-id"));
      const body = (html: string, id = thread) => sqlDb(server.backend.store).run("UPDATE message_bodies SET body_html = ? WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)", html, id);
      body(`<div style="background:#1a1a2e;color:#fff"><p>Diseñado</p></div>`, designed);
      body(`<div style="background:#ffffff"><p id="ink" style="font-family:'Arial',sans-serif;color:#111">Texto oscuro</p><p id="quiet" style="color:#888">Pie</p></div>`);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openRow(page, 0);
      await expect(page.locator("iframe[data-mail=themed]").first()).toBeVisible();
      const frame = page.frameLocator("iframe[title='Message content']").first();
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
      const dracula = builtinTheme("dracula")!.tokens;
      await expect.poll(() => frame.locator("#ink").evaluate((el) => getComputedStyle(el).color)).toBe(rgb(toHex(dracula.foreground)));
      expect(await frame.locator("#quiet").evaluate((el) => getComputedStyle(el).color)).toBe(rgb(toHex(dracula["muted-foreground"])));
      expect(await frame.locator("#ink").evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      await openRow(page, 1);
      await expect(page.locator("iframe[data-mail=paper]").first()).toBeVisible();
    });
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

    // editing: the JSON in place, validated like an import; the id stays
    await page.getByTestId("theme-edit-custom:rosa").click();
    const json = page.getByTestId("theme-editor-json");
    await json.fill(JSON.stringify({ ...rosa, id: "otra" }));
    await page.getByTestId("theme-editor-save").click();
    await expect(page.getByTestId("theme-editor-error")).toContainText("The id can’t be changed");
    const fuchsia = "#ff55aa";
    await json.fill(JSON.stringify({ ...rosa, name: "Rosa fuerte", tokens: { ...rosa.tokens, primary: fuchsia } }));
    await page.getByTestId("theme-editor-save").click();
    await expect(page.getByTestId("theme-editor")).toHaveCount(0);
    await expect(page.getByTestId("theme-card-custom:rosa")).toContainText("Rosa fuerte");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).toBe(formatOklch(parseColor(fuchsia)));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).toBe(formatOklch(parseColor(fuchsia)));
    await openAppearance(page);

    // deleting the theme in use (after confirming) falls back to the mode's default
    await page.getByTestId("theme-delete-custom:rosa").click();
    await page.getByTestId("theme-delete-dialog-confirm").click();
    await expect(page.getByTestId("theme-card-custom:rosa")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "terno-dark");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--primary"))).toBe("");
  });
});

test.describe("visual: a palette from each family, the Appearance tab", () => {
  test.use({ deviceScaleFactor: 1 });

  test("the HTML reader in a palette from each family, the Appearance tab in both modes", async ({ app: page, server }) => {
    for (const id of ["solarized-light", "dracula", "nord"] as const) {
      await scenario(`HTML reader in ${id}`, async () => {
        const mode = builtinTheme(id)!.mode;
        await server.backend.server.invoke("settings.update", mode === "light" ? { theme: "light", lightTheme: id } : { theme: "dark", darkTheme: id }, ctx);
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await openRow(page, 2);
        await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await stabilize(page);
        await expect(page).toHaveScreenshot(`reader-${id}.png`);
      });
    }
    for (const mode of ["light", "dark"] as const) {
      await scenario(`Appearance tab in ${mode}`, async () => {
        await server.backend.server.invoke("settings.update", { theme: mode, lightTheme: "design", darkTheme: "design" }, ctx);
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await openAppearance(page);
        await page.evaluate(() => document.fonts.ready);
        await stabilize(page);
        await expect(page.getByTestId("settings-dialog")).toHaveScreenshot(`settings-appearance-${mode}.png`);
      });
    }
  });
});
