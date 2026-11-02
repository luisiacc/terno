/**
 * Plan 108: focus on one account. The sidebar shows only it (a way back, its name and address, every view, its
 * Gmail tabs and its own folders), shortcuts and search stay in it, and the back arrow is the all-accounts Inbox.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, focusList, search, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const accountOf = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", name)!.id;
async function accountIds(page: Page): Promise<number[]> {
  const ids = await page.locator('[data-testid^="nav-account-"]').evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-testid")!.slice("nav-account-".length))));
  expect(ids.length).toBeGreaterThan(1);
  return ids;
}
/** what the list shows: [view, accountId, categoryId, …, query] */
const listFor = (page: Page) => page.getByTestId("thread-list").getAttribute("data-results-for").then((k) => JSON.parse(k!) as unknown[]);
const rowIds = (page: Page) => page.locator("[data-testid=thread-row]").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-thread-id"))));
const accountOfThread = (server: DevServer, id: number) => sqlDb(server.backend.store).get<{ account_id: number }>("SELECT account_id FROM threads WHERE id = ?", id)!.account_id;

async function focusFromMenu(page: Page, id: number) {
  await page.getByTestId(`nav-account-${id}`).click({ button: "right" });
  await page.getByTestId("account-menu-focus").click();
  await expect(page.getByTestId("solo-back")).toBeVisible();
}

test.describe("focus on one account", { tag: "@design" }, () => {
  test("the menu focuses an account: only its places show, Starred and All Mail its own; the back arrow is all accounts", async ({ app: page, server }) => {
    const [a, b] = await accountIds(page);
    const account = (await server.backend.store.accounts.get(a!))!;
    await focusFromMenu(page, a!);
    // the menu's row is gone: the keyboard is on the way back
    await expect(page.getByTestId("solo-back")).toBeFocused();
    await expect(page.getByTestId("solo-title")).toContainText(account.displayName);
    await expect(page.getByTestId("solo-title")).toContainText(account.email);
    const order = await page.locator("#app-sidebar nav [data-testid^=nav-folder-]").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(order).toEqual(["inbox", "starred", "sent", "archive", "all", "spam", "trash"].map((v) => `nav-folder-${a}-${v}`));
    // nothing of the other accounts, of all of them, or the categories
    for (const id of ["nav-inbox", "nav-starred", "nav-more", `nav-account-${a}`, `nav-account-${b}`, "sidebar-add-account"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.locator("[data-testid^=nav-category-]")).toHaveCount(0);
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);
    await expect(page.getByTestId(`nav-folder-${a}-inbox`)).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#app-sidebar nav")).toHaveAttribute("aria-label", `${account.displayName} mailboxes`);

    // Starred and All Mail are its own here, by click or by shortcut
    await page.getByTestId(`nav-folder-${a}-all`).click();
    await expect.poll(() => listFor(page)).toEqual(["all", a, null, null, null, ""]);
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("s");
    await expect.poll(() => listFor(page)).toEqual(["starred", a, null, null, null, ""]);
    await expect(page.getByTestId(`nav-folder-${a}-starred`)).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#app-sidebar [aria-current=page]")).toHaveCount(1);

    // back: the all-accounts Inbox, the keyboard on the account's row
    await page.getByTestId("solo-back").click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId(`nav-account-${a}`)).toBeFocused();
    await expect(page.getByTestId("solo-back")).toHaveCount(0);
  });

  test("its own folders sit flush under a Folders title, nested; a new one starts there", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    await focusFromMenu(page, acme);
    const pad = (id: string) => page.getByTestId(id).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    await expect(page.getByTestId("solo-folders")).toBeVisible();
    // Proyectos lines up with Inbox; Rediseño web, under it, one step in
    expect(await pad(`nav-own-${acme}-Label_21`)).toBe(await pad(`nav-folder-${acme}-inbox`));
    expect(await pad(`nav-own-${acme}-Label_22`)).toBeGreaterThan(await pad(`nav-own-${acme}-Label_21`));
    await page.getByTestId(`nav-own-${acme}-Label_21`).click();
    await expect.poll(() => listFor(page)).toEqual(["all", acme, null, null, null, "Label_21", ""]);

    await page.getByTestId("solo-folders").hover();
    await page.getByTestId("solo-add-folder").click();
    const field = page.getByTestId(`folder-new-${acme}`);
    await expect(field).toBeFocused();
    // the field's name starts where a top folder's does
    expect(await page.getByTestId(`folder-new-${acme}-row`).locator("> div").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBe(await pad(`nav-own-${acme}-Label_21`));
    // Esc: the keyboard goes back up to the way back (the account's row isn't here)
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(page.getByTestId("solo-back")).toBeFocused();
  });

  test("a search looks only in the focused account; Search all accounts widens it and shows every account again", async ({ app: page, server }) => {
    const [a, b] = await accountIds(page);
    const db = sqlDb(server.backend.store);
    // a word in the other account's newest subject
    const subject = db.get<{ subject: string }>("SELECT subject FROM threads WHERE account_id = ? AND in_inbox = 1 ORDER BY last_date DESC LIMIT 1", b!)!.subject;
    const word = subject.split(/\s+/).find((w) => /^\p{L}{5,}$/u.test(w))!;
    await focusFromMenu(page, a!);
    await search(page, word);
    const name = (await server.backend.store.accounts.get(a!))!.displayName;
    await expect(page.getByTestId("search-input")).toHaveAttribute("placeholder", `Search ${name}`);
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, "~solo", word]);
    expect((await rowIds(page)).every((id) => accountOfThread(server, id) === a)).toBe(true);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/search-${test.info().project.name}.png` });
    await expect(page.getByTestId("solo-back")).toBeVisible();

    await page.getByTestId("solo-search-all").click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, word]);
    await expect.poll(async () => (await rowIds(page)).some((id) => accountOfThread(server, id) === b)).toBe(true);
    await expect(page.getByTestId("solo-back")).toHaveCount(0);
    await expect(page.getByTestId(`nav-account-${b}`)).toBeVisible();
    await expect(page.getByTestId("search-input")).toHaveAttribute("placeholder", "Search all your accounts");
  });

  test("remembered on reload; the palette focuses and All accounts leaves", async ({ app: page }) => {
    const [a, b] = await accountIds(page);
    await focusFromMenu(page, a!);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.getByTestId("solo-back")).toBeVisible();
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);

    // another account from the palette: it focuses that one
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId(`palette-focus-${b}`).click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", b, null, null, null, ""]);
    await expect(page.getByTestId(`nav-folder-${b}-inbox`)).toBeVisible();
    await expect(page.getByTestId(`nav-folder-${a}-inbox`)).toHaveCount(0);

    // Reminders is every account's: it leaves focus, and a reload remembers that
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("r");
    await expect(page.getByTestId("solo-back")).toHaveCount(0);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.getByTestId("nav-inbox")).toBeVisible();
    await expect(page.getByTestId("solo-back")).toHaveCount(0);
  });

  test("the header's menu has Show all accounts; Shift+F10 on the back row opens it", async ({ app: page }) => {
    const [a] = await accountIds(page);
    await focusFromMenu(page, a!);
    await expect(page.getByTestId("solo-back")).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId(`account-menu-${a}`)).toBeVisible();
    await expect(page.getByTestId("account-menu-focus")).toHaveCount(0);
    await page.getByTestId("account-menu-unfocus").click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
    await expect(page.getByTestId(`nav-account-${a}`)).toBeFocused();
    // the menu went with the header: shortcuts work again
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect.poll(() => listFor(page)).toEqual(["sent", null, null, null, null, ""]);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the focused sidebar is axe-clean, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await focusFromMenu(page, accountOf(server, "Acme Studio"));
      await page.getByTestId("solo-title").hover();
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/focus-${mode}.png` });
      const r = await new AxeBuilder({ page }).include("#app-sidebar").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    });
  }
});
