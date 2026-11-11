/**
 * Plan 67: what's at the top of the sidebar is all your mail; what's under an account is that account's.
 * An account row opens into its folders (one at a time), the top folders and categories are cross-account,
 * and at most one row is selected.
 */
import type { Locator, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, test, scenario, freshStart } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

/** The account rows, in sidebar order, as ids. */
async function accountIds(page: Page): Promise<number[]> {
  const ids = await page.locator('[data-testid^="nav-account-"]').evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-testid")!.slice("nav-account-".length))));
  expect(ids.length).toBeGreaterThan(1);
  return ids;
}
const row = (page: Page, id: number) => page.getByTestId(`nav-account-${id}`);
const child = (page: Page, id: number, view: string) => page.getByTestId(`nav-folder-${id}-${view}`);
const group = (page: Page, id: number) => page.locator(`#account-folders-${id}`);
/** what the list shows: [view, accountId, categoryId, …] */
const listFor = (page: Page) => page.getByTestId("thread-list").getAttribute("data-results-for").then((k) => JSON.parse(k!) as [string, number | null, number | null]);
const selected = (page: Page) => page.locator("#app-sidebar [aria-current=page]");
const count = (l: Locator) => l.locator("[data-slot=nav-count]");

test.describe("accounts open into their folders", () => {
  test("a click selects an account and leaves it closed; a click on it then, a double click or its chevron opens it; a click on the open one you're in closes it (plan 67, the owner, 2026-11-10)", { tag: "@variant" }, async ({ app: page, design }) => {
    const [a, b] = await accountIds(page);
    await expect(group(page, a!)).toHaveAttribute("inert", "");
    // one click: its Inbox, and it stays closed
    await row(page, a!).click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, a!)).toHaveAttribute("aria-current", "page");
    await expect(selected(page)).toHaveCount(1);
    // again, now that it's selected: it opens
    await row(page, a!).click();
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
    for (const v of ["inbox", "sent", "archive", "spam", "trash"]) await expect(child(page, a!, v)).toBeVisible();
    // Starred and All Mail are cross-account: at the top only
    await expect(group(page, a!).locator('[data-testid$="-starred"], [data-testid$="-all"]')).toHaveCount(0);
    await expect(selected(page)).toHaveCount(1);
    await expect(child(page, a!, "inbox")).toHaveAttribute("aria-current", "page");
    const name = (await row(page, a!).textContent())!.trim();
    // designs that greet leave the account out of the Inbox's title
    if (design !== "lumen") await expect(page.getByTestId("thread-list")).toContainText(`· ${name}`);

    await child(page, a!, "sent").click();
    await expect.poll(() => listFor(page)).toEqual(["sent", a, null, null, null, ""]);
    await expect(selected(page)).toHaveCount(1);
    await expect(child(page, a!, "sent")).toHaveAttribute("aria-current", "page");

    // another account, by double click: it opens at its Inbox, and the first closes
    await row(page, b!).dblclick();
    await expect(row(page, b!)).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "false");
    await expect(group(page, a!)).toHaveAttribute("inert", "");
    await expect.poll(() => listFor(page)).toEqual(["inbox", b, null, null, null, ""]);

    // the open one you're in: a click closes it, you stay, and its row is what's selected
    await child(page, b!, "trash").click();
    await row(page, b!).click();
    await expect(row(page, b!)).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => listFor(page)).toEqual(["trash", b, null, null, null, ""]);
    await expect(selected(page)).toHaveCount(1);
    await expect(row(page, b!)).toHaveAttribute("aria-current", "page");

    // the chevron only opens and closes: you stay where you are
    await page.getByTestId("nav-inbox").click();
    const chevron = row(page, a!).locator("[data-slot=nav-disclosure]");
    await chevron.click();
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
    await chevron.click();
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "false");

    // selected and closed, a double click at the row's end: the first click opens it and its + appears under the
    // pointer; the second isn't a press of the + (Codex code review #1)
    await row(page, a!).click();
    await expect(row(page, a!)).toHaveAttribute("aria-current", "page");
    const box = (await row(page, a!).boundingBox())!;
    await row(page, a!).dblclick({ position: { x: box.width - 14, y: box.height / 2 } });
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId(`folder-new-${a}`)).toHaveCount(0);
  });

  test("the scope: top folders, counts, shortcuts, the palette, what's remembered", async ({ app: page, server }) => {
    await scenario("the top folders and categories are all accounts; the count moves to the open account's Inbox", async () => {
      const [a] = await accountIds(page);
      const unread = await count(row(page, a!)).textContent();
      expect(Number(unread)).toBeGreaterThan(0);
      await row(page, a!).dblclick();
      await expect(count(row(page, a!))).toHaveCount(0);
      await expect(count(child(page, a!, "inbox"))).toHaveText(unread!);

      await page.getByTestId("nav-inbox").click();
      await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
      await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
      await expect(selected(page)).toHaveCount(1);
      // still open: opening is separate from where you are
      await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");

      await child(page, a!, "inbox").click();
      const cat = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories ORDER BY id LIMIT 1")!.id;
      await page.getByTestId(`nav-category-${cat}`).click();
      await expect.poll(() => listFor(page)).toEqual(["all", null, cat, null, null, ""]);
      await expect(page.getByTestId(`nav-category-${cat}`)).toHaveAttribute("aria-current", "page");
      await expect(selected(page)).toHaveCount(1);
    });
    await scenario("Archive and Spam show their unread, the account's under it and all accounts' at the top; Sent and Trash none", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      const db = sqlDb(server.backend.store);
      const unread = (where: string, account?: number) =>
        db.get<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE unread_count > 0 AND ${where}${account === undefined ? "" : ` AND account_id = ${account}`}`)!.c;
      const shown = async (l: Locator, n: number) => (n ? await expect(count(l)).toHaveText(new Intl.NumberFormat("en-US").format(n)) : await expect(count(l)).toHaveCount(0));
      const ARCHIVE = "in_inbox = 0 AND in_trash = 0 AND in_spam = 0";
      const SPAM = "in_spam = 1 AND in_trash = 0";
      expect(unread(ARCHIVE, a)).toBeGreaterThan(0);
      await row(page, a!).dblclick();
      await shown(child(page, a!, "archive"), unread(ARCHIVE, a));
      await shown(child(page, a!, "spam"), unread(SPAM, a));
      await expect(count(child(page, a!, "sent"))).toHaveCount(0);
      await expect(count(child(page, a!, "trash"))).toHaveCount(0);
      await shown(page.getByTestId("nav-archive"), unread(ARCHIVE));
      await shown(page.getByTestId("nav-spam"), unread(SPAM));

      // an unread thread in the Archive that's read leaves the count
      const before = unread(ARCHIVE, a);
      const id = db.get<{ id: number }>(`SELECT id FROM threads WHERE account_id = ? AND unread_count > 0 AND ${ARCHIVE} LIMIT 1`, a!)!.id;
      await server.backend.server.invoke("threads.act", { threadIds: [id], action: "markRead" }, ctx);
      await shown(child(page, a!, "archive"), before - 1);
      await shown(page.getByTestId("nav-archive"), unread(ARCHIVE));
    });
    await scenario("shortcuts keep the scope for the folders an account lists; Starred goes to all accounts", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      await row(page, a!).dblclick();
      await child(page, a!, "sent").click();
      await page.getByRole("listbox").focus();
      await page.keyboard.press("g");
      await page.keyboard.press("i");
      await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);
      await expect(child(page, a!, "inbox")).toHaveAttribute("aria-current", "page");
      await page.keyboard.press("g");
      await page.keyboard.press("s");
      await expect.poll(() => listFor(page)).toEqual(["starred", null, null, null, null, ""]);
      await expect(page.getByTestId("nav-starred")).toHaveAttribute("aria-current", "page");
    });
    await scenario("the palette: an account opens it at its Inbox, All accounts goes back to everything", async () => {
      await freshStart(page);
      const [, b] = await accountIds(page);
      const name = (await row(page, b!).textContent())!.replace(/\d+$/, "").trim();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-input").fill(name);
      await page.getByRole("option", { name: new RegExp(name) }).first().click();
      await expect.poll(() => listFor(page)).toEqual(["inbox", b, null, null, null, ""]);
      await expect(row(page, b!)).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-input").fill("All accounts");
      await page.getByRole("option", { name: "All accounts", exact: true }).click();
      await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
    });
    await scenario("the open account is remembered; the scope isn't", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      await row(page, a!).dblclick();
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
      await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
    });
    await scenario("the palette's account command lands in its Inbox even from inside it (Codex R1)", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      await row(page, a!).dblclick();
      await child(page, a!, "sent").click();
      const name = (await row(page, a!).textContent())!.replace(/\d+$/, "").trim();
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-input").fill(name);
      await page.getByRole("option", { name: new RegExp(name) }).first().click();
      await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);
    });
  });

  test("the rows: a new category, the keyboard, drops, what's mounted, an update after focus left", async ({ app: page, server }) => {
    await scenario("a category made with the sidebar's + opens for all accounts, even from inside one (Codex R2)", async () => {
      const [a] = await accountIds(page);
      await row(page, a!).dblclick();
      await child(page, a!, "sent").click();
      await page.getByText("Categories").first().hover();
      await page.getByTestId("new-category").click();
      await page.getByTestId("new-category-input").fill("Recibos 64");
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await listFor(page))[1]).toBeNull();
      await expect(page.locator("#app-sidebar [aria-current=page]")).toContainText("Recibos 64");
    });
    await scenario("keyboard: Enter and Space toggle an account; a focused folder that closes hands focus to its account", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      await row(page, a!).focus();
      await page.keyboard.press("Enter");
      await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Tab");
      await expect(child(page, a!, "inbox")).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Space");
      await expect(row(page, a!)).toHaveAttribute("aria-expanded", "false");
      // closed folders are out of the Tab order
      await page.keyboard.press("Tab");
      await expect(child(page, a!, "inbox")).not.toBeFocused();

      // you're in it (Enter took you there): a click opens it
      await row(page, a!).click();
      await child(page, a!, "sent").focus();
      // a scripted click doesn't move focus: it's still on the folder as the folders close
      await row(page, a!).evaluate((el) => (el as HTMLElement).click());
      await expect(row(page, a!)).toBeFocused();
    });
    await scenario("dropping on a category still works with an account open; accounts and their folders take no drops", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      await row(page, a!).dblclick();
      await expect(page.locator(`#app-sidebar [data-testid^="nav-account-"][data-drop-target], #app-sidebar [data-testid^="nav-folder-"][data-drop-target]`)).toHaveCount(0);
      const viajes = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
      const target = page.getByTestId(`nav-category-${viajes}`);
      const dragged = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${viajes}"]))`).first();
      const id = (await dragged.getAttribute("data-thread-id"))!;
      await page.locator("#app-sidebar nav").evaluate((el) => (el.scrollTop = el.scrollHeight));
      const from = (await dragged.boundingBox())!;
      const to = (await target.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 6, from.y + from.height / 2 + 2, { steps: 2 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await expect(target).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect(page.locator(`[data-thread-id="${id}"] [data-cat-dot="${viajes}"]`)).toHaveCount(1);
    });
    await scenario("closed accounts mount no folder rows; a closing one lets its rows go after the slide (Codex R1)", async () => {
      await freshStart(page);
      const ids = await accountIds(page);
      await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(0);
      await row(page, ids[0]!).dblclick();
      await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(5);
      await expect(page.locator(`[data-testid^="nav-folder-${ids[0]}-"]`)).toHaveCount(5);
      await row(page, ids[1]!).dblclick();
      await expect(page.locator(`[data-testid^="nav-folder-${ids[0]}-"]`)).toHaveCount(0);
      await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(5);
    });
    await scenario("an account update after focus left the sidebar never pulls focus back (Codex R3)", async () => {
      await freshStart(page);
      const [a] = await accountIds(page);
      await row(page, a!).focus();
      // focus leaves on purpose (what a click on something that takes no focus does)
      await row(page, a!).evaluate((el) => (el as HTMLElement).blur());
      await expect(row(page, a!)).not.toBeFocused();
      await server.backend.server.invoke("accounts.update", { id: a!, displayName: "Renamed" }, ctx);
      await expect(row(page, a!)).toContainText("Renamed");
      await expect(row(page, a!)).not.toBeFocused();
    });
  });

  test("accounts going away: where you are, and who keeps focus", async ({ app: page, server }) => {
    await scenario("an account that's removed stops being where you are", async () => {
      const [a, b] = await accountIds(page);
      await row(page, b!).dblclick();
      await child(page, b!, "sent").click();
      await server.backend.server.invoke("accounts.remove", { id: b }, ctx);
      await expect(row(page, b!)).toHaveCount(0);
      await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
      await expect(row(page, a!)).toBeVisible();
    });
    await scenario("two accounts to one: a focused folder of the one that stays keeps focus (its folders stay listed)", async () => {
      await freshStart(page);
      const ids = await accountIds(page);
      for (const id of ids.slice(2)) await server.backend.server.invoke("accounts.remove", { id }, ctx);
      await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(2);
      await row(page, ids[0]!).dblclick();
      await child(page, ids[0]!, "sent").focus();
      await server.backend.server.invoke("accounts.remove", { id: ids[1] }, ctx);
      await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(1);
      await expect(child(page, ids[0]!, "sent")).toBeFocused();
    });
  });

});

test("with one account it opens to its Inbox, Sent, Archive, Spam and Trash like any account (as Mail lists them)", async ({ app: page, server }) => {
  const ids = await accountIds(page);
  for (const id of ids.slice(1)) await server.backend.server.invoke("accounts.remove", { id }, ctx);
  // no folders of its own and no Gmail tabs: its standard folders alone
  await server.backend.store.folders.replace(ids[0]!, []);
  await server.backend.server.invoke("accounts.update", { id: ids[0]!, separateTabs: false }, ctx);
  server.backend.server.emit("folders", await server.backend.store.folders.list());
  await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(1);
  const only = row(page, ids[0]!);
  await expect(only).toHaveAttribute("aria-expanded", "false");
  await only.dblclick();
  await expect(only).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => listFor(page)).toEqual(["inbox", ids[0], null, null, null, ""]);
  for (const v of ["inbox", "sent", "archive", "spam", "trash"]) await expect(child(page, ids[0]!, v)).toBeVisible();
  await child(page, ids[0]!, "sent").click();
  await expect.poll(() => listFor(page)).toEqual(["sent", ids[0], null, null, null, ""]);
  await expect(child(page, ids[0]!, "sent")).toHaveAttribute("aria-current", "page");
});
