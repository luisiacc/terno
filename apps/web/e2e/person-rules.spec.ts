/**
 * Plan 278: "Counts as a person" from a sender's menu. A person's conversation leaves People with Never and comes back with
 * the snack's Undo; Settings → General lists your choices, each Reset by keyboard and named for its sender, focus kept; an
 * app's mail sent through a sending service (never a person's) joins People with Always. Axe in light and dark.
 */
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, menuPath, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ design: "lumen" });

const carlos = { name: "Carlos Mena", email: "carlos@mena.test" };
const app = { name: "Recibos App", email: "hola@recibosapp.test" };

/** a person's mail and an app's (Amazon SES's Message-ID), both newest in the Inbox */
async function seed(server: DevServerFixture): Promise<{ person: number; service: number }> {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const mail = (id: string, from: { name: string; email: string }, rfcMessageId: string, minutes: number) =>
    ({ accountId: acct.id, providerMsgId: id, providerThreadId: id, rfcMessageId, inReplyTo: null, references: [], from, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: `About ${id}`, date: E2E_NOW - minutes * 60_000, snippet: "Hello", bodyText: "Hello", bodyHtml: null, bodyState: "full", listId: null, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 }) as unknown as IncomingMessage;
  await store.sync.ingest([mail("carlos", carlos, "<c1@mail.mena.test>", 1), mail("receipt", app, "<0100abc-000000@email.amazonses.com>", 2)], { applyFilters: false, now: E2E_NOW, classifier: null });
  const thread = (p: string) => db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = ?", p)!.thread_id;
  return { person: thread("carlos"), service: thread("receipt") };
}

const rowOf = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const snack = (page: Page) => page.getByTestId("snack");

async function personMenu(page: Page, id: number): Promise<void> {
  await rowOf(page, id).click({ button: "right" });
  await menuPath(page, "menu-more", "menu-sender-person");
}

test("plan 278: Counts as a person from a sender's menu, with Undo; Reset in Settings; Always for an app's mail", async ({ app: page, server }) => {
  const { person, service } = await seed(server);
  await fresh(page);
  await page.getByTestId("quick-filter-people").click();
  await expect(rowOf(page, person)).toBeVisible({ timeout: 15_000 });
  await expect(rowOf(page, service)).toHaveCount(0);
  // another conversation open: the open one stays in a filtered list until the selection moves (plan 17)
  await page.locator(`[data-testid=thread-row]:not([data-thread-id="${person}"])`).first().click();

  await scenario("Never takes a person's conversation out of People, said in a snack; z puts it back", async () => {
    await personMenu(page, person);
    await expect(page.getByTestId("menu-sender-person")).toHaveText("Counts as a person");
    await expect(page.getByTestId("menu-sender-person-list").getByRole("menuitemradio")).toHaveText(["Automatically", "Always", "Never"]);
    await expect(page.getByTestId("menu-sender-person-auto")).toHaveAttribute("aria-checked", "true");
    await axeBothModes(page, '[data-testid="menu-sender-person-list"]');
    await page.getByTestId("menu-sender-person-never").click();
    await expect(snack(page)).toContainText("Carlos Mena won’t count as a person");
    await expect(rowOf(page, person)).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(rowOf(page, person)).toBeVisible();
  });

  await scenario("Never again: the menu says so; Settings → General lists it, Reset by keyboard keeps focus in the tab", async () => {
    await personMenu(page, person);
    await page.getByTestId("menu-sender-person-never").click();
    await expect(rowOf(page, person)).toHaveCount(0);
    await page.getByTestId("quick-filter-all").click();
    await personMenu(page, person);
    await expect(page.getByTestId("menu-sender-person-never")).toHaveAttribute("aria-checked", "true");
    // the menu, More and Counts as a person: one Escape each
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-general").click();
    const list = page.getByTestId("people-rules-list");
    await list.scrollIntoViewIfNeeded();
    await expect(list.getByTestId("people-rules-list-item")).toHaveText(["Carlos Menacarlos@mena.testNot a personReset"]);
    const reset = list.getByTestId("people-rules-list-reset");
    await expect(reset).toHaveAccessibleDescription("Carlos Mena");
    await axeBothModes(page, '[data-testid="people-rules"]');
    await reset.focus();
    await page.keyboard.press("Enter");
    await expect(snack(page)).toContainText("Terno decides again whether Carlos Mena is a person");
    await expect(page.getByTestId("people-rules-list-empty")).toHaveText("No one yet. Right-click a sender’s mail and choose More, then Counts as a person.");
    // plan 294: the language above (the sync window went to Accounts), and General stays
    await expect(page.getByTestId("language-select")).toBeFocused();
    await expect(page.getByTestId("tab-general")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
  });

  await scenario("an app's mail through a sending service isn't in People; Always brings it in", async () => {
    await expect(rowOf(page, service)).toBeVisible();
    await personMenu(page, service);
    await page.getByTestId("menu-sender-person-always").click();
    await expect(snack(page)).toContainText("Recibos App counts as a person now");
    await page.getByTestId("quick-filter-people").click();
    await expect(rowOf(page, service)).toBeVisible();
    await expect(rowOf(page, person)).toBeVisible();
  });

  await scenario("Settings search opens the group with its title in view, however long the list (Codex code review #8)", async () => {
    // through the backend, as a window would: every window hears the list
    for (let i = 0; i < 30; i++) await server.backend.server.invoke("people.setRule", { email: `sender${i}@lists.test`, name: `Sender ${i}`, person: false }, { clientId: "setup", origin: "dev" });
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-find").fill("counts as a person");
    await page.getByTestId("settings-find-result").first().click();
    await expect(page.getByTestId("people-rules-list-item")).toHaveCount(31);
    await expect(page.getByTestId("people-group").getByText("People", { exact: true })).toBeInViewport();
  });
});
