/**
 * Plan 64: what's at the top of the sidebar is all your mail; what's under an account is that account's.
 * An account row opens into its folders (one at a time), the top folders and categories are cross-account,
 * and at most one row is selected.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, test } from "./fixtures";

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

test.describe("accounts open into their folders", { tag: "@design" }, () => {
  test("a click opens an account into its Inbox; another closes it; clicking an open one closes it and you stay", async ({ app: page, design }) => {
    const [a, b] = await accountIds(page);
    await expect(group(page, a!)).toHaveAttribute("inert", "");
    await row(page, a!).click();
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
    for (const v of ["inbox", "sent", "archive", "spam", "trash"]) await expect(child(page, a!, v)).toBeVisible();
    // Starred and All Mail are cross-account: at the top only
    await expect(group(page, a!).locator('[data-testid$="-starred"], [data-testid$="-all"]')).toHaveCount(0);
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);
    await expect(selected(page)).toHaveCount(1);
    await expect(child(page, a!, "inbox")).toHaveAttribute("aria-current", "page");
    const name = (await row(page, a!).textContent())!.trim();
    // designs that greet leave the account out of the Inbox's title
    if (design !== "lumen") await expect(page.getByTestId("thread-list")).toContainText(`· ${name}`);

    await child(page, a!, "sent").click();
    await expect.poll(() => listFor(page)).toEqual(["sent", a, null, null, null, ""]);
    await expect(selected(page)).toHaveCount(1);
    await expect(child(page, a!, "sent")).toHaveAttribute("aria-current", "page");

    // another account: the first closes
    await row(page, b!).click();
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "false");
    await expect(group(page, a!)).toHaveAttribute("inert", "");
    await expect.poll(() => listFor(page)).toEqual(["inbox", b, null, null, null, ""]);

    // the open one: it closes, you stay, and its row is what's selected
    await child(page, b!, "trash").click();
    await row(page, b!).click();
    await expect(row(page, b!)).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => listFor(page)).toEqual(["trash", b, null, null, null, ""]);
    await expect(selected(page)).toHaveCount(1);
    await expect(row(page, b!)).toHaveAttribute("aria-current", "page");
  });

  test("the top folders and categories are all accounts; the count moves to the open account's Inbox", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    const unread = await count(row(page, a!)).textContent();
    expect(Number(unread)).toBeGreaterThan(0);
    await row(page, a!).click();
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

  test("a category made with the sidebar's + opens for all accounts, even from inside one (Codex R2)", async ({ app: page }) => {
    const [a] = await accountIds(page);
    await row(page, a!).click();
    await child(page, a!, "sent").click();
    await page.getByText("Categories").first().hover();
    await page.getByTestId("new-category").click();
    await page.getByTestId("new-category-input").fill("Recibos 64");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await listFor(page))[1]).toBeNull();
    await expect(page.locator("#app-sidebar [aria-current=page]")).toContainText("Recibos 64");
  });

  test("shortcuts keep the scope for the folders an account lists; Starred goes to all accounts", async ({ app: page }) => {
    const [a] = await accountIds(page);
    await row(page, a!).click();
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

  test("the palette: an account opens it at its Inbox, All accounts goes back to everything", async ({ app: page }) => {
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

  test("the open account is remembered; the scope isn't", async ({ app: page }) => {
    const [a] = await accountIds(page);
    await row(page, a!).click();
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(row(page, a!)).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("aria-current", "page");
  });

  test("keyboard: Enter and Space toggle an account; a focused folder that closes hands focus to its account", async ({ app: page }) => {
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

    await row(page, a!).click();
    await child(page, a!, "sent").focus();
    // a scripted click doesn't move focus: it's still on the folder as the folders close
    await row(page, a!).evaluate((el) => (el as HTMLElement).click());
    await expect(row(page, a!)).toBeFocused();
  });

  test("an account that's removed stops being where you are", async ({ app: page, server }) => {
    const [a, b] = await accountIds(page);
    await row(page, b!).click();
    await child(page, b!, "sent").click();
    await server.backend.server.invoke("accounts.remove", { id: b }, ctx);
    await expect(row(page, b!)).toHaveCount(0);
    await expect.poll(() => listFor(page)).toEqual(["inbox", null, null, null, null, ""]);
    await expect(row(page, a!)).toBeVisible();
  });

  test("dropping on a category still works with an account open; accounts and their folders take no drops", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    await row(page, a!).click();
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

  test("closed accounts mount no folder rows; a closing one lets its rows go after the slide (Codex R1)", async ({ app: page }) => {
    const ids = await accountIds(page);
    await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(0);
    await row(page, ids[0]!).click();
    await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(5);
    await expect(page.locator(`[data-testid^="nav-folder-${ids[0]}-"]`)).toHaveCount(5);
    await row(page, ids[1]!).click();
    await expect(page.locator(`[data-testid^="nav-folder-${ids[0]}-"]`)).toHaveCount(0);
    await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(5);
  });

  test("the palette's account command lands in its Inbox even from inside it (Codex R1)", async ({ app: page }) => {
    const [a] = await accountIds(page);
    await row(page, a!).click();
    await child(page, a!, "sent").click();
    const name = (await row(page, a!).textContent())!.replace(/\d+$/, "").trim();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-input").fill(name);
    await page.getByRole("option", { name: new RegExp(name) }).first().click();
    await expect.poll(() => listFor(page)).toEqual(["inbox", a, null, null, null, ""]);
  });

  test("two accounts to one: a focused folder of the one that stays hands focus to its row (Codex R1)", async ({ app: page, server }) => {
    const ids = await accountIds(page);
    for (const id of ids.slice(2)) await server.backend.server.invoke("accounts.remove", { id }, ctx);
    await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(2);
    await row(page, ids[0]!).click();
    await child(page, ids[0]!, "sent").focus();
    await server.backend.server.invoke("accounts.remove", { id: ids[1] }, ctx);
    await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(1);
    await expect(row(page, ids[0]!)).toBeFocused();
  });

  test("an account update after focus left the sidebar never pulls focus back (Codex R3)", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    await row(page, a!).focus();
    // focus leaves on purpose (what a click on something that takes no focus does)
    await row(page, a!).evaluate((el) => (el as HTMLElement).blur());
    await expect(row(page, a!)).not.toBeFocused();
    await server.backend.server.invoke("accounts.update", { id: a!, displayName: "Renamed" }, ctx);
    await expect(row(page, a!)).toContainText("Renamed");
    await expect(row(page, a!)).not.toBeFocused();
  });

  for (const mode of ["light", "dark"] as const) {
    test(`axe with an account open, ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const [a] = await accountIds(page);
      await row(page, a!).click();
      await child(page, a!, "sent").hover();
      const r = await new AxeBuilder({ page }).include("#app-sidebar").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(", ")}`)).toEqual([]);
    });
  }
});

test("with one account it lists no folders of its own: the top ones are the same mail", async ({ app: page, server }) => {
  const ids = await accountIds(page);
  for (const id of ids.slice(1)) await server.backend.server.invoke("accounts.remove", { id }, ctx);
  // plan 65: an account with folders of its own lists those; this one has none
  await server.backend.store.folders.replace(ids[0]!, []);
  server.backend.server.emit("folders", await server.backend.store.folders.list());
  await expect(page.locator('[data-testid^="nav-account-"]')).toHaveCount(1);
  const only = row(page, ids[0]!);
  await expect(only).not.toHaveAttribute("aria-expanded");
  await expect(page.locator('[data-testid^="nav-folder-"]')).toHaveCount(0);
  await only.click();
  await expect.poll(() => listFor(page)).toEqual(["inbox", ids[0], null, null, null, ""]);
  await expect(only).toHaveAttribute("aria-current", "page");
});
