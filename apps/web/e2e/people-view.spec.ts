/**
 * Plan 281: the People view. The row below the Inbox (only while AI features are offered), the list (Open, Everyone, the search),
 * a person's page (what's open, Done and its Undo, a conversation opened and Esc back), the person card in a chip's menu
 * and Open in People; List layout's page in the list pane; axe in light and dark.
 */
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, chipsOf, expect, fresh, ingestConversation, scenario, selectThread, test, type DevServerFixture } from "./fixtures";
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
    // longest waiting first (owner, after the QA panel): the section says so, and Ana's row leads with what has waited
    // longest, its kind and then what, under her name (never naming her again), and how long it's been
    await expect(page.getByTestId("people-heading").first()).toContainText("Longest waiting first");
    await expect(row(page, "Ana Ruiz").first()).toContainText("Owes you a reply · The signed contract");
    await expect(row(page, "Ana Ruiz").first().getByTestId("person-row-when")).toHaveText("6 daysOpen for 6 days");
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
    await expect(row(page, "Ana Ruiz").first()).toContainText("The signed contract");
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
    // longest waiting first, each saying its kind in words
    await expect(items(page).nth(0)).toContainText("Owes you a reply");
    await expect(items(page).nth(0)).toContainText("The signed contract");
    await expect(items(page).nth(1)).toContainText("Phase 2 scope");
    await expect(items(page).nth(1)).toContainText("Waiting on you");
    await expect(page.getByTestId("person-conversation").filter({ hasText: "Phase 2 scope" })).toBeVisible();
    await axeBothModes(page, '[data-testid="people"]', '[data-testid="person-page"]');
  });

  await scenario("Done takes the item off the page, the row says the next one, and Undo brings it back", async () => {
    const owed = items(page).filter({ hasText: "The signed contract" });
    await owed.hover();
    await owed.getByTestId("person-item-done").click();
    await expect(items(page)).toHaveCount(1);
    // her row follows: the next thing open leads it (found by the search: the list moved her down among the rest)
    await page.getByTestId("people-search").fill("Ana Ruiz");
    await expect(row(page, "Ana Ruiz").first()).toContainText("Phase 2 scope", { timeout: 8000 });
    await expect(row(page, "Ana Ruiz").first()).not.toContainText("The signed contract");
    const snack = page.getByTestId("snack").last();
    await expect(snack).toBeVisible();
    await snack.getByRole("button", { name: "Undo" }).click();
    await expect(items(page)).toHaveCount(2, { timeout: 8000 });
    await expect(row(page, "Ana Ruiz").first()).toContainText("The signed contract");
    await page.getByTestId("people-search").fill("");
  });

  await scenario("Later's Pick a date…: What matters' picker, the item put off to that moment", async () => {
    const waiting = items(page).filter({ hasText: "Phase 2 scope" });
    await waiting.hover();
    await waiting.getByTestId("person-item-later").click();
    await page.getByTestId("person-item-later-pick").click();
    const dialog = page.getByTestId("person-later-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Move" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("person-later-items").getByTestId("person-item")).toHaveCount(1, { timeout: 8000 });
    await page.getByTestId("snack").last().getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("person-later-items")).toHaveCount(0, { timeout: 8000 });
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
    // what's done with their mail waits under More (the card is what the menu is for)
    await expect(menu.getByTestId("menu-filter")).toHaveCount(0);
    await expect(menu.getByTestId("person-more")).toBeVisible();
    await axeBothModes(page, '[data-testid="person-menu"]');
    await menu.getByTestId("person-open-people").click();
    await expect(page.getByTestId("people")).toBeVisible();
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
  });

  await scenario("the card's Done finishes an item without leaving the conversation, with its Undo", async () => {
    await page.getByTestId("person-item-open").filter({ hasText: "Phase 2 scope" }).click();
    await expect(page.getByTestId("reader-subject")).toContainText("Phase 2 scope");
    const chip = page.getByTestId("thread-person").filter({ hasText: "Ana" });
    await chip.hover();
    await chip.click();
    const menu = page.getByTestId("person-menu");
    const contract = menu.getByTestId("person-card-row").filter({ hasText: "The signed contract" });
    await contract.getByTestId("person-card-done").click();
    // the card stays, the item leaves it in place, the keyboard on the next one
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("person-card-item")).toHaveCount(1);
    await expect(menu.getByTestId("person-card-item")).toBeFocused();
    await expect(page.getByTestId("reader-subject")).toContainText("Phase 2 scope");
    const snack = page.getByTestId("snack").last();
    await expect(snack).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await chip.click();
    await expect(menu.getByTestId("person-card-item")).toHaveCount(1, { timeout: 8000 });
    await page.keyboard.press("Escape");
    await snack.getByRole("button", { name: "Undo" }).click();
    await chip.click();
    await expect(menu.getByTestId("person-card-item")).toHaveCount(2, { timeout: 8000 });
    // More holds what's done with their mail
    await menu.getByTestId("person-more").hover();
    await expect(page.getByTestId("person-more-menu").getByTestId("menu-filter")).toBeVisible();
    // Esc: the submenu, then the menu, then the conversation (back to her page)
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("person-more-menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("person-name")).toHaveText("Ana Ruiz");
  });

  await scenario("from a conversation, Open in People and Esc comes back to it; a group email they didn't write says so", async () => {
    // one message to you and two others: its people have chips (the way to each one's card)
    const group = await ingestConversation(server, { subject: "Kickoff notes", count: 1, cc: [marco], now: E2E_NOW });
    await page.getByTestId("nav-inbox").click();
    await selectThread(page, group, 'subject:"Kickoff notes"');
    await expect(page.getByTestId("thread-person")).toHaveCount(2);
    const chip = page.getByTestId("thread-person").filter({ hasText: "Marco" });
    await chip.click();
    await page.getByTestId("person-menu").getByTestId("person-open-people").click();
    await expect(page.getByTestId("person-name")).toHaveText("Marco Bell");
    await expect(page.getByTestId("person-conversation").filter({ hasText: "Kickoff notes" }).getByTestId("person-conversation-by")).toHaveText("Yuki wrote last · ");
    await page.getByTestId("person-page").getByTestId("person-write").focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("people")).toHaveCount(0);
    await expect(page.getByTestId("reader-subject")).toHaveText("Kickoff notes");
    await page.getByTestId("nav-people").click();
    await expect(page.getByTestId("people")).toBeVisible();
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
    // his row's Last email is his page's: one date, his last conversation
    const when = row(page, "Marco Bell").getByTestId("person-row-when");
    await expect(when).toHaveText(/^Last email /);
    await expect(page.getByTestId("person-page").getByText(/Last email/)).toContainText((await when.textContent())!);
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

test.describe("People's filter and People in a focused account (plan 287)", () => {
  const bob = { name: "Bob Archer", email: "bob.archer@harbor.test" };
  const zoe = { name: "Zoe Lindqvist", email: "zoe.lindqvist@harbor.test" };
  const olga = { name: "Olga Petrova", email: "olga.petrova@oldmail.test" };

  /** Ana's (plan 281's seed) in the first account; Bob waiting on you and Zoe written to in the second; Olga written to long ago */
  async function seedTwo(server: DevServerFixture) {
    await seed(server);
    const db = sqlDb(server.backend.store);
    const [home, work] = db.all<{ id: number; email: string; display_name: string }>("SELECT id, email, display_name FROM accounts ORDER BY id LIMIT 2");
    const meAt = (a: { email: string }) => ({ name: "Luis Cordero", email: a.email });
    await server.backend.store.sync.ingest(
      [
        message(server, "bob-1", bob, "Harbor lease", "Can you confirm the lease by Friday?", E2E_NOW - 2 * 3_600_000, { accountId: work!.id, to: [meAt(work!)], inInbox: true, isRead: false }),
        message(server, "zoe-1", meAt(work!), "Dock schedule", "Here's the schedule.", E2E_NOW - 2 * 86_400_000, { accountId: work!.id, isSent: true, to: [zoe] }),
        message(server, "olga-1", meAt(home!), "Old times", "It was good to see you.", E2E_NOW - 200 * 86_400_000, { accountId: home!.id, isSent: true, to: [olga] }),
      ],
      { applyFilters: false, now: E2E_NOW, classifier: null },
    );
    const bobThread = db.get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE provider_msg_id = 'bob-1'")!.thread_id;
    db.run("UPDATE threads SET waiting_since = ?, has_sent = 1, person = 1 WHERE id = ?", E2E_NOW - 2 * 3_600_000, bobThread);
    server.backend.today.changed();
    return { home: home!, work: work! };
  }

  const menu = (page: Page) => page.getByTestId("people-filter-menu");
  /** the menu, open with the keyboard in it */
  async function openMenu(page: Page) {
    await page.getByTestId("people-filter").click();
    await expect(menu(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-testid=people-filter-menu]"))).toBe(true);
  }

  test("the filter: a date and several accounts, said as chips, each removable; nobody matching says so; a focused account's People is its own", async ({ app: page, server }) => {
    const { home, work } = await seedTwo(server);
    await fresh(page);
    await page.getByTestId("nav-people").click();
    // (Everyone is long: Olga, written to once long ago, is found by the search)
    await page.getByTestId("people-search").fill("Olga");
    await expect(row(page, olga.name)).toBeVisible();
    await page.getByTestId("people-search").fill("");

    await scenario("Past month: Olga, last written to 200 days ago, isn't listed; the chip and the button say the filter is on", async () => {
      await expect(page.getByTestId("people-filter")).not.toHaveAttribute("data-active");
      await openMenu(page);
      await page.getByTestId("people-filter-month").click();
      await expect(menu(page)).toBeHidden();
      await expect(page.getByTestId("people-filter")).toHaveAttribute("data-active", "true");
      await expect(page.getByTestId("people-filter")).toHaveAccessibleName("Filter people: Past month");
      await expect(page.getByTestId("people-filter-chip-date")).toHaveText("Past month");
      await page.getByTestId("people-search").fill("Olga");
      await expect(page.getByTestId("people-note")).toBeVisible();
      await expect(row(page, olga.name)).toHaveCount(0);
      await page.getByTestId("people-search").fill("");
      await expect(row(page, ana.name).first()).toBeVisible();
    });

    await scenario("ticking an account keeps the menu open (several at once); the list is that account's: Bob, not Ana", async () => {
      await openMenu(page);
      await page.getByTestId(`people-filter-account-${work.id}`).click();
      await expect(menu(page)).toBeVisible();
      await expect(page.getByTestId(`people-filter-account-${work.id}`)).toHaveAttribute("aria-checked", "true");
      await expect(page.getByTestId("people-filter-all-accounts")).toHaveAttribute("aria-checked", "false");
      await axeBothModes(page, '[data-testid="people-filter-menu"]');
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(page.getByTestId("people-filter")).toBeFocused();
      await expect(page.getByTestId("people-filter-chip-accounts")).toHaveText(work.display_name);
      await expect(row(page, bob.name).first()).toBeVisible();
      await expect(row(page, ana.name)).toHaveCount(0);
      // (Everyone is long: Zoe, written to from that account, is found by the search, within the filter)
      await page.getByTestId("people-search").fill("Zoe");
      await expect(row(page, zoe.name).first()).toBeVisible();
      await expect(page.getByTestId("people-line")).toHaveText("1 person in your filter");
      await page.getByTestId("people-search").fill("");
      await axeBothModes(page, '[data-testid="people"]');
    });

    await scenario("a chip's × takes its part away, the keyboard back on the filter's button", async () => {
      await page.getByTestId("people-filter-chip-accounts").getByRole("button").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("people-filter-chip-accounts")).toHaveCount(0);
      await expect(page.getByTestId("people-filter")).toBeFocused();
      await expect(row(page, ana.name).first()).toBeVisible();
      await expect(page.getByTestId("people-filter-chip-date")).toBeVisible();
    });

    await scenario("nobody in the filter: it says so, and Clear filters is the way out", async () => {
      const { account: lonely } = await server.backend.store.accounts.create({ kind: "gmail", email: "lonely@example.test", displayName: "Lonely", color: "brown", now: E2E_NOW });
      await fresh(page);
      await page.getByTestId("nav-people").click();
      await openMenu(page);
      await page.getByTestId(`people-filter-account-${lonely.id}`).click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("people-note")).toContainText("No one matches these filters.");
      await page.getByTestId("people-filter-clear").click();
      await expect(page.getByTestId("people-filter-chips")).toHaveCount(0);
      await expect(row(page, ana.name).first()).toBeVisible();
      await expect(page.getByTestId("people-filter")).not.toHaveAttribute("data-active");
    });

    await scenario("the filter is remembered on this device", async () => {
      await openMenu(page);
      await page.getByTestId("people-filter-year").click();
      await fresh(page);
      await page.getByTestId("nav-people").click();
      await expect(page.getByTestId("people-filter-chip-date")).toHaveText("Past year");
      await openMenu(page);
      await page.getByTestId("people-filter-clear-menu").click();
      await expect(page.getByTestId("people-filter-chips")).toHaveCount(0);
    });

    await scenario("focused on an account: People right below its Inbox, that account's people only, no accounts to choose", async () => {
      await page.getByTestId(`nav-account-${work.id}`).click({ button: "right" });
      await page.getByTestId("account-menu-focus").click();
      await expect(page.getByTestId("solo-back")).toBeVisible();
      const order = await page.locator("#app-sidebar nav [data-testid^=nav-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      expect(order.indexOf(`nav-solo-people-${work.id}`)).toBe(order.indexOf(`nav-folder-${work.id}-inbox`) + 1);
      await page.getByTestId(`nav-solo-people-${work.id}`).click();
      await expect(page.getByTestId("people-title-account")).toHaveText(`· ${work.display_name}`);
      await expect(page.getByTestId(`nav-solo-people-${work.id}`)).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId(`nav-folder-${work.id}-all`)).not.toHaveAttribute("aria-current", "page");
      await expect(row(page, bob.name).first()).toBeVisible();
      await expect(row(page, ana.name)).toHaveCount(0);
      await openMenu(page);
      await expect(menu(page).getByText("Accounts")).toHaveCount(0);
      await expect(page.getByTestId(`people-filter-account-${home.id}`)).toHaveCount(0);
      await page.keyboard.press("Escape");
      // the search too: Ana isn't anyone in this account
      await page.getByTestId("people-search").fill("Ana Ruiz");
      await expect(page.getByTestId("people-note")).toBeVisible();
      await expect(row(page, ana.name)).toHaveCount(0);
      await page.getByTestId("people-search").fill("");
      // Bob's page: his conversation of this account
      await row(page, bob.name).first().click();
      await expect(page.getByTestId("person-name")).toHaveText(bob.name);
      await expect(page.getByTestId("person-page")).toContainText("Harbor lease");
      await axeBothModes(page, '[data-testid="people"]', '[data-testid="person-page"]');
    });

    await scenario("the way back to all accounts leaves the focused People", async () => {
      await page.getByTestId("solo-back").click();
      await expect(page.getByTestId("solo-back")).toHaveCount(0);
      await expect(page.getByTestId("people")).toHaveCount(0);
    });
  });
});
