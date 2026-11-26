/**
 * Plan 281: the People view. The row below the Inbox (only while AI features are offered), the list (Open, Everyone, the search),
 * a person's page (what's open, Done and its Undo, a conversation opened and Esc back), the person card in a chip's menu
 * and Open in People; List layout's page in the list pane; axe in light and dark.
 */
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, chipsOf, expect, fresh, ingestConversation, scenario, test, type DevServerFixture } from "./fixtures";
import { message } from "./helpers/today";

test.use({ backendOptions: { network: true } });

const dev = { clientId: "setup", origin: "dev" as const };
const ana = { name: "Ana Ruiz", email: "ana.ruiz@greenway.studio" };
const marco = { name: "Marco Bell", email: "marco@greenway.studio" };

/** Ana's conversation waiting on your answer (Marco on it too), and a reply she owes you on another */
async function seed(server: DevServerFixture): Promise<{ waiting: number; owed: number }> {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, followups: { enabled: true } }, dev);
  const db = sqlDb(server.backend.store);
  const waiting = await ingestConversation(server, { subject: "Phase 2 scope", count: 3, from: { 0: ana, 2: ana }, cc: [marco], now: E2E_NOW });
  db.run("UPDATE threads SET waiting_since = ?, has_sent = 1, person = 1 WHERE id = ?", E2E_NOW - 3_600_000, waiting);
  // you wrote to Ana last, and she hasn't answered
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const me = { name: "Luis Cordero", email: acct.email };
  await server.backend.store.sync.ingest(
    [
      message(server, "contract-1", ana, "Contract for phase 2", "Could you send the contract?", E2E_NOW - 8 * 86_400_000, { providerThreadId: "contract" }),
      message(server, "contract-2", me, "Re: Contract for phase 2", "Here it is, ready to sign.", E2E_NOW - 6 * 86_400_000, { providerThreadId: "contract", isSent: true, to: [ana], inReplyTo: "<contract-1@e2e.test>", references: ["<contract-1@e2e.test>"] }),
    ],
    { applyFilters: false, now: E2E_NOW, classifier: null },
  );
  const owed = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'contract-2'")!.thread_id;
  db.run(
    "INSERT INTO followups (thread_id, message_id, item, kind, text, person_name, person_email, sent_at, due_at, state, created_at) VALUES (?, (SELECT id FROM messages WHERE thread_id = ? ORDER BY date DESC LIMIT 1), 0, 'awaiting', 'the signed contract', ?, ?, ?, ?, 'open', ?)",
    owed,
    owed,
    ana.name,
    ana.email,
    E2E_NOW - 6 * 86_400_000,
    E2E_NOW + 86_400_000,
    E2E_NOW - 6 * 86_400_000,
  );
  server.backend.today.changed();
  return { waiting, owed };
}

const row = (page: Page, name: string) => page.getByTestId("person-row").filter({ hasText: name });
const items = (page: Page) => page.getByTestId("person-page").getByTestId("person-item");

async function openPerson(page: Page, name: string) {
  await page.getByTestId("people-search").fill(name);
  await row(page, name).first().click();
  await expect(page.getByTestId("person-name")).toHaveText(name);
}

test("People: the row below the Inbox, Open and the search, a person's page, Done and Undo, a conversation and back, the card, axe", async ({ app: page, server }) => {
  await scenario("no row while AI features aren't offered", async () => {
    await server.backend.server.invoke("settings.update", { ai: { provider: "none" } }, dev);
    await fresh(page);
    await expect(page.getByTestId("nav-inbox")).toBeVisible();
    await expect(page.getByTestId("nav-people")).toHaveCount(0);
  });

  await seed(server);
  await fresh(page);

  await scenario("People sits right below the Inbox, and opens its list", async () => {
    const order = await page.locator("[data-testid^=nav-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order.indexOf("nav-people")).toBe(order.indexOf("nav-inbox") + 1);
    await page.getByTestId("nav-people").click();
    await expect(page.getByTestId("people")).toBeVisible();
    await expect(page.getByTestId("list-title")).toHaveText("People");
    await expect(page.getByTestId("nav-people")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("people-heading").first()).toContainText("Open");
    // Ana's newest thing open with you leads her row, under her name, not naming her again: its kind, then what
    await expect(row(page, "Ana Ruiz").first()).toContainText("Waiting on you · Phase 2 scope");
  });

  await scenario("the search finds people by a name's start and by domain, marks what matched, and Esc clears it", async () => {
    const field = page.getByTestId("people-search");
    await field.fill("greenway");
    await expect(row(page, "Ana Ruiz")).toHaveCount(1);
    await expect(row(page, "Marco Bell")).toHaveCount(1);
    // found by their domain, each says the address it matched (it's why they're here), and how much is open
    await expect(row(page, "Ana Ruiz").getByTestId("people-match").first()).toHaveText("greenway");
    await expect(row(page, "Ana Ruiz").first()).toContainText("2 open");
    await expect(row(page, "Marco Bell").getByTestId("people-match").first()).toHaveText("greenway");
    // found by name, a row reads as it does in the list: what's open with them
    await field.fill("ana r");
    await expect(row(page, "Ana Ruiz").first()).toContainText("Phase 2 scope");
    await field.fill("ana r");
    await expect(row(page, "Ana Ruiz")).toHaveCount(1);
    await field.press("Escape");
    await expect(field).toHaveValue("");
    await expect(page.getByTestId("people-heading").first()).toBeVisible();
  });

  await scenario("a person's page: what's open, both kinds, and the conversations", async () => {
    await openPerson(page, "Ana Ruiz");
    await page.getByTestId("people-search").fill("");
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(0)).toContainText("Waiting on you");
    await expect(items(page).nth(1)).toContainText("Owes you a reply");
    await expect(items(page).nth(1)).toContainText("The signed contract");
    await expect(page.getByTestId("person-conversation").filter({ hasText: "Phase 2 scope" })).toBeVisible();
    await axeBothModes(page, '[data-testid="people"]', '[data-testid="person-page"]');
  });

  await scenario("Done takes the item off the page, the row says the next one, and Undo brings it back", async () => {
    const waiting = items(page).filter({ hasText: "Phase 2 scope" });
    await waiting.hover();
    await waiting.getByTestId("person-item-done").click();
    await expect(items(page)).toHaveCount(1);
    // her row follows: the next thing open leads it (found by the search: the list moved her down among the rest)
    await page.getByTestId("people-search").fill("Ana Ruiz");
    await expect(row(page, "Ana Ruiz").first()).toContainText("The signed contract", { timeout: 8000 });
    await expect(row(page, "Ana Ruiz").first()).not.toContainText("Phase 2 scope");
    const snack = page.getByTestId("snack").last();
    await expect(snack).toBeVisible();
    await snack.getByRole("button", { name: "Undo" }).click();
    await expect(items(page)).toHaveCount(2, { timeout: 8000 });
    await expect(row(page, "Ana Ruiz").first()).toContainText("Phase 2 scope");
    await page.getByTestId("people-search").fill("");
  });

  await scenario("an item opens its conversation in the reader; Esc is the person's page again", async () => {
    await items(page).filter({ hasText: "Phase 2 scope" }).getByTestId("person-item-open").click();
    await expect(page.getByTestId("reader-subject")).toContainText("Phase 2 scope");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
  });

  await scenario("the person card: a chip's menu says what's open with them, and Open in People goes to their page", async () => {
    await items(page).filter({ hasText: "Phase 2 scope" }).getByTestId("person-item-open").click();
    const chip = page.getByTestId("thread-person").filter({ hasText: "Ana" });
    await chip.hover();
    await chip.click();
    const menu = page.getByTestId("person-menu");
    await expect(menu.getByTestId("person-card-open")).toBeVisible();
    await expect(menu.getByTestId("person-card-item")).toHaveCount(2);
    await expect(menu.getByTestId("person-card-last")).toContainText("Contract for phase 2");
    await axeBothModes(page, '[data-testid="person-menu"]');
    await menu.getByTestId("person-open-people").click();
    await expect(page.getByTestId("people")).toBeVisible();
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
  });

  await scenario("j and k walk the people, their pages following", async () => {
    await page.getByTestId("people-rows").click({ position: { x: 4, y: 4 } });
    const first = await page.getByTestId("person-row").first().getAttribute("data-key");
    await page.keyboard.press("j");
    await expect(page.locator(`[data-testid=person-row][aria-current=true]`)).not.toHaveAttribute("data-key", "ana.ruiz@greenway.studio");
    await page.keyboard.press("k");
    expect(first).not.toBeNull();
  });

  await scenario("the keyboard all the way: / types at once, ↓ onto the rows, Enter into the page, D finishes the item and the keyboard moves on", async () => {
    await page.keyboard.press("/");
    await page.keyboard.type("ana r");
    await expect(page.getByTestId("people-search")).toHaveValue("ana r");
    await expect(row(page, "Ana Ruiz")).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("[data-testid=person-row]:focus")).toHaveAttribute("data-key", "ana.ruiz@greenway.studio");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
    await expect(page.locator("[data-testid=person-item-open]:focus")).toHaveCount(1);
    const before = await items(page).count();
    await page.keyboard.press("d");
    await expect(items(page)).toHaveCount(before - 1);
    // the keyboard is on the next thing, not nowhere
    await expect(page.locator("[data-testid=person-page] :focus")).toHaveCount(1);
    await expect(page.getByTestId("snack").last()).toBeVisible();
    await page.keyboard.press("z");
    await expect(items(page)).toHaveCount(before, { timeout: 8000 });
    // Esc: back on her row
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-testid=person-row]:focus")).toHaveAttribute("data-key", "ana.ruiz@greenway.studio");
  });

  await scenario("the keyboard never drops to nowhere: Esc in an empty search, Later, Undo, a conversation opened", async () => {
    const onBody = () => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);
    const field = page.getByTestId("people-search");
    await field.fill("");
    await field.press("Escape");
    await expect(page.locator("[data-testid=person-row]:focus")).toHaveCount(1);
    await page.keyboard.press("Enter");
    const onItem = page.locator("[data-testid=person-page] [data-testid=person-item-open]:focus");
    await expect(onItem).toHaveCount(1);
    const id = await onItem.evaluate((el) => el.closest<HTMLElement>("[data-testid=person-item]")!.dataset.item);
    // Later: the item stays (further on), and so does the keyboard
    await page.keyboard.press("b");
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await page.getByRole("menuitem").first().press("Enter");
    await expect(page.locator(`[data-testid=person-item][data-item="${id}"] [data-testid=person-item-open]`)).toBeFocused({ timeout: 8000 });
    await expect(page.getByTestId("snack").last()).toBeVisible();
    await page.keyboard.press("z");
    await expect(page.locator(`[data-testid=person-item][data-item="${id}"]`)).not.toHaveAttribute("data-later", { timeout: 8000 });
    expect(await onBody()).toBe(false);
    // a conversation opened from the page takes the keyboard
    await page.locator(`[data-testid=person-item][data-item="${id}"] [data-testid=person-item-open]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await expect.poll(onBody).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("person-page")).toBeVisible();
  });

  await scenario("G P goes to People; Enter typed at once opens what's typed; Esc on a hit is the whole list again; C writes to the person", async () => {
    await page.getByTestId("nav-inbox").click();
    await page.keyboard.press("g");
    await page.keyboard.press("p");
    await expect(page.getByTestId("people")).toBeVisible();
    // typed and Entered without a pause: the first match of what was typed, never the last query's
    await page.keyboard.press("/");
    await page.keyboard.type("marco");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("person-name")).toHaveText("Marco Bell");
    await expect(page.locator("[data-testid=person-row]:focus")).toHaveAttribute("data-key", "marco@greenway.studio");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("people-search")).toHaveValue("");
    await expect(page.locator("[data-testid=person-row]:focus")).toHaveAttribute("data-key", "marco@greenway.studio");
    // / selects what was typed before: typing replaces it
    await page.getByTestId("people-search").fill("mar");
    await page.locator("[data-testid=person-row]").first().focus();
    await page.keyboard.press("/");
    await page.keyboard.type("ana r");
    await expect(page.getByTestId("people-search")).toHaveValue("ana r");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
    await expect(page.locator("[data-testid=person-row]:focus")).toHaveAttribute("data-key", "ana.ruiz@greenway.studio");
    await page.keyboard.press("c");
    await expect(chipsOf(page, "compose-to")).toHaveText(["Ana Ruiz"]);
  });
});

test.describe("List layout", () => {
  test.use({ layout: "list" });
  test("a person's page is the list pane's, over the list; a conversation opens as its page; Back and Esc come back", async ({ app: page, server }) => {
    await seed(server);
    await fresh(page);
    await page.getByTestId("nav-people").click();
    await openPerson(page, "Ana Ruiz");
    await expect(page.getByTestId("person-back")).toBeVisible();
    await items(page).filter({ hasText: "Phase 2 scope" }).getByTestId("person-item-open").click();
    await expect(page.getByTestId("list-page")).toBeVisible();
    await expect(page.getByTestId("reader-subject")).toContainText("Phase 2 scope");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("list-page")).toHaveCount(0);
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("person-page")).toHaveCount(0);
    await expect(page.getByTestId("people")).toBeVisible();
  });
});
