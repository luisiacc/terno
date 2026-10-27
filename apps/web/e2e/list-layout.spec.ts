/**
 * Plan 24: the List layout. The list takes the full width with category tabs
 * on top; opening a thread makes the conversation the page, and Esc, ⌘[,
 * the menu's Back and the browser's Back return to the list exactly as it
 * was (scroll, cursor, focus). The core flows run in every design (@design).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, focusList, ingestConversation, navTo, rows, selectedRow, stabilize, test } from "./fixtures";

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

test.describe("the List layout", { tag: "@design" }, () => {
  test("the list is full width with tabs; a click opens the conversation as the page; Esc comes back to the same scroll, row and focus", async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
    await expect(page.locator("main")).toHaveCount(0);
    await expect(page.getByTestId("pane-handle-list")).toHaveCount(0);
    await expect(page.getByTestId("pane-handle-sidebar")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Inbox sections" })).toBeVisible();
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

  test("⌘[ goes back and ⌘] forward; the browser's Back and Forward do the same, one step each", async ({ app: page }) => {
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

  test("j and k on the page step through conversations; one Back returns to the list with the cursor in view", async ({ app: page }) => {
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

  test("e on the page archives and returns to the list, the cursor on the next thread; z brings it back and stays on the list", async ({ app: page }) => {
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

  test("r opens the inline draft on the page (also from the list); Esc collapses it, a second Esc goes back", async ({ app: page }) => {
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

  test("c opens the new message as the page; Esc lands on the list (also when it was opened from a conversation) with the draft in the strip", async ({ app: page }) => {
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

  test("a reload on a conversation comes back to it, and Back lands on the list", async ({ app: page }) => {
    const id = await openRow(page, rows(page).nth(2));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(listPage(page)).toHaveAttribute("data-page", "thread");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", id);
    await page.goBack();
    await expect(listPage(page)).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
  });
});

test.describe("the List layout: what stays put", () => {
  test("Enter with checked rows opens only the cursor's thread, and e archives just it (R2)", async ({ app: page }) => {
    const ids = await rows(page).evaluateAll((els) => els.slice(0, 3).map((e) => e.getAttribute("data-thread-id")!));
    await rows(page).first().click();
    await page.keyboard.press("Escape");
    for (const id of ids.slice(1)) await page.locator(`[data-thread-id="${id}"]`).click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("selection-bar")).toHaveAttribute("data-variant", "toolbar");
    await focusList(page);
    await page.keyboard.press("Enter");
    await expect(listPage(page)).toBeVisible();
    await expect(page.locator("[data-testid=thread-row][data-checked]")).toHaveCount(0);
    const open = (await selectedRow(page).getAttribute("data-thread-id"))!;
    await page.keyboard.press("e");
    await expect(page.locator(`[data-thread-id="${open}"]`)).toHaveCount(0);
    for (const id of ids.filter((x) => x !== open)) await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(1);
  });

  test("on the list, j and k move the cursor without opening or fetching a conversation (R12)", async ({ app: page }) => {
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

  test("mail arriving while a conversation is open: Back finds the rows where they were, the cursor's row unmoved (Codex review)", async ({ app: page, server }) => {
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

  test("the tall categorization snackbar on a long conversation's page: the reply bar still scrolls clear of it (second Codex review)", async ({ app: page, server }) => {
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

  test("a drag released over the rows doesn't open a row (R8)", async ({ app: page }) => {
    const row = rows(page).nth(1);
    const b = (await row.boundingBox())!;
    await page.mouse.move(b.x + 40, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 60, b.y + b.height / 2 + 8, { steps: 4 });
    await page.mouse.move(b.x + 80, b.y + b.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await expect(listPage(page)).toHaveCount(0);
  });

  test("a Forward made on another list is dropped, not reopened over this one (R6)", async ({ app: page, server }) => {
    await openRow(page, rows(page).first());
    await page.keyboard.press("Escape");
    await page.getByTestId(`list-tab-${categoryId(server, "Viajes")}`).click();
    await page.goForward();
    await page.waitForTimeout(300);
    await expect(listPage(page)).toHaveCount(0);
  });

  test("Split and back: the list width plan 21 remembers is untouched by List", async ({ app: page, server }) => {
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

  test("the setting: General → List → Layout switches at once, both ways", async ({ app: page, server }) => {
    await page.getByTestId("open-settings").click();
    await page.getByTestId("layout-split").click();
    await expect(page.locator("html")).toHaveAttribute("data-layout", "split");
    await expect(page.locator("main")).toHaveCount(1);
    await expect.poll(() => server.backend.server.invoke("settings.update", {}, ctx).then((s) => (s as { layout: string }).layout)).toBe("split");
    await page.getByTestId("layout-list").click();
    await expect(page.locator("html")).toHaveAttribute("data-layout", "list");
    await expect(page.getByTestId("layout-list")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("category tabs", { tag: "@design" }, () => {
  test("All, Unread and the categories: the same state as the sidebar and ⌘L, with unread counts", async ({ app: page, server }) => {
    const viajes = categoryId(server, "Viajes");
    const all = page.getByTestId("list-tab-all");
    const unread = page.getByTestId("list-tab-unread");
    const tab = page.getByTestId(`list-tab-${viajes}`);
    await expect(all).toHaveAttribute("aria-selected", "true");
    await expect(all).toHaveAttribute("aria-controls", "list-tabpanel");
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "list-tab-all");
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`nav-category-${viajes}`)).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("list-title")).toHaveText("Viajes");
    await page.getByTestId("nav-inbox").click();
    await expect(all).toHaveAttribute("aria-selected", "true");
    // Unread is the inbox's ⌘L
    await unread.click();
    await expect(unread).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("unread-filter")).toHaveAttribute("aria-pressed", "true");
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+l");
    await expect(all).toHaveAttribute("aria-selected", "true");
    // counts: the inbox's unread on Unread, in its accessible name
    const n = await page.evaluate(() => (window as unknown as { __terno: { getApp(): { counts: { inboxUnread: number } } } }).__terno.getApp().counts.inboxUnread);
    await expect(unread).toHaveAccessibleName("Unread");
    if (n > 0) await expect(unread).toHaveAccessibleDescription(`${n} unread`);
    // the arrows move along the tabs and open them
    await all.focus();
    await page.keyboard.press("ArrowRight");
    await expect(unread).toBeFocused();
    await expect(unread).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(all).toHaveAttribute("aria-selected", "true");
    // hidden where there's nothing to slice: another folder, a search
    await navTo(page, "sent");
    await expect(page.getByTestId("list-tabs")).toHaveCount(0);
  });

  test("+ creates a category and opens its tab", async ({ app: page }) => {
    await page.getByTestId("list-tabs-new").click();
    await page.getByTestId("list-tabs-new-input").fill("Recibos");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("list-title")).toHaveText("Recibos");
    await expect(page.locator("[role=tab][aria-selected=true]")).toHaveAccessibleName("Recibos");
  });

  test("dragging rows onto a tab moves them there and only there; the ghost flies to the tab", async ({ app: page, server }) => {
    const viajes = categoryId(server, "Viajes");
    const tab = page.getByTestId(`list-tab-${viajes}`);
    const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${viajes}"]))`).first();
    const id = (await row.getAttribute("data-thread-id"))!;
    const from = (await row.boundingBox())!;
    const to = (await tab.boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 46, from.y + from.height / 2 + 2, { steps: 2 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await expect(tab).toHaveAttribute("data-drop-state", "over");
    // the sidebar's item for the same category shows it too
    await expect(page.getByTestId(`nav-category-${viajes}`)).toHaveAttribute("data-drop-state", "over");
    await page.mouse.up();
    await expect(page.getByTestId("category-snackbar")).toBeVisible();
    const dropped = page.locator(`[data-thread-id="${id}"]`);
    await expect(dropped.locator(`[data-cat-dot="${viajes}"]`)).toHaveCount(1);
    await expect(dropped.locator("[data-cat-dot]")).toHaveCount(1);
    await expect(listPage(page)).toHaveCount(0);
  });
});

test.describe("tabs at narrow widths", () => {
  test("what doesn't fit goes behind More; a category picked there takes a visible place", async ({ app: page, server }) => {
    for (const name of ["Proyectos", "Familia", "Suscripciones", "Bancos", "Colegio", "Seguros"]) await server.backend.server.invoke("categories.create", { name, color: "slate" }, ctx).catch(() => {});
    await page.setViewportSize({ width: 1000, height: 800 });
    const more = page.getByTestId("list-tabs-more");
    await expect(more).toBeVisible();
    // the strip never overflows its row
    const strip = page.locator("[data-testid=list-tabs] [data-drop-scroll]");
    expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await more.click();
    const item = page.locator("[data-testid^=list-tabs-more-]").last();
    const picked = (await item.getAttribute("data-testid"))!.replace("list-tabs-more-", "");
    await item.click();
    await expect(page.getByTestId(`list-tab-${picked}`)).toBeVisible();
    await expect(page.getByTestId(`list-tab-${picked}`)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("List layout: accessibility and look", { tag: "@design" }, () => {
  for (const mode of ["light", "dark"] as const) {
    test(`axe-clean and on baseline (${mode}): the list with tabs, a conversation, a new message`, async ({ app: page }) => {
      await page.emulateMedia({ colorScheme: mode });
      await stabilize(page);
      const wcag = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("iframe");
      const check = async () => expect((await wcag().analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
      await check();
      await expect(page).toHaveScreenshot(`list-${mode}.png`);
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
