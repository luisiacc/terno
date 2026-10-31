/**
 * Plan 63: archive, delete or spam similar mail, from the snackbar after an
 * action and from the thread menu's "… similar" submenus.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, selectThread, test } from "./fixtures";

const wcag = (page: Page) => new AxeBuilder({ page }).include("[data-testid=snack-dock]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

/** The inbox sender with the most plain (not starred, not replied) inbox threads; what each action's scope holds for it. */
function senderSetup(server: DevServer) {
  const db = sqlDb(server.backend.store);
  const plain = "t.is_starred = 0 AND t.has_sent = 0 AND t.in_trash = 0 AND t.in_spam = 0";
  const email = db.get<{ email: string }>(
    `SELECT t.last_from_email AS email FROM threads t WHERE t.in_inbox = 1 AND ${plain} AND t.message_count = 1
     GROUP BY t.last_from_email ORDER BY count(*) DESC, email LIMIT 1`,
  )!.email;
  const scope = (inbox: boolean) =>
    db.all<{ id: number }>(
      `SELECT t.id FROM threads t WHERE ${plain} ${inbox ? "AND t.in_inbox = 1" : ""}
       AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.from_email = ? AND m.is_sent = 0) ORDER BY t.last_date DESC`,
      email,
    ).map((r) => r.id);
  const ids = scope(true);
  const anywhere = scope(false);
  const count = (where: string, of: number[]) => () => db.get<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE ${where} AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(of))!.c;
  return { db, email, ids, anywhere, inInbox: count("in_inbox = 1", ids), inSpam: count("in_spam = 1", anywhere) };
}

const result = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });

test.describe("similar mail", { tag: "@design" }, () => {
  test("archiving one thread offers the rest from its sender: 1 archives them, one Undo brings back all", async ({ app: page, server }) => {
    const { email, ids, inInbox } = senderSetup(server);
    expect(ids.length).toBeGreaterThan(2);
    await selectThread(page, ids[0]!, `in:inbox from:${email}`);
    await page.keyboard.press("e");

    const snack = page.getByTestId("similar-snackbar");
    await expect(snack.getByTestId("snack-message")).toHaveText("Archived");
    await expect(snack.getByTestId("similar-sender")).toContainText("All from");
    await expect(snack.getByTestId("similar-sender-count")).toHaveText(`· ${ids.length - 1}`);
    await expect.poll(inInbox).toBe(ids.length - 1);

    await page.keyboard.press("1");
    const done = result(page, `Archived ${ids.length - 1}`);
    await expect(done).toBeVisible();
    await expect.poll(inInbox).toBe(0);
    // Always is offered for the future
    await expect(done.getByTestId("snack-secondary")).toHaveText("Always");

    await page.keyboard.press("z");
    await expect.poll(inInbox).toBe(ids.length);
  });

  test("the snackbar is axe-clean in light and dark", async ({ app: page, server }) => {
    const { email, ids } = senderSetup(server);
    await selectThread(page, ids[0]!, `in:inbox from:${email}`);
    await page.keyboard.press("e");
    await expect(page.getByTestId("similar-sender")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // hovered: the countdown waits while axe reads
      await page.getByTestId("similar-snackbar").hover();
      expect((await wcag(page).analyze()).violations, scheme).toEqual([]);
    }
  });

  test("right-click → Mark similar as spam → sender: all of it goes to Spam and future mail with it; Undo takes both back", async ({ app: page, server }) => {
    const { email, ids, anywhere, inSpam } = senderSetup(server);
    await selectThread(page, ids[0]!, `in:inbox from:${email}`);
    await page.locator(`[data-testid=thread-row][data-thread-id="${ids[0]}"]`).click({ button: "right" });
    await page.getByTestId("menu-spam-similar").hover();
    const list = page.getByTestId("menu-spam-similar-list");
    await expect(list.getByTestId("menu-spam-similar-note")).toHaveText("Their future mail goes to Spam too.");
    await expect(list.getByTestId("menu-similar-sender-count")).toHaveText(String(anywhere.length));
    // the full address follows the name, so same-named senders tell apart
    await expect(list.getByTestId("menu-similar-sender")).toContainText(new RegExp(`^All from .+ ${email.replace(/[.+]/g, "\\$&")}`));
    await list.getByTestId("menu-similar-sender").click();

    const done = result(page, `Marked ${anywhere.length} as spam`);
    await expect(done).toBeVisible();
    await expect(done).toContainText("Future mail like this goes to Spam too.");
    await expect.poll(inSpam).toBe(anywhere.length);
    const filters = async () => (await server.backend.store.filters.list()).filter((f) => f.rule.conditions.some((c) => "value" in c && c.value === email));
    await expect.poll(async () => (await filters()).map((f) => [f.rule.conditions, f.rule.actions])).toEqual([[[{ field: "from", op: "equals", value: email }], [{ type: "spam" }]]]);

    await done.getByTestId("snack-action").click();
    await expect.poll(inSpam).toBe(0);
    await expect.poll(async () => (await filters()).length).toBe(0);
  });

  test("the submenu is reachable with the keyboard", async ({ app: page, server }) => {
    const { email, ids, inInbox } = senderSetup(server);
    await selectThread(page, ids[0]!, `in:inbox from:${email}`);
    await focusList(page);
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("thread-menu")).toBeVisible();
    const trigger = page.getByTestId("menu-archive-similar");
    // down the menu to the trigger, then into its submenu
    for (let i = 0; i < 20 && !(await trigger.evaluate((el) => el === document.activeElement || el.hasAttribute("data-highlighted"))); i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("menu-similar-sender")).toBeVisible();
    await expect(page.getByTestId("menu-similar-sender-count")).toHaveText(String(ids.length));
    await page.keyboard.press("Enter");
    await expect.poll(inInbox).toBe(0);
  });
});
