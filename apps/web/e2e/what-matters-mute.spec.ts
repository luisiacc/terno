/**
 * Plan 210 (iteration 4, the owner's "Mute this kind/sender"; iteration 5's narrow offer): after Remove, the snack offers
 * once to hide that kind from that sender, then (a machine only) the sender alone, each with its own Undo; never a person
 * alone. What matters' gear and Settings list what's hidden, each with Show again, by keyboard and named for screen
 * readers; a whole kind is hidden from Settings only; axe in light and dark.
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { IncomingMessage } from "@terno/store";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { axeBothModes, expect, fresh, scenario, test, type DevServerFixture } from "./fixtures";

test.use({ backendOptions: { network: true }, today: true });

const dev = { clientId: "setup", origin: "dev" as const };
// a machine by its headers (a list), as a shop's tracking mail is
const parcelo = { name: "Parcelo", email: "track@parcelo.test", listId: "<updates.parcelo.test>" };
// a shop's address, no list: maybe a person, so never offered alone
const lamps = { name: "Lamp Shop", email: "orders@lamps.test", listId: null };

/** an open item due today at `hour`, on its own conversation from `from`, written as the reader writes one */
async function item(server: DevServerFixture, key: string, text: string, kind: "pay" | "delivery", from: { name: string; email: string; listId: string | null }, hour: number) {
  const store = server.backend.store;
  const db = sqlDb(store);
  const acct = db.get<{ id: number; email: string }>("SELECT id, email FROM accounts ORDER BY id LIMIT 1")!;
  const m: IncomingMessage = { accountId: acct.id, providerMsgId: key, providerThreadId: key, rfcMessageId: `<${key}@e2e.test>`, inReplyTo: null, references: [], from: { name: from.name, email: from.email }, to: [{ name: "", email: acct.email }], cc: [], bcc: [], subject: `${text} (${key})`, date: E2E_NOW, snippet: `${text}.`, bodyText: `${text}.`, bodyHtml: null, bodyState: "full", listId: from.listId, isRead: false, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 1200 } as unknown as IncomingMessage;
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
  await expect(snack(page)).toContainText(text);
}

async function seed(server: DevServerFixture) {
  await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true } }, dev);
  await item(server, "box1", "First parcel arrives", "delivery", parcelo, 14);
  await item(server, "box2", "Second parcel arrives", "delivery", parcelo, 15);
  await item(server, "box4", "Third parcel arrives", "delivery", parcelo, 17);
  await item(server, "inv", "Pay the Parcelo invoice", "pay", parcelo, 12);
  await item(server, "lamp", "Lamp arrives", "delivery", lamps, 16);
  await item(server, "shade", "Shade arrives", "delivery", lamps, 18);
  await item(server, "rent", "Pay the rent", "pay", { name: "Billing", email: "rent@bills.test", listId: null }, 13);
}

test("plan 210 (iteration 5): Remove offers that kind from its sender, then a machine alone, each with Undo; the gear and Settings list what's hidden, with Show again; a whole kind only from Settings", async ({ app: page, server }) => {
  await seed(server);
  await fresh(page);
  await page.getByTestId("nav-today").click();
  await expect(openLine(page, "First parcel arrives")).toBeVisible({ timeout: 15_000 });

  await scenario("the first Remove offers deliveries from that sender beside Undo; taken, only theirs hide (their bill and another shop's delivery stay), and its Undo (z) brings them back", async () => {
    await remove(page, "First parcel arrives");
    // with Mute's offer, the first line says what happened and the task's words are under it
    await expect(snack(page)).toContainText("Removed");
    const offer = page.getByTestId("snack-secondary");
    await expect(offer).toHaveText("Don’t show deliveries from Parcelo");
    await offer.click();
    await expect(snack(page)).toContainText("You won’t see deliveries from Parcelo in What matters");
    // the open row (the next, opened by the Remove) stays in place while it's open; the others go at once
    await expect(openLine(page, "Third parcel arrives")).toHaveCount(0);
    await expect(openLine(page, "Pay the Parcelo invoice")).toBeVisible();
    await expect(openLine(page, "Lamp arrives")).toBeVisible();
    await page.keyboard.press("z");
    await expect(openLine(page, "Third parcel arrives")).toBeVisible();
  });

  await scenario("the next Remove from that machine offers it alone, once; a shop that may be a person is offered its kind, never itself", async () => {
    await remove(page, "Second parcel arrives");
    await expect(page.getByTestId("snack-secondary")).toHaveText("Don’t show anything from Parcelo");
    await page.keyboard.press("z");
    await expect(openLine(page, "Second parcel arrives")).toBeVisible();
    await remove(page, "Lamp arrives");
    await expect(page.getByTestId("snack-secondary")).toHaveText("Don’t show deliveries from Lamp Shop");
    // taken this time: kept for the lists below
    await page.getByTestId("snack-secondary").click();
    await expect(snack(page)).toContainText("You won’t see deliveries from Lamp Shop in What matters");
    await expect(openLine(page, "Shade arrives")).toHaveCount(0);
    // Parcelo's next: both of theirs were offered once, so the snack is the plain one
    await remove(page, "Third parcel arrives");
    await expect(snack(page)).toContainText("Removed");
    await expect(page.getByTestId("snack-secondary")).toHaveCount(0);
  });

  await scenario("the gear lists the pair by both, the address beside it, named for screen readers; Show again by keyboard brings it back", async () => {
    if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");
    await page.getByTestId("wm-options").click();
    const section = page.getByTestId("wm-options-muted");
    await expect(section).toBeVisible();
    await expect(page.getByTestId("wm-muted")).toHaveAccessibleName("Hidden from What matters");
    await expect(page.getByTestId("wm-muted-item")).toHaveText(["Deliveries from Lamp Shoporders@lamps.testShow again"]);
    const show = page.getByTestId("wm-muted-unmute");
    await expect(show).toHaveAccessibleName("Show again");
    await expect(show).toHaveAccessibleDescription("Deliveries from Lamp Shop");
    await axeBothModes(page, '[data-testid="wm-options-panel"]');
    await show.focus();
    await page.keyboard.press("Enter");
    await expect(snack(page)).toContainText("You’ll see deliveries from Lamp Shop in What matters again");
    await expect(section).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(openLine(page, "Shade arrives")).toBeVisible();
  });

  await scenario("Settings → What matters: nothing hidden says how it comes about; a whole kind is hidden from its menu, from any sender, and a pair is listed by both", async () => {
    await page.getByTestId("wm-options").click();
    await page.getByTestId("wm-options-more").click();
    await expect(page.getByTestId("today-muted-list-empty")).toHaveText("Nothing is hidden. When you remove an item, you can hide that kind of mail from its sender.");
    const hide = page.getByTestId("today-hide-kind");
    await expect(hide).toHaveAccessibleName("Hide a kind from every sender…");
    // by keyboard: the menu offers the kinds mail tells you about, never a person's requests
    await hide.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByTestId("today-hide-kind-menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Bills", "Renewals", "Expirations", "Alerts", "Events", "Deliveries"]);
    await menu.getByRole("menuitem", { name: "Bills" }).click();
    await expect(snack(page)).toContainText("You won’t see bills in What matters");
    await server.backend.server.invoke("dated.mute", { on: "pair", key: "delivery|track@parcelo.test", name: "Parcelo" }, dev);
    // the same moment (the app's clock is held here): by target, then key
    await expect(page.getByTestId("today-muted-list-item")).toHaveText(["BillsFrom any senderShow again", "Deliveries from Parcelotrack@parcelo.testShow again"]);
    await expect(page.getByTestId("today-muted-list-unmute").last()).toHaveAccessibleDescription("Deliveries from Parcelo");
    // bills hidden: the menu no longer offers them
    await hide.click();
    await expect(menu.getByRole("menuitem")).toHaveText(["Renewals", "Expirations", "Alerts", "Events", "Deliveries"]);
    await page.keyboard.press("Escape");
    await axeBothModes(page, '[data-testid="today-muted"]');
    await page.getByTestId("today-muted-list-unmute").first().click();
    await page.getByTestId("today-muted-list-unmute").first().click();
    await expect(page.getByTestId("today-muted-list-empty")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

/** The toast's offer and Settings' list in light and dark, en and es, for the plan's record (WM_MUTE_SHOTS=<dir>). */
for (const language of ["en", "es"] as const) {
  test(`plan 210 (iteration 5): the offer and the list, pictured (${language})`, async ({ app: page, server }) => {
    const shots = process.env.WM_MUTE_SHOTS;
    test.skip(!shots, "pictures only when asked for");
    await seed(server);
    await server.backend.server.invoke("settings.update", { language }, dev);
    await page.addInitScript((l) => localStorage.setItem("terno:language", l), language);
    await fresh(page);
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}(?:-|$)`));
    await page.getByTestId("nav-today").click();
    await expect(openLine(page, "First parcel arrives")).toBeVisible({ timeout: 15_000 });
    await remove(page, "First parcel arrives");
    await expect(page.getByTestId("snack-secondary")).toBeVisible();
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.screenshot({ path: join(shots!, `offer-${language}-${mode}.png`) });
    }
    await page.getByTestId("snack-secondary").click();
    await page.emulateMedia({ colorScheme: "light" });
    await server.backend.server.invoke("dated.mute", { on: "kind", key: "event" }, dev);
    if (await page.getByTestId("reader").count()) await page.keyboard.press("Escape");
    await page.getByTestId("wm-options").click();
    await page.getByTestId("wm-options-more").click();
    await expect(page.getByTestId("today-muted-list-item")).toHaveCount(2);
    await page.getByTestId("today-muted").scrollIntoViewIfNeeded();
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.screenshot({ path: join(shots!, `settings-${language}-${mode}.png`) });
    }
  });
}

/**
 * Plan 210 (round 14's faults): a long sender's offer ("Don't show deliveries from Northgate Business Store") crushed the
 * snack's first line to "R… 2 La…". The status and the item's words keep their line; the offer wraps beside them; Undo stays.
 */
for (const language of ["en", "es"] as const) {
  test(`plan 210 (round 14's faults): a long sender's offer never crushes the snack's first line (${language})`, async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true }, language }, dev);
    await item(server, "stands", "2 Laptop stands arrive", "delivery", { name: "Northgate Business Store", email: "orders@northgate.test", listId: "<orders.northgate.test>" }, 14);
    await page.addInitScript((l) => localStorage.setItem("terno:language", l), language);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await expect(openLine(page, "2 Laptop stands arrive")).toBeVisible({ timeout: 15_000 });
    await remove(page, "2 Laptop stands arrive");
    const offer = page.getByTestId("snack-secondary");
    await expect(offer).toHaveText(language === "en" ? "Don’t show deliveries from Northgate Business Store" : "No mostrar entregas de Northgate Business Store");
    const message = page.getByTestId("snack-message");
    await expect(message.locator("p").first()).toHaveText(language === "en" ? "Removed" : "Quitado");
    // the first line whole, the item's words under it readable, the offer whole on its lines, Undo beside them
    const fit = await message.evaluate((el) => {
      const [status, words] = [...el.querySelectorAll("p")] as HTMLElement[];
      const button = document.querySelector<HTMLElement>("[data-testid=snack-secondary]")!;
      const said = button.querySelector<HTMLElement>("span") ?? button;
      return { width: el.getBoundingClientRect().width, status: status!.scrollWidth <= status!.clientWidth, words: words!.clientWidth, offer: said.scrollHeight <= said.clientHeight + 1 };
    });
    expect(fit.width).toBeGreaterThanOrEqual(128);
    expect(fit.status).toBe(true);
    expect(fit.words).toBeGreaterThanOrEqual(120);
    expect(fit.offer).toBe(true);
    await expect(page.getByTestId("snack-action")).toBeVisible();
    await axeBothModes(page, '[data-testid="snack"]');
    const shots = process.env.WM_MUTE_SHOTS;
    if (shots) {
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await page.screenshot({ path: join(shots, `long-offer-${language}-${mode}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.keyboard.press("z");
    await expect(openLine(page, "2 Laptop stands arrive")).toBeVisible();
  });
}

/**
 * The Codex code review of round 14's faults: in Split's reader at its minimum width the offer beside the message shrank to a
 * sliver, and Spanish "Deshacer" pushed the close button out of the card. Narrow, the offer has its own line under the first,
 * its words on the message's; the first line keeps the status, Undo and the close button inside the card.
 */
for (const language of ["en", "es"] as const) {
  test(`plan 210 (round 14's faults, code review): in the narrowest reader the offer has its own line (${language})`, async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true }, language }, dev);
    await item(server, "stands", "2 Laptop stands arrive", "delivery", { name: "Northgate Business Store", email: "orders@northgate.test", listId: "<orders.northgate.test>" }, 14);
    await page.addInitScript((l) => localStorage.setItem("terno:language", l), language);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await expect(openLine(page, "2 Laptop stands arrive")).toBeVisible({ timeout: 15_000 });
    // the item open beside the feed (Split's reader), the window narrowed until the reader is at its minimum
    await openLine(page, "2 Laptop stands arrive").getByTestId("wm-item-open").click();
    await expect(page.getByTestId("reader")).toBeVisible();
    // (the sidebar and the list give way first, each to its own minimum)
    const measure = () => page.evaluate(() => ({ reader: document.querySelector("[data-testid=reader]")!.getBoundingClientRect().width, min: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reader-min")) }));
    let width = 1440;
    for (let m = await measure(); m.reader > m.min + 0.5; m = await measure()) {
      width -= Math.ceil(m.reader - m.min);
      await page.setViewportSize({ width, height: 900 });
    }
    const { min } = await measure();
    expect(Math.round((await measure()).reader)).toBe(Math.round(min));
    await remove(page, "2 Laptop stands arrive");
    await expect(page.getByTestId("snack-dock")).toHaveAttribute("data-over", "reader");
    const offer = page.getByTestId("snack-secondary");
    await expect(offer).toHaveText(language === "en" ? "Don’t show deliveries from Northgate Business Store" : "No mostrar entregas de Northgate Business Store");
    const fit = await page.getByTestId("snack").evaluate((card) => {
      const box = (el: Element) => el.getBoundingClientRect();
      const q = (id: string) => card.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
      const [status, words] = [...q("snack-message").querySelectorAll("p")] as HTMLElement[];
      const said = q("snack-secondary").querySelector("span")!;
      return { card: box(card), message: box(q("snack-message")), pill: box(q("snack-action")), close: box(q("snack-close")), offer: box(said), status: status!.scrollWidth <= status!.clientWidth, words: words!.clientWidth, offerWhole: said.scrollHeight <= said.clientHeight + 1 };
    });
    // the first line: the status whole, the item's words readable, Undo and the close button inside the card
    expect(fit.status).toBe(true);
    expect(fit.words).toBeGreaterThanOrEqual(100);
    expect(fit.close.right).toBeLessThanOrEqual(fit.card.right);
    expect(fit.pill.right).toBeLessThanOrEqual(fit.close.left);
    // the offer under it, whole, its words on the message's line
    expect(fit.offer.top).toBeGreaterThanOrEqual(Math.max(fit.message.bottom, fit.pill.bottom) - 1);
    expect(fit.offerWhole).toBe(true);
    expect(Math.abs(fit.offer.left - fit.message.left)).toBeLessThanOrEqual(1);
    expect(fit.offer.bottom).toBeLessThanOrEqual(fit.card.bottom);
    await axeBothModes(page, '[data-testid="snack"]');
    const shots = process.env.WM_MUTE_SHOTS;
    if (shots) {
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await page.screenshot({ path: join(shots, `narrow-offer-${language}-${mode}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.keyboard.press("z");
    await expect(openLine(page, "2 Laptop stands arrive")).toBeVisible();
  });
}

/**
 * The claims ledger's second batch (Jordan, Margaret, Sam): the offer cut a long sender to "(vi…" and the item's words were
 * clamped in an 8rem column beside it; the Done message was one cut line. The offer has its own line under the message at
 * any width, the sender whole; a message wraps to two lines before it's cut.
 */
for (const language of ["en", "es"] as const) {
  test(`the claims ledger's second batch: the offer's own line, its sender whole; Done's message on two lines (${language})`, async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { ai: { provider: "fake", model: "demo" }, dated: { enabled: true, scanAnswered: true }, language }, dev);
    await item(server, "lab", "Lab meeting snacks arrive", "delivery", { name: "Ingrid Vasquez-Lund (via Calendar)", email: "events@halvorsen.test", listId: "<events.halvorsen.test>" }, 14);
    const water = "Pay $58.71 for the City of Millbrook water and sewer service, account 4471-22";
    await item(server, "water", water, "pay", { name: "City of Millbrook", email: "billing@millbrook.test", listId: null }, 15);
    await page.addInitScript((l) => localStorage.setItem("terno:language", l), language);
    await fresh(page);
    await page.getByTestId("nav-today").click();
    await expect(openLine(page, "Lab meeting snacks arrive")).toBeVisible({ timeout: 15_000 });
    await remove(page, "Lab meeting snacks arrive");
    const offer = page.getByTestId("snack-secondary");
    await expect(offer).toHaveText(language === "en" ? "Don’t show deliveries from Ingrid Vasquez-Lund (via Calendar)" : "No mostrar entregas de Ingrid Vasquez-Lund (via Calendar)");
    const fit = await page.getByTestId("snack").evaluate((card) => {
      const box = (el: Element) => el.getBoundingClientRect();
      const q = (id: string) => card.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
      const [, words] = [...q("snack-message").querySelectorAll("p")] as HTMLElement[];
      const said = q("snack-secondary").querySelector("span")!;
      return { card: box(card), message: box(q("snack-message")), offer: box(said), words: box(words!), wordsWhole: words!.scrollHeight <= words!.clientHeight + 1, offerWhole: said.scrollHeight <= said.clientHeight + 1 };
    });
    // the offer under the message, starting where it does, whole; the item's words get the card's width, whole
    expect(fit.offer.top).toBeGreaterThanOrEqual(fit.message.bottom - 1);
    expect(Math.abs(fit.offer.left - fit.message.left)).toBeLessThanOrEqual(1);
    expect(fit.offerWhole).toBe(true);
    expect(fit.wordsWhole).toBe(true);
    expect(fit.words.width).toBeGreaterThan(fit.card.width / 2);
    await axeBothModes(page, '[data-testid="snack"]');
    const shots = process.env.WM_MUTE_SHOTS;
    const shoot = async (name: string) => {
      if (!shots) return;
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await page.screenshot({ path: join(shots, `${name}-${language}-${mode}.png`) });
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    await shoot("ledger2-offer");
    // Done on a long item: its message on two lines, never cut on one
    await page.getByTestId("snack-close").click();
    await openLine(page, water.slice(0, 20)).getByTestId("wm-item-open").click();
    await expect(openLine(page, water.slice(0, 20))).toHaveAttribute("data-open");
    await page.keyboard.press("d");
    const message = page.getByTestId("snack-message").locator("p").first();
    await expect(message).toContainText(language === "en" ? "Done: Pay $58.71" : "Hecho: Pay $58.71");
    const done = await message.evaluate((p) => ({ whole: p.scrollHeight <= p.clientHeight + 1, lines: Math.round(p.clientHeight / parseFloat(getComputedStyle(p).lineHeight)) }));
    expect(done).toEqual({ whole: true, lines: 2 });
    await shoot("ledger2-done");
  });
}
