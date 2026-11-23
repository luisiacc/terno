/**
 * Plan 240: "Always show in “What matters”" from a sender's menu. A list's mail (never a person's, so never in Needs you)
 * comes into What matters once its sender is shown, and leaves with the snack's Undo; the menu then offers to stop; Settings
 * lists who's shown, each with Stop, named for screen readers; axe in light and dark.
 */
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, menuPath, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const esof = { name: "ESOF", email: "casa@tacsecurity.test" };

/** the reminder that started it: a list's mail, unread in the Inbox */
async function seed(server: DevServerFixture): Promise<number> {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true } }, dev);
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const text = "Your account has been created. Please complete the LOV form.";
  const m = { accountId: acct.id, providerMsgId: "lov", providerThreadId: "lov", rfcMessageId: "<lov@e2e.test>", inReplyTo: null, references: [], from: esof, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: "Reminder to Complete LOV Form Submission", date: E2E_NOW - 60_000, snippet: text, bodyText: text, bodyHtml: null, bodyState: "full", listId: "<casa.tacsecurity.test>", isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 } as unknown as IncomingMessage;
  await store.sync.ingest([m], { applyFilters: false, now: E2E_NOW, classifier: null });
  return db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'lov'")!.thread_id;
}

const rowOf = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const feedLine = (page: Page, id: number) => page.getByTestId("wm-feed").locator(`[data-thread-id="${id}"]:not([data-history])`);
const snack = (page: Page) => page.getByTestId("snack");

async function senderMenu(page: Page, id: number): Promise<void> {
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more");
}

test("plan 240: Always show in What matters from a sender's menu, with Undo; Stop from the menu and from Settings", async ({ app: page, server }) => {
  const thread = await seed(server);
  await fresh(page);
  await expect(rowOf(page, thread)).toBeVisible({ timeout: 15_000 });

  await scenario("a list's mail isn't in What matters; the sender's menu shows it there, and the snack's Undo takes it back out", async () => {
    await page.getByTestId("nav-today").click();
    await expect(page.getByTestId("wm-feed")).toBeVisible();
    await expect(feedLine(page, thread)).toHaveCount(0);
    await page.getByTestId("nav-inbox").click();
    await senderMenu(page, thread);
    await axeBothModes(page, '[data-testid="menu-more-list"]');
    const show = page.getByTestId("menu-sender-show");
    await expect(show).toHaveText("Always show in “What matters”");
    await show.click();
    await expect(snack(page)).toContainText("“What matters” will always show mail from ESOF");
    await page.getByTestId("nav-today").click();
    await expect(feedLine(page, thread)).toBeVisible();
    await page.keyboard.press("z");
    await expect(feedLine(page, thread)).toHaveCount(0);
  });

  await scenario("shown again, the menu offers to stop, and Stop is said with its own Undo", async () => {
    await page.getByTestId("nav-inbox").click();
    await senderMenu(page, thread);
    await page.getByTestId("menu-sender-show").click();
    await expect(snack(page)).toContainText("will always show mail from ESOF");
    await senderMenu(page, thread);
    const stop = page.getByTestId("menu-sender-unshow");
    await expect(stop).toHaveText("Stop always showing in “What matters”");
    await stop.click();
    await expect(snack(page)).toContainText("“What matters” is back to its usual rules for ESOF");
    await page.keyboard.press("z");
    await page.getByTestId("nav-today").click();
    await expect(feedLine(page, thread)).toBeVisible();
  });

  await scenario("Settings → What matters lists who's always shown, by keyboard, each Stop named for its sender", async () => {
    await page.getByTestId("wm-options").click();
    await page.getByTestId("wm-options-more").click();
    const list = page.getByTestId("today-shown-list");
    await expect(list.getByTestId("today-shown-list-item")).toHaveText(["ESOFcasa@tacsecurity.testStop"]);
    const stop = list.getByTestId("today-shown-list-stop");
    await expect(stop).toHaveAccessibleDescription("ESOF");
    await axeBothModes(page, '[data-testid="today-shown"]');
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(snack(page)).toContainText("back to its usual rules for ESOF");
    await expect(list).toHaveCount(0);
  });
});
