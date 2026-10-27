/**
 * Visual regression of the key screens (light + dark). Baselines live in
 * e2e/__screenshots__; regenerate with `pnpm test:e2e --update-snapshots`.
 */
import { expect, focusList, isolateLocalDiscovery, openRow, search, stabilize, test } from "./fixtures";
import { startOllamaStub } from "./ollama-stub";
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";

/** AI tab on a local Ollama (stub) with its models listed and a successful connection test. */
async function aiTabWithOllama(page: Page, ollamaUrl: string) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-provider").click();
  await page.getByTestId("ai-choice-ollama").click();
  await page.getByTestId("ai-endpoint").fill(`${ollamaUrl}/v1`);
  await page.getByTestId("ai-model-option").first().click();
  await expect(page.getByTestId("ai-model-option").first()).toContainText("40k ctx");
  await page.getByTestId("ai-test").click();
  await expect(page.getByTestId("ai-test-result")).toBeVisible();
  await stabilize(page);
}

/** The snackbar with its counts loaded, nothing hovered or focused. Screenshots finish animations: the countdown ring is drawn run out (the snack itself expires by its timer, not by that). */
async function snackbarReady(page: Page) {
  await expect(page.getByTestId("snackbar-sender-count")).toBeVisible();
  await expect(page.getByTestId("snackbar-count-loading")).toHaveCount(0);
  await expect(page.getByTestId("snackbar-topic-count")).toHaveText(/· \d/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
}

async function ready(page: Page, { banner = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  if (banner) await expect(page.getByTestId("learned-banner")).toBeVisible();
  await expect(page.getByTestId("message").first()).toBeVisible();
  await stabilize(page);
}

test.describe("chrome", () => {
  test("toolbar hairlines appear only once content scrolls under them", async ({ app: page }) => {
    const header = page.getByTestId("list-header");
    await expect(header).not.toHaveAttribute("data-scrolled");
    await page.getByRole("listbox").evaluate((el) => el.scrollTo(0, 400));
    await expect(header).toHaveAttribute("data-scrolled", "");
    await page.getByRole("listbox").evaluate((el) => el.scrollTo(0, 0));
    await expect(header).not.toHaveAttribute("data-scrolled");
  });

  test("the learned-filter suggestion is quiet: its action isn't a solid primary button", async ({ app: page }) => {
    const accept = page.getByTestId("learned-accept");
    await expect(accept).toBeVisible();
    const [bg, primary] = await accept.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--primary)";
      document.body.append(probe);
      const p = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(el).backgroundColor, p];
    });
    expect(bg).not.toBe(primary);
  });

  test("compose is a quiet icon in the list header, named for assistive tech", async ({ app: page }) => {
    const button = page.getByRole("button", { name: "Compose" });
    await expect(button).toBeVisible();
    await expect(page.getByTestId("sidebar").getByRole("button", { name: /Compose/ })).toHaveCount(0);
  });
});

test.describe("light", () => {
  test("inbox with the reader", async ({ app: page }) => {
    await ready(page);
    await expect(page).toHaveScreenshot("inbox-light.png");
  });

  test("HTML newsletter with remote content blocked", async ({ app: page }) => {
    await openRow(page, 2);
    await expect(page.getByTestId("remote-blocked")).toBeVisible();
    await expect(page.frameLocator("iframe[title='Message content']").locator("h1")).toBeVisible();
    await ready(page);
    await expect(page).toHaveScreenshot("reader-html.png");
  });

  test("search results", async ({ app: page }) => {
    await search(page, "in:all factura");
    await ready(page, { banner: false });
    await expect(page).toHaveScreenshot("search.png", { mask: [page.getByTestId("search-stats")] });
  });

  test("inline reply", async ({ app: page }) => {
    await ready(page);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("Hola Isabella, sí lo reviso hoy.");
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    await expect(page).toHaveScreenshot("reply-inline.png");
  });

  test("new message in the reader pane", async ({ app: page }) => {
    await ready(page);
    await focusList(page);
    await page.keyboard.press("c");
    await page.getByTestId("compose-to").fill("Ana Torres <ana@example.com>");
    await page.getByTestId("compose-subject").fill("Propuesta de colaboración");
    await page.getByTestId("compose-body").fill("Hola Ana,\n\nTe comparto la propuesta que platicamos. Si te parece bien, la revisamos el jueves.\n\nSaludos,\nLuis");
    await expect(page.getByTestId("draft-status")).toHaveText("Draft saved");
    await expect(page).toHaveScreenshot("compose-new-inline.png");
  });

  test("AI filter builder with live preview", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("preview-count")).toHaveText(/^\d+$/);
    await stabilize(page);
    await expect(page).toHaveScreenshot("filters-ai.png", { mask: [page.getByTestId("preview-ms")] });
  });

  test("settings: agents", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-agents").click();
    await expect(page.getByTestId("mcp-claude")).toBeVisible();
    await stabilize(page);
    await expect(page).toHaveScreenshot("settings-agents.png");
  });

  test("settings: AI on a local model", async ({ app: page }) => {
    await ready(page);
    const ollama = await startOllamaStub();
    try {
      await aiTabWithOllama(page, ollama.url);
      await expect(page).toHaveScreenshot("settings-ai-local.png", { mask: [page.getByTestId("ai-endpoint"), page.getByTestId("ai-test-latency")] });
    } finally {
      await ollama.close();
    }
  });

  test("settings: general with local mode first", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("local-pill").click();
    await expect(page.getByTestId("local-mode-switch")).toBeChecked();
    await stabilize(page);
    await expect(page).toHaveScreenshot("settings-general.png");
  });

  test("add account", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("sidebar").getByText("Add account").click();
    await page.getByTestId("imap-email").fill("ana@icloud.com");
    await stabilize(page);
    await expect(page).toHaveScreenshot("add-account.png");
  });

  test("category picker and the snackbar after filing", async ({ app: page, server }) => {
    const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await search(page, "in:inbox from:uber.receipts@uber.com");
    const target = sqlDb(server.backend.store).get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
      facturas,
    )!.id;
    await page.locator(`[data-thread-id="${target}"]`).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await expect(page.getByTestId("category-picker").getByRole("combobox")).toBeFocused();
    await stabilize(page);
    await expect(page).toHaveScreenshot("category-picker.png", { mask: [page.getByTestId("search-stats")] });
    await page.getByTestId(`pick-category-${facturas}`).click();
    await snackbarReady(page);
    await expect(page.getByTestId("snack")).toHaveScreenshot("category-snackbar.png");
  });
});

test.describe("owner identity", () => {
  test.use({ backendOptions: { ownerClaims: true } });

  test("settings: accounts with the owner card", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("sidebar").getByText("Add account").click();
    await page.getByTestId("imap-email").fill("luis@fastmail.com");
    await page.getByTestId("imap-password").fill("app-password");
    await page.getByTestId("imap-submit").click();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.getByTestId("owner-email")).toHaveText("luis@fastmail.com");
    await stabilize(page);
    await expect(page.getByTestId("settings-dialog")).toHaveScreenshot("settings-accounts-owner.png");
  });
});

test.describe("first run", () => {
  test.use({ backendOptions: { empty: true, ownerClaims: true } });

  test("step 1: local or connected", async ({ app: page, server }) => {
    // no real Ollama / LM Studio on the test machine may change what this screen shows
    await isolateLocalDiscovery(server);
    await page.reload();
    await expect(page.getByTestId("first-run")).toContainText("Step 1 of 2");
    await expect(page.getByTestId("first-run-found")).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    await stabilize(page);
    await expect(page).toHaveScreenshot("first-run.png");
  });
});

test.describe("dark", () => {
  test.use({ colorScheme: "dark" });

  test("settings: AI on a local model", async ({ app: page }) => {
    await ready(page);
    const ollama = await startOllamaStub();
    try {
      await aiTabWithOllama(page, ollama.url);
      await expect(page).toHaveScreenshot("settings-ai-local-dark.png", { mask: [page.getByTestId("ai-endpoint"), page.getByTestId("ai-test-latency")] });
    } finally {
      await ollama.close();
    }
  });

  test("snackbar after filing", async ({ app: page, server }) => {
    const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const target = sqlDb(server.backend.store).get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
      facturas,
    )!.id;
    await search(page, "in:inbox from:uber.receipts@uber.com");
    await page.locator(`[data-thread-id="${target}"]`).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    await snackbarReady(page);
    await expect(page.getByTestId("snack")).toHaveScreenshot("category-snackbar-dark.png");
  });

  test("inbox with the reader", async ({ app: page }) => {
    await ready(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page).toHaveScreenshot("inbox-dark.png");
  });

  test("AI filter builder", async ({ app: page }) => {
    await ready(page);
    await page.getByTestId("open-filters").click();
    await page.getByTestId("ai-prompt").fill("archiva los correos de uber.com y ponlos en Facturas");
    await page.getByTestId("ai-generate").click();
    await expect(page.getByTestId("preview-count")).toHaveText(/^\d+$/);
    await stabilize(page);
    await expect(page).toHaveScreenshot("filters-ai-dark.png", { mask: [page.getByTestId("preview-ms")] });
  });
});

/** Spanish runs longer than English: the densest screens, to catch overflow and truncation. */
async function spanish(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("language-select").click();
  await page.getByTestId("language-es").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
}

test.describe("Spanish", () => {
  test("inbox with the reader", async ({ app: page }) => {
    await spanish(page);
    await page.keyboard.press("Escape");
    await ready(page);
    await expect(page).toHaveScreenshot("es-inbox-light.png");
  });

  test("settings: general", async ({ app: page }) => {
    await spanish(page);
    await ready(page);
    await expect(page).toHaveScreenshot("es-settings-general.png");
  });

  test("settings: appearance", async ({ app: page }) => {
    await spanish(page);
    await page.getByTestId("tab-appearance").click();
    await ready(page);
    await expect(page).toHaveScreenshot("es-settings-appearance.png");
  });

  test("print sheet", async ({ app: page }) => {
    await spanish(page);
    await page.keyboard.press("Escape");
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("Meta+p");
    await expect(page.getByTestId("print-sheet")).toBeVisible();
    await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
    await ready(page);
    await expect(page).toHaveScreenshot("es-print-sheet.png");
  });

  test.describe("dark", () => {
    test.use({ colorScheme: "dark" });
    test("inbox with the reader", async ({ app: page }) => {
      await spanish(page);
      await page.keyboard.press("Escape");
      await ready(page);
      await expect(page).toHaveScreenshot("es-inbox-dark.png");
    });
  });
});
