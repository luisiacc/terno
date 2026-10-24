import { expect, test } from "./fixtures";

test.describe("accounts, settings and command palette", () => {
  test("IMAP presets autofill servers; the account is added and appears in the sidebar", async ({ app: page }) => {
    await page.getByTestId("sidebar").getByText("Añadir cuenta").click();
    const dialog = page.getByTestId("add-account-dialog");
    await page.getByTestId("imap-email").fill("ana@icloud.com");
    await expect(page.getByTestId("imap-host")).toHaveValue("imap.mail.me.com");
    await expect(page.getByTestId("smtp-host")).toHaveValue("smtp.mail.me.com");
    // required password: the form is not submitted
    await page.getByTestId("imap-submit").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("imap-password").fill("app-password");
    await page.getByTestId("imap-submit").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("[data-testid^=nav-account-]").filter({ hasText: "ana@icloud.com" })).toBeVisible();
  });

  test("theme switches to dark; Agents shows the MCP setup", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();
    await page.getByTestId("mode-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByTestId("tab-agents").click();
    await expect(page.getByTestId("mcp-claude")).toContainText('claude mcp add unica -- "/Applications/Unica.app/Contents/Resources/bin/unica-mcp"');
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/); // persisted before React mounts
  });

  test("the settings tab list is vertical: ↓/↑ move between tabs, Esc returns focus to the gear", async ({ app: page }) => {
    await page.getByTestId("open-settings").click();
    const general = page.getByTestId("tab-general");
    await expect(page.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    await general.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("tab-appearance")).toBeFocused();
    await expect(page.getByTestId("tab-appearance")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await expect(general).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    await expect(page.getByTestId("open-settings")).toBeFocused();
  });

  test("every settings tab opens from the palette; ⌘, opens settings, also from the search field", async ({ app: page }) => {
    for (const [tab, label] of [["general", "General"], ["appearance", "Apariencia"], ["accounts", "Cuentas"], ["categories", "Categorías"], ["ai", "IA"], ["agents", "Agentes"]] as const) {
      await page.keyboard.press("Meta+k");
      await page.getByTestId("palette-input").fill(`ajustes ${label}`);
      await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", `palette-settings-${tab}`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    }
    await page.getByTestId("search-input").focus();
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("tab-general")).toHaveAttribute("aria-selected", "true");
  });

  test("⌘K jumps to a category and runs a search", async ({ app: page }) => {
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("Viajes");
    await expect(page.getByRole("option", { selected: true })).toContainText("Viajes");
    await expect(page.getByRole("option", { selected: true })).not.toContainText("Buscar");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("list-title")).toHaveText("Viajes");
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("presupuesto");
    await page.getByRole("option", { name: /Buscar «presupuesto»/ }).click();
    await expect(page.getByTestId("search-input")).toHaveValue("presupuesto");
    await expect(page.getByTestId("search-stats")).toBeVisible();
  });

  test("g then i returns to the inbox from anywhere; ? shows the shortcuts", async ({ app: page }) => {
    await page.getByTestId("nav-archive").click();
    await expect(page.getByTestId("list-title")).toHaveText("Archivo");
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.getByTestId("list-title")).toHaveText("Entrada");
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Atajos de teclado" })).toBeVisible();
  });
});
