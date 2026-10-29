/**
 * Plan 06: the thread context menu, multi-selection (⌘A, ⌘/⇧-click, ⇧J/K,
 * Esc), triage keys on a selection, "select all N" acted on by the backend,
 * the bulk bar, and baselines for the menu and the bar.
 */
import type { Locator, Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { expect, navTo, focusList, rows, selectedRow, selectRows, stabilize, test, searchBox } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";

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

async function rightClick(page: Page, target: Locator) {
  await target.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
}

test.describe("context menu on one thread", { tag: "@design" }, () => {
  test("acts on the row it opened on: read state, star, archive with undo", async ({ app: page, server }) => {
    const unread = page.locator("[data-testid=thread-row][data-unread]").nth(1);
    const id = (await unread.getAttribute("data-thread-id"))!;
    await rightClick(page, unread);
    // one thread: reply, reply all and forward lead; the read state it doesn't have isn't offered
    await expect(item(page, "menu-reply")).toBeVisible();
    await expect(item(page, "menu-unread")).toHaveCount(0);
    await expect(item(page, "menu-read")).toContainText("⇧I");
    // the row's inset selection shape is outlined while the menu is up; the selection didn't move to it
    expect(await row(page, id).evaluate((e) => getComputedStyle(e, "::before").boxShadow)).not.toBe("none");
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

  test("delete and spam from the menu; z undoes the last one", async ({ app: page, server }) => {
    const [a, b] = (await idsOf(rows(page))).slice(2, 4);
    await rightClick(page, row(page, a!));
    await item(page, "menu-trash").click();
    await expect(row(page, a!)).toHaveCount(0);
    await expect.poll(() => flags(server, a!).in_trash).toBe(1);
    await rightClick(page, row(page, b!));
    await item(page, "menu-spam").click();
    await expect(row(page, b!)).toHaveCount(0);
    await expect.poll(() => flags(server, b!).in_spam).toBe(1);
    await focusList(page);
    await page.keyboard.press("z");
    await expect(row(page, b!)).toHaveCount(1);
    await expect.poll(() => flags(server, b!).in_spam).toBe(0);
  });

  test("reply from the menu opens the composer on that thread", async ({ app: page }) => {
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

  test("reply, reply all and forward from the menu: the closing menu never hands focus back to the list, so they always open", async ({ app: page }) => {
    // the hand-back landed while the reply was still opening and made it give up: nothing opened, often
    for (const [n, action, field] of [[3, "menu-reply", "compose-body"], [5, "menu-reply-all", "compose-body"], [6, "menu-forward", "compose-to"]] as const) {
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

  test("an ordinary menu close still returns focus to the list, after a reply's hand-off too", async ({ app: page }) => {
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

  test("sender items: search their mail, copy the address, a filter prefilled with them", async ({ app: page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const target = rows(page).nth(1);
    const id = (await target.getAttribute("data-thread-id"))!;
    await rightClick(page, target);
    await expect(item(page, "menu-sender-file")).toContainText("Everything from");
    await item(page, "menu-copy").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/@/);
    await rightClick(page, row(page, id));
    await item(page, "menu-search-sender").click();
    await expect(page.getByTestId("search-input")).toHaveValue(`from:${copied}`);
    await expect(page.getByTestId("list-title")).toHaveText("Search");
    await rightClick(page, rows(page).first());
    await item(page, "menu-filter").click();
    await expect(page.getByTestId("filters-dialog")).toBeVisible();
    await expect(page.getByTestId("condition-value").first()).toHaveValue(copied);
  });

  test("Trash and Spam: what can't apply there is disabled, the way back is offered", async ({ app: page }) => {
    await navTo(page, "trash");
    await expect(page.getByTestId("list-title")).toHaveText("Trash");
    await viewLoaded(page, "trash");
    await rightClick(page, rows(page).first());
    await expect(item(page, "menu-trash")).toHaveAttribute("data-disabled", "");
    await expect(item(page, "menu-archive")).toHaveAttribute("data-disabled", "");
    await expect(item(page, "menu-inbox")).toHaveText(/Restore to Inbox/);
    await expect(item(page, "menu-spam")).not.toHaveAttribute("data-disabled");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();

    await navTo(page, "spam");
    await expect(page.getByTestId("list-title")).toHaveText("Spam");
    await viewLoaded(page, "spam");
    await rightClick(page, rows(page).first());
    await expect(item(page, "menu-spam")).toHaveAttribute("data-disabled", "");
    await expect(item(page, "menu-not-spam")).toBeVisible();
    await expect(item(page, "menu-trash")).not.toHaveAttribute("data-disabled");
    const id = (await rows(page).first().getAttribute("data-thread-id"))!;
    await item(page, "menu-not-spam").click();
    await expect(row(page, id)).toHaveCount(0);
  });

  test("opens from the keyboard (⇧F10) and its items run with the arrows and Enter", async ({ app: page, server }) => {
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
      const now = await page.evaluate(() => document.querySelector("[data-testid=thread-menu] [data-highlighted]")?.textContent ?? "");
      if (now.startsWith("Archive")) break;
    }
    await expect(menu(page).locator("[data-highlighted]")).toContainText("Archive");
    await page.keyboard.press("Enter");
    await expect(row(page, id)).toHaveCount(0);
    await expect.poll(() => flags(server, id).in_inbox).toBe(0);
  });

  test("its category toggles can file a thread in two categories; Move to… leaves it in one", async ({ app: page, server }) => {
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
});

test.describe("category picker modes", { tag: "@design" }, () => {
  test("after v (Move to…) is dismissed, the reader's Category button toggles again: picking C keeps A and B", async ({ app: page, server }) => {
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

test.describe("multi-selection", { tag: "@design" }, () => {
  test("⇧-click selects a range, ⌘-click toggles, Esc clears; the reader becomes the bulk bar", async ({ app: page }) => {
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

  test("⇧J extends and ⇧K shrinks from the anchor", async ({ app: page }) => {
    const ids = await idsOf(rows(page));
    await focusList(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+J");
    expect(await idsOf(checked(page))).toEqual(ids.slice(0, 4));
    await page.keyboard.press("Shift+K");
    expect(await idsOf(checked(page))).toEqual(ids.slice(0, 3));
    await page.keyboard.press("Shift+ArrowDown");
    expect(await idsOf(checked(page))).toEqual(ids.slice(0, 4));
  });

  test("⌘A selects the loaded rows; right-click → read, archive and delete apply to all, with undo", async ({ app: page, server }) => {
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

  test("right-clicking a row outside the selection acts on that row only and keeps the selection", async ({ app: page, server }) => {
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

  test("the read-after-dwell of a thread just opened never clears a selection made right after", async ({ app: page, server }) => {
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

  test("⇧F10 with a selection opens the menu on the selection even when the open thread isn't part of it", async ({ app: page }) => {
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

  test("⌫ trashes the selection", async ({ app: page, server }) => {
    const ids = (await idsOf(rows(page))).slice(2, 5);
    await selectRows(page, ids);
    await page.keyboard.press("Backspace");
    for (const id of ids) await expect(row(page, id)).toHaveCount(0);
    await expect.poll(() => ids.every((id) => flags(server, id).in_trash === 1)).toBe(true);
    await expect(toast(page, "3 conversations")).toBeVisible();
  });

  test("⌘A inside the search box selects its text, not the rows", async ({ app: page }) => {
    const input = await searchBox(page);
    await input.fill("factura");
    await input.press("ControlOrMeta+a");
    expect(await input.evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd])).toEqual([0, 7]);
    await expect(checked(page)).toHaveCount(0);
    await input.press("Backspace");
    await expect(input).toHaveValue("");
  });

  test("select all N of the view: the banner, a backend archive with progress, and its undo", async ({ app: page, server }) => {
    const inboxCount = () => db(server).get<{ c: number }>("SELECT count(*) AS c FROM threads WHERE in_inbox = 1")!.c;
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
    await expect(toast(page, /Undone/)).toBeVisible();
    await expect.poll(inboxCount).toBe(total);
    await expect(rows(page).first()).toBeVisible();
  });
});

test.describe("undo is exact", { tag: "@design" }, () => {
  test("all of Archive to Trash, then Undo: they're back in Archive, none in Inbox", async ({ app: page, server }) => {
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

  test("marking a mixed selection read, then z: the ones that were read stay read", async ({ app: page, server }) => {
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
});

test.describe("select all N and dragging", { tag: "@design" }, () => {
  test("with all N of a view selected, rows don't drag (only part of them would move)", async ({ app: page, server }) => {
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
});

test.describe("accessibility", { tag: "@design" }, () => {
  test("the listbox is multi-selectable: aria-selected follows the real selection, the open thread is the active descendant", async ({ app: page }) => {
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
});

test.describe("help", { tag: "@design" }, () => {
  test("the shortcuts dialog lists the new keys", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("?");
    const dialog = page.getByTestId("shortcuts-dialog");
    await expect(dialog).toBeVisible();
    for (const c of ["list.selectAll", "list.extendNext", "thread.markRead", "thread.toggleRead", "thread.move", "action.undo", "list.menu"]) await expect(dialog.getByTestId(`shortcut-${c}`)).toBeVisible();
    await expect(dialog.getByTestId("shortcut-thread.trash")).toContainText("⌫");
    await expect(dialog.getByTestId("shortcut-thread.trash")).toContainText("⌦");
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
