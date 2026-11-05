/**
 * Plan 127: dragging mail onto an account's own folders, on the seeded demo mailbox's Gmail-like account (Acme Studio's
 * labels) and IMAP-like one (Freelance's folders): only what's dropped moves, the snack offers the rest, Undo is exact,
 * a thread in a category shown in the Inbox stays there, another account's folder refuses.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { msg } from "@terno/store/conformance";
import { sqlDb, type DevServer } from "../../backend-dev/src/server";
import { expect, test } from "./fixtures";

test.use({ reducedMotion: "no-preference" });

/** a folder of the seed's IMAP-like account */
const FOLDER_NAME = "Clientes antiguos";
const accountOf = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = ?", name)!.id;
const inFolder = (server: DevServer, accountId: number, folder: string) => new Set(sqlDb(server.backend.store).all<{ thread_id: number }>("SELECT thread_id FROM thread_folders WHERE account_id = ? AND folder = ?", accountId, folder).map((r) => r.thread_id));
const own = (page: Page, accountId: number, key: string) => page.getByTestId(`nav-own-${accountId}-${key}`);

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function dragTo(page: Page, row: Locator, target: Locator) {
  const from = await center(row);
  const to = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 2, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
}
/** an account's Inbox on screen, its folders open; the rows there aren't in `folder` yet */
async function openAccount(page: Page, accountId: number) {
  await page.getByTestId(`nav-account-${accountId}`).click();
  await page.getByTestId(`nav-folder-${accountId}-inbox`).click();
  await expect(page.locator("[data-testid=thread-row]").first()).toBeVisible();
}
const rowOutside = async (page: Page, members: Set<number>) => {
  const ids = await page.locator("[data-testid=thread-row]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-thread-id"))));
  return ids.find((id) => !members.has(id))!;
};
const row = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);

test.describe("dragging mail onto a folder", () => {
  for (const [name, key] of [["Acme Studio", "Label_23"], ["Freelance", "Clientes antiguos"]] as const) {
    test(`${name}: only the dropped one moves, it leaves the Inbox, and z brings it back`, async ({ app: page, server }) => {
      const account = accountOf(server, name);
      await openAccount(page, account);
      const target = own(page, account, key);
      const id = await rowOutside(page, inFolder(server, account, key));
      const others = await page.locator("[data-testid=thread-row]").count();
      await dragTo(page, row(page, id), target);
      await expect(target).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect(row(page, id)).toHaveCount(0);
      await expect(page.getByTestId("snack-message")).toContainText("Moved to");
      await expect.poll(() => inFolder(server, account, key).has(id)).toBe(true);
      await expect(target).not.toHaveAttribute("data-drop-state");
      // the others stayed
      expect(await page.locator("[data-testid=thread-row]").count()).toBeGreaterThanOrEqual(others - 1);
      expect(sqlDb(server.backend.store).get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox).toBe(0);

      await target.click();
      await expect(row(page, id)).toBeVisible();
      await page.getByTestId(`nav-folder-${account}-inbox`).click();
      await expect(row(page, id)).toHaveCount(0);

      await page.keyboard.press("z");
      await expect(row(page, id)).toBeVisible();
      await expect.poll(() => inFolder(server, account, key).has(id)).toBe(false);
      expect(sqlDb(server.backend.store).get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox).toBe(1);
    });
  }

  test("a line of the snack moves the rest from the sender, and one Undo takes back all of it", async ({ app: page, server }) => {
    const account = accountOf(server, "Acme Studio");
    await openAccount(page, account);
    const db = sqlDb(server.backend.store);
    // the row on top, and everything of this account from who wrote it
    const first = await rowOutside(page, inFolder(server, account, "Label_23"));
    const sender = db.get<{ from_email: string }>("SELECT from_email FROM messages WHERE thread_id = ? AND is_sent = 0 ORDER BY date LIMIT 1", first)!.from_email;
    const ids = db.all<{ id: number }>("SELECT DISTINCT t.id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.account_id = ? AND m.from_email = ? AND m.is_sent = 0 AND t.in_trash = 0 AND t.in_spam = 0", account, sender).map((r) => r.id);
    const before = new Map(db.all<{ id: number; in_inbox: number }>(`SELECT id, in_inbox FROM threads WHERE id IN (${ids.join(",")})`).map((r) => [r.id, r.in_inbox]));
    await dragTo(page, row(page, first), own(page, account, "Label_23"));
    await page.mouse.up();
    await expect(page.getByTestId("folder-snackbar")).toBeVisible();
    // only the dropped one has moved
    await expect.poll(() => inFolder(server, account, "Label_23").has(first)).toBe(true);
    const line = page.getByTestId("folder-sender");
    await expect(line).toBeVisible();
    await line.click();
    await expect.poll(() => ids.every((id) => inFolder(server, account, "Label_23").has(id))).toBe(true);
    await page.keyboard.press("z");
    await expect.poll(() => ids.every((id) => !inFolder(server, account, "Label_23").has(id))).toBe(true);
    await expect.poll(() => db.all<{ id: number; in_inbox: number }>(`SELECT id, in_inbox FROM threads WHERE id IN (${ids.join(",")})`).every((r) => before.get(r.id) === r.in_inbox)).toBe(true);
  });

  test("a line says + new mail: what arrives next lands in the folder, and Undo takes the filter back too (plan 128)", async ({ app: page, server }) => {
    const account = accountOf(server, "Acme Studio");
    const db = sqlDb(server.backend.store);
    const arrive = async (id: string, email: string) => {
      const { touched } = await server.backend.store.sync.ingest([msg({ accountId: account, providerMsgId: id, rfcMessageId: `${id}@t`, from: { name: "Sender", email }, subject: `Fresh ${id}`, date: Date.now(), gmailLabels: ["INBOX"], inInbox: true })], { applyFilters: true, now: Date.now(), classifier: null });
      return touched[0]!;
    };
    await openAccount(page, account);
    const first = await rowOutside(page, inFolder(server, account, "Label_23"));
    const sender = db.get<{ from_email: string }>("SELECT from_email FROM messages WHERE thread_id = ? AND is_sent = 0 ORDER BY date LIMIT 1", first)!.from_email;
    await dragTo(page, row(page, first), own(page, account, "Label_23"));
    await page.mouse.up();
    const line = page.getByTestId("folder-sender");
    await expect(line).toContainText("+ new mail");
    await line.click();
    await expect.poll(() => db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE auto = 1 AND rule_json LIKE '%moveToFolder%'")!.c).toBe(1);

    const caught = await arrive("future-1", sender);
    expect(inFolder(server, account, "Label_23").has(caught)).toBe(true);
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", caught)!.in_inbox).toBe(0);
    const stranger = await arrive("future-2", "someone-else@example.test");
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", stranger)!.in_inbox).toBe(1);

    await page.keyboard.press("z");
    await expect.poll(() => db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE rule_json LIKE '%moveToFolder%'")!.c).toBe(0);
    const after = await arrive("future-3", sender);
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", after)!.in_inbox).toBe(1);
  });

  test("the builder moves mail to a folder, and says when it only moves one account's", async ({ app: page, server }) => {
    await page.getByTestId("open-filters").click();
    await page.getByTestId("condition-value").fill("someone@example.test");
    await page.getByTestId("action-folder-select").click();
    await page.getByRole("option").filter({ hasText: FOLDER_NAME }).first().click();
    await expect(page.getByTestId("action-toggle-archive")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("filter-folder-account")).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: test.info().outputPath(`builder-${colorScheme}.png`) });
    }
    await page.getByTestId("action-toggle-archive").click();
    await expect(page.getByTestId("action-folder-select")).toContainText("No folder");
    await page.getByTestId("action-folder-select").click();
    await page.getByRole("option").filter({ hasText: FOLDER_NAME }).first().click();
    await page.getByTestId("filter-save").click();
    await expect.poll(async () => (await server.backend.store.filters.list()).some((f) => f.rule.actions.some((a) => a.type === "moveToFolder"))).toBe(true);
  });

  test("a thread in a category shown in the Inbox stays there and the note says why", async ({ app: page, server }) => {
    const account = accountOf(server, "Acme Studio");
    const db = sqlDb(server.backend.store);
    const ctx = { clientId: "setup", origin: "dev" as const };
    await openAccount(page, account);
    const id = await rowOutside(page, inFolder(server, account, "Label_23"));
    const shown = await server.backend.server.invoke("categories.create", { name: "Se ve", color: "cyan", showInInbox: true }, ctx) as { id: number };
    await server.backend.server.invoke("categories.moveThreads", { to: shown.id, threadIds: [id], source: "picker" }, ctx);
    await expect(row(page, id).locator(`[data-cat-dot="${shown.id}"]`)).toHaveCount(1);
    await dragTo(page, row(page, id), own(page, account, "Label_23"));
    await page.mouse.up();
    await expect(page.getByTestId("snack").getByText("Stays in the Inbox: Se ve shows there.")).toBeVisible();
    await expect(row(page, id)).toBeVisible();
    await expect.poll(() => inFolder(server, account, "Label_23").has(id)).toBe(true);
    expect(db.get<{ in_inbox: number }>("SELECT in_inbox FROM threads WHERE id = ?", id)!.in_inbox).toBe(1);
    await expect(row(page, id).locator(`[data-cat-dot="${shown.id}"]`)).toHaveCount(1);
  });

  test("a thread goes from one folder to another", async ({ app: page, server }) => {
    const account = accountOf(server, "Acme Studio");
    await page.getByTestId(`nav-account-${account}`).click();
    await own(page, account, "Label_21").click();
    const members = inFolder(server, account, "Label_21");
    await expect.poll(async () => members.has(Number(await page.locator("[data-testid=thread-row]").first().getAttribute("data-thread-id")))).toBe(true);
    const id = await rowOutside(page, inFolder(server, account, "Label_23"));
    await dragTo(page, row(page, id), own(page, account, "Label_23"));
    await page.mouse.up();
    await expect(row(page, id)).toHaveCount(0);
    await expect.poll(() => inFolder(server, account, "Label_23").has(id)).toBe(true);
    await expect.poll(() => inFolder(server, account, "Label_21").has(id)).toBe(false);
    await page.keyboard.press("z");
    await expect(row(page, id)).toBeVisible();
    await expect.poll(() => inFolder(server, account, "Label_21").has(id)).toBe(true);
    await expect.poll(() => inFolder(server, account, "Label_23").has(id)).toBe(false);
  });

  test("the folder you're in shows a check and ignores the drop", async ({ app: page, server }) => {
    const account = accountOf(server, "Acme Studio");
    await page.getByTestId(`nav-account-${account}`).click();
    const target = own(page, account, "Label_21");
    await target.click();
    const first = page.locator("[data-testid=thread-row]").first();
    await expect.poll(async () => inFolder(server, account, "Label_21").has(Number(await first.getAttribute("data-thread-id")))).toBe(true);
    await dragTo(page, first, target);
    await expect(target).toHaveAttribute("data-drop-state", "already");
    await page.mouse.up();
    await expect(page.getByTestId("folder-snackbar")).toHaveCount(0);
  });

  test("another account's folder refuses the drop and says why; nothing moves", async ({ app: page, server }) => {
    const acme = accountOf(server, "Acme Studio");
    const freelance = accountOf(server, "Freelance");
    // Acme's folder under a favorite stays on screen with another account's list
    await server.backend.server.invoke("folders.favorite", { accountId: acme, folder: "Label_23", view: null, on: true }, { clientId: "setup", origin: "dev" });
    await openAccount(page, freelance);
    const target = page.getByTestId(`nav-fav-${acme}-Label_23`);
    await expect(target).toBeVisible();
    const before = inFolder(server, acme, "Label_23").size;
    const first = page.locator("[data-testid=thread-row]").first();
    const id = Number(await first.getAttribute("data-thread-id"));
    await dragTo(page, first, target);
    await expect(target).toHaveAttribute("data-drop-state", "refused");
    await page.mouse.up();
    await expect(page.getByTestId("snack").getByText("is in another account")).toBeVisible();
    await expect(row(page, id)).toBeVisible();
    expect(inFolder(server, acme, "Label_23").size).toBe(before);
  });

  test("by the keyboard: the thread menu's Move to lists the account's folders", async ({ app: page, server }) => {
    const account = accountOf(server, "Acme Studio");
    await openAccount(page, account);
    const id = await rowOutside(page, inFolder(server, account, "Label_23"));
    await row(page, id).click({ button: "right" });
    await page.getByTestId("menu-move").focus();
    await page.keyboard.press("ArrowRight");
    const item = page.getByTestId("menu-move-folder-Label_23");
    await expect(item).toBeVisible();
    await item.click();
    await expect(row(page, id)).toHaveCount(0);
    await expect.poll(() => inFolder(server, account, "Label_23").has(id)).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`mid-drag and with its offers, axe clean (${theme})`, async ({ app: page, server }) => {
      await page.emulateMedia({ colorScheme: theme });
      const account = accountOf(server, "Acme Studio");
      await openAccount(page, account);
      const id = await rowOutside(page, inFolder(server, account, "Label_23"));
      await dragTo(page, row(page, id), own(page, account, "Label_23"));
      await expect(own(page, account, "Label_23")).toHaveAttribute("data-drop-state", "over");
      await page.screenshot({ path: test.info().outputPath(`drag-${theme}.png`) });
      await page.mouse.up();
      await expect(page.getByTestId("snack-message")).toBeVisible();
      await page.waitForTimeout(150);
      await page.screenshot({ path: test.info().outputPath(`dropped-${theme}.png`) });
      const results = await new AxeBuilder({ page }).include("[data-testid=snack-dock]").analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
