/**
 * Plan 106: an account's right-click menu in the sidebar: rename in place, color, a new message from it, check
 * for new mail, mark its Inbox read, sign in again, its settings, and remove it. Shift+F10 opens it from the row.
 */
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, rows, test } from "./fixtures";

type Handlers = Record<string, (...a: unknown[]) => Promise<unknown>>;

async function accountIds(page: Page): Promise<number[]> {
  const ids = await page.locator('[data-testid^="nav-account-"]').evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-testid")!.slice("nav-account-".length))));
  expect(ids.length).toBeGreaterThan(2);
  return ids;
}
const row = (page: Page, id: number) => page.getByTestId(`nav-account-${id}`);
const menu = (page: Page, id: number) => page.getByTestId(`account-menu-${id}`);
async function openMenu(page: Page, id: number) {
  await row(page, id).click({ button: "right" });
  await expect(menu(page, id)).toBeVisible();
}
/** an account's unread threads in its Inbox, as its sidebar count counts them */
const inboxUnread = (db: ReturnType<typeof sqlDb>, account: number) =>
  db.get<{ c: number }>(
    "SELECT count(*) AS c FROM threads t WHERE t.account_id = ? AND t.in_inbox = 1 AND t.tab = 0 AND t.unread_count > 0 AND NOT EXISTS (SELECT 1 FROM thread_categories h JOIN categories k ON k.id = h.category_id WHERE h.thread_id = t.id AND k.show_in_inbox = 0)",
    account,
  )!.c;

test.describe("the account menu", () => {
  test.describe("an account that needs a sign-in", () => {
    test.use({ backendOptions: { network: true } });
    test("shows its actions; Sign in again… only for an account that needs it", async ({ app: page, server }) => {
      const [a, b] = await accountIds(page);
      await openMenu(page, a!);
      for (const id of ["compose", "sync", "read-all", "rename", "color", "settings", "remove"]) await expect(page.getByTestId(`account-menu-${id}`)).toBeVisible();
      await expect(page.getByTestId("account-menu-sign-in")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu(page, a!)).toHaveCount(0);

      // the account's server refuses its saved sign-in and a sync finds out: the status owner, not a stored state,
      // says it needs a sign-in (w05 account-status owner, 80d812de)
      const email = (await server.backend.store.accounts.get(b!))!.email;
      server.net.refused.add(email);
      await server.backend.syncAccount(b!);
      // the row has its key; the menu opens the same panel beside it
      await expect(page.getByTestId(`sign-in-marker-${b}`)).toBeVisible();
      await openMenu(page, b!);
      await page.getByTestId("account-menu-sign-in").click();
      const popover = page.getByTestId("sign-in-popover");
      await expect(popover).toBeVisible();
      await expect.poll(() => popover.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      // a right-click in the panel is its own (paste into the password), never the account menu (Codex code review round 6)
      await popover.click({ button: "right" });
      await page.waitForTimeout(200);
      await expect(menu(page, b!)).toHaveCount(0);
      await expect(popover).toBeVisible();
    });
  });

  test("Rename: the field sits where the name was; Enter saves, Esc cancels, leaving saves, empty keeps the name", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    const before = (await server.backend.store.accounts.get(a!))!.displayName;
    const label = row(page, a!).locator("span.truncate").first();
    const labelBox = (await label.boundingBox())!;
    const rowBox = (await row(page, a!).boundingBox())!;

    await openMenu(page, a!);
    await page.getByTestId("account-menu-rename").click();
    const input = page.getByTestId(`account-rename-input-${a}`);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(before);
    // the whole name is selected, ready to type over
    expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, before.length]);
    // the text starts where the name did, and the row keeps its height
    const textLeft = await input.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
    expect(Math.abs(textLeft - labelBox.x)).toBeLessThanOrEqual(1);
    expect((await page.getByTestId(`account-rename-${a}`).boundingBox())!.height).toBeCloseTo(rowBox.height, 0);

    // Esc: nothing changes, the row has focus again
    await input.fill("Not this");
    await input.press("Escape");
    await expect(row(page, a!)).toBeFocused();
    await expect(row(page, a!)).toContainText(before);

    // Enter: saved once, the row has focus again
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const update = handlers["accounts.update"]!;
    let updates = 0;
    handlers["accounts.update"] = async (...args) => (updates++, update(...args));
    await openMenu(page, a!);
    await page.getByTestId("account-menu-rename").click();
    await input.fill("  Work mail  ");
    await input.press("Enter");
    await expect(row(page, a!)).toBeFocused();
    await expect(row(page, a!)).toContainText("Work mail");
    await expect.poll(async () => (await server.backend.store.accounts.get(a!))!.displayName).toBe("Work mail");
    expect(updates).toBe(1);

    // empty: the name stays, nothing is sent
    await openMenu(page, a!);
    await page.getByTestId("account-menu-rename").click();
    await input.fill("   ");
    await input.press("Enter");
    await expect(row(page, a!)).toContainText("Work mail");
    expect(updates).toBe(1);

    // leaving the field saves it, and focus stays where the click went
    await openMenu(page, a!);
    await page.getByTestId("account-menu-rename").click();
    await input.fill("Personal again");
    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("nav-inbox")).toBeFocused();
    await expect.poll(async () => (await server.backend.store.accounts.get(a!))!.displayName).toBe("Personal again");
    await expect(row(page, a!)).toContainText("Personal again");
    expect(updates).toBe(2);
  });

  test("Rename: a refused save puts the name back and says why", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    const before = (await server.backend.store.accounts.get(a!))!.displayName;
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    handlers["accounts.update"] = async () => {
      await new Promise((r) => setTimeout(r, 200));
      throw new Error("disk full");
    };
    await openMenu(page, a!);
    await page.getByTestId("account-menu-rename").click();
    await page.getByTestId(`account-rename-input-${a}`).fill("Doomed");
    await page.getByTestId(`account-rename-input-${a}`).press("Enter");
    // shown at once, then put back
    await expect(row(page, a!)).toContainText("Doomed");
    await expect(page.getByTestId("snack").filter({ hasText: "Couldn’t rename the account: disk full" })).toBeVisible();
    await expect(row(page, a!)).toContainText(before);
  });

  test("a click elsewhere closes the menu (it's modal); the next click's focus stays where it went", async ({ app: page }) => {
    const [a] = await accountIds(page);
    await openMenu(page, a!);
    // the sidebar's Inbox: in every design (Lumen's search hides behind a button)
    const target = page.getByTestId("nav-inbox");
    const box = (await target.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(menu(page, a!)).toHaveCount(0);
    await target.click();
    await expect(target).toBeFocused();
    // past the menu's close: nothing takes it back
    await page.waitForTimeout(300);
    await expect(target).toBeFocused();
  });

  test("Color: the dot and the account change", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    const current = (await server.backend.store.accounts.get(a!))!.color;
    const next = current === "rose" ? "emerald" : "rose";
    await openMenu(page, a!);
    await page.getByTestId("account-menu-color").hover();
    await expect(page.getByTestId(`account-menu-color-${current}`)).toHaveAttribute("aria-checked", "true");
    await page.getByTestId(`account-menu-color-${next}`).click();
    await expect(menu(page, a!)).toHaveCount(0);
    await expect.poll(async () => (await server.backend.store.accounts.get(a!))!.color).toBe(next);
    await expect(row(page, a!).locator(`[data-slot=category-dot].bg-cat-${next}`)).toHaveCount(1);
  });

  test("New message: from that account, wherever you are", async ({ app: page, server }) => {
    const [a, b] = await accountIds(page);
    // in another account's Inbox
    await row(page, a!).click();
    await openMenu(page, b!);
    await page.getByTestId("account-menu-compose").click();
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await page.getByTestId("compose-subject").fill("From the menu");
    await expect.poll(async () => (await server.backend.store.drafts.list())[0]?.account_id).toBe(b);
  });

  test("Check for new mail: syncs that account", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const sync = handlers["sync.now"]!;
    const asked: unknown[] = [];
    handlers["sync.now"] = async (...args) => (asked.push(args[0]), sync(...args));
    await openMenu(page, a!);
    await page.getByTestId("account-menu-sync").click();
    await expect.poll(() => asked).toContainEqual({ accountId: a, reason: "user" });
    await expect(page.getByTestId("snack").filter({ hasText: "for new mail" })).toBeVisible();
    await expect(row(page, a!)).toBeFocused();
  });

  test("Mark all as read: that account's Inbox only, undone exactly; off when nothing's unread", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const ids = await accountIds(page);
    const [a] = ids.filter((id) => inboxUnread(db, id) > 0);
    expect(a).toBeDefined();
    const others = Object.fromEntries(ids.filter((id) => id !== a).map((id) => [id, inboxUnread(db, id)]));
    const unread = inboxUnread(db, a!);
    // the unified Inbox shows its rows read at once
    await page.getByTestId("nav-inbox").click();
    await rows(page).first().waitFor();
    await openMenu(page, a!);
    await page.getByTestId("account-menu-read-all").click();
    await expect(page.getByTestId("snack").filter({ hasText: /Marked as read/ })).toBeVisible();
    await expect.poll(() => inboxUnread(db, a!)).toBe(0);
    for (const [id, n] of Object.entries(others)) expect(inboxUnread(db, Number(id))).toBe(n);
    await expect(row(page, a!).locator("[data-slot=nav-count]")).toHaveCount(0);

    await openMenu(page, a!);
    await expect(page.getByTestId("account-menu-read-all")).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    await page.keyboard.press("z");
    await expect.poll(() => inboxUnread(db, a!)).toBe(unread);
  });

  test("Account settings…: Settings opens on that account, open and focused", async ({ app: page }) => {
    const [, b] = await accountIds(page);
    await openMenu(page, b!);
    await page.getByTestId("account-menu-settings").click();
    const item = page.locator(`[data-testid=settings-account][data-account-id="${b}"]`);
    await expect(item.getByTestId("account-toggle")).toBeFocused();
    await expect(item.getByTestId("account-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(item.getByTestId("account-editor")).toBeVisible();
    // once: going to another tab and back opens nothing by itself
    await page.getByTestId("tab-general").click();
    await page.getByTestId("tab-accounts").click();
    await expect(page.locator("[data-testid=account-editor]")).toHaveCount(0);
  });

  test("Remove account…: Cancel keeps it; Remove removes it and the next row takes the focus", async ({ app: page, server }) => {
    const [a, b] = await accountIds(page);
    // a thread has the focus; the menu is opened with the pointer (Codex code review round 2 #4)
    await rows(page).first().click();
    await openMenu(page, a!);
    await page.getByTestId("account-menu-remove").click();
    const dialog = page.getByTestId("account-remove-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, a!)).toBeFocused();

    // a failure keeps it and its row has the focus back
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const remove = handlers["accounts.remove"]!;
    handlers["accounts.remove"] = async () => {
      throw new Error("busy");
    };
    await rows(page).first().click();
    await openMenu(page, a!);
    await page.getByTestId("account-menu-remove").click();
    await page.getByTestId("account-remove-dialog-confirm").click();
    await expect(page.getByTestId("snack").filter({ hasText: "busy" })).toBeVisible();
    await expect(row(page, a!)).toBeFocused();

    // a slow removal: the focus waits for the row to go
    handlers["accounts.remove"] = async (...args) => (await new Promise((r) => setTimeout(r, 300)), remove(...args));
    await row(page, a!).focus();
    await page.keyboard.press("Shift+F10");
    await page.getByTestId("account-menu-remove").click();
    await page.getByTestId("account-remove-dialog-confirm").click();
    await expect(page.getByTestId("snack").filter({ hasText: "Account removed" })).toBeVisible();
    await expect(row(page, a!)).toHaveCount(0);
    await expect(row(page, b!)).toBeFocused();
    expect(await server.backend.store.accounts.get(a!)).toBeFalsy();
  });

  test("plan 125: a Gmail account's dialog says where to withdraw Google's access; an unconfirmed revoke says to check there", async ({ app: page, server }) => {
    const accounts = await server.backend.store.accounts.list();
    const gmail = accounts.find((a) => a.kind === "gmail")!;
    const imap = accounts.find((a) => a.kind === "imap")!;
    const dialog = page.getByTestId("account-remove-dialog");
    // the browser can't revoke (Google's endpoint has no CORS): it points to Google's page
    await openMenu(page, imap.id);
    await page.getByTestId("account-menu-remove").click();
    await expect(dialog).not.toContainText("Google");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await openMenu(page, gmail.id);
    await page.getByTestId("account-menu-remove").click();
    await expect(dialog).toContainText("To withdraw Terno’s access to your Google Account too, remove Terno at myaccount.google.com/permissions.");
    // a desktop removal Google didn't confirm: removed anyway, and the snack says where to check
    const handlers = (server.backend.server as unknown as { handlers: Handlers }).handlers;
    const remove = handlers["accounts.remove"]!;
    handlers["accounts.remove"] = async (...args) => ({ ...((await remove(...args)) as object), google: "failed" });
    await page.getByTestId("account-remove-dialog-confirm").click();
    const snack = page.getByTestId("snack").filter({ hasText: "Google didn’t confirm Terno lost access." });
    await expect(snack).toContainText("Account removed");
    await expect(snack.getByRole("button", { name: "Check at Google" })).toBeVisible();
    await expect(row(page, gmail.id)).toHaveCount(0);
  });

  test("Shift+F10 and the menu key open the focused row's own menu: an account's, a category's, never the thread menu", async ({ app: page, server }) => {
    const [a] = await accountIds(page);
    await rows(page).first().click();
    await row(page, a!).focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu(page, a!)).toBeVisible();
    await expect(page.getByTestId("thread-menu")).toHaveCount(0);
    // the arrows walk it, Enter picks
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(menu(page, a!)).toHaveCount(0);
    await expect(row(page, a!)).toBeFocused();

    await page.keyboard.press("ContextMenu");
    await expect(menu(page, a!)).toBeVisible();
    await page.keyboard.press("Escape");
    // the closing menu hands focus back to the row as it goes
    await expect(menu(page, a!)).toHaveCount(0);
    await expect(row(page, a!)).toBeFocused();

    const cat = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories ORDER BY id LIMIT 1")!.id;
    await page.getByTestId(`nav-category-${cat}`).focus();
    await expect(page.getByTestId(`nav-category-${cat}`)).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId(`category-menu-${cat}`)).toBeVisible();
    await expect(page.getByTestId("thread-menu")).toHaveCount(0);
  });
});
