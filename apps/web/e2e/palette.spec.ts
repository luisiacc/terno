/**
 * Plan 88: the palette. Recent commands lead it, the synonym that matched
 * shows, Reply and Forward are in it, Move to / Add to / Remind me take their
 * value on a page of their own, and a focused draft gets its own commands
 * (the second ⌘K in the text goes past the link popover to them).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, openRow, rows, selectedRow, test } from "./fixtures";

const input = (page: Page) => page.getByTestId("palette-input");
const selected = (page: Page) => page.getByRole("option", { selected: true });
const snackWith = (page: Page, text: string | RegExp) => page.locator("[data-testid=snack]").filter({ hasText: text });
const group = (page: Page, name: string) => page.locator(`[data-group=${name}]`);

async function palette(page: Page, query?: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input(page)).toBeFocused();
  if (query !== undefined) await input(page).fill(query);
}

test.describe("palette", () => {
  test("what you ran leads it under Recent, once; typing hides Recent", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await palette(page);
    await expect(group(page, "recent")).toHaveCount(0);
    await input(page).fill("star or");
    await page.keyboard.press("Enter");
    await palette(page);
    const recent = group(page, "recent");
    await expect(recent.getByRole("option")).toHaveCount(1);
    await expect(recent.getByRole("option").first()).toContainText("Star or unstar");
    // not listed twice
    await expect(page.getByRole("option", { name: /Star or unstar/ })).toHaveCount(1);
    await input(page).fill("sta");
    await expect(group(page, "recent")).toHaveCount(0);
  });

  test("a synonym finds the command and says so", async ({ app: page }) => {
    const id = await rows(page).first().getAttribute("data-thread-id");
    await openRow(page, 0);
    await focusList(page);
    await palette(page, "done");
    await expect(selected(page)).toContainText("Archive conversation");
    await expect(selected(page).getByTestId("palette-alias")).toHaveText("(done)");
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toHaveCount(0);
  });

  test("Reply, Reply all and Forward act on the selected conversation; not on several", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await palette(page, "reply");
    await expect(page.getByTestId("palette-reply")).toBeVisible();
    await page.getByTestId("palette-reply").click();
    await expect(page.getByTestId("composer")).toHaveAccessibleName(/^Reply to /);
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.press("Escape");
    // two checked: no reply to pick between them
    await focusList(page);
    await page.keyboard.press("x");
    await page.keyboard.press("j");
    await page.keyboard.press("x");
    await palette(page, "forward");
    await expect(page.getByTestId("palette-forward")).toHaveCount(0);
  });

  test("Keyboard shortcuts, Spam and All Mail are in it", async ({ app: page }) => {
    await palette(page, "hotkeys");
    await expect(selected(page)).toContainText("Keyboard shortcuts");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await palette(page, "all mail");
    await page.getByTestId("palette-go-all").click();
    await expect(page.getByTestId("list-title")).toHaveText("All Mail");
  });

  test("Move to… takes the category on its own page; Backspace and Esc go back; Esc at the root closes", async ({ app: page, server }) => {
    const viajes = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    const inViajes = (id: string) => sqlDb(server.backend.store).all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ?", Number(id)).map((r) => r.category_id);
    await openRow(page, 1);
    const id = (await selectedRow(page).getAttribute("data-thread-id"))!;
    await focusList(page);
    await palette(page, "move to");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-page")).toHaveText(/Move to/);
    await expect(input(page)).toHaveAttribute("placeholder", "Category…");
    // back, and in again
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("palette-page")).toHaveCount(0);
    await page.getByTestId("palette-move").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-page")).toHaveCount(0);
    await expect(input(page)).toBeVisible();
    await page.getByTestId("palette-move").click();
    await input(page).fill("viaj");
    await expect(selected(page)).toHaveAttribute("data-testid", `palette-move-${viajes}`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(snackWith(page, "Viajes")).toBeVisible();
    await expect.poll(() => inViajes(id)).toEqual([viajes]);
    // moved there already: it can't be picked again
    await palette(page);
    await page.getByTestId("palette-move").click();
    await expect(page.getByTestId(`palette-move-${viajes}`)).toHaveAttribute("aria-disabled", "true");
    // the root's Esc closes
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Enter on the page's chip goes back, and moves nothing", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    await openRow(page, 1);
    const id = Number(await selectedRow(page).getAttribute("data-thread-id"));
    const before = db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ?", id);
    await focusList(page);
    await palette(page, "move to");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-page")).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("palette-page")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-page")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ?", id)).toEqual(before);
  });

  test("⌘K closes from a page or a query; the next ⌘K starts at the root, empty", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await palette(page, "remind");
    await page.getByTestId("palette-remind").click();
    await expect(page.getByTestId("palette-page")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await palette(page);
    await expect(page.getByTestId("palette-page")).toHaveCount(0);
    await expect(input(page)).toHaveValue("");
    await input(page).fill("archive");
    await page.keyboard.press("ControlOrMeta+k");
    await palette(page);
    await expect(input(page)).toHaveValue("");
  });

  test("holding Backspace to clear a page's text stays on the page; a fresh Backspace goes back", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await palette(page, "move to");
    await page.keyboard.press("Enter");
    await input(page).fill("vi");
    // a held key: the repeats after the text is gone don't leave the page
    for (let i = 0; i < 5; i++) await page.keyboard.down("Backspace");
    await page.keyboard.up("Backspace");
    await expect(input(page)).toHaveValue("");
    await expect(page.getByTestId("palette-page")).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("palette-page")).toHaveCount(0);
  });

  test("“move viajes” moves from the root; a bare “viajes” still goes to the category, however often you moved there", async ({ app: page, server }) => {
    const viajes = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    for (const n of [3, 4, 5]) {
      await openRow(page, n);
      await focusList(page);
      await palette(page, "move viajes");
      await expect(selected(page)).toContainText("Move to “Viajes”");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await palette(page, "viajes");
    await expect(selected(page)).toHaveAttribute("data-command", `category:${viajes}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("list-title")).toHaveText("Viajes");
  });

  test("Remind me… sets a preset from its page, with each moment shown", async ({ app: page }) => {
    await openRow(page, 2);
    const id = (await selectedRow(page).getAttribute("data-thread-id"))!;
    await focusList(page);
    await palette(page, "snooze");
    await expect(selected(page)).toContainText("Remind me…");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-page")).toHaveText(/Remind me/);
    await expect(page.getByTestId("palette-remind-always-weekend")).toContainText("Sat 9:00 AM");
    await expect(page.getByTestId("palette-remind-noReply-in3d")).toBeVisible();
    await page.getByTestId("palette-remind-always-tomorrow").click();
    await expect(snackWith(page, "I'll remind you tomorrow at 9:00 AM")).toBeVisible();
    await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`).getByTestId("row-reminder")).toBeVisible();
    // now it has one: the page offers to clear it
    await focusList(page);
    await palette(page, "remind");
    await page.getByTestId("palette-remind").click();
    await page.getByTestId("palette-remind-clear").click();
    await expect(snackWith(page, "Reminder cleared")).toBeVisible();
  });

  test("a focused reply: ⌘K in the text is a link, the second ⌘K the palette with the draft's commands; Add Cc, then Send", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeFocused();
    await page.keyboard.type("Nos vemos el viernes.");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("link-popover")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("link-popover")).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    const draft = group(page, "draft");
    await expect(draft.getByRole("option")).toHaveText([/Send/, /Attach files/, /Add Cc/, /Add Bcc/, /Insert link/, /Discard draft/]);
    await page.getByTestId("palette-draft-cc").click();
    await expect(page.getByTestId("compose-cc")).toBeFocused();
    // from Cc, ⌘K opens the palette directly; Cc is there now, so no "Add Cc"
    await palette(page);
    await expect(page.getByTestId("palette-draft-cc")).toHaveCount(0);
    await input(page).fill("send");
    await expect(selected(page)).toHaveAttribute("data-testid", "palette-draft-send");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(page.getByTestId("quick-reply")).toBeFocused();
    await expect(snackWith(page, "Message sent")).toBeVisible();
  });

  test("the new message is a draft too: Discard from the palette, with Undo", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("compose-to")).toBeFocused();
    await page.getByTestId("compose-body").fill("Borrador de prueba");
    // in the text, the first ⌘K is a link; the second the palette
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("link-popover")).toBeVisible();
    await palette(page, "delete draft");
    await expect(selected(page)).toHaveAttribute("data-testid", "palette-draft-discard");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(snackWith(page, "Draft discarded")).toBeVisible();
  });

  test("no draft group without a focused draft", async ({ app: page }) => {
    await openRow(page, 0);
    await focusList(page);
    await palette(page);
    await expect(group(page, "draft")).toHaveCount(0);
  });

  test("in Spanish the synonyms are Spanish, and the English ones still match", async ({ app: page }) => {
    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("language-select").click();
    await page.getByTestId("language-es").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
    await page.keyboard.press("Escape");
    await openRow(page, 0);
    await focusList(page);
    await palette(page, "listo");
    await expect(selected(page)).toContainText("Archivar conversación");
    await expect(selected(page).getByTestId("palette-alias")).toHaveText("(listo)");
    await input(page).fill("done");
    await expect(selected(page)).toContainText("Archivar conversación");
    // the commands' English names match too, new ones included
    await input(page).fill("forward");
    await expect(selected(page)).toHaveAttribute("data-testid", "palette-forward");
    await input(page).fill("reply all");
    await expect(selected(page)).toHaveAttribute("data-testid", "palette-reply-all");
  });

  for (const mode of ["light", "dark"] as const) {
    test(`a page and the draft group are axe-clean, ${mode}`, async ({ app: page }) => {
      await page.emulateMedia({ colorScheme: mode });
      await openRow(page, 0);
      await focusList(page);
      await palette(page, "remind");
      await page.getByTestId("palette-remind").click();
      const wcag = () => new AxeBuilder({ page }).include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
      expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.getByTestId("compose-to").focus();
      await palette(page);
      await expect(group(page, "draft")).toBeVisible();
      expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
    });
  }
});
