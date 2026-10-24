import { readFileSync } from "node:fs";
import { connect } from "node:net";
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
    for (const [tab, label] of [["general", "General"], ["appearance", "Apariencia"], ["accounts", "Cuentas"], ["categories", "Categorías"], ["filters", "Filtros"], ["ai", "IA"], ["agents", "Agentes"], ["data", "Datos"]] as const) {
      await page.keyboard.press("Meta+k");
      await page.getByTestId("palette-input").fill(`ajustes ${label}`);
      await expect(page.getByRole("option", { selected: true })).toHaveAttribute("data-testid", `palette-settings-${tab}`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette-input")).toHaveCount(0);
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    }
    await page.getByTestId("search-input").focus();
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("tab-general")).toHaveAttribute("aria-selected", "true");
  });

  test("Ajustes → Filtros: turn off, edit in the builder (closing comes back), delete after confirming", async ({ app: page, server }) => {
    const ctx = { clientId: "t", origin: "dev" as const };
    const f = await server.backend.server.invoke("filters.save", { name: "Boletines", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "fromDomain", op: "equals", value: "news.example" }], actions: [{ type: "archive" }] } }, ctx);
    await page.keyboard.press("Meta+k");
    await page.getByTestId("palette-input").fill("ajustes filtros");
    await page.keyboard.press("Enter");
    const row = page.locator(`[data-filter-id="${f.id}"]`);
    await expect(row).toContainText("Dominio es «news.example»");
    await row.getByRole("switch", { name: "Activar «Boletines»" }).click();
    await expect.poll(async () => (await server.backend.server.invoke("filters.list", {}, ctx)).find((x) => x.id === f.id)!.enabled).toBe(false);
    await row.getByRole("button", { name: "Editar «Boletines»" }).click();
    await expect(page.getByTestId("filter-name")).toHaveValue("Boletines");
    await page.getByTestId("filter-name").fill("Boletines semanales");
    await page.getByTestId("filter-save").click();
    await expect.poll(async () => (await server.backend.server.invoke("filters.list", {}, ctx)).filter((x) => x.id === f.id).map((x) => [x.name, x.enabled])).toEqual([["Boletines semanales", false]]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tab-filters")).toHaveAttribute("aria-selected", "true");
    await row.getByRole("button", { name: "Eliminar «Boletines semanales»" }).click();
    await page.getByTestId("settings-filter-delete-dialog-confirm").click();
    await expect(row).toHaveCount(0);
    expect((await server.backend.server.invoke("filters.list", {}, ctx)).some((x) => x.id === f.id)).toBe(false);
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

test.describe("agents", () => {
  test.use({ backendOptions: { agentSocket: true } });

  test("Ajustes → Agentes: changing the token cuts connected agents off and writes a new one", async ({ app: page, server }) => {
    const { socketPath, tokenPath } = server.agents!;
    const old = readFileSync(tokenPath, "utf8");
    const agent = connect(socketPath);
    await new Promise<void>((r) => agent.once("data", () => r()).write(`${old}\n`));
    const closed = new Promise<void>((r) => agent.once("close", () => r()));
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-agents").click();
    await expect(page.getByTestId("agents-token-row")).toContainText("1 agente conectado");
    await page.getByRole("button", { name: "Cambiar token" }).click();
    await closed;
    await expect(page.getByTestId("agents-token-row")).toContainText("0 agentes conectados");
    expect(readFileSync(tokenPath, "utf8")).not.toBe(old);
    // and the send permission round-trips
    await page.getByRole("switch", { name: "Permitir que los agentes envíen correos" }).click();
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("tab-agents").click();
    await expect(page.getByRole("switch", { name: "Permitir que los agentes envíen correos" })).toBeChecked();
  });
});
