/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"): after Remove, the snack offers once to hide more of its kind,
 * then its sender, each with its own Undo; What matters' gear and Settings list what's hidden, each with Show again, by
 * keyboard and named for screen readers; axe in light and dark.
 */
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
const parcel = { name: "Parcel Co", email: "track@parcel.test" };

/** an open item due today at `hour`, on its own conversation from `from`, written as the reader writes one */
async function item(server: DevServerFixture, key: string, text: string, kind: "pay" | "delivery", from: { name: string; email: string }, hour: number) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const m: IncomingMessage = { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: `${text} (${key})`, date: E2E_NOW, snippet: `${text}.`, bodyText: `${text}.`, bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 } as unknown as IncomingMessage;
  await store.sync.ingest([m], { applyFilters: false, now: E2E_NOW, classifier: null });
  const row = db.get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE provider_msg_id = ?", key)!;
  await store.dated.marks.queueScan([row.id], E2E_NOW);
  const due = new Date(E2E_NOW);
  due.setHours(hour, 0, 0, 0);
  const day = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await store.dated.finish({ messageId: row.id, threadId: row.thread_id, fromScan: true, rows: [{ kind, item: 0, text, quote: `${text}.`, dueDay: day, dueAt: due.getTime(), timed: true, dated: true, actAt: E2E_NOW - 86_400_000 }], settled: [], now: E2E_NOW, model: "demo", provider: "fake", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
}

const feed = (page: Page) => page.getByTestId("wm-feed");
const openLine = (page: Page, text: string) => feed(page).locator("[data-thread-id]:not([data-history])").filter({ hasText: text });
const snack = (page: Page) => page.getByTestId("snack");

async function remove(page: Page, text: string): Promise<void> {
  // (the next row is opened by a Remove before: a second click would put it away)
  if ((await openLine(page, text).getAttribute("data-open")) === null) await openLine(page, text).getByTestId("wm-item-open").click();
  await expect(openLine(page, text)).toHaveAttribute("data-open");
  await page.keyboard.press("Shift+D");
  // with Mute's offer, the task's words are under the first line
  await expect(snack(page)).toContainText("Removed from What matters");
  await expect(snack(page)).toContainText(text);
}

test("plan 210 (iteration 4): Remove offers to hide its kind, then its sender, each with Undo; the gear and Settings list what's hidden, with Show again", async ({ app: page, server }) => {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await item(server, "box1", "First parcel arrives", "delivery", parcel, 14);
  await item(server, "box2", "Second parcel arrives", "delivery", parcel, 15);
  await item(server, "box4", "Third parcel arrives", "delivery", parcel, 17);
  await item(server, "lamp", "Lamp arrives", "delivery", { name: "Lamp Shop", email: "orders@lamps.test" }, 16);
  await item(server, "rent", "Pay the rent", "pay", { name: "Billing", email: "rent@bills.test" }, 13);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(openLine(page, "First parcel arrives")).toBeVisible({ timeout: 15_000 });

  await scenario("the first Remove of a delivery offers its kind beside Undo; taken, every delivery hides, and its Undo (z) brings them back", async () => {
    await remove(page, "First parcel arrives");
    const offer = page.getByTestId("snack-secondary");
    await expect(offer).toHaveText("Don’t show deliveries");
    await offer.click();
    await expect(snack(page)).toContainText("You won’t see deliveries in What matters");
    // the open row (the next, opened by the Remove) stays in place while it's open; the others go at once
    await expect(openLine(page, "Third parcel arrives")).toHaveCount(0);
    await expect(openLine(page, "Lamp arrives")).toHaveCount(0);
    await expect(openLine(page, "Pay the rent")).toBeVisible();
    await page.keyboard.press("z");
    await expect(openLine(page, "Third parcel arrives")).toBeVisible();
    await expect(openLine(page, "Lamp arrives")).toBeVisible();
  });

  await scenario("the next Remove from the same sender offers the sender (the kind was offered once); taken, only theirs hide", async () => {
    await remove(page, "Second parcel arrives");
    const offer = page.getByTestId("snack-secondary");
    await expect(offer).toHaveText("Don’t show Parcel Co");
    await offer.click();
    await expect(snack(page)).toContainText("Nothing from Parcel Co will show in What matters");
    await expect(openLine(page, "Third parcel arrives")).toHaveCount(0);
    await expect(openLine(page, "Lamp arrives")).toBeVisible();
    // the kind is never offered again; another sender is, once
    await remove(page, "Lamp arrives");
    await expect(page.getByTestId("snack-secondary")).toHaveText("Don’t show Lamp Shop");
    await page.keyboard.press("z");
    await expect(openLine(page, "Lamp arrives")).toBeVisible();
  });

  await scenario("the gear lists the hidden sender, named for screen readers; Show again by keyboard brings their items back", async () => {
    if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");
    await page.getByTestId("wm-options").click();
    const section = page.getByTestId("wm-options-muted");
    await expect(section).toBeVisible();
    await expect(page.getByTestId("wm-muted")).toHaveAccessibleName("Hidden from What matters");
    await expect(page.getByTestId("wm-muted-item")).toHaveText(["Parcel Cotrack@parcel.testShow again"]);
    const show = page.getByTestId("wm-muted-unmute");
    await expect(show).toHaveAccessibleName("Show again");
    await expect(show).toHaveAccessibleDescription("Parcel Co");
    await axeBothModes(page, '[data-testid="wm-options-panel"]');
    await show.focus();
    await page.keyboard.press("Enter");
    await expect(snack(page)).toContainText("You’ll see Parcel Co in What matters again");
    await expect(section).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(openLine(page, "Third parcel arrives")).toBeVisible();
  });

  await scenario("Settings → What matters: nothing hidden says how it comes about; a hidden kind is from any sender, and Show again empties it", async () => {
    await page.getByTestId("wm-options").click();
    await page.getByTestId("wm-options-more").click();
    const list = page.getByTestId("today-muted");
    await expect(page.getByTestId("today-muted-list-empty")).toHaveText("Nothing is hidden. When you remove an item, you can choose to hide others like it.");
    await server.backend.server.invoke("dated.mute", { on: "kind", key: "delivery" }, dev);
    await expect(page.getByTestId("today-muted-list-item")).toHaveText(["DeliveriesFrom any senderShow again"]);
    await expect(page.getByTestId("today-muted-list-unmute")).toHaveAccessibleName("Show again");
    await expect(page.getByTestId("today-muted-list-unmute")).toHaveAccessibleDescription("Deliveries");
    await axeBothModes(page, '[data-testid="today-muted"]');
    await page.getByTestId("today-muted-list-unmute").click();
    await expect(page.getByTestId("today-muted-list-empty")).toBeVisible();
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
