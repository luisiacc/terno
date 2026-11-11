/**
 * Plan 24: the List layout. The list takes the full width (its categories are
 * the sidebar's, as in Split); opening a thread makes the conversation the page, and Esc, ⌘[,
 * the menu's Back and the browser's Back return to the list exactly as it
 * was (scroll, cursor, focus). The round trip and the look run in every design (@design): row
 * height, scroll and focus depend on it; the filters go through a variant (@variant).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import { E2E_NOW } from "./constants";
import { expect, focusList, ingestConversation, rows, search, selectedRow, stabilize, test, fresh, scenario } from "./fixtures";

// baselines are at twice the pixels; everything else draws at one (plan 139)
test.use({ deviceScaleFactor: 2 });

test.use({ layout: "list" });

const ctx = { clientId: "setup", origin: "dev" as const };
const categoryId = (server: DevServer, name: string) => sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = ?", name)!.id;
const listPage = (page: Page) => page.getByTestId("list-page");
const listbox = (page: Page) => page.locator("[data-testid=thread-list] [role=listbox]");
const section = (page: Page) => page.locator("[data-list-section]");
const scrollTop = (page: Page) => listbox(page).evaluate((el) => el.scrollTop);

/** Opens a row like a hand: a click (List opens on the click that ends a press, not on the press). */
async function openRow(page: Page, row: Locator): Promise<string> {
  const id = (await row.getAttribute("data-thread-id"))!;
  await row.click();
  await expect(listPage(page)).toHaveAttribute("data-page", "thread");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  return id;
}

/** RPC calls the page sends, by method (the backend's WebSocket). */
function rpcLog(page: Page): string[] {
  const calls: string[] = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      const m = /"m":"([^"]+)"/.exec(String(f.payload));
      if (m) calls.push(m[1]!);
    }),
  );
  return calls;
}

test.describe("the table (plan 158)", () => {
  test("one header line, columns that line up, a preview a step under the subject, a selection that moves nothing, and back exactly where it was", { tag: "@design" }, async ({ app: page, server, design }) => {
    const box = async (l: Locator) => (await l.boundingBox())!;
    const list = listbox(page);
    await scenario("the columns: every row's subject starts on one line and its preview on another, the date ends on one, and the row is short", async () => {
      await expect(rows(page).first()).toHaveAttribute("data-wide", "true");
      const lefts = await rows(page).evaluateAll((els) => els.slice(0, 12).map((r) => {
        const [subject, snippet] = ["row-subject", "row-snippet"].map((id) => r.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect());
        return { subject: subject!.left, snippet: snippet!.left };
      }));
      expect(new Set(lefts.map((l) => l.subject)).size).toBe(1);
      // plan 160: the subject has a column of its own, so every preview starts at one x (plan 158's flowing line zigzagged)
      expect(new Set(lefts.map((l) => Math.round(l.snippet))).size).toBe(1);
      const rights = await rows(page).evaluateAll((els) => els.slice(0, 12).map((r) => Math.round(r.querySelector("[data-testid=row-date]")!.getBoundingClientRect().right)));
      expect(new Set(rights).size).toBe(1);
      const marks = await rows(page).evaluateAll((els) => els.slice(0, 12).map((r) => Math.round(r.querySelector("[data-testid=row-marks]")!.getBoundingClientRect().left)));
      expect(new Set(marks).size).toBe(1);
      const row = rows(page).nth(1);
      const size = (id: string) => row.getByTestId(id).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(await size("row-snippet")).toBeLessThan(await size("row-subject"));
      expect((await box(row)).height).toBeLessThanOrEqual(40);
    });
    await scenario("narrow, the same columns: the category's slot keeps its name (never a color alone), the account column gives way first", async () => {
      const row = rows(page).nth(3);
      const id = Number(await row.getAttribute("data-thread-id"));
      const all = sqlDb(server.backend.store).all<{ id: number }>("SELECT id FROM categories").map((c) => c.id);
      for (const categoryId of all) await server.backend.server.invoke("categories.addThreads", { categoryId, threadIds: [id], source: "picker" }, ctx);
      server.backend.notifyChanged([id]);
      await page.setViewportSize({ width: 1100, height: 700 });
      await expect(rows(page).first()).toHaveAttribute("data-wide", "true");
      await expect.poll(() => row.locator("[data-cat-dot]").count()).toBe(2);
      const lefts = await rows(page).evaluateAll((els) => els.slice(0, 14).map((r) => Math.round(r.querySelector("[data-testid=row-marks]")!.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(1);
      const dots = await row.locator("[data-cat-dot]").last().boundingBox();
      const marks = await row.getByTestId("row-marks").evaluate((el) => (el.children[0] as HTMLElement).getBoundingClientRect().right);
      expect(dots!.x + dots!.width).toBeLessThanOrEqual(marks + 0.5);
      // plan 158: the name stays, the account goes
      await expect(row.getByTestId("row-category")).toBeVisible();
      await expect(row.getByTestId("account-label")).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await scenario("the header: no category tabs (they're the sidebar's); the title starts on the rows' content line; with the filters in a menu, title, filter and search share one line", async () => {
      await expect(page.getByRole("tablist")).toHaveCount(0);
      const content = await rows(page).first().evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
      expect(Math.abs((await box(page.getByTestId("list-title"))).x - content)).toBeLessThanOrEqual(1);
      // (Lumen's chips have a line of their own)
      if (design === "lumen") return;
      const y = async (id: string) => {
        const b = await box(page.getByTestId(id));
        return b.y + b.height / 2;
      };
      const title = await y("list-title");
      expect(Math.abs((await y("filter-menu")) - title)).toBeLessThanOrEqual(2);
      expect(Math.abs((await y("search-input")) - title)).toBeLessThanOrEqual(2);
      // the controls keep the right edge, the title the left
      expect((await box(page.getByTestId("filter-menu"))).x).toBeGreaterThan((await box(page.getByTestId("list-title"))).x + (await box(page.getByTestId("list-title"))).width);
      expect((await box(page.getByTestId("list-header"))).height).toBeLessThanOrEqual(64);
    });
    await scenario("selecting moves no row; the cursor isn't part of it; what's clicked is what's counted", async () => {
      const a = rows(page).nth(4);
      const b = rows(page).nth(6);
      const before = await box(b);
      await a.click({ modifiers: ["ControlOrMeta"] });
      await expect(page.getByTestId("selection-bar")).toHaveAttribute("data-variant", "toolbar");
      await expect(page.getByTestId("selection-count")).toHaveText("1 conversation selected");
      expect((await box(b)).y).toBe(before.y);
      await b.click({ modifiers: ["ControlOrMeta"] });
      await expect(page.getByTestId("selection-count")).toHaveText("2 conversations selected");
      expect((await box(b)).y).toBe(before.y);
      // plan 158: as in Split, a cursor outside what's checked is a place, never mistaken for it: another fill, no rail
      // (outlined once j/k move it)
      await page.mouse.move(0, 0);
      const look = (l: Locator) => l.evaluate((el) => ({ fill: getComputedStyle(el, "::before").backgroundColor, ring: getComputedStyle(el, "::before").boxShadow }));
      const cursor = page.locator("[data-testid=thread-row][data-cursor]:not([data-checked])");
      const [c, k] = [await look(cursor), await look(b)];
      expect(c.fill).not.toBe(k.fill);
      // what's under the toolbar can't be reached; a search ends the selection and takes the keys (the field behind a button opens)
      const covered = page.getByTestId("list-title").locator("xpath=ancestor::*[@inert]");
      await expect(covered).toHaveCount(1);
      await focusList(page);
      await page.keyboard.press("/");
      await expect(page.getByTestId("search-input")).toBeFocused();
      await expect(page.getByTestId("selection-bar")).toHaveCount(0);
      await page.getByTestId("search-input").press("Escape");
      await a.click({ modifiers: ["ControlOrMeta"] });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("selection-bar")).toHaveCount(0);
      expect((await box(b)).y).toBe(before.y);
    });
    await scenario("a long title truncates: the controls keep the right edge", async () => {
      if (design === "lumen") return;
      await page.keyboard.press("g");
      await page.keyboard.press("a");
      await expect(page.getByTestId("list-title")).toContainText("Archive");
      await page.getByTestId("list-title").evaluate((el) => (el.textContent = "A very long folder name ".repeat(20)));
      const header = await box(page.getByTestId("list-header"));
      const control = await box(page.getByTestId("filter-menu"));
      expect(control.x + control.width).toBeLessThanOrEqual(header.x + header.width);
      await page.keyboard.press("g");
      await page.keyboard.press("i");
      await expect(rows(page).first()).toBeVisible();
    });
    await scenario("the row opened comes back where it was, to the pixel, however the list is scrolled", async () => {
      for (const at of [0, 300, 900]) {
        await list.evaluate((el, top) => el.scrollTo(0, top), at);
        await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(at);
        // the banner gives way as the list scrolls: measured after, or a click would retry through its own scrollIntoView
        if (at > 0) await expect(page.getByTestId("learned-banner")).toBeHidden();
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        // a row in the middle of the window, by where it is (the rendered rows include the overscan)
        const id = await list.evaluate((el) => {
          const { top, height } = el.getBoundingClientRect();
          return [...el.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].find((r) => r.getBoundingClientRect().top > top + height / 2)!.dataset.threadId!;
        });
        const before = await box(page.locator(`[data-thread-id="${id}"]`));
        await page.locator(`[data-thread-id="${id}"]`).click();
        await expect(listPage(page)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(listPage(page)).toHaveCount(0);
        await expect.poll(async () => (await box(page.locator(`[data-thread-id="${id}"]`))).y).toBe(before.y);
        expect(await list.evaluate((el) => el.scrollTop)).toBe(at);
      }
    });
  });
});

/** The pointer on a row's avatar, or with none on its subject (the row's own hover). By position: the avatar hides under it. */
async function pointAt(page: Page, row: Locator, avatars: boolean): Promise<void> {
  const b = (await (avatars ? row.getByTestId("sender-avatar") : row.getByTestId("row-subject")).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

test.describe("the pointer's checkbox (2026-11-07)", () => {
  test("in the avatar's place (with none, a slot of its size): over it, then on every row once one is checked; it checks without opening, ⇧ checks a range, and nothing moves", { tag: "@design" }, async ({ app: page, design }) => {
    const away = () => page.mouse.move(1, 1);
    const shown = (l: Locator) => l.evaluate((el) => getComputedStyle(el).visibility === "visible");
    const fromX = (row: Locator) => row.getByTestId("row-from").evaluate((el) => el.getBoundingClientRect().left);
    const checkedCount = () => page.evaluate(() => (window as unknown as { __terno: { getApp(): { checked: Set<number> } } }).__terno.getApp().checked.size);
    const avatars = DESIGNS.find((d) => d.id === design)!.variants.row !== "classic";
    // a row under the pointer: its avatar's, or with none the row's
    const hover = (row: Locator) => pointAt(page, row, avatars);
    const pick = async (row: Locator, modifiers?: ["Shift"]) => {
      await hover(row);
      await row.getByTestId("row-pick").click({ modifiers });
    };
    // past the cursor's row, so it can't be what's checked
    const row = rows(page).nth(3);
    const box = row.getByTestId("row-pick");
    const before = { x: await fromX(row), height: (await row.boundingBox())!.height, cursor: await selectedRow(page).getAttribute("data-thread-id") };
    await scenario("at rest, no box; over the avatar (or the row, with none) the box takes its place, and nothing moves", async () => {
      await away();
      await expect(row.getByTestId("sender-avatar")).toHaveCount(avatars ? 1 : 0);
      expect(await shown(box)).toBe(false);
      if (avatars) {
        // the rest of the row is the row's: no box for it
        await row.getByTestId("row-subject").hover();
        expect(await shown(box)).toBe(false);
      }
      await hover(row);
      expect(await shown(box)).toBe(true);
      const b = (await box.boundingBox())!;
      if (avatars) {
        expect(await shown(row.getByTestId("sender-avatar"))).toBe(false);
        const a = (await row.getByTestId("sender-avatar").boundingBox())!;
        expect(Math.abs(b.x + b.width / 2 - (a.x + a.width / 2))).toBeLessThanOrEqual(1);
        expect(Math.abs(b.y + b.height / 2 - (a.y + a.height / 2))).toBeLessThanOrEqual(1);
      } else {
        // a slot the size of Lumen's wide avatar, there at rest too: the full box, centred, with air before the name
        const s = (await row.getByTestId("row-pick-slot").boundingBox())!;
        expect(s.width).toBe(DESIGNS.find((d) => d.id === "lumen")!.avatar.rowWide);
        expect(b.width).toBe(16);
        expect(Math.abs(b.x + b.width / 2 - (s.x + s.width / 2))).toBeLessThanOrEqual(0.5);
        expect(before.x - (b.x + b.width)).toBeGreaterThanOrEqual(8);
        // an unread row's dot sits in the slot at rest, and gives it up to the box (one mark per slot)
        const unread = rows(page).and(page.locator("[data-unread]")).first();
        const dot = unread.getByTestId("row-unread-dot");
        await away();
        const d = (await dot.boundingBox())!;
        const us = (await unread.getByTestId("row-pick-slot").boundingBox())!;
        expect(Math.abs(d.x + d.width / 2 - (us.x + us.width / 2))).toBeLessThanOrEqual(0.5);
        expect(await shown(dot)).toBe(true);
        await hover(unread);
        expect(await shown(dot)).toBe(false);
        expect(await shown(unread.getByTestId("row-pick"))).toBe(true);
        await hover(row);
      }
      expect(await fromX(row)).toBe(before.x);
      expect((await row.boundingBox())!.height).toBe(before.height);
    });
    await scenario("a click on it checks the row without opening it or moving the cursor; then every row shows its box, nothing moved", async () => {
      await pick(row);
      await expect(row).toHaveAttribute("data-checked", "true");
      await expect(page.getByTestId("selection-count")).toHaveText("1 conversation selected");
      await expect(listPage(page)).toHaveCount(0);
      expect(await selectedRow(page).getAttribute("data-thread-id")).toBe(before.cursor);
      await away();
      const all = await rows(page).evaluateAll((els) => els.map((r) => ({
        box: getComputedStyle(r.querySelector("[data-testid=row-pick]")!).visibility,
        avatar: r.querySelector("[data-testid=sender-avatar]") && getComputedStyle(r.querySelector("[data-testid=sender-avatar]")!).visibility,
        dot: r.querySelector("[data-testid=row-unread-dot]") && getComputedStyle(r.querySelector("[data-testid=row-unread-dot]")!).visibility,
        check: !!r.querySelector("[data-testid=row-check]"),
      })));
      for (const r of all) {
        expect(r.box).toBe("visible");
        if (avatars) expect(r.avatar).toBe("hidden");
        // one mark per slot: the box says checked; with no avatar, the dot gives the column up
        else if (r.dot) expect(r.dot).toBe("hidden");
        expect(r.check).toBe(false);
      }
      await expect(row.getByTestId("row-pick")).toHaveAttribute("data-checked", "");
      expect(await fromX(row)).toBe(before.x);
      expect((await row.boundingBox())!.height).toBe(before.height);
    });
    await scenario("unchecking the last one brings the avatars back", async () => {
      await row.getByTestId("row-pick").click();
      await expect(page.getByTestId("selection-bar")).toHaveCount(0);
      await away();
      expect(await shown(box)).toBe(false);
      if (avatars) expect(await shown(row.getByTestId("sender-avatar"))).toBe(true);
      await expect(listPage(page)).toHaveCount(0);
    });
    await scenario("⇧ on a box checks the range from the last one clicked; ⌘-click and x still check as before", async () => {
      await pick(rows(page).nth(2));
      await pick(rows(page).nth(6), ["Shift"]);
      await expect.poll(checkedCount).toBe(5);
      for (const i of [2, 3, 4, 5, 6]) await expect(rows(page).nth(i)).toHaveAttribute("data-checked", "true");
      await rows(page).nth(8).click({ modifiers: ["ControlOrMeta"] });
      await expect.poll(checkedCount).toBe(6);
      await page.keyboard.press("Escape");
      await expect.poll(checkedCount).toBe(0);
      await focusList(page);
      await page.keyboard.press("x");
      await expect.poll(checkedCount).toBe(1);
      await away();
      expect(await shown(rows(page).nth(5).getByTestId("row-pick"))).toBe(true);
      await page.keyboard.press("Escape");
    });
    await scenario("a search's results in List: the same box", async () => {
      await search(page, "design");
      const hit = rows(page).nth(1);
      await expect(page.getByTestId("search-input")).toBeFocused();
      await pick(hit);
      await expect(hit).toHaveAttribute("data-checked", "true");
      await expect(listPage(page)).toHaveCount(0);
      // (Codex review) the keys go to the list, as after a row's press: x checks the cursor's row, Esc ends the selection
      await expect(listbox(page)).toBeFocused();
      await page.keyboard.press("x");
      await expect.poll(checkedCount).toBe(2);
      await page.keyboard.press("Escape");
      await expect.poll(checkedCount).toBe(0);
      await expect(page.getByTestId("search-input")).toHaveValue("design");
    });
  });
});

test.describe("the pointer's checkbox: Split (2026-11-07)", () => {
  test.use({ layout: "split" });
  test("Split's rows have none, whatever is under the pointer or checked", async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-layout", "split");
    await rows(page).nth(3).hover();
    await rows(page).nth(3).click({ modifiers: ["ControlOrMeta"] });
    await rows(page).nth(4).hover();
    await expect(page.getByTestId("row-pick")).toHaveCount(0);
  });
});

test.describe("the List layout", () => {
  test("the list is full width; a click opens the conversation as the page; Esc comes back to the same scroll, row and focus", { tag: "@design" }, async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
    await expect(page.locator("main")).toHaveCount(0);
    await expect(page.getByTestId("pane-handle-list")).toHaveCount(0);
    await expect(page.getByTestId("pane-handle-sidebar")).toBeVisible();
    // nothing opens by itself (R7)
    await expect(listPage(page)).toHaveCount(0);

    // deep in the list
    await listbox(page).evaluate((el) => (el.scrollTop = 2400));
    await expect.poll(() => scrollTop(page)).toBe(2400);
    // a row wholly on screen (clicking it scrolls nothing), once the rows for this offset are in
    await page.waitForTimeout(150);
    const onScreen = await listbox(page).evaluate((lb) => {
      const r = lb.getBoundingClientRect();
      return [...lb.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].find((row) => {
        const b = row.getBoundingClientRect();
        return b.top >= r.top + 100 && b.bottom <= r.bottom - 100;
      })!.dataset.threadId!;
    });
    const id = await openRow(page, page.locator(`[data-thread-id="${onScreen}"]`));
    expect(await scrollTop(page)).toBe(2400);
    await expect(page).toHaveURL(new RegExp(`#/thread/${id}$`));
    // the list is still there underneath: not painted, not reachable, its rows still mounted
    await expect(section(page)).toHaveAttribute("inert", "");
    await expect(section(page)).toHaveAttribute("data-covered");
    expect(await page.locator(`[data-thread-id="${id}"]`).count()).toBe(1);
    // focus starts on the conversation, named by its subject
    await expect(page.getByTestId("reader")).toBeFocused();
    await expect(page.getByTestId("reader-back")).toHaveAccessibleName("Back to Inbox");

    await page.keyboard.press("Escape");
    await expect(listPage(page)).toHaveCount(0);
    await expect(section(page)).not.toHaveAttribute("inert");
    expect(await scrollTop(page)).toBe(2400);
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
    await expect(listbox(page)).toBeFocused();
    // back on the base entry: the address the app opened with
    await expect(page).not.toHaveURL(/#\/thread/);
  });

  test("on a conversation's page: ⌘[ and Back, j and k, e and z, r and c, a reload", async ({ app: page }) => {
    const fresh = async () => {
      await page.evaluate(() => (location.hash = ""));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
    };
    await scenario("j and k on the page step through conversations; one Back returns to the list with the cursor in view", async () => {
      const length = await page.evaluate(() => history.length);
      await openRow(page, rows(page).first());
      for (let i = 0; i < 6; i++) await page.keyboard.press("j");
      const id = await selectedRow(page).getAttribute("data-thread-id");
      await expect(page).toHaveURL(new RegExp(`#/thread/${id}$`));
      // replaced, not pushed: one entry above the list
      expect(await page.evaluate(() => history.length)).toBe(length + 1);
      await page.getByTestId("reader-older").click();
      await page.getByTestId("reader-newer").click();
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id!);
      await page.keyboard.press("Escape");
      await expect(listPage(page)).toHaveCount(0);
      await expect(selectedRow(page)).toBeInViewport();
      await expect(page.getByTestId("reader-newer")).toHaveCount(0);
    });
    await scenario("⌘[ goes back and ⌘] forward; the browser's Back and Forward do the same, one step each", async () => {
      await fresh();
      const id = await openRow(page, rows(page).nth(1));
      await page.keyboard.press("ControlOrMeta+BracketLeft");
      await expect(listPage(page)).toHaveCount(0);
      await page.keyboard.press("ControlOrMeta+BracketRight");
      await expect(listPage(page)).toBeVisible();
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
      await page.goBack();
      await expect(listPage(page)).toHaveCount(0);
      await expect(page).not.toHaveURL(/#\/thread/);
      await page.goForward();
      await expect(listPage(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#/thread/${id}$`));
      // the back button in the toolbar
      await page.getByTestId("reader-back").click();
      await expect(listPage(page)).toHaveCount(0);
      // back on the base entry (a Back from the list would leave the app): one Terno entry at most
      expect(await page.evaluate(() => location.hash)).not.toContain("thread");
    });
    await scenario("e on the page archives and returns to the list, the cursor on the next thread; z brings it back and stays on the list", async () => {
      await fresh();
      const first = (await rows(page).first().getAttribute("data-thread-id"))!;
      const second = (await rows(page).nth(1).getAttribute("data-thread-id"))!;
      await openRow(page, rows(page).first());
      await page.keyboard.press("e");
      await expect(listPage(page)).toHaveCount(0);
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", second);
      await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(0);
      await expect(page.getByTestId("snack-dock")).toContainText("Archived");
      await focusList(page);
      await page.keyboard.press("z");
      await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(1);
      await expect(listPage(page)).toHaveCount(0);
    });
    await scenario("a reload on a conversation comes back to it, and Back lands on the list", async () => {
      await fresh();
      const id = await openRow(page, rows(page).nth(2));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(listPage(page)).toHaveAttribute("data-page", "thread");
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
      await page.goBack();
      await expect(listPage(page)).toHaveCount(0);
      await expect(rows(page).first()).toBeVisible();
    });
    await scenario("r opens the inline draft on the page (also from the list); Esc collapses it, a second Esc goes back", async () => {
      await fresh();
      await focusList(page);
      const id = (await selectedRow(page).getAttribute("data-thread-id"))!;
      // from the list: the conversation opens with its draft (R3)
      await page.keyboard.press("r");
      await expect(listPage(page)).toHaveAttribute("data-page", "thread");
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
      const editor = page.locator("[data-testid=draft-slot] [contenteditable=true]");
      await expect(editor).toBeFocused();
      await page.keyboard.type("Thanks, see you then");
      await page.keyboard.press("Escape");
      await expect(listPage(page)).toBeVisible();
      await focusList(page);
      await page.keyboard.press("Escape");
      await expect(listPage(page)).toHaveCount(0);
    });
    await scenario("c opens the new message as the page; Esc lands on the list (also when it was opened from a conversation) with the draft in the strip", async () => {
      await fresh();
      await openRow(page, rows(page).first());
      await focusList(page);
      await page.keyboard.press("c");
      await expect(listPage(page)).toHaveAttribute("data-page", "compose");
      await expect(page).toHaveURL(/#\/compose$/);
      await page.getByTestId("compose-to").fill("ana@example.com");
      await page.keyboard.press("Escape");
      // not back on the conversation it was opened over (R1)
      await expect(listPage(page)).toHaveCount(0);
      await expect(page.getByTestId("drafts-strip")).toBeVisible();
      await expect(page).not.toHaveURL(/#\/compose/);
    });
  });

});

test.describe("the List layout: what stays put", () => {
  test("what stays put: checked rows, ⇧U, j and k fetch nothing, a drag, a Forward from another list", async ({ app: page, server }) => {
    const fresh = async () => {
      await page.evaluate(() => (location.hash = ""));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
    };
    await scenario("⇧U and ⇧A filter the list on the list, and do nothing on a conversation's page", async () => {
      const read = page.locator("[data-testid=thread-row]:not([data-unread=true])");
      const unfiltered = await read.count();
      expect(unfiltered).toBeGreaterThan(1);
      await openRow(page, read.first());
      await page.keyboard.press("Shift+U");
      await page.keyboard.press("Escape");
      await expect(listPage(page)).toHaveCount(0);
      await expect.poll(() => read.count()).toBe(unfiltered);
      await page.keyboard.press("Shift+U");
      await expect.poll(() => read.count()).toBeLessThanOrEqual(1);
      await page.keyboard.press("Shift+A");
      await expect.poll(() => read.count()).toBe(unfiltered);
    });
    await scenario("Enter with checked rows opens only the cursor's thread, and e archives just it (R2)", async () => {
      await fresh();
      const ids = await rows(page).evaluateAll((els) => els.slice(0, 3).map((e) => e.getAttribute("data-thread-id")!));
      await rows(page).first().click();
      await page.keyboard.press("Escape");
      for (const id of ids.slice(1)) await page.locator(`[data-thread-id="${id}"]`).click({ modifiers: ["ControlOrMeta"] });
      await expect(page.getByTestId("selection-bar")).toHaveAttribute("data-variant", "toolbar");
      // plan 158: it lies over the title line: nothing under it takes the keyboard
      await expect(page.getByTestId("list-title").locator("xpath=ancestor::*[@inert]")).toHaveCount(1);
      await focusList(page);
      await page.keyboard.press("Enter");
      await expect(listPage(page)).toBeVisible();
      await expect(page.locator("[data-testid=thread-row][data-checked]")).toHaveCount(0);
      const open = (await selectedRow(page).getAttribute("data-thread-id"))!;
      await page.keyboard.press("e");
      await expect(page.locator(`[data-thread-id="${open}"]`)).toHaveCount(0);
      for (const id of ids.filter((x) => x !== open)) await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(1);
    });
    await scenario("on the list, j and k move the cursor without opening or fetching a conversation (R12)", async () => {
      await fresh();
      const calls = rpcLog(page);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
      await focusList(page);
      const before = calls.filter((c) => c === "threads.get").length;
      for (let i = 0; i < 5; i++) await page.keyboard.press("j");
      await page.waitForTimeout(500);
      expect(calls.filter((c) => c === "threads.get").length).toBe(before);
      await expect(listPage(page)).toHaveCount(0);
      await page.keyboard.press("Enter");
      await expect(listPage(page)).toBeVisible();
      await expect.poll(() => calls.filter((c) => c === "threads.get").length).toBeGreaterThan(before);
    });
    await scenario("a drag released over the rows doesn't open a row (R8)", async () => {
      await fresh();
      const row = rows(page).nth(1);
      const b = (await row.boundingBox())!;
      await page.mouse.move(b.x + 120, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 140, b.y + b.height / 2 + 8, { steps: 4 });
      await page.mouse.move(b.x + 160, b.y + b.height / 2 + 30, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      await expect(listPage(page)).toHaveCount(0);
    });
    await scenario("a Forward made on another list is dropped, not reopened over this one (R6)", async () => {
      await fresh();
      await openRow(page, rows(page).first());
      await page.keyboard.press("Escape");
      await page.getByTestId(`nav-category-${categoryId(server, "Viajes")}`).click();
      await page.goForward();
      await page.waitForTimeout(300);
      await expect(listPage(page)).toHaveCount(0);
    });
  });

  test("mail arriving, a tall snackbar, a folder's draft; the setting and Split", async ({ app: page, server }) => {
    const fresh = async () => {
      await page.evaluate(() => (location.hash = ""));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
    };
    await scenario("mail arriving while a conversation is open: Back finds the rows where they were, the cursor's row unmoved (Codex review)", async () => {
      const first = rows(page).first();
      const h = (await first.boundingBox())!.height;
      const id = await openRow(page, first);
      expect(await scrollTop(page)).toBe(0);
      // a new thread lands above every row while the list is covered: its refresh waits for Back
      const arrived = await ingestConversation(server, { subject: "Llegó mientras leías", count: 1, now: E2E_NOW + 3 * 3_600_000 });
      server.backend.notifyChanged([arrived]);
      await page.waitForTimeout(600);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-thread-id]").first()).not.toHaveAttribute("data-thread-id", id);
      // the first row on screen is still the one that was there (the new one is just above, out of view)
      await expect.poll(() => scrollTop(page)).toBe(Math.round(h));
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
      await expect(selectedRow(page)).toBeInViewport();
    });
    await scenario("the tall categorization snackbar on a long conversation's page: the reply bar still scrolls clear of it (second Codex review)", async () => {
      await fresh();
      // a long conversation (every message open), newest of all
      const id = await ingestConversation(server, { subject: "Campaña de otoño", count: 6, unread: 6, now: E2E_NOW + 3 * 3_600_000 });
      server.backend.notifyChanged([id]);
      const row = page.locator(`[data-thread-id="${id}"]`);
      await row.waitFor();
      await openRow(page, row);
      // l → a category: the three-row categorization snackbar comes up in the dock, over the page's foot
      await page.keyboard.press("l");
      await page.locator("[data-testid^=pick-category-]").first().click();
      const card = page.getByTestId("category-snackbar");
      await expect(card).toBeVisible();
      await page.locator("[data-reader-scroller]").evaluate((el) => (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(200);
      const reply = (await page.getByTestId("draft-slot").boundingBox())!;
      expect(reply.y + reply.height).toBeLessThanOrEqual((await card.boundingBox())!.y + 1);
    });
    await scenario("plan 68 (Codex R5): writing in one folder, choosing another of the same account shows that list; the draft is kept", async () => {
      await fresh();
      const acme = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts WHERE display_name = 'Acme Studio'")!.id;
      await page.getByTestId(`nav-account-${acme}`).dblclick();
      await page.getByTestId(`nav-own-${acme}-Label_21`).click();
      await focusList(page);
      await page.keyboard.press("c");
      await expect(listPage(page)).toHaveAttribute("data-page", "compose");
      await page.getByTestId("compose-to").fill("ana@example.com");
      await page.getByTestId(`nav-own-${acme}-Label_23`).click();
      await expect(listPage(page)).toHaveCount(0);
      await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /"Label_23"/);
      await expect(page.getByTestId("drafts-strip")).toBeVisible();
    });
    await scenario("the setting: Appearance → List → Layout switches at once, both ways", async () => {
      await fresh();
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      await page.getByTestId("layout-split").click();
      await expect(page.locator("html")).toHaveAttribute("data-layout", "split");
      await expect(page.locator("main")).toHaveCount(1);
      await expect.poll(() => server.backend.server.invoke("settings.update", {}, ctx).then((s) => (s as { layout: string }).layout)).toBe("split");
      await page.getByTestId("layout-list").click();
      await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
      await expect(page.getByTestId("layout-list")).toHaveAttribute("aria-pressed", "true");
    });
    await scenario("Split and back: the list width plan 21 remembers is untouched by List", async () => {
      await fresh();
      await server.backend.server.invoke("settings.update", { layout: "split" }, ctx);
      await page.evaluate(() => localStorage.setItem("terno:panes", JSON.stringify({ v: 1, sidebar: 240, list: 500 })));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("#app-list")).toHaveJSProperty("offsetWidth", 500);
      await page.evaluate(() => (window as unknown as { __terno: { updateAppearance(p: object): Promise<unknown> } }).__terno.updateAppearance({ layout: "list" }));
      await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
      await expect(page.getByTestId("pane-handle-list")).toHaveCount(0);
      await page.evaluate(() => (window as unknown as { __terno: { updateAppearance(p: object): Promise<unknown> } }).__terno.updateAppearance({ layout: "split" }));
      await expect(page.locator("#app-list")).toHaveJSProperty("offsetWidth", 500);
      expect(await page.evaluate(() => localStorage.getItem("terno:panes"))).toBe(JSON.stringify({ v: 1, sidebar: 240, list: 500 }));
    });
  });

});

test.describe("one-line rows", () => {
  test("the right edge is straight: account, attachment, star and date hold their columns; the subject stands apart from its preview", { tag: "@design" }, async ({ app: page }) => {
    const visible = rows(page);
    await expect(visible.first()).toBeVisible();
    const rights = await visible.evaluateAll((els) =>
      els.flatMap((row) => {
        const left = (id: string) => row.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect().left;
        const right = (id: string) => row.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect().right;
        return [{ account: left("account-label"), date: right("row-date") }];
      }),
    );
    expect(new Set(rights.map((r) => Math.round(r.date!))).size).toBe(1);
    expect(new Set(rights.map((r) => Math.round(r.account!))).size).toBe(1);
    const row = visible.first();
    const color = (id: string) => row.getByTestId(id).evaluate((el) => getComputedStyle(el).color);
    expect(await color("row-subject")).not.toBe(await color("row-snippet"));
  });
});

test.describe("categories in List are the sidebar's", () => {
  test("a category opens from the sidebar; the filters are the design's own, as in Split", { tag: "@variant" }, async ({ app: page, server, design }) => {
    const viajes = categoryId(server, "Viajes");
    const variants = DESIGNS.find((d) => d.id === design)!.variants;
    await page.getByTestId(`nav-category-${viajes}`).click();
    await expect(page.getByTestId(`nav-category-${viajes}`)).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("list-title")).toHaveText("Viajes");
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("data-active", "true");
    // the filters reach the same way as in Split: the chips, or the header's control
    const chips = variants.quickFilters === "chips";
    const unread = page.getByTestId(chips ? "quick-filter-unread" : "filter-segment-unread");
    await unread.click();
    await expect(unread).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(chips ? "filter-menu" : "quick-filters")).toHaveCount(0);
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-unread-filter").click();
    await expect(unread).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("data-active", "true");
  });

  test("the sidebar's + creates and opens one; a drag onto a sidebar category moves there", async ({ app: page, server }) => {
    await scenario("+ creates a category and opens its list", async () => {
      await page.getByTestId("new-category").click();
      await page.getByTestId("new-category-input").fill("Recibos");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("list-title")).toHaveText("Recibos");
      await expect(page.getByTestId(`nav-category-${categoryId(server, "Recibos")}`)).toHaveAttribute("data-active", "true");
    });
    await scenario("dragging rows onto a sidebar category moves them there and only there; nothing opens", async () => {
      await fresh(page);
      const viajes = categoryId(server, "Viajes");
      const target = page.getByTestId(`nav-category-${viajes}`);
      const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${viajes}"]))`).first();
      const id = (await row.getAttribute("data-thread-id"))!;
      const from = (await row.boundingBox())!;
      const to = (await target.boundingBox())!;
      await page.mouse.move(from.x + 120, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 126, from.y + from.height / 2 + 2, { steps: 2 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await expect(target).toHaveAttribute("data-drop-state", "over");
      await page.mouse.up();
      await expect(page.getByTestId("category-snackbar")).toBeVisible();
      const dropped = page.locator(`[data-thread-id="${id}"]`);
      await expect(dropped.locator(`[data-cat-dot="${viajes}"]`)).toHaveCount(1);
      await expect(dropped.locator("[data-cat-dot]")).toHaveCount(1);
      await expect(listPage(page)).toHaveCount(0);
    });
  });
});


test.describe("List layout: accessibility and look", { tag: "@design" }, () => {
  for (const mode of ["light", "dark"] as const) {
    test(`axe-clean and on baseline (${mode}): the list, a conversation, a new message`, async ({ app: page, design }) => {
      await page.emulateMedia({ colorScheme: mode });
      await stabilize(page);
      // names, roles and structure don't change with the mode: dark reads contrast alone
      const wcag = () => (mode === "light" ? new AxeBuilder({ page }).setLegacyMode().withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]) : new AxeBuilder({ page }).setLegacyMode().withRules(["color-contrast"])).exclude("iframe");
      const check = async () => expect((await wcag().analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
      await check();
      await expect(page).toHaveScreenshot(`list-${mode}.png`);
      // the pointer's checkboxes (2026-11-07): one row checked by its box, another's under the pointer; nothing new for a
      // keyboard or a screen reader (the row is the option, `x` its key)
      const avatars = DESIGNS.find((d) => d.id === design)!.variants.row !== "classic";
      const under = (i: number) => pointAt(page, rows(page).nth(i), avatars);
      await under(2);
      await rows(page).nth(2).getByTestId("row-pick").click();
      await under(4);
      await expect(page.getByTestId("selection-count")).toBeVisible();
      await check();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("selection-bar")).toHaveCount(0);
      await openRow(page, rows(page).first());
      await check();
      await expect(page).toHaveScreenshot(`list-thread-${mode}.png`);
      await page.keyboard.press("Escape");
      await focusList(page);
      await page.keyboard.press("c");
      await expect(listPage(page)).toHaveAttribute("data-page", "compose");
      await check();
    });
  }
});
