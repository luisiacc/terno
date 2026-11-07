/**
 * Plan 12: the unread filter, like Mail's message filter. The header button
 * and the palette (⌘L is the composer's link since plan 93); per mailbox and across a reload; the open thread stays
 * while it is open; select-all and actions reach only the unread threads;
 * the empty state; axe and baselines of the header and the empty state.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, selectedRow, stabilize, test, scenario, pickFilter } from "./fixtures";

// baselines are at twice the pixels; everything else draws at one (plan 139)
test.use({ deviceScaleFactor: 2 });

const ctx = { clientId: "setup", origin: "dev" as const };
const button = (page: Page) => page.getByTestId("filter-menu");
const db = (server: DevServer) => sqlDb(server.backend.store);
// plan 86: what the Inbox shows (Gmail's Promotions and Social live apart)
const unreadInbox = (server: DevServer) => db(server).all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND tab = 0 AND unread_count > 0").map((r) => r.id);
const readInbox = (server: DevServer) => db(server).all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND tab = 0 AND unread_count = 0").map((r) => r.id);
const loadedIds = (page: Page) => page.evaluate(() => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds());
const row = (page: Page, id: number) => page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`);
/** the list shows the rows of that list key (the header changes before they arrive) */
const showing = (page: Page, unreadOnly: boolean) => expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", new RegExp(`,${unreadOnly ? '"unread"' : "null"},"[^"]*"\\]$`));
const toast = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });

/** a category with nothing in it, opened: nothing is open in it either */
async function emptyCategory(page: Page, server: DevServer) {
  const c = (await server.backend.server.invoke("categories.create", { name: "Viajes", color: "violet" }, ctx)) as { id: number };
  await page.locator(`[data-drop-target="${c.id}"]`).click();
  await expect(page.getByTestId("list-title")).toContainText("Viajes");
}

async function filterOn(page: Page) {
  await pickFilter(page, "unread");
  await expect(button(page)).toHaveAttribute("data-active");
  await showing(page, true);
  await focusList(page);
}

test.describe("the toggle", () => {
  test("the toggle: the button and its state, ⌘L isn't it, per mailbox across a reload, a filtered search", async ({ app: page, server }) => {
    const fresh = async () => {
      await page.evaluate(() => localStorage.removeItem("terno:list-filter"));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("thread-row").first().waitFor();
    };
    await scenario("the header's control filters to unread and back: the accent, its name, the unread count on hover, only unread rows", async () => {
      await expect(button(page)).toHaveText("Filter");
      expect(await page.locator("[data-testid=thread-row]:not([data-unread])").count()).toBeGreaterThan(0);
      await filterOn(page);
      const n = unreadInbox(server).length;
      await expect(button(page)).toHaveText("Unread");
      await expect(button(page)).toHaveAccessibleName("Filter: Unread");
      // the accent, not the muted grey
      const [on, muted] = await button(page).evaluate((b) => [getComputedStyle(b).color, getComputedStyle(document.querySelector("[data-testid=compose-button]")!).color]);
      expect(on).not.toBe(muted);
      // read rows: only the open one (the app opened the first thread, its dwell read it), kept while it is open
      await expect(page.locator("[data-testid=thread-row]:not([data-unread]):not([data-cursor])")).toHaveCount(0);
      const unread = new Set(unreadInbox(server));
      expect((await loadedIds(page)).filter((id) => unread.has(id)).length).toBe(Math.min(n, 100));
      await page.mouse.move(0, 0);
      await button(page).hover();
      await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(`Showing: Unread · ${n.toLocaleString("en-US")}`);
      await page.getByTestId("filter-clear").click();
      await expect(button(page)).not.toHaveAttribute("data-active");
      await showing(page, false);
      await expect(page.getByTestId("filter-clear")).toHaveCount(0);
    });
    await scenario("⌘L is not the filter's (it is the composer's link); the palette offers the other state, with no key", async () => {
      await fresh();
      await focusList(page);
      await page.evaluate(() => {
        const mac = navigator.platform.includes("Mac");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: mac, ctrlKey: !mac, cancelable: true }));
      });
      await page.waitForTimeout(100);
      await expect(button(page)).not.toHaveAttribute("data-active");
      await button(page).hover();
      await expect(page.locator("[data-slot=tooltip-content]")).toHaveText("Show only some of this list");
      // the menu says ⇧U beside Unread
      await button(page).click();
      await expect(page.getByTestId("filter-option-unread")).toContainText("⇧U");
      await page.getByTestId("filter-option-unread").click();
      await expect(button(page)).toHaveAttribute("data-active");

      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByTestId("palette-unread-filter").locator("[data-slot=command-shortcut]")).toHaveCount(0);
      await expect(page.getByTestId("palette-unread-filter")).toContainText("Show all");
      await page.getByTestId("palette-unread-filter").click();
      await expect(button(page)).not.toHaveAttribute("data-active");
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByTestId("palette-unread-filter")).toContainText("Show unread only");
      await page.keyboard.press("Escape");
    });
    await scenario("it is per mailbox and survives a reload: Inbox and a category on, Archive off", async () => {
      await fresh();
      await filterOn(page);
      await page.keyboard.press("g");
      await page.keyboard.press("a");
      await expect(page.getByTestId("list-title")).toContainText("Archive");
      await expect(button(page)).not.toHaveAttribute("data-active");
      const cat = db(server).get<{ id: number; name: string }>("SELECT c.id, c.name FROM categories c JOIN thread_categories tc ON tc.category_id = c.id GROUP BY c.id ORDER BY count(*) DESC LIMIT 1")!;
      await page.locator(`[data-drop-target="${cat.id}"]`).click();
      await expect(page.getByTestId("list-title")).toContainText(cat.name);
      await expect(button(page)).not.toHaveAttribute("data-active");
      await filterOn(page);
      await expect(page.locator("[data-testid=thread-row]:not([data-unread]):not([data-cursor])")).toHaveCount(0);

      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(button(page)).toHaveAttribute("data-active");
      await page.keyboard.press("g");
      await page.keyboard.press("i");
      await expect(page.getByTestId("list-title")).toContainText("Inbox");
      await expect(button(page)).toHaveAttribute("data-active");
      await showing(page, true);
      await focusList(page);
      await page.keyboard.press("g");
      await page.keyboard.press("a");
      await expect(page.getByTestId("list-title")).toContainText("Archive");
      await expect(button(page)).not.toHaveAttribute("data-active");
    });
    await scenario("a search in a filtered mailbox is filtered too: unread results only, counted as such", async () => {
      await fresh();
      await filterOn(page);
      // the Inbox's search, compared with the Inbox's unread (a search everywhere is filtered the same way)
      await page.getByTestId("search-input").fill("in:inbox factura");
      await expect(page.getByTestId("search-stats")).toBeVisible();
      await expect(button(page)).toHaveText("Unread");
      const shown = await loadedIds(page);
      expect(shown.length).toBeGreaterThan(0);
      // in:inbox is the server's Inbox: Gmail's tabs too (plan 86 keeps them out of the Inbox list only)
      const unread = new Set(db(server).all<{ id: number }>("SELECT id FROM threads WHERE in_inbox = 1 AND unread_count > 0").map((r) => r.id));
      expect(shown.every((id) => unread.has(id))).toBe(true);
      await expect(page.getByTestId("search-stats")).toContainText(`${shown.length.toLocaleString("en-US")} results`);
    });
  });

});

test.describe("the open thread stays while it is open", () => {
  test("the open thread stays while it is open: read by the dwell, ⇧I, j and k", async ({ app: page, server }) => {
    const fresh = async () => {
      await page.evaluate(() => localStorage.removeItem("terno:list-filter"));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("thread-row").first().waitFor();
    };
    await scenario("read by the dwell it stays put, through a refresh; j moves on and it leaves, k is predictable", async () => {
      await filterOn(page);
      const unread = new Set(unreadInbox(server));
      const [a, b, c, d] = (await loadedIds(page)).filter((id) => unread.has(id)).slice(0, 4);
      expect([a, b, c, d].every(Boolean)).toBe(true);
      await row(page, b!).dispatchEvent("mousedown", { button: 0 });
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(b));
      // past the 450 ms dwell it is read, in the store and in the row, and still here
      await expect.poll(() => db(server).get<{ u: number }>("SELECT unread_count AS u FROM threads WHERE id = ?", b)!.u).toBe(0);
      await expect(row(page, b!)).not.toHaveAttribute("data-unread");
      // a refresh from the backend (another change) keeps it too
      await server.backend.server.invoke("threads.act", { threadIds: [d!], action: "star" }, ctx);
      await expect(row(page, d!).locator("svg.fill-star")).toBeVisible();
      await expect(row(page, b!)).toBeVisible();
      await focusList(page);
      await page.keyboard.press("j");
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(c));
      await expect(row(page, b!)).toHaveCount(0);
      expect((await loadedIds(page)).filter((id) => id === a || id === b || id === c)).toEqual([a, c]);
      // c is read by its dwell too: k goes to a, the row above, and c leaves
      await expect(row(page, c!)).not.toHaveAttribute("data-unread");
      await page.keyboard.press("k");
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(a));
      await expect(row(page, c!)).toHaveCount(0);
    });
    await scenario("turning the filter on keeps the open read thread; ⇧I on it keeps it, on other rows they leave", async () => {
      await fresh();
      const read = page.locator("[data-testid=thread-row]:not([data-unread])").first();
      const id = Number(await read.getAttribute("data-thread-id"));
      await read.dispatchEvent("mousedown", { button: 0 });
      await filterOn(page);
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(id));
      await expect(row(page, id)).not.toHaveAttribute("data-unread");
      // ⇧I on a checked unread row: it leaves (it doesn't match any more); the open one stays
      const other = page.locator("[data-testid=thread-row][data-unread]").first();
      const otherId = Number(await other.getAttribute("data-thread-id"));
      await other.click({ button: "right" });
      await page.getByTestId("thread-menu").getByTestId("menu-read").click();
      await expect(row(page, otherId)).toHaveCount(0);
      await expect.poll(() => db(server).get<{ u: number }>("SELECT unread_count AS u FROM threads WHERE id = ?", otherId)!.u).toBe(0);
      await expect(row(page, id)).toBeVisible();
    });
  });

});

test.describe("with motion on", () => {
  test.use({ reducedMotion: "no-preference" });

  test("reading the open thread (dwell, ⇧I) keeps it without an error, and moving off it slides the rest up", async ({ app: page, server }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await filterOn(page);
    const unread = new Set(unreadInbox(server));
    const [a, b] = (await loadedIds(page)).filter((id) => unread.has(id));
    await row(page, a!).dispatchEvent("mousedown", { button: 0 });
    await expect.poll(() => db(server).get<{ u: number }>("SELECT unread_count AS u FROM threads WHERE id = ?", a)!.u).toBe(0);
    await expect(row(page, a!)).not.toHaveAttribute("data-unread");
    await focusList(page);
    await page.keyboard.press("j");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(b));
    await expect(row(page, a!)).toHaveCount(0);
    // ⇧I on the open one: read in place, still here
    await page.keyboard.press("Shift+I");
    await expect.poll(() => db(server).get<{ u: number }>("SELECT unread_count AS u FROM threads WHERE id = ?", b)!.u).toBe(0);
    await expect(row(page, b!)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("acting on a filtered mailbox", () => {
  test("⌘A + archive archives the threads shown (the unread ones and the open one), nothing else read; undo brings them back", async ({ app: page, server }) => {
    await filterOn(page);
    const open = Number(await selectedRow(page).getAttribute("data-thread-id"));
    const read = readInbox(server).filter((id) => id !== open);
    const shown = await loadedIds(page);
    expect(shown).toContain(open);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("e");
    await expect.poll(() => db(server).get<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE in_inbox = 1 AND id IN (${shown.join(",")})`)!.c).toBe(0);
    expect(readInbox(server)).toEqual(read);
    await toast(page, /Archived/).getByTestId("snack-action").click();
    await expect.poll(() => db(server).get<{ c: number }>(`SELECT count(*) AS c FROM threads WHERE in_inbox = 1 AND id IN (${shown.join(",")})`)!.c).toBe(shown.length);
  });

  test("“select all N” is the unread threads of the mailbox: the banner counts them and archive reaches them only", async ({ app: page, server }) => {
    // enough unread for more than one page
    const read = readInbox(server).slice(0, 150);
    await server.backend.server.invoke("threads.act", { threadIds: read, action: "markUnread" }, ctx);
    await filterOn(page);
    // chosen and past the 450 ms dwell, the open thread is read (⌘A inside it would leave it unread): count once it is, not racing it
    const open = Number(await selectedRow(page).getAttribute("data-thread-id"));
    await selectedRow(page).click();
    await expect.poll(() => db(server).get<{ u: number }>("SELECT unread_count AS u FROM threads WHERE id = ?", open)!.u).toBe(0);
    const unread = unreadInbox(server);
    expect(unread.length).toBeGreaterThan(100);
    const stillRead = readInbox(server);
    expect(stillRead.length).toBeGreaterThan(0);
    await page.keyboard.press("ControlOrMeta+a");
    const banner = page.getByTestId("select-all-scope-button");
    await expect(banner).toHaveText(`Select all ${unread.length.toLocaleString("en-US")} conversations in “Inbox · Unread”`);
    await banner.click();
    await expect(page.getByTestId("select-all-scope")).toContainText("Inbox · Unread");
    await page.keyboard.press("e");
    await expect.poll(() => unreadInbox(server).length).toBe(0);
    expect(readInbox(server)).toEqual(stillRead);
    // read, it was outside the scope; it stays while it is open (the empty state has its own test below)
    await expect(page.getByTestId("thread-row")).toHaveCount(1);
    await expect(row(page, open)).toBeVisible();
  });
});

test.describe("nothing unread", () => {
  test("nothing unread: the empty state, and a filtered search", async ({ app: page, server }) => {
    const fresh = async () => {
      await page.evaluate(() => localStorage.removeItem("terno:list-filter"));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("thread-row").first().waitFor();
    };
    await scenario("the empty state says so and “Clear filter” brings everything back, focus on the filter control", async () => {
      await emptyCategory(page, server);
      await filterOn(page);
      const empty = page.getByTestId("unread-empty");
      await expect(empty).toContainText("No unread conversations");
      // not inside the listbox: a button isn't an option
      expect(await empty.evaluate((e) => e.closest("[role=listbox]") === null)).toBe(true);
      await page.getByTestId("unread-empty-clear").click();
      await expect(button(page)).not.toHaveAttribute("data-active");
      await expect(button(page)).toBeFocused();
      await expect(empty).toHaveCount(0);
    });
    await scenario("a filtered search with nothing unread", async () => {
      await fresh();
      await filterOn(page);
      await page.getByTestId("search-input").fill("is:read factura");
      await expect(page.getByTestId("unread-empty")).toContainText("No unread results");
    });
  });

  test("accessible (axe), in light and dark: the active header and the empty state", async ({ app: page }) => {
    await filterOn(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      const serious = async (include: string) => {
        const axe = new AxeBuilder({ page }).include(include).setLegacyMode(true);
        // names, roles and structure don't change with the mode: dark reads contrast alone
        const r = await (scheme === "dark" ? axe.withRules(["color-contrast"]) : axe).analyze();
        return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      };
      await page.getByTestId("search-input").fill("");
      await expect(page.getByTestId("unread-empty")).toHaveCount(0);
      expect(await serious("[data-testid=list-header]")).toEqual([]);
      await page.getByTestId("search-input").fill("is:read factura");
      await expect(page.getByTestId("unread-empty")).toBeVisible();
      expect(await serious("[data-testid=unread-empty]")).toEqual([]);
    }
  });
});

test.describe("baselines", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`the filtered header and the empty state, ${scheme}`, async ({ app: page, server }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await filterOn(page);
      await expect(button(page)).toHaveText("Unread");
      await stabilize(page);
      await expect(page.getByTestId("list-header")).toHaveScreenshot(`header-filtered-${scheme}.png`);
      await emptyCategory(page, server);
      await filterOn(page);
      await expect(page.getByTestId("unread-empty")).toBeVisible();
      await stabilize(page);
      await expect(page.getByTestId("thread-list")).toHaveScreenshot(`empty-filtered-${scheme}.png`);
    });
  }
});
