/**
 * Plan 15: the quick filters (plan 12's unread filter, generalized): with
 * attachments and starred beside unread. macOS and Atelier choose them from
 * the "Filtered by" menu, Lumen from chips; one state per mailbox either way,
 * the open thread kept while it is open, select-all and the palette included.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, selectedRow, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const db = (server: DevServer) => sqlDb(server.backend.store);
const inboxWhere = (server: DevServer, where: string) => db(server).all<{ id: number }>(`SELECT id FROM threads WHERE in_inbox = 1 AND ${where}`).map((r) => r.id);
const loadedIds = (page: Page) => page.evaluate(() => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds());
const showing = (page: Page, filter: string | null) => expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", new RegExp(`,${filter ? `"${filter}"` : "null"},"[^"]*"\\]$`));

test.describe("macOS: the criterion menu", () => {
  test("Filtered by → With attachments, then Starred: only those rows, the open one kept; the button turns it off", async ({ app: page, server }) => {
    await page.getByTestId("unread-filter").click();
    await showing(page, "unread");
    await page.getByTestId("filter-criterion").click();
    await page.getByTestId("filter-option-attachments").click();
    await showing(page, "attachments");
    await expect(page.getByTestId("filter-criterion")).toContainText("With attachments");
    const open = Number(await selectedRow(page).getAttribute("data-thread-id"));
    const withFiles = new Set(inboxWhere(server, "has_attachments = 1"));
    expect((await loadedIds(page)).filter((id) => id !== open).every((id) => withFiles.has(id))).toBe(true);
    // the count is Unread's alone
    await expect(page.getByTestId("unread-filter-status")).not.toContainText("·");

    await page.getByTestId("filter-criterion").click();
    await page.getByTestId("filter-option-starred").click();
    await showing(page, "starred");
    const starred = new Set(inboxWhere(server, "is_starred = 1"));
    const shown = await loadedIds(page);
    expect(shown.filter((id) => id !== open).every((id) => starred.has(id))).toBe(true);
    // ⌘L from another filter: Unread
    await focusList(page);
    await page.keyboard.press("ControlOrMeta+l");
    await showing(page, "unread");
    await page.getByTestId("unread-filter").click();
    await showing(page, null);
    await expect(page.getByTestId("unread-filter-status")).toHaveCount(0);
  });

  test("a starred thread unstarred while open stays until the selection moves; select-all counts the starred ones", async ({ app: page, server }) => {
    const unstarred = inboxWhere(server, "is_starred = 0").slice(0, 3);
    await server.backend.server.invoke("threads.act", { threadIds: unstarred, action: "star" }, ctx);
    await page.getByTestId("unread-filter").click();
    await page.getByTestId("filter-criterion").click();
    await page.getByTestId("filter-option-starred").click();
    await showing(page, "starred");
    const first = page.locator("[data-testid=thread-row]").first();
    const id = Number(await first.getAttribute("data-thread-id"));
    await first.dispatchEvent("mousedown");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", String(id));
    await focusList(page);
    await page.keyboard.press("s");
    await expect.poll(() => db(server).get<{ s: number }>(`SELECT is_starred AS s FROM threads WHERE id = ${id}`)!.s).toBe(0);
    await expect(page.locator(`[data-thread-id="${id}"]`)).toBeVisible();
    await page.keyboard.press("j");
    await expect(page.locator(`[data-thread-id="${id}"]`)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    const n = inboxWhere(server, "is_starred = 1").length;
    if (n > (await loadedIds(page)).length) await expect(page.getByTestId("select-all-scope-button")).toContainText("Inbox · Starred");
  });

  test("an empty filtered mailbox says what's missing and clears back to everything", async ({ app: page, server }) => {
    const c = (await server.backend.server.invoke("categories.create", { name: "Viajes", color: "violet" }, ctx)) as { id: number };
    await page.locator(`[data-drop-target="${c.id}"]`).click();
    await page.getByTestId("unread-filter").click();
    await page.getByTestId("filter-criterion").click();
    await page.getByTestId("filter-option-attachments").click();
    await expect(page.getByTestId("unread-empty")).toHaveAttribute("data-filter", "attachments");
    await expect(page.getByTestId("unread-empty")).toContainText("No conversations with attachments");
    await page.getByTestId("unread-empty-clear").click();
    await expect(page.getByTestId("unread-filter")).toBeFocused();
    await expect(page.getByTestId("unread-filter")).toHaveAttribute("aria-pressed", "false");
  });

  test("the palette offers the other filters; its ⌘L item does what ⌘L does; Show all turns any filter off", async ({ app: page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-attachments").click();
    await showing(page, "attachments");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("palette-filter-attachments")).toHaveCount(0);
    // with another filter on, ⌘L switches to Unread: so does the item that shows ⌘L (Codex review #6)
    await expect(page.getByTestId("palette-unread-filter")).toContainText("Show unread only");
    await page.getByTestId("palette-unread-filter").click();
    await showing(page, "unread");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-starred").click();
    await showing(page, "starred");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-filter-all").click();
    await showing(page, null);
  });
});

test.describe("Lumen: chips", () => {
  test.use({ design: "lumen" });

  test("one choice at a time, by click or arrow keys; per mailbox, across a reload; axe-clean", async ({ app: page, server }) => {
    const chips = page.getByTestId("quick-filters");
    await expect(chips).toBeVisible();
    await expect(page.getByTestId("unread-filter")).toHaveCount(0);
    await expect(page.getByTestId("quick-filter-all")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("quick-filter-unread").click();
    await showing(page, "unread");
    await expect(page.getByTestId("quick-filter-unread")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("quick-filter-all")).toHaveAttribute("aria-pressed", "false");
    // arrow keys move the focus along the chips; Enter picks
    await page.getByTestId("quick-filter-unread").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("quick-filter-people")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("quick-filter-attachments")).toBeFocused();
    await page.keyboard.press("Enter");
    await showing(page, "attachments");
    // pressing the chosen chip again keeps it (one choice is always on)
    await page.getByTestId("quick-filter-attachments").click();
    await showing(page, "attachments");
    const results = await new AxeBuilder({ page }).include("[data-testid=list-header]").analyze();
    expect(results.violations).toEqual([]);
    await page.getByTestId("nav-archive").click();
    await expect(page.getByTestId("quick-filter-all")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("quick-filter-attachments")).toHaveAttribute("aria-pressed", "true");
    await showing(page, "attachments");
    await page.getByTestId("quick-filter-all").click();
    await showing(page, null);
    void server;
  });

  test("the Starred view has no Starred chip", async ({ app: page }) => {
    await page.getByTestId("nav-starred").click();
    await expect(page.getByTestId("quick-filter-unread")).toBeVisible();
    await expect(page.getByTestId("quick-filter-starred")).toHaveCount(0);
  });
});
