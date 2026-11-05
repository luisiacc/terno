/**
 * Plan 86: Gmail's Promotions and Social out of the Inbox, on the seeded demo mailbox plus a few promotions and a
 * social notification each test adds to Personal (newest of all, so the virtualized list draws them). They live
 * under their account, after Trash; the unified and the account's Inbox and their counts leave them out; Move to
 * Inbox takes one out of its tab (and Undo puts it back); the account's setting brings them all back.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { msg } from "@terno/store/conformance";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, rows, test } from "./fixtures";

const accountOf = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", name)!.id;
const rowIds = (page: Page) => page.locator("[data-testid=thread-row]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-thread-id"))));
const listFor = (page: Page) => page.getByTestId("thread-list").getAttribute("data-results-for").then((k) => JSON.parse(k!) as unknown[]);
const row = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const threadOf = (server: DevServer, providerMsgId: string) => sqlDb(server.backend.store).get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", providerMsgId)!.thread_id;

/** Three promotions and a social notification in Personal, newer than any demo mail; the app reloads to show them. */
async function seedTabs(page: Page, server: DevServer, accountId: number) {
  const mail = (id: string, from: string, label: string, minutes: number) =>
    msg({ accountId, providerMsgId: id, from: { name: from.split("@")[0]!, email: from }, subject: `${id} subject`, date: E2E_NOW + minutes * 60_000, gmailLabels: ["INBOX", "UNREAD", label] });
  await server.backend.store.sync.ingest(
    [mail("promo-a", "deals@shop.example", "CATEGORY_PROMOTIONS", 1), mail("promo-b", "news@store.example", "CATEGORY_PROMOTIONS", 2), mail("promo-c", "sale@outlet.example", "CATEGORY_PROMOTIONS", 3), mail("social-a", "notify@friends.example", "CATEGORY_SOCIAL", 4)],
    { applyFilters: false, now: E2E_NOW, classifier: null },
  );
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  return { promo: threadOf(server, "promo-c"), promos: ["promo-a", "promo-b", "promo-c"].map((id) => threadOf(server, id)), social: threadOf(server, "social-a") };
}
const inboxUnread = (server: DevServer) =>
  sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM threads t JOIN accounts a ON a.id = t.account_id WHERE t.in_inbox = 1 AND t.unread_count > 0 AND (t.tab = 0 OR coalesce(json_extract(a.provider_config, '$.separateTabs') = 0, 0)) AND NOT EXISTS (SELECT 1 FROM thread_categories h JOIN categories k ON k.id = h.category_id WHERE h.thread_id = t.id AND k.show_in_inbox = 0)")!.c;

test.describe("Gmail's Promotions and Social (plan 86)", () => {
  test("a Gmail account lists them after Trash with their counts; an IMAP one doesn't; a promotion is out of every Inbox and in its tab", { tag: "@variant" }, async ({ app: page, server }) => {
    const personal = accountOf(server, "Personal");
    const freelance = accountOf(server, "Freelance");
    const { promo, social } = await seedTabs(page, server, personal);
    await expect(page.getByTestId("nav-inbox").locator("[data-slot=nav-count]")).toHaveText(String(inboxUnread(server)));
    await expect(row(page, promo)).toHaveCount(0);
    await expect(row(page, social)).toHaveCount(0);

    await page.getByTestId(`nav-account-${personal}`).click();
    const group = page.locator(`#account-folders-${personal}`);
    const order = () => group.locator("[data-testid^=nav-folder-], [data-testid^=nav-tab-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    await expect.poll(order).toEqual([...["inbox", "sent", "archive", "spam", "trash"].map((v) => `nav-folder-${personal}-${v}`), `nav-tab-${personal}-promotions`, `nav-tab-${personal}-social`]);
    await expect.poll(() => listFor(page)).toEqual(["inbox", personal, null, null, null, ""]);
    await expect(rows(page).first()).toBeVisible();
    await expect(row(page, promo)).toHaveCount(0);
    const unreadPromotions = sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE account_id = ? AND in_inbox = 1 AND tab = 1 AND unread_count > 0", personal)!.c;
    expect(unreadPromotions).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId(`nav-tab-${personal}-promotions`).locator("[data-slot=nav-count]")).toHaveText(String(unreadPromotions));
    await expect(page.getByTestId(`nav-tab-${personal}-social`).locator("[data-slot=nav-count]")).toHaveText("1");
    await page.getByTestId(`nav-tab-${personal}-social`).click();
    await expect(row(page, social)).toBeVisible();

    await page.getByTestId(`nav-tab-${personal}-promotions`).click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", personal, null, null, null, "~promotions", ""]);
    await expect(page.getByTestId(`nav-tab-${personal}-promotions`)).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#app-sidebar [aria-current=page]")).toHaveCount(1);
    await expect(page.getByTestId("thread-list")).toContainText("Promotions");
    // its own unread count under the title, where the design shows one, not the account's Inbox's (Codex code review #7)
    if (await page.getByTestId("list-subtitle").count()) await expect(page.getByTestId("list-subtitle")).toContainText(`${unreadPromotions} unread`);
    await expect(row(page, promo)).toBeVisible();
    const members = new Set(sqlDb(server.backend.store).all<{ id: number }>("SELECT id FROM threads WHERE account_id = ? AND in_inbox = 1 AND tab = 1", personal).map((r) => r.id));
    expect((await rowIds(page)).every((id) => members.has(id))).toBe(true);

    await page.getByTestId(`nav-account-${freelance}`).click();
    await expect(page.locator(`#account-folders-${freelance} [data-testid^=nav-tab-]`)).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include("#app-sidebar").analyze()).violations).toEqual([]);
  });

  test("a lone Gmail account opens to its standard folders and tabs; turned off, the tabs go and focus goes to its Inbox", async ({ app: page, server }) => {
    const personal = accountOf(server, "Personal");
    for (const a of await server.backend.store.accounts.list()) if (a.id !== personal) await server.backend.server.invoke("accounts.remove", { id: a.id }, { clientId: "setup", origin: "dev" as const });
    await server.backend.store.folders.replace(personal, []);
    server.backend.server.emit("folders", await server.backend.store.folders.list());
    await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(1);
    const only = page.getByTestId(`nav-account-${personal}`);
    await expect(only).toHaveAttribute("aria-expanded", "false");
    await only.click();
    const promotions = page.getByTestId(`nav-tab-${personal}-promotions`);
    await expect(promotions).toBeVisible();
    await promotions.click();
    await expect(promotions).toHaveAttribute("aria-current", "page");
    await promotions.focus();
    await server.backend.server.invoke("accounts.update", { id: personal, separateTabs: false }, { clientId: "setup", origin: "dev" as const });
    await expect(promotions).toHaveCount(0);
    // its standard folders stay listed: the account's Inbox takes the focus, as with several accounts
    await expect(page.getByTestId(`nav-folder-${personal}-inbox`)).toBeFocused();
    await expect(only).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => listFor(page)).toEqual(["inbox", personal, null, null, null, ""]);
  });

  test("a focused Promotions row that goes (the setting off elsewhere) hands focus to the account's Inbox row", async ({ app: page, server }) => {
    const personal = accountOf(server, "Personal");
    await page.getByTestId(`nav-account-${personal}`).click();
    const promotions = page.getByTestId(`nav-tab-${personal}-promotions`);
    await promotions.focus();
    await expect(promotions).toBeFocused();
    await server.backend.server.invoke("accounts.update", { id: personal, separateTabs: false }, { clientId: "setup", origin: "dev" as const });
    await expect(promotions).toHaveCount(0);
    await expect(page.getByTestId(`nav-folder-${personal}-inbox`)).toBeFocused();
  });

  test("Move to Inbox takes a promotion out of its tab into the Inbox; Undo puts it back", async ({ app: page, server }) => {
    const personal = accountOf(server, "Personal");
    const { promo } = await seedTabs(page, server, personal);
    await page.getByTestId(`nav-account-${personal}`).click();
    await page.getByTestId(`nav-tab-${personal}-promotions`).click();
    await row(page, promo).click();
    await page.getByTestId("action-inbox").click();
    await expect(page.getByTestId("snack").filter({ hasText: "Moved to Inbox" })).toBeVisible();
    await expect(row(page, promo)).toHaveCount(0);
    await expect.poll(() => sqlDb(server.backend.store).get<{ tab: number }>("SELECT tab FROM threads WHERE id = ?", promo)!.tab).toBe(0);
    // Gmail is told (the category op, queued for the account)
    expect(sqlDb(server.backend.store).get<{ c: number }>("SELECT count(*) AS c FROM ops WHERE kind = 'toPrimary' AND account_id = ?", personal)!.c).toBe(1);
    await page.getByTestId(`nav-folder-${personal}-inbox`).click();
    await expect(row(page, promo)).toBeVisible();

    await page.keyboard.press("z");
    await expect.poll(() => sqlDb(server.backend.store).get<{ tab: number }>("SELECT tab FROM threads WHERE id = ?", promo)!.tab).toBe(1);
    await expect(row(page, promo)).toHaveCount(0);
  });

  test("right-click in the Inbox → Move to Promotions; in Promotions → Move to Inbox", async ({ app: page, server }) => {
    const personal = accountOf(server, "Personal");
    await page.getByTestId(`nav-account-${personal}`).click();
    const first = rows(page).first();
    const id = Number(await first.getAttribute("data-thread-id"));
    await first.click({ button: "right" });
    await page.getByTestId("menu-to-promotions").click();
    await expect(page.getByTestId("snack").filter({ hasText: "Moved to Promotions" })).toBeVisible();
    await expect(row(page, id)).toHaveCount(0);
    await page.getByTestId(`nav-tab-${personal}-promotions`).click();
    await expect(row(page, id)).toBeVisible();
    await row(page, id).click({ button: "right" });
    await expect(page.getByTestId("menu-to-promotions")).toHaveCount(0);
    await page.getByTestId("menu-inbox").click();
    await expect(row(page, id)).toHaveCount(0);
  });

  test("Settings → Accounts: Separate Promotions and Social off brings them back to the Inbox at once; on takes them out", async ({ app: page, server }) => {
    const personal = accountOf(server, "Personal");
    const { promo } = await seedTabs(page, server, personal);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    const account = page.locator(`[data-testid=settings-account][data-account-id="${personal}"]`);
    await account.getByTestId("account-toggle").click();
    const toggle = account.getByRole("switch", { name: "Separate Promotions and Social" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId("snack").filter({ hasText: "Promotions and Social show in the Inbox again" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row(page, promo)).toBeVisible();
    await expect(page.getByTestId("nav-inbox").locator("[data-slot=nav-count]")).toHaveText(String(inboxUnread(server)));
    await page.getByTestId(`nav-account-${personal}`).click();
    await expect(page.getByTestId(`nav-tab-${personal}-promotions`)).toHaveCount(0);

    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-accounts").click();
    if ((await account.getByTestId("account-toggle").getAttribute("aria-expanded")) !== "true") await account.getByTestId("account-toggle").click();
    await account.getByRole("switch", { name: "Separate Promotions and Social" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`nav-tab-${personal}-promotions`)).toBeVisible();
    await page.getByTestId("nav-inbox").click();
    await expect(row(page, promo)).toHaveCount(0);
  });
});
