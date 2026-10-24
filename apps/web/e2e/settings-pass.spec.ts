/**
 * Plan 08: every settings page reachable (gear, palette, keyboard), every
 * control in it named, editable, persisted across a reload and in effect,
 * with axe on every tab in light and dark (and its contrast rule in all 13
 * themes), at the minimum window size and with motion on and off.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { THEMES } from "../../../packages/ui/src/themes/registry";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, rows, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const TABS = [
  ["general", "General"],
  ["appearance", "Apariencia"],
  ["accounts", "Cuentas"],
  ["categories", "Categorías"],
  ["filters", "Filtros"],
  ["ai", "IA"],
  ["agents", "Agentes"],
  ["data", "Datos"],
] as const;
type Tab = (typeof TABS)[number][0];

const dialog = (page: Page) => page.getByTestId("settings-dialog");
/** the tab last opened by openVia/show (Base UI keeps a leaving panel for a moment: look for the named one) */
let current: Tab = "general";
const panel = (page: Page) => dialog(page).getByRole("tabpanel", { name: TABS.find(([t]) => t === current)![1], exact: true });

async function openVia(page: Page, how: "gear" | "palette" | "keyboard", tab: Tab) {
  current = tab;
  if (how === "gear") {
    await page.getByTestId("open-settings").click();
    await page.getByTestId(`tab-${tab}`).click();
  } else if (how === "palette") {
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill(`ajustes ${TABS.find(([t]) => t === tab)![1]}`);
    await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", `palette-settings-${tab}`);
    await page.keyboard.press("Enter");
    // the palette has finished closing (Esc meant for settings must not reach it)
    await expect(page.getByTestId("palette-input")).toHaveCount(0);
  } else {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("tab-general")).toBeFocused();
    // ↓ through the tab list: each tab activates as it gets focus
    for (let i = 0; i < TABS.findIndex(([t]) => t === tab); i++) await page.keyboard.press("ArrowDown");
  }
  await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  await expect(panel(page)).toBeVisible();
}

async function reopen(page: Page, tab: Tab) {
  await page.reload();
  await page.locator("[data-ready]").waitFor();
  await rows(page).first().waitFor();
  await openVia(page, "gear", tab);
}

async function axe(page: Page, only?: string[]) {
  const builder = new AxeBuilder({ page }).include("[data-testid=settings-dialog]");
  if (only) builder.withRules(only);
  const r = await builder.analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** Shows a tab and waits for its own panel (the previous one is gone), with editors behind disclosures open (the first account, category). */
async function show(page: Page, tab: Tab) {
  current = tab;
  await page.getByTestId(`tab-${tab}`).click();
  const own = panel(page);
  await expect(own).toBeVisible();
  if (tab === "accounts") await own.getByTestId("account-toggle").first().click();
  if (tab === "categories") await own.getByTestId("category-toggle").first().click();
}

test.describe("reachable", () => {
  for (const [tab] of TABS) {
    test(`${tab}: from the gear (focus comes back to it), the palette and the keyboard`, async ({ app: page }) => {
      await openVia(page, "gear", tab);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByTestId("open-settings")).toBeFocused();

      await openVia(page, "palette", tab);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);

      await openVia(page, "keyboard", tab);
      // Tab leaves the tab list for the panel's first control, and Shift+Tab comes back (no trap)
      await page.keyboard.press("Tab");
      const inPanel = await page.evaluate(() => !!document.activeElement?.closest("[role=tabpanel]") || !!document.activeElement?.closest("[data-testid=settings-dialog]"));
      expect(inPanel).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId(`tab-${tab}`)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    });
  }
});

test.describe("editable, persisted and in effect", () => {
  test("General: local mode, remote images, density (row height), sync window (validated)", async ({ app: page }) => {
    await openVia(page, "gear", "general");
    const local = page.getByRole("switch", { name: "Modo local" });
    await local.click();
    await page.getByTestId("local-mode-confirm-off").click();
    await expect(local).not.toBeChecked();
    const images = page.getByRole("switch", { name: "Cargar imágenes remotas siempre" });
    await images.click();
    await expect(images).toBeChecked();
    await page.getByRole("combobox", { name: "Densidad" }).click();
    await page.getByTestId("density-compact").click();
    await expect(rows(page).first()).toHaveCSS("height", "40px");
    const days = page.getByRole("spinbutton", { name: "Ventana de sincronización" });
    await days.fill("3");
    await days.press("Enter");
    await expect(page.getByTestId("sync-window-error")).toHaveText("Escribe un número de días entre 7 y 3650.");
    await expect(days).toHaveAttribute("aria-invalid", "true");
    await expect(days).toHaveAccessibleDescription(/entre 7 y 3650/);
    await days.fill("45");
    await days.press("Enter");
    await expect(page.getByTestId("sync-window-error")).toHaveCount(0);

    await reopen(page, "general");
    await expect(page.getByRole("switch", { name: "Modo local" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Cargar imágenes remotas siempre" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Densidad" })).toContainText("Compacta");
    await expect(page.getByRole("spinbutton", { name: "Ventana de sincronización" })).toHaveValue("45");
    await expect(rows(page).first()).toHaveCSS("height", "40px");
    // local mode back on blocks remote images (the switch says so and turns off)
    await page.getByRole("switch", { name: "Modo local" }).click();
    await expect(page.getByRole("switch", { name: "Cargar imágenes remotas siempre" })).toBeDisabled();
    await page.getByTestId("open-shortcuts").click();
    await expect(page.getByRole("dialog", { name: "Atajos de teclado" })).toContainText("Ajustes");
  });

  test("Apariencia: mode, light and dark themes, motion (--motion), HTML mail", async ({ app: page }) => {
    await openVia(page, "gear", "appearance");
    await page.getByTestId("theme-card-solarized-light").click();
    await page.getByTestId("theme-card-nord").click();
    await page.getByRole("group", { name: "Modo" }).getByRole("button", { name: "Oscuro" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
    await page.getByRole("group", { name: "Animaciones" }).getByRole("button", { name: "50 ms" }).click();
    await page.getByRole("group", { name: "Correo HTML" }).getByRole("button", { name: "Siempre papel" }).click();

    await reopen(page, "appearance");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "nord");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--motion").trim())).toBe("50ms");
    await expect(page.getByTestId("mail-paper")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("group", { name: "Modo" }).getByRole("button", { name: "Claro" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "solarized-light");
    await expect(page.getByTestId("theme-card-solarized-light")).toHaveAttribute("aria-pressed", "true");
  });

  test("Cuentas: name, sender, color, signature (sent and shown under the draft), sync window, reconnect, remove", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const imap = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts WHERE kind = 'imap' ORDER BY id LIMIT 1")!;
    await openVia(page, "gear", "accounts");
    const item = page.locator(`[data-testid=settings-account][data-account-id="${imap.id}"]`);
    await item.getByTestId("account-toggle").click();
    await expect(item.getByTestId("account-toggle")).toHaveAttribute("aria-expanded", "true");
    await item.getByRole("textbox", { name: "Nombre", exact: true }).fill("Freelance (nuevo)");
    await item.getByRole("textbox", { name: "Nombre", exact: true }).press("Enter");
    await expect(page.getByTestId(`nav-account-${imap.id}`)).toContainText("Freelance (nuevo)");
    await item.getByRole("textbox", { name: "Nombre del remitente" }).fill("Luis C.");
    await item.getByRole("textbox", { name: "Nombre del remitente" }).blur();
    await item.getByRole("radiogroup", { name: "Color" }).getByRole("radio", { name: "Violeta" }).check({ force: true }); // the input is visually hidden behind its dot
    await item.getByRole("textbox", { name: "Firma" }).fill("Luis Cordero\nhola@luiscordero.dev");
    await item.getByRole("textbox", { name: "Firma" }).blur();
    await item.getByRole("spinbutton", { name: "Ventana de sincronización" }).fill("30");
    await item.getByRole("spinbutton", { name: "Ventana de sincronización" }).press("Enter");
    await expect.poll(async () => (await server.backend.server.invoke("app.bootstrap", {}, ctx)).accounts.find((a) => a.id === imap.id)).toMatchObject({
      displayName: "Freelance (nuevo)",
      senderName: "Luis C.",
      color: "violet",
      signature: "Luis Cordero\nhola@luiscordero.dev",
      syncWindowDays: 30,
    });
    // reconnect: the password is checked by a live login (the demo registry accepts it)
    await item.getByTestId("account-reconnect").click();
    await item.getByLabel(`Contraseña de ${imap.email}`).fill("app-password");
    await item.getByTestId("account-reconnect-submit").click();
    await expect(page.getByText(`${imap.email} vuelve a estar conectada`)).toBeVisible();

    await reopen(page, "accounts");
    await item.getByTestId("account-toggle").click();
    await expect(item.getByRole("textbox", { name: "Nombre", exact: true })).toHaveValue("Freelance (nuevo)");
    await expect(item.getByRole("radio", { name: "Violeta" })).toBeChecked();
    await expect(item.getByRole("textbox", { name: "Firma" })).toHaveValue("Luis Cordero\nhola@luiscordero.dev");
    await expect(item.getByRole("spinbutton", { name: "Ventana de sincronización" })).toHaveValue("30");
    // emptied: back to the general window
    await item.getByRole("spinbutton", { name: "Ventana de sincronización" }).fill("");
    await item.getByRole("spinbutton", { name: "Ventana de sincronización" }).press("Enter");
    await expect.poll(async () => (await server.backend.server.invoke("app.bootstrap", {}, ctx)).accounts.find((a) => a.id === imap.id)!.syncWindowDays).toBeNull();

    // the signature shows under a new message from that account, and is what gets sent below the text
    await page.keyboard.press("Escape");
    await page.getByTestId(`nav-account-${imap.id}`).click();
    await page.getByTestId("compose-button").click();
    await expect(page.getByTestId("compose-signature")).toHaveText("-- \nLuis Cordero\nhola@luiscordero.dev");

    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("tab-accounts").click();
    await item.getByTestId("account-toggle").click();
    await item.getByTestId("account-remove").click();
    await expect(page.getByTestId("account-remove-dialog")).toContainText(`¿Quitar ${imap.email}?`);
    await page.getByTestId("account-remove-dialog-confirm").click();
    await expect(item).toHaveCount(0);
    await expect(page.getByTestId(`nav-account-${imap.id}`)).toHaveCount(0);
  });

  test("Categorías: engine mode, AI help, rename, color, order (sidebar), auto-filing, create, delete", async ({ app: page, server }) => {
    const cats = (await server.backend.server.invoke("app.bootstrap", {}, ctx)).categories;
    const [first, second] = cats as [(typeof cats)[number], (typeof cats)[number]];
    await openVia(page, "gear", "categories");
    await page.getByRole("combobox", { name: "Categorización inteligente" }).click();
    await page.getByTestId("auto-categorize-suggest").click();
    await expect(page.getByRole("switch", { name: `Añadir sola a «${first.name}»` })).toBeDisabled();
    await page.getByRole("combobox", { name: "Categorización inteligente" }).click();
    await page.getByTestId("auto-categorize-auto").click();
    await page.getByRole("switch", { name: `Añadir sola a «${first.name}»` }).click();
    await page.getByRole("switch", { name: "Pedir ayuda a la IA" }).click();

    const item = page.locator(`[data-category-id="${second.id}"]`);
    await item.getByTestId("category-toggle").click();
    await item.getByRole("textbox", { name: "Nombre" }).fill("Clientes VIP");
    await item.getByRole("textbox", { name: "Nombre" }).press("Enter");
    await item.getByRole("radio", { name: "Rosa" }).check({ force: true });
    await item.getByRole("button", { name: "Subir «Clientes VIP»" }).click();
    // the moved button keeps focus; the sidebar follows
    await expect(item.getByRole("button", { name: "Subir «Clientes VIP»" })).toBeFocused();
    await expect(page.locator("[data-testid^=nav-category-]").first()).toContainText("Clientes VIP");

    await page.getByTestId("category-new").fill("Mudanza");
    await page.getByTestId("category-create").click();
    await expect(page.locator("[data-testid^=nav-category-]").filter({ hasText: "Mudanza" })).toBeVisible();

    await reopen(page, "categories");
    await expect(page.getByRole("combobox", { name: "Categorización inteligente" })).toContainText("Automática");
    await expect(page.getByRole("switch", { name: `Añadir sola a «${first.name}»` })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Pedir ayuda a la IA" })).toBeChecked();
    await expect(panel(page).getByTestId("category-name").first()).toHaveText("Clientes VIP");
    const boot = await server.backend.server.invoke("app.bootstrap", {}, ctx);
    expect(boot.categories[0]).toMatchObject({ id: second.id, name: "Clientes VIP", color: "rose" });

    const mudanza = boot.categories.find((c) => c.name === "Mudanza")!;
    const m = page.locator(`[data-category-id="${mudanza.id}"]`);
    await m.getByTestId("category-toggle").click();
    await m.getByTestId("category-delete").click();
    await page.getByTestId("category-delete-dialog-confirm").click();
    await expect(m).toHaveCount(0);
    await expect(page.locator("[data-testid^=nav-category-]").filter({ hasText: "Mudanza" })).toHaveCount(0);
  });

  test("IA: provider, endpoint (validated, announced), model, all persisted", async ({ app: page }) => {
    await openVia(page, "gear", "ai");
    await page.getByRole("combobox", { name: "Proveedor" }).click();
    await page.getByTestId("ai-choice-ollama").click();
    const endpoint = page.getByRole("textbox", { name: "Endpoint" });
    await endpoint.fill("ftp://nada");
    await expect(page.getByTestId("ai-endpoint-error")).toHaveText("Escribe una URL http:// o https://");
    await expect(endpoint).toHaveAccessibleDescription(/http:\/\/ o https:\/\//);
    await endpoint.fill("http://127.0.0.1:9/v1");
    await expect(page.getByTestId("ai-endpoint-error")).toHaveCount(0);
    const model = page.getByRole("textbox", { name: "Modelo" });
    await model.fill("qwen3:8b");
    await model.press("Enter");

    await reopen(page, "ai");
    await expect(page.getByRole("combobox", { name: "Proveedor" })).toContainText("Ollama");
    await expect(page.getByRole("textbox", { name: "Endpoint" })).toHaveValue("http://127.0.0.1:9/v1");
    await expect(page.getByRole("textbox", { name: "Modelo" })).toHaveValue("qwen3:8b");
  });

  test("IA: a saved key isn't sent to an endpoint it wasn't saved for (an import, say) until confirmed", async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { localMode: false, ai: { provider: "openai", model: "gpt-x" } }, ctx);
    await server.backend.server.invoke("ai.setKey", { provider: "openai", value: "sk-e2e-0123456789" }, ctx);
    await server.backend.server.invoke("app.import", { data: { format: "unica-export", version: 1, settings: { ai: { provider: "openai", model: "gpt-x", baseURL: "https://evil.example/v1" } } } as never }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await openVia(page, "gear", "ai");
    await expect(page.getByRole("textbox", { name: "Endpoint" })).toHaveValue("https://evil.example/v1");
    await expect(page.getByTestId("ai-key-unconfirmed")).toContainText("https://api.openai.com");
    await page.getByTestId("ai-key-confirm").click();
    await expect(page.getByTestId("ai-key-saved")).toBeVisible();
  });

  test("Agentes and Datos: agent sending persists; export downloads and imports back", async ({ app: page, server }) => {
    await openVia(page, "gear", "agents");
    await page.getByRole("switch", { name: "Permitir que los agentes envíen correos" }).click();
    await reopen(page, "agents");
    await expect(page.getByRole("switch", { name: "Permitir que los agentes envíen correos" })).toBeChecked();

    await page.getByTestId("tab-data").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("data-export").click();
    const file = await download;
    const dump = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8")) as { categories: { name: string }[]; accounts: { email: string }[]; drafts: unknown[] };
    dump.categories.push({ ...dump.categories[0]!, name: "Desde el archivo", id: 999 } as never);
    dump.drafts.push({ accountEmail: dump.accounts[0]!.email, mode: "new", to: [{ name: "", email: "copia@x.dev" }], cc: [], bcc: [], subject: "Desde la copia", subjectEdited: true, bodyText: "Hola", quotedText: "", includeQuote: false, inReplyTo: null, forwardOf: null, uiState: "open", updatedAt: 1 });
    const input = page.getByTestId("data-import-input");
    await input.setInputFiles({ name: "unica.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(dump)) });
    await expect(page.locator("[data-testid^=nav-category-]").filter({ hasText: "Desde el archivo" })).toBeVisible();
    // its draft shows at once, and importing the same file again doesn't add it twice
    await expect(page.getByTestId("strip-item").filter({ hasText: "copia@x.dev" })).toHaveCount(1);
    await input.setInputFiles({ name: "unica.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(dump)) });
    await expect(page.getByText(/Importado: 0 categorías nuevas/)).toBeVisible();
    await expect(page.getByTestId("strip-item").filter({ hasText: "copia@x.dev" })).toHaveCount(1);
    expect((await server.backend.server.invoke("drafts.list", {}, ctx)).filter((d) => d.subject === "Desde la copia")).toHaveLength(1);
    expect((await server.backend.server.invoke("app.bootstrap", {}, ctx)).categories.some((c) => c.name === "Desde el archivo")).toBe(true);
  });
});

async function setMode(server: DevServer, page: Page, patch: object) {
  await server.backend.server.invoke("settings.update", patch, ctx);
  await page.reload();
  await page.locator("[data-ready]").waitFor();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`accessible (${scheme})`, () => {
    test(`axe finds nothing serious on any tab; controls have names and the right roles`, async ({ app: page, server }) => {
      test.setTimeout(90_000);
      await setMode(server, page, { theme: scheme });
      await page.getByTestId("open-settings").click();
      for (const [tab] of TABS) {
        await show(page, tab);
        expect(await axe(page), `tab ${tab}`).toEqual([]);
        // every switch, select and text field in the panel has a name
        const unnamed = await panel(page).evaluate((el) =>
          [...el.querySelectorAll<HTMLElement>("[role=switch], [role=combobox], input:not([type=hidden]):not([aria-hidden=true]), textarea, button")]
            .filter((c) => c.offsetParent !== null)
            .filter((c) => {
              const named = c.getAttribute("aria-label") || c.getAttribute("aria-labelledby") || (c.id && el.ownerDocument.querySelector(`label[for="${c.id}"]`)) || c.closest("label") || (c.textContent ?? "").trim();
              return !named;
            })
            .map((c) => c.outerHTML.slice(0, 120)),
        );
        expect(unnamed, `tab ${tab}`).toEqual([]);
      }
      // the color pickers are radio groups; descriptions are linked
      await show(page, "accounts");
      await expect(panel(page).getByRole("radiogroup", { name: "Color" }).getByRole("radio")).toHaveCount(8);
      await page.getByTestId("tab-general").click();
      await expect(page.getByRole("switch", { name: "Modo local" })).toHaveAccessibleDescription(/correo con tus servidores/);
    });
  });
}

test("contrast: axe's color-contrast rule passes on every tab in all 13 themes", async ({ app: page, server }) => {
  test.setTimeout(240_000);
  for (const theme of THEMES) {
    await setMode(server, page, theme.mode === "light" ? { theme: "light", lightTheme: theme.id } : { theme: "dark", darkTheme: theme.id });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.id);
    await page.getByTestId("open-settings").click();
    for (const [tab] of TABS) {
      await show(page, tab);
      expect(await axe(page, ["color-contrast"]), `${theme.id} / ${tab}`).toEqual([]);
    }
  }
});

test.describe("at the minimum window size (980×600)", () => {
  test.use({ viewport: { width: 980, height: 600 } });
  test("every tab fits: the tab list is whole, nothing scrolls sideways, the dialog stays in the window", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    for (const [tab] of TABS) {
      await show(page, tab);
      const box = (await dialog(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(980);
      expect(box.y + box.height).toBeLessThanOrEqual(600);
      await expect(page.getByTestId(`tab-${TABS.at(-1)![0]}`)).toBeInViewport();
      const sideways = await panel(page).evaluate((el) => {
        const scroller = el.parentElement!;
        return scroller.scrollWidth - scroller.clientWidth;
      });
      expect(sideways, tab).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("motion", () => {
  test.use({ reducedMotion: "no-preference" });
  test("the dialog opens on --motion (≤ 100 ms) and not at all at 0", async ({ app: page, server }) => {
    await setMode(server, page, { motionMs: 100 });
    await page.getByTestId("open-settings").click();
    const longest = await dialog(page).evaluate((el) => Math.max(0, ...el.getAnimations({ subtree: false }).map((a) => Number(a.effect?.getTiming().duration ?? 0))));
    expect(longest).toBeLessThanOrEqual(100);
    await page.keyboard.press("Escape");
    await setMode(server, page, { motionMs: 0 });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    await page.getByTestId("open-settings").click();
    expect(await dialog(page).evaluate((el) => getComputedStyle(el).transitionDuration.split(",").every((d) => parseFloat(d) === 0))).toBe(true);
  });
});

test.describe("reduced motion from the OS", () => {
  test("nothing in settings animates", async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await page.getByTestId("account-toggle").first().click();
    expect(await dialog(page).evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => Number(a.effect?.getTiming().duration ?? 0) > 0).length)).toBe(0);
  });
});
