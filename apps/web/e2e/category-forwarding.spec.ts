/**
 * Plan 116 in the page: a category's menu sets up forwarding (the sidebar
 * marks it), new mail filed there waits its 10 s with one notice and Cancel,
 * the reader says where each forward is, and the filter builder's "Forward
 * to" saves a forward action. The send itself (after the 10 s) is the
 * backend's (forwarding.test.ts): the e2e backend's clock stands still.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { E2E_NOW } from "./constants";
import { chipsOf, expect, rows, test } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

test.use({ backendOptions: { network: true } });

const SETUP = { clientId: "setup", origin: "dev" as const };

function invoice(accountId: number, subject: string): IncomingMessage {
  return {
    accountId, providerMsgId: `fwd-${subject}`, providerThreadId: null, rfcMessageId: `${subject.replace(/\W/g, "")}@shop.test`, inReplyTo: null, references: [],
    from: { name: "Tienda", email: "facturas@shop.test" }, to: [{ name: "Me", email: "me@example.com" }], cc: [], bcc: [],
    subject, date: E2E_NOW - 60_000, snippet: "Total: 10", bodyText: "Total: 10", bodyHtml: null, bodyState: "full", listId: null,
    isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  };
}

/** Facturas (the seed's), a filter filing "Factura" mail there, and its menu's dialog open. */
async function setUp(page: Page, server: Parameters<Parameters<typeof test>[2]>[0]["server"]) {
  const db = sqlDb(server.backend.store);
  const cat = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  await server.backend.server.invoke("filters.save", { name: "Facturas", enabled: true, source: "manual", rule: { match: "all", conditions: [{ field: "subject", op: "contains", value: "Factura" }], actions: [{ type: "addCategory", categoryId: cat }] } }, SETUP);
  await page.getByTestId(`nav-category-${cat}`).click({ button: "right" });
  await page.getByTestId("category-menu-forward").click();
  const dialog = page.getByTestId("category-forward-dialog");
  await expect(dialog).toBeVisible();
  return { db, cat, dialog };
}

test.describe("forwarding what lands in a category (plan 116)", { tag: "@design" }, () => {
  test("the menu sets it up; new mail filed there waits with one notice and Cancel; the reader says so", async ({ app: page, server }) => {
    const { db, cat, dialog } = await setUp(page, server);
    await expect(dialog.getByRole("heading")).toHaveText("Forward new mail from Facturas");
    await expect(dialog.getByTestId("category-forward-save")).toBeDisabled();
    await dialog.getByTestId("category-forward-to").pressSequentially("Ana <ana@books.test>, ");
    await expect(chipsOf(dialog as unknown as Page, "category-forward-to")).toHaveCount(1);
    await dialog.getByTestId("category-forward-save").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("snack").filter({ hasText: "New mail in Facturas will be forwarded" })).toBeVisible();
    await expect(page.getByTestId(`nav-category-forward-${cat}`)).toHaveAttribute("aria-label", "Forwards new mail to Ana");
    expect(JSON.parse(db.get<{ forward_json: string }>("SELECT forward_json FROM categories WHERE id = ?", cat)!.forward_json)).toMatchObject({ addresses: [{ name: "Ana", email: "ana@books.test" }], enabled: true });

    // new mail the filter files there: one notice with Cancel
    const accountId = (await server.backend.store.accounts.list())[0]!.id;
    server.net.incoming.push(invoice(accountId, "Factura 0042"));
    await server.backend.syncAccount(accountId);
    const notice = page.getByTestId("snack").filter({ hasText: "Forwarding a message to Ana" });
    await expect(notice).toBeVisible();

    // the reader: where it is, with its own Cancel
    await page.getByTestId(`nav-category-${cat}`).click();
    await rows(page).filter({ hasText: "Factura 0042" }).click();
    const line = page.getByTestId("forward-line-item");
    await expect(line).toHaveAttribute("data-status", "waiting");
    await expect(line).toContainText("Forwarding to Ana");
    await line.getByTestId("forward-line-cancel").click();
    await expect(line).toHaveAttribute("data-status", "cancelled");
    await expect(line).toContainText("Forward to Ana cancelled");
    await expect(notice).toBeHidden();
    expect(db.get("SELECT state FROM forwards")).toEqual({ state: "cancelled" });

    // the notice's Cancel takes what it stands for
    server.net.incoming.push(invoice(accountId, "Factura 0043"));
    await server.backend.syncAccount(accountId);
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Cancel forwarding" }).click();
    await expect(page.getByTestId("snack").filter({ hasText: "Forward cancelled" })).toBeVisible();
    expect(db.all("SELECT state FROM forwards ORDER BY id")).toEqual([{ state: "cancelled" }, { state: "cancelled" }]);
  });

  test("set up with the keyboard alone; Stop forwarding forgets the addresses", async ({ app: page, server }) => {
    const { db, cat, dialog } = await setUp(page, server);
    await expect(dialog.getByTestId("category-forward-to")).toBeFocused();
    await page.keyboard.type("luis@books.test, ");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(dialog.getByTestId("category-forward-save")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(`nav-category-forward-${cat}`)).toBeVisible();

    await page.getByTestId(`nav-category-${cat}`).click({ button: "right" });
    await page.getByTestId("category-menu-forward").click();
    await expect(chipsOf(dialog as unknown as Page, "category-forward-to")).toHaveCount(1);
    await dialog.getByTestId("category-forward-stop").click();
    await expect(page.getByTestId(`nav-category-forward-${cat}`)).toHaveCount(0);
    expect(db.get("SELECT forward_json FROM categories WHERE id = ?", cat)).toEqual({ forward_json: null });
  });

  test("the filter builder's Forward to saves a forward action; incomplete until it has an address", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-filters").click();
    await page.getByTestId("settings-filter-new").click();
    await page.getByTestId("condition-value").fill("facturas@shop.test");
    await expect(page.getByTestId("filter-invalid")).toHaveCount(0);
    await page.getByTestId("action-toggle-archive").click();
    await page.getByTestId("action-toggle-forward").click();
    await expect(page.getByTestId("action-toggle-forward")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-forward")).toContainText("Applying the filter to existing mail never forwards.");
    await expect(page.getByTestId("filter-invalid")).toBeVisible();
    await page.getByTestId("filter-forward-to").pressSequentially("ana@books.test, bob@");
    // Codex code review #11: a wrong address is never dropped quietly: it's named, and Save waits for it
    await page.getByTestId("filter-forward-to").press("Tab");
    await expect(page.getByTestId("filter-forward").getByRole("alert")).toHaveText("Check the addresses: bob@ isn't valid.");
    await expect(page.getByTestId("filter-save")).toBeDisabled();
    await page.getByTestId("filter-forward-to").click();
    // the chip before is selected, then removed (the selection holds focus)
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("filter-forward").getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("filter-invalid")).toHaveCount(0);
    await page.getByTestId("filter-name").fill("Facturas a Ana");
    await page.getByTestId("filter-save").click();
    await expect.poll(() => db.get<{ rule_json: string }>("SELECT rule_json FROM filters WHERE name = 'Facturas a Ana'")?.rule_json).toContain('"type":"forward"');
    expect(JSON.parse(db.get<{ forward_json: string }>("SELECT forward_json FROM filters WHERE name = 'Facturas a Ana'")!.forward_json)).toMatchObject({ enabled: true, rev: 1 });
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the dialog, the sidebar's mark and the reader's line are axe-clean, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, SETUP);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const { cat, dialog } = await setUp(page, server);
      await dialog.getByTestId("category-forward-to").pressSequentially("Ana <ana@books.test>, luis@books.test, ");
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/forward-dialog-${mode}.png` });
      const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
      const inDialog = await new AxeBuilder({ page }).include("[data-testid=category-forward-dialog]").withTags(tags).analyze();
      expect(inDialog.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
      await dialog.getByTestId("category-forward-save").click();
      await expect(dialog).toBeHidden();

      const accountId = (await server.backend.store.accounts.list())[0]!.id;
      server.net.incoming.push(invoice(accountId, "Factura 0099"));
      await server.backend.syncAccount(accountId);
      await page.getByTestId(`nav-category-${cat}`).click();
      await rows(page).filter({ hasText: "Factura 0099" }).click();
      await expect(page.getByTestId("forward-line-item")).toHaveAttribute("data-status", "waiting");
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/forward-reader-${mode}.png` });
      const rest = await new AxeBuilder({ page }).include("[data-testid=forward-line]").include(`[data-testid=nav-category-${cat}]`).withTags(tags).analyze();
      expect(rest.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    });
  }
});
