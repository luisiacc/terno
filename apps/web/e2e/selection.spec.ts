/**
 * Plan 06: the thread context menu, multi-selection (⌘A, ⌘/⇧-click, ⇧J/K,
 * Esc), triage keys on a selection, "select all N" acted on by the backend,
 * the bulk bar, and baselines for the menu and the bar.
 */
import type { Locator, Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, menuPath, navTo, focusList, rows, search, selectedRow, selectRows, stabilize, test, searchBox, fresh, scenario } from "./fixtures";
import { E2E_NOW, UNDO_KEYS } from "./constants";
import { sqlDb } from "../../backend-dev/src/server";

// baselines are at twice the pixels; everything else draws at one (plan 139)
test.use({ deviceScaleFactor: 2 });

const ctx = { clientId: "setup", origin: "dev" as const };
const menu = (page: Page) => page.getByTestId("thread-menu");
const item = (page: Page, id: string) => menu(page).getByTestId(id);
const checked = (page: Page) => page.locator("[data-testid=thread-row][data-checked]");
const toast = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const row = (page: Page, id: string | number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
const db = (server: DevServer) => sqlDb(server.backend.store);
const flags = (server: DevServer, id: number | string) => db(server).get<{ in_inbox: number; in_trash: number; in_spam: number; unread_count: number; is_starred: number }>("SELECT in_inbox, in_trash, in_spam, unread_count, is_starred FROM threads WHERE id = ?", Number(id))!;
const idsOf = (l: Locator) => l.evaluateAll((els) => els.map((e) => e.getAttribute("data-thread-id")!));
/** every loaded row's id (the DOM only holds the rows in view) */
/** the list shows that view's rows (the title changes before they arrive) */
const viewLoaded = (page: Page, view: string) => expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", new RegExp(`^\\["${view}"`));
/** how many threads are checked (the DOM holds only the rows in view) */
const checkedCount = (page: Page) => page.evaluate(() => (window as unknown as { __terno: { getApp(): { checked: Set<number> } } }).__terno.getApp().checked.size);
const loadedIds = (page: Page) => page.evaluate(() => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds());
/** submenus render in their own popup, outside the menu's element */
const sub = (page: Page, id: string) => page.getByTestId(id);

/** One message from someone else, to me and whoever's on Cc. */
async function ingestConversation(server: DevServer, subject: string, cc: { name: string; email: string }[]): Promise<number> {
  const account = (await server.backend.store.accounts.list())[0]!;
  const { touched } = await server.backend.store.sync.ingest([{
    accountId: account.id, providerMsgId: subject, providerThreadId: null, rfcMessageId: `${subject.replace(/ /g, "-")}@acme.test`, inReplyTo: null, references: [],
    from: { name: "Bea", email: "bea@acme.test" }, replyTo: [], to: [{ name: "Me", email: account.email }], cc, bcc: [],
    subject, date: E2E_NOW - 60_000, snippet: "Hello", bodyText: "Hello", bodyHtml: null, bodyState: "full", listId: null,
    isRead: true, isStarred: false, inInbox: true, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
  }], { applyFilters: false, now: E2E_NOW, classifier: null });
  return touched[0]!;
}

async function rightClick(page: Page, target: Locator) {
  await target.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
}

test("a batch: every row shows it's in, Delete reads as the menu's, Undo puts the selection back and the keyboard in the list", async ({ app: page }) => {
  const ids = (await idsOf(rows(page))).slice(1, 4);
  const open = selectedRow(page);
  await expect(open.getByTestId("row-check")).toHaveCount(0);
  // the open row is its fill alone: no rail (the owner's call), in any design
  await expect(page.getByTestId("row-rail")).toHaveCount(0);
  // the open row checked alone (x): its check is its mark
  await focusList(page);
  await page.keyboard.press("x");
  await expect(open.getByTestId("row-check")).toBeVisible();
  await page.keyboard.press("x");
  await expect(open.getByTestId("row-check")).toHaveCount(0);
  await selectRows(page, ids);
  await expect(checked(page).getByTestId("row-check")).toHaveCount(3);
  // plan 158: one selection, one look: the first row (the cursor among them) is the rest's fill and ink, its check on the
  // sender's line, in the unread dot's slot
  await page.mouse.move(0, 0);
  const looks = await checked(page).evaluateAll((els) => els.map((el) => {
    const fill = getComputedStyle(el, "::before").backgroundColor;
    const from = el.querySelector("[data-testid=row-from]")!.getBoundingClientRect();
    const check = el.querySelector("[data-testid=row-check]")!.getBoundingClientRect();
    return { fill, ink: getComputedStyle(el).color, off: Math.abs(check.top + check.height / 2 - (from.top + from.height / 2)) };
  }));
  expect(new Set(looks.map((l) => l.fill)).size).toBe(1);
  expect(new Set(looks.map((l) => l.ink)).size).toBe(1);
  for (const l of looks) expect(l.off).toBeLessThanOrEqual(2);
  // plan 158: the marks share one column, inside the fill with air on both sides (never clipped by its rounded edge),
  // and clear of the text: the check where an unread dot sits
  const column = (sel: string) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
  const geometry = await checked(page).first().evaluate((el) => {
    const fill = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el, "::before").left);
    const check = el.querySelector("[data-testid=row-check] path, [data-testid=row-check]")!.closest("svg")!.getBoundingClientRect();
    const text = el.querySelector("[data-testid=row-from]")!.getBoundingClientRect().left;
    const avatar = el.querySelector("[data-slot=avatar], [data-testid=sender-avatar]")?.getBoundingClientRect().left;
    return { fill, left: check.left, right: check.right, centre: check.left + check.width / 2, text: Math.min(text, avatar ?? text), size: check.width };
  });
  expect(geometry.size).toBeGreaterThanOrEqual(12);
  // plan 173: the fill starts 6 px in (the owner's 2 px more off the pane's edge), so the 12 px check's box keeps 1 px
  // either side (its glyph is drawn inset in it); the fill is where it should be
  expect(geometry.fill - (await checked(page).first().evaluate((el) => el.getBoundingClientRect().left))).toBeCloseTo(6, 0);
  expect(geometry.left - geometry.fill).toBeGreaterThanOrEqual(1);
  expect(geometry.text - geometry.right).toBeGreaterThanOrEqual(1);
  expect(Math.abs((await column("[data-testid=row-unread-dot]")) - geometry.centre)).toBeLessThanOrEqual(1);
  // j among them: the cursor gets a mark of its own, only by keys, and only while there's a selection
  const list = page.getByTestId("thread-list");
  await expect(list).not.toHaveAttribute("data-keyed");
  await focusList(page);
  await page.keyboard.press("j");
  await expect(list).toHaveAttribute("data-keyed");
  await page.keyboard.press("k");
  await expect(page.getByTestId("selection-count")).toHaveText("3 conversations selected");
  await expect(page.getByTestId("bar-spam")).toHaveAccessibleName("Mark as spam");
  // plan 158: Remind me is here too, as in the row menu; and what's selected is listed, to check before acting
  await expect(page.getByTestId("bar-remind")).toHaveAccessibleName("Remind me");
  await expect(page.getByTestId("selection-rows").locator("li")).toHaveCount(3);
  // the same red as the menu's Delete
  const red = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
  const barRed = await red(page.getByTestId("bar-trash"));
  await rightClick(page, row(page, ids[0]!));
  expect(await red(item(page, "menu-trash"))).toBe(barRed);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();

  // from the pane's button, then the snack's: the button that had focus is gone, focus isn't lost
  await page.getByTestId("bar-archive").click();
  await expect(checked(page)).toHaveCount(0);
  await expect(toast(page, "Archived · 3 conversations").getByTestId("snack-action")).toHaveAttribute("aria-keyshortcuts", UNDO_KEYS);
  await page.getByTestId("snack-action").click();
  await expect(checked(page)).toHaveCount(3);
  expect(await idsOf(checked(page))).toEqual(ids);
  await expect(page.locator("[role=listbox]")).toBeFocused();

  // and with the keys: e, z, e again resumes the same cleanup
  await page.keyboard.press("e");
  await expect(checked(page)).toHaveCount(0);
  await expect(toast(page, "Archived · 3 conversations").getByTestId("snack-action")).toBeVisible();
  await page.keyboard.press("z");
  await expect(checked(page)).toHaveCount(3);
  await page.keyboard.press("e");
  await expect(row(page, ids[0]!)).toHaveCount(0);
  await page.keyboard.press("z");
  await expect(checked(page)).toHaveCount(3);

  // a range survives too: where it grew from comes back, so the next ⇧K shrinks it
  await rows(page).nth(6).click();
  await expect(checked(page)).toHaveCount(0);
  await focusList(page);
  await page.keyboard.press("Shift+J");
  await page.keyboard.press("Shift+J");
  await expect(checked(page)).toHaveCount(3);
  await page.keyboard.press("e");
  await expect(checked(page)).toHaveCount(0);
  await expect(toast(page, "Archived · 3 conversations").getByTestId("snack-action")).toBeVisible();
  await page.keyboard.press("z");
  await expect(checked(page)).toHaveCount(3);
  await page.keyboard.press("Shift+K");
  await expect(checked(page)).toHaveCount(2);
});

test.describe("context menu on one thread", () => {
  test("one thread's menu: what it acts on, Trash and Spam, ⇧F10, categories and the picker", async ({ app: page, server }) => {
    await scenario("acts on the row it opened on: read state, star, archive with undo", async () => {
      const unread = page.locator("[data-testid=thread-row][data-unread]").nth(1);
      const id = (await unread.getAttribute("data-thread-id"))!;
      await rightClick(page, unread);
      // one thread: reply, reply all and forward lead; the read state it doesn't have isn't offered
      await expect(item(page, "menu-reply")).toBeVisible();
      await expect(item(page, "menu-unread")).toHaveCount(0);
      await expect(item(page, "menu-read")).toContainText("⇧I");
      // the row's inset selection shape is outlined while the menu is up; the selection didn't move to it
      expect(await row(page, id).evaluate((e) => getComputedStyle(e, "::before").boxShadow)).not.toBe("none");
      // plan 158: the open row stays open (its fill: the reader still shows it); the menu's row is outlined, not filled
      const opened = page.locator("[data-testid=thread-row][data-opened]");
      expect(await opened.evaluate((e) => getComputedStyle(e, "::before").backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await row(page, id).evaluate((e) => getComputedStyle(e, "::before").backgroundColor)).not.toBe(await opened.evaluate((e) => getComputedStyle(e, "::before").backgroundColor));
      await expect(row(page, id)).not.toHaveAttribute("aria-selected", "true");
      await item(page, "menu-read").click();
      await expect(menu(page)).toBeHidden();
      await expect(row(page, id)).not.toHaveAttribute("data-unread");
      await expect.poll(() => flags(server, id).unread_count).toBe(0);
      expect(await row(page, id).evaluate((e) => getComputedStyle(e, "::before").boxShadow)).toBe("none");

      await rightClick(page, row(page, id));
      await item(page, "menu-star").click();
      await expect(row(page, id).locator("svg.fill-star")).toBeVisible();
      await expect.poll(() => flags(server, id).is_starred).toBe(1);

      await rightClick(page, row(page, id));
      await item(page, "menu-archive").click();
      await expect(row(page, id)).toHaveCount(0);
      await expect.poll(() => flags(server, id).in_inbox).toBe(0);
      await toast(page, "Archived").getByTestId("snack-action").click();
      await expect(row(page, id)).toHaveCount(1);
    });
    await scenario("delete and spam from the menu; z undoes the last one", async () => {
      await fresh(page);
      const [a, b] = (await idsOf(rows(page))).slice(2, 4);
      await rightClick(page, row(page, a!));
      await item(page, "menu-trash").click();
      await expect(row(page, a!)).toHaveCount(0);
      await expect.poll(() => flags(server, a!).in_trash).toBe(1);
      await rightClick(page, row(page, b!));
      await menuPath(page, "menu-more");
      await sub(page, "menu-spam").click();
      await expect(row(page, b!)).toHaveCount(0);
      await expect.poll(() => flags(server, b!).in_spam).toBe(1);
      // z is the undo of what the snack offers: the row goes at once, but the snack (and z with it) waits for the backend's answer
      await expect(toast(page, "Spam").getByTestId("snack-action")).toHaveAttribute("aria-keyshortcuts", UNDO_KEYS);
      await focusList(page);
      await page.keyboard.press("z");
      await expect(row(page, b!)).toHaveCount(1);
      await expect.poll(() => flags(server, b!).in_spam).toBe(0);
    });
    await scenario("sender items: search their mail, copy the address, a filter prefilled with them", async () => {
      await fresh(page);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const target = rows(page).nth(1);
      const id = (await target.getAttribute("data-thread-id"))!;
      await rightClick(page, target);
      await menuPath(page, "menu-more");
      // what's about the sender stands under their name: a label, not a level of its own; a row with several answers opens them beside it
      await expect(sub(page, "menu-sender")).toHaveText(/^From /);
      await expect(sub(page, "menu-sender")).not.toHaveAttribute("data-slot", "context-menu-sub-trigger");
      await expect(sub(page, "menu-sender-file")).toHaveAttribute("data-slot", "context-menu-sub-trigger");
      await expect(sub(page, "menu-sender-file")).toContainText("File all their mail");
      await sub(page, "menu-copy").click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toMatch(/@/);
      await rightClick(page, row(page, id));
      await menuPath(page, "menu-more");
      await sub(page, "menu-search-sender").click();
      await expect(page.getByTestId("search-input")).toHaveValue(`from:${copied}`);
      await expect(page.getByTestId("list-title")).toHaveText("Search");
      await rightClick(page, rows(page).first());
      await menuPath(page, "menu-more");
      await sub(page, "menu-filter").click();
      await expect(page.getByTestId("filters-dialog")).toBeVisible();
      await expect(page.getByTestId("condition-value").first()).toHaveValue(copied);
    });
    await scenario("the top level stays short, reply then triage, and fits a small window beside the pointer", async () => {
      await fresh(page);
      await page.setViewportSize({ width: 1100, height: 700 });
      const low = rows(page).nth(3);
      const at = (await low.boundingBox())!;
      await rightClick(page, low);
      const own = () => menu(page).locator("> [role=menuitem]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid!));
      const top = await own();
      expect(top.length).toBeLessThanOrEqual(11);
      expect(top[0]).toBe("menu-reply");
      expect(top.indexOf("menu-forward")).toBeLessThan(top.indexOf("menu-archive"));
      expect(top.slice(top.indexOf("menu-archive"), top.indexOf("menu-archive") + 2)).toEqual(["menu-archive", "menu-trash"]);
      expect(top.slice(-4)).toEqual(["menu-remind-always", "menu-move", "menu-categories", "menu-more"]);
      for (const moved of ["menu-print", "menu-copy-text", "menu-spam", "menu-select-all", "menu-copy", "menu-filter", "menu-trash-similar"]) expect(top).not.toContain(moved);
      // a row that isn't the open one says itself, on screen and to a screen reader
      const target = menu(page).getByTestId("menu-target");
      const [sender, subject] = await target.locator("p").allTextContents();
      await expect(menu(page)).toHaveAttribute("aria-label", `${sender}: ${subject}`);
      // no scrolling, and its first rows stay by the pointer (shifted to fit, never flipped a panel away)
      await menu(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      const box = (await menu(page).boundingBox())!;
      expect(await menu(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
      expect(box.y).toBeLessThanOrEqual(at.y + at.height);
      // (Reply all comes once the conversation's read; the panel shifts to fit it)
      await expect.poll(async () => { const b = (await menu(page).boundingBox())!; return b.y + b.height; }).toBeLessThanOrEqual(700);
      expect(at.y + at.height / 2 - box.y).toBeLessThan(box.height);
      // shortcuts in one column, chevrons in another
      const ends = (id: string) => item(page, id).locator("[data-slot=context-menu-shortcut]").evaluate((el) => el.getBoundingClientRect().right);
      expect(await ends("menu-remind-always")).toBeCloseTo(await ends("menu-archive"), 0);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1280, height: 800 });
    });
    await scenario("Reply all is offered only where it reaches more than one other person, and from there it opens", async () => {
      const one = await ingestConversation(server, "Pepino for one", []);
      const many = await ingestConversation(server, "Pepino for many", [{ name: "Ana", email: "ana@acme.test" }]);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await search(page, "Pepino for");
      await rightClick(page, row(page, one));
      await expect(item(page, "menu-reply")).toBeVisible();
      await expect(item(page, "menu-reply-all")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await rightClick(page, row(page, many));
      await item(page, "menu-reply-all").click();
      await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.press("Escape");
      // the palette offers it in the same place, beside Reply (plan 158: it was under the fold, after Spam)
      await page.keyboard.press("ControlOrMeta+k");
      const order = await page.locator("[data-group=conversation] [data-command]").evaluateAll((els) => els.map((e) => e.getAttribute("data-command")));
      expect(order.slice(order.indexOf("compose.reply"), order.indexOf("compose.reply") + 2)).toEqual(["compose.reply", "compose.replyAll"]);
      await page.keyboard.press("Escape");
    });
    await scenario("Trash and Spam: what can't apply there isn't offered, the way back leads", async () => {
      await fresh(page);
      await navTo(page, "trash");
      await expect(page.getByTestId("list-title")).toHaveText("Trash");
      await viewLoaded(page, "trash");
      await rightClick(page, rows(page).first());
      await expect(item(page, "menu-trash")).toHaveCount(0);
      await expect(item(page, "menu-archive")).toHaveCount(0);
      await expect(item(page, "menu-inbox")).toHaveText(/Restore to Inbox/);
      await menuPath(page, "menu-more");
      await expect(sub(page, "menu-spam")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();

      await navTo(page, "spam");
      await expect(page.getByTestId("list-title")).toHaveText("Spam");
      await viewLoaded(page, "spam");
      await rightClick(page, rows(page).first());
      await expect(item(page, "menu-not-spam")).toBeVisible();
      await expect(item(page, "menu-trash")).toBeVisible();
      await menuPath(page, "menu-more");
      await expect(sub(page, "menu-spam")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      const id = (await rows(page).first().getAttribute("data-thread-id"))!;
      await rightClick(page, row(page, id));
      await item(page, "menu-not-spam").click();
      await expect(row(page, id)).toHaveCount(0);
    });
    await scenario("opens from the keyboard (⇧F10) and its items run with the arrows and Enter", async () => {
      await fresh(page);
      const id = (await selectedRow(page).getAttribute("data-thread-id"))!;
      await focusList(page);
      await page.keyboard.press("Shift+F10");
      await expect(menu(page)).toBeVisible();
      // global shortcuts wait while the menu is open: "e" doesn't archive
      await page.keyboard.press("e");
      await expect(row(page, id)).toHaveCount(1);
      // ("e" went to the menu's typeahead: the highlight may start anywhere)
      for (let i = 0; i < 24; i++) {
        await page.keyboard.press("ArrowDown");
        // read without waiting: between two keys there may be no highlighted item yet
        await page.waitForTimeout(30);
        const now = await page.evaluate(() => document.querySelector("[data-testid=thread-menu] [data-highlighted]")?.textContent ?? "");
        if (now.startsWith("Archive")) break;
      }
      await expect(menu(page).locator("[data-highlighted]")).toContainText("Archive");
      await page.keyboard.press("Enter");
      await expect(row(page, id)).toHaveCount(0);
      await expect.poll(() => flags(server, id).in_inbox).toBe(0);
    });
    await scenario("its category toggles can file a thread in two categories; Move to… leaves it in one", async () => {
      await fresh(page);
      const [lecturas, clientes, viajes] = ["Lecturas", "Clientes", "Viajes"].map((n) => db(server).get<{ id: number }>("SELECT id FROM categories WHERE name = ?", n)!.id) as [number, number, number];
      const target = page.locator("[data-testid=thread-row]:not(:has([data-cat-dot]))").first();
      const id = Number(await target.getAttribute("data-thread-id"));
      const cats = () => db(server).all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY category_id", id).map((r) => r.category_id);
      for (const cat of [lecturas, clientes]) {
        await rightClick(page, row(page, id));
        await item(page, "menu-categories").hover();
        await sub(page, `menu-category-${cat}`).click();
        await expect(page.getByTestId("category-snackbar")).toBeVisible();
      }
      await expect.poll(cats).toEqual([lecturas, clientes].sort((a, b) => a - b));
      await expect(row(page, id).locator("[data-cat-dot]")).toHaveCount(2);
      // the checkmarks show where it is; unchecking removes
      await rightClick(page, row(page, id));
      await item(page, "menu-categories").hover();
      await expect(sub(page, `menu-category-${lecturas}`)).toHaveAttribute("data-checked", "");
      await expect(sub(page, `menu-category-${viajes}`)).toHaveAttribute("data-unchecked", "");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await rightClick(page, row(page, id));
      await item(page, "menu-move").hover();
      await sub(page, `menu-move-${viajes}`).click();
      await expect(page.getByTestId("snackbar-title")).toHaveText("Moved to Viajes");
      await expect.poll(cats).toEqual([viajes]);
    });
    await scenario("after v (Move to…) is dismissed, the reader's Category button toggles again: picking C keeps A and B", async () => {
      await fresh(page);
      const [lecturas, clientes, viajes] = ["Lecturas", "Clientes", "Viajes"].map((n) => db(server).get<{ id: number }>("SELECT id FROM categories WHERE name = ?", n)!.id) as [number, number, number];
      const id = Number(await page.locator("[data-testid=thread-row]:not(:has([data-cat-dot]))").first().getAttribute("data-thread-id"));
      for (const cat of [lecturas, clientes]) await server.backend.server.invoke("categories.addThreads", { categoryId: cat, threadIds: [id], source: "picker" }, ctx);
      await row(page, id).dispatchEvent("mousedown", { button: 0 });
      await expect(row(page, id).locator("[data-cat-dot]")).toHaveCount(2);
      await focusList(page);
      await page.keyboard.press("v");
      await expect(page.getByTestId("category-picker")).toHaveAttribute("data-mode", "move");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("category-picker")).toBeHidden();
      await page.getByTestId("action-category").click();
      await expect(page.getByTestId("category-picker")).toHaveAttribute("data-mode", "toggle");
      await page.getByTestId(`pick-category-${viajes}`).click();
      await expect(page.getByTestId("snackbar-title")).toHaveText("Added to Viajes");
      const cats = () => db(server).all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ? ORDER BY category_id", id).map((r) => r.category_id);
      await expect.poll(cats).toEqual([lecturas, clientes, viajes].sort((a, b) => a - b));
    });
  });

  test("reply from the menu, and where focus goes when it closes", async ({ app: page }) => {
    await scenario("reply from the menu opens the composer on that thread", async () => {
      const target = rows(page).nth(4);
      const subject = (await target.getByTestId("row-subject").textContent())!.trim();
      await rightClick(page, target);
      await item(page, "menu-reply").click();
      // inline, in that thread's conversation, focused
      await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
      await expect(page.getByTestId("reader-subject")).toHaveText(subject.replace(/^Re:\s*/, ""));
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.getByTestId("compose-show-subject").click();
      await expect(page.getByTestId("compose-subject")).toHaveValue(subject.startsWith("Re:") ? subject : `Re: ${subject}`);
    });
    await scenario("reply and forward from the menu: the closing menu never hands focus back to the list, so they always open", async () => {
      await fresh(page);
      // the hand-back landed while the reply was still opening and made it give up: nothing opened, often
      for (const [n, action, field] of [[3, "menu-reply", "compose-body"], [6, "menu-forward", "compose-to"]] as const) {
        await rightClick(page, rows(page).nth(n));
        // from the menu on (the right-click itself focuses the list)
        await page.evaluate(() => {
          const w = window as unknown as { __listFocus: number; __listWatch?: boolean };
          w.__listFocus = 0;
          if (!w.__listWatch) document.addEventListener("focusin", (e) => { if ((e.target as Element).getAttribute?.("role") === "listbox") w.__listFocus++; }, true);
          w.__listWatch = true;
        });
        await item(page, action).click();
        await expect(page.getByTestId("reader").getByTestId("composer")).toBeVisible();
        await expect(page.getByTestId(field)).toBeFocused();
        expect(await page.evaluate(() => (window as unknown as { __listFocus: number }).__listFocus), action).toBe(0);
        await page.keyboard.press("Escape");
      }
    });
    await scenario("an ordinary menu close still returns focus to the list, after a reply's hand-off too", async () => {
      await fresh(page);
      const list = page.getByRole("listbox", { name: "Conversations", exact: true });
      await rightClick(page, rows(page).nth(2));
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(list).toBeFocused();
      // a reply first (its hand-off is spent on that close), then a plain close: back to the list again
      await rightClick(page, rows(page).nth(3));
      await item(page, "menu-reply").click();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await rightClick(page, rows(page).nth(4));
      await page.keyboard.press("Escape");
      await expect(menu(page)).toBeHidden();
      await expect(list).toBeFocused();
    });
  });

});


test.describe("multi-selection", () => {
  test("multi-selection: the keys, the bar, the listbox and the shortcuts list", async ({ app: page, server }) => {
    await scenario("⇧-click selects a range, ⌘-click toggles, Esc clears; the reader becomes the bulk bar", async () => {
      const ids = await idsOf(rows(page));
      await row(page, ids[1]!).dispatchEvent("mousedown", { button: 0 });
      await row(page, ids[5]!).click({ modifiers: ["Shift"] });
      await expect(checked(page)).toHaveCount(5);
      expect(await idsOf(checked(page))).toEqual(ids.slice(1, 6));
      await expect(page.getByTestId("selection-bar")).toContainText("5 conversations selected");
      await row(page, ids[3]!).click({ modifiers: ["ControlOrMeta"] });
      await expect(checked(page)).toHaveCount(4);
      await focusList(page);
      await page.keyboard.press("Escape");
      await expect(checked(page)).toHaveCount(0);
      await expect(page.getByTestId("reader")).toBeVisible();
    });
    await scenario("⇧J extends and ⇧K shrinks from the anchor", async () => {
      await fresh(page);
      const ids = await idsOf(rows(page));
      await focusList(page);
      for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+J");
      expect(await idsOf(checked(page))).toEqual(ids.slice(0, 4));
      await page.keyboard.press("Shift+K");
      expect(await idsOf(checked(page))).toEqual(ids.slice(0, 3));
      await page.keyboard.press("Shift+ArrowDown");
      expect(await idsOf(checked(page))).toEqual(ids.slice(0, 4));
    });
    await scenario("right-clicking a row outside the selection acts on that row only and keeps the selection", async () => {
      await fresh(page);
      const ids = await idsOf(rows(page));
      await selectRows(page, ids.slice(0, 3));
      const other = page.locator("[data-testid=thread-row][data-unread]:not([data-checked])").first();
      const otherId = (await other.getAttribute("data-thread-id"))!;
      await rightClick(page, other);
      await expect(item(page, "menu-count")).toHaveCount(0);
      await item(page, "menu-read").click();
      await expect.poll(() => flags(server, otherId).unread_count).toBe(0);
      await expect(checked(page)).toHaveCount(3);
    });
    await scenario("the read-after-dwell of a thread just opened never clears a selection made right after", async () => {
      await fresh(page);
      const unread = page.locator("[data-testid=thread-row][data-unread]").first();
      const id = (await unread.getAttribute("data-thread-id"))!;
      await unread.dispatchEvent("mousedown", { button: 0 });
      await focusList(page);
      await page.keyboard.press("ControlOrMeta+a");
      await expect(page.getByTestId("selection-bar")).toBeVisible();
      const n = (await loadedIds(page)).length;
      expect(await checkedCount(page)).toBe(n);
      // past the 450 ms dwell: the selection stands, and the reader that went away didn't mark the thread read
      await page.waitForTimeout(900);
      await expect(page.getByTestId("selection-bar")).toBeVisible();
      expect(await checkedCount(page)).toBe(n);
      expect(flags(server, id).unread_count).toBeGreaterThan(0);
    });
    await scenario("⇧F10 with a selection opens the menu on the selection even when the open thread isn't part of it", async () => {
      await fresh(page);
      const ids = await idsOf(rows(page));
      // the open thread is ids[0]; check 1 and 2, then uncheck 0: the cursor sits on an unchecked row
      await selectRows(page, ids.slice(0, 3));
      await row(page, ids[0]!).click({ modifiers: ["ControlOrMeta"] });
      await expect(checked(page)).toHaveCount(2);
      await focusList(page);
      await page.keyboard.press("Shift+F10");
      await expect(menu(page)).toBeVisible();
      await expect(item(page, "menu-count")).toHaveText("2 conversations");
    });
    await scenario("⌫ trashes the selection", async () => {
      await fresh(page);
      const ids = (await idsOf(rows(page))).slice(2, 5);
      await selectRows(page, ids);
      await page.keyboard.press("Backspace");
      for (const id of ids) await expect(row(page, id)).toHaveCount(0);
      await expect.poll(() => ids.every((id) => flags(server, id).in_trash === 1)).toBe(true);
      await expect(toast(page, "3 conversations")).toBeVisible();
    });
    await scenario("⌘A inside the search box selects its text, not the rows", async () => {
      await fresh(page);
      const input = await searchBox(page);
      await input.fill("factura");
      await input.press("ControlOrMeta+a");
      expect(await input.evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd])).toEqual([0, 7]);
      await expect(checked(page)).toHaveCount(0);
      await input.press("Backspace");
      await expect(input).toHaveValue("");
    });
    await scenario("the listbox is multi-selectable: aria-selected follows the real selection, the open thread is the active descendant", async () => {
      await fresh(page);
      const list = page.getByRole("listbox", { name: "Conversations" });
      const selectedOptions = page.locator("[role=option][aria-selected=true]");
      await expect(list).toHaveAttribute("aria-multiselectable", "true");
      // nothing checked: the open thread is the selection
      await expect(selectedOptions).toHaveCount(1);
      const cursor = page.locator("[data-testid=thread-row][data-cursor]");
      await expect(list).toHaveAttribute("aria-activedescendant", (await cursor.getAttribute("id"))!);
      await expect(selectedOptions.first()).toHaveAttribute("data-cursor", "true");
      // ⌘A: every option is selected
      await focusList(page);
      await page.keyboard.press("ControlOrMeta+a");
      await expect(page.getByTestId("selection-bar")).toBeVisible();
      await expect(page.locator("[role=option][aria-selected=false]")).toHaveCount(0);
      expect(await selectedOptions.count()).toBeGreaterThan(10);
      await page.keyboard.press("Escape");
      await expect(selectedOptions).toHaveCount(1);
      // ⌘-click: exactly the checked rows; the open thread can be outside them and stays the active descendant
      const ids = await idsOf(rows(page));
      await selectRows(page, ids.slice(0, 3));
      await row(page, ids[0]!).click({ modifiers: ["ControlOrMeta"] });
      expect(await idsOf(selectedOptions)).toEqual(ids.slice(1, 3));
      await expect(list).toHaveAttribute("aria-activedescendant", `thread-${ids[0]}`);
      await expect(row(page, ids[0]!)).toHaveAttribute("aria-selected", "false");
      // j moves the active descendant without a multi-selection
      await page.keyboard.press("Escape");
      await page.keyboard.press("j");
      await expect(list).toHaveAttribute("aria-activedescendant", `thread-${ids[1]}`);
      await expect(selectedOptions).toHaveCount(1);
    });
    await scenario("the shortcuts dialog lists the new keys", async () => {
      await fresh(page);
      await focusList(page);
      await page.keyboard.press("?");
      const dialog = page.getByTestId("shortcuts-dialog");
      await expect(dialog).toBeVisible();
      for (const c of ["list.selectAll", "list.extendNext", "thread.markRead", "thread.toggleRead", "thread.move", "action.undo", "list.menu"]) await expect(dialog.getByTestId(`shortcut-${c}`)).toBeVisible();
      await expect(dialog.getByTestId("shortcut-thread.trash")).toContainText("⌫");
      await expect(dialog.getByTestId("shortcut-thread.trash")).toContainText("⌦");
    });
  });

  test("selections of many: ⌘A, select all N, a mixed read, undo is exact, no drag", async ({ app: page, server }) => {
    await scenario("⌘A selects the loaded rows; right-click → read, archive and delete apply to all, with undo", async () => {
      await (await searchBox(page)).fill("in:inbox factura");
      await expect(page.getByTestId("search-stats")).toBeVisible();
      await focusList(page);
      const ids = await loadedIds(page);
      expect(ids.length).toBeGreaterThan(30);
      await page.keyboard.press("ControlOrMeta+a");
      await expect(page.getByTestId("selection-bar")).toContainText(`${ids.length} conversations selected`);

      await rightClick(page, rows(page).nth(1));
      await expect(item(page, "menu-count")).toHaveText(`${ids.length} conversations`);
      await expect(item(page, "menu-reply")).toHaveCount(0);
      await item(page, "menu-read").click();
      await expect.poll(() => ids.every((id) => flags(server, id).unread_count === 0)).toBe(true);
      await expect(page.locator("[data-testid=thread-row][data-unread]")).toHaveCount(0);

      await page.keyboard.press("ControlOrMeta+a");
      await rightClick(page, rows(page).first());
      await item(page, "menu-archive").click();
      await expect.poll(() => ids.every((id) => flags(server, id).in_inbox === 0)).toBe(true);
      // the search is in:inbox: none of them is listed any more
      await expect.poll(async () => (await loadedIds(page)).filter((id) => ids.includes(id)).length).toBe(0);
      await toast(page, `Archived · ${ids.length} conversations`).getByTestId("snack-action").click();
      await expect.poll(() => ids.every((id) => flags(server, id).in_inbox === 1)).toBe(true);
      await expect.poll(async () => (await loadedIds(page)).filter((id) => ids.includes(id)).length).toBe(ids.length);

      await focusList(page);
      await page.keyboard.press("ControlOrMeta+a");
      const again = await loadedIds(page);
      await rightClick(page, rows(page).first());
      await item(page, "menu-trash").click();
      await expect.poll(() => again.every((id) => flags(server, id).in_trash === 1)).toBe(true);
    });
    await scenario("marking a mixed selection read, then z: the ones that were read stay read", async () => {
      await fresh(page);
      const ids = (await idsOf(rows(page))).slice(0, 8);
      const unreadBefore = ids.filter((id) => flags(server, id).unread_count > 0);
      expect(unreadBefore.length).toBeGreaterThan(0);
      expect(unreadBefore.length).toBeLessThan(ids.length);
      await selectRows(page, ids);
      await page.keyboard.press("Shift+I");
      await expect.poll(() => ids.every((id) => flags(server, id).unread_count === 0)).toBe(true);
      await page.keyboard.press("z");
      await expect.poll(() => ids.filter((id) => flags(server, id).unread_count > 0)).toEqual(unreadBefore);
    });
    await scenario("with all N of a view selected, rows don't drag (only part of them would move)", async () => {
      await fresh(page);
      const viajes = db(server).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
      await focusList(page);
      await page.keyboard.press("ControlOrMeta+a");
      await expect(page.getByTestId("select-all-scope-button")).toHaveText(/Select all/);
      await page.getByTestId("select-all-scope-button").click();
      await expect(page.getByTestId("select-all-scope")).toBeVisible();
      const before = db(server).get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", viajes)!.c;
      const from = (await rows(page).nth(2).boundingBox())!;
      const to = (await page.getByTestId(`nav-category-${viajes}`).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 2, { steps: 2 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await expect(page.getByTestId("drag-ghost")).toBeHidden();
      await page.mouse.up();
      await page.waitForTimeout(300);
      await expect(page.getByTestId("category-snackbar")).toHaveCount(0);
      expect(db(server).get<{ c: number }>("SELECT count(*) AS c FROM thread_categories WHERE category_id = ?", viajes)!.c).toBe(before);
    });
    await scenario("select all N of the view: the banner, a backend archive with progress, and its undo", async () => {
      await fresh(page);
      // plan 86: what the Inbox shows (Gmail's Promotions and Social live apart)
      const inboxCount = () => db(server).get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_inbox = 1 AND tab = 0")!.c;
      const total = inboxCount();
      const signalsBefore = db(server).get<{ c: number }>("SELECT count(*) AS c FROM user_actions")!.c;
      expect(total).toBeGreaterThan(100); // more than the first page: the banner has something to offer
      await focusList(page);
      await page.keyboard.press("ControlOrMeta+a");
      const banner = page.getByTestId("select-all-banner");
      await expect(banner).toContainText("100 loaded conversations");
      await expect(page.getByTestId("select-all-scope-button")).toHaveText(`Select all ${total.toLocaleString("en-US")} conversations in “Inbox”`);
      await page.getByTestId("select-all-scope-button").click();
      await expect(page.getByTestId("select-all-scope")).toContainText(`All ${total.toLocaleString("en-US")} conversations in Inbox`);
      await expect(page.getByTestId("selection-bar")).toContainText(`All ${total.toLocaleString("en-US")} conversations in Inbox`);
      // the progress toast shows while the backend works through the slices
      await page.evaluate(() => {
        const w = window as unknown as { __progress: string[] };
        w.__progress = [];
        new MutationObserver(() => {
          for (const t of document.querySelectorAll("[data-testid=snack]")) if (t.textContent?.includes("Archiving")) w.__progress.push(t.textContent);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await focusList(page);
      await page.keyboard.press("e");
      await expect(toast(page, `Archived · ${total.toLocaleString("en-US")} conversations`)).toBeVisible();
      expect((await page.evaluate(() => (window as unknown as { __progress: string[] }).__progress)).some((t) => t.includes(`Archiving ${total.toLocaleString("en-US")} conversations`))).toBe(true);
      expect(inboxCount()).toBe(0);
      await expect(page.getByTestId("list-empty")).toBeVisible();
      // no learned-filter signal from a sweep
      expect(db(server).get<{ c: number }>("SELECT count(*) AS c FROM user_actions")!.c).toBe(signalsBefore);
      await toast(page, "Archived").getByTestId("snack-action").click();
      await expect(toast(page, /Restored/)).toBeVisible();
      await expect.poll(inboxCount).toBe(total);
      await expect(rows(page).first()).toBeVisible();
    });
    await scenario("all of Archive to Trash, then Undo: they're back in Archive, none in Inbox", async () => {
      await fresh(page);
      const count = (where: string) => db(server).get<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE ${where}`)!.c;
      const archived = count("in_inbox = 0 AND in_trash = 0 AND in_spam = 0");
      const inbox = count("in_inbox = 1");
      await navTo(page, "archive");
      await expect(page.getByTestId("list-title")).toHaveText("Archive");
      await viewLoaded(page, "archive");
      await focusList(page);
      await page.keyboard.press("ControlOrMeta+a");
      await page.getByTestId("select-all-scope-button").click();
      await expect(page.getByTestId("select-all-scope")).toBeVisible();
      await page.keyboard.press("Backspace");
      await expect.poll(() => count("in_inbox = 0 AND in_trash = 0 AND in_spam = 0")).toBe(0);
      await toast(page, "Moved to Trash").getByTestId("snack-action").click();
      await expect.poll(() => count("in_inbox = 0 AND in_trash = 0 AND in_spam = 0")).toBe(archived);
      expect(count("in_inbox = 1")).toBe(inbox);
      await expect(rows(page).first()).toBeVisible();
    });
  });

});





test.describe("visual: context menu and bulk bar", () => {
  test.use({ deviceScaleFactor: 1 });
  for (const theme of ["terno-light", "dracula"] as const) {
    test(`the menu on one thread in ${theme}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", theme === "dracula" ? { theme: "dark", darkTheme: "dracula" } : { theme: "light" }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
      const b = (await rows(page).nth(2).boundingBox())!;
      await page.mouse.click(b.x + 120, b.y + b.height / 2, { button: "right" });
      await expect(menu(page)).toBeVisible();
      await item(page, "menu-categories").hover();
      await expect(sub(page, "menu-categories-list")).toBeVisible();
      await expect(page).toHaveScreenshot(`thread-menu-${theme}.png`);
    });
  }

  test("the bulk bar for a selection", async ({ app: page }) => {
    await page.evaluate(() => document.fonts.ready);
    await stabilize(page);
    const ids = await idsOf(rows(page));
    await selectRows(page, ids.slice(0, 4));
    await expect(page.getByTestId("selection-bar")).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot("selection-bar.png");
  });
});
