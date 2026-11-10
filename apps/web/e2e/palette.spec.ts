/**
 * Plan 88: the palette. Recent commands lead it, the synonym that matched
 * shows, Reply and Forward are in it, Move to / Add to / Remind me take their
 * value on a page of their own, and a focused draft gets its own commands
 * (⌘K in the text too: ⌘L is the link).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, openRow, rows, selectedRow, test, fresh, scenario } from "./fixtures";

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
  test("it finds actions by the app's own words, hugs what it holds, and a name or subject offers mail (plan 158)", async ({ app: page, server }) => {
    const accountId = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")!.id;
    await server.backend.store.sync.ingest([{
      accountId, providerMsgId: "pal-1", providerThreadId: "pal", rfcMessageId: "<pal-1@e2e.test>", inReplyTo: null, references: [],
      from: { name: "Zzisabel Quintana", email: "zzisabel@else.example" }, to: [{ name: "Luis", email: "luis@else.example" }], cc: [], bcc: [],
      subject: "Sobre el concierto", date: 1, snippet: "", bodyText: "Hola.", bodyHtml: null, bodyState: "full", listId: null,
      isRead: true, isStarred: false, inInbox: false, isSent: false, isDraft: false, isTrash: false, isSpam: false, hasAttachments: false, size: 100,
    }], { applyFilters: false, now: 1, classifier: null });
    await openRow(page, 0);
    await focusList(page);
    await scenario("compose finds New message, said why; new finds it by name, with nothing after it; the rest of the main words", async () => {
      await palette(page, "compose");
      await expect(selected(page)).toHaveAttribute("data-testid", "palette-compose");
      await expect(selected(page).getByTestId("palette-alias")).toHaveText("(compose)");
      await input(page).fill("new");
      await expect(selected(page)).toContainText("New message");
      await expect(selected(page).getByTestId("palette-alias")).toHaveCount(0);
      for (const [word, command] of [["respond", "compose.reply"], ["fwd", "compose.forward"], ["done", "thread.archive"], ["preferences", "settings:general"], ["search", "search.focus"]]) {
        await input(page).fill(word!);
        await expect(selected(page), word).toHaveAttribute("data-command", command!);
      }
    });
    await scenario("the panel is as tall as what it holds, the field where it was, and Search mail goes to the field", async () => {
      const list = page.locator("[data-slot=command-list]");
      await input(page).fill("");
      const full = (await list.boundingBox())!.height;
      const field = (await input(page).boundingBox())!.y;
      await input(page).fill("search");
      await expect(page.getByTestId("palette-search-mail")).toBeVisible();
      expect((await list.boundingBox())!.height).toBeLessThan(full / 2);
      expect((await input(page).boundingBox())!.y).toBe(field);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("search-input")).toBeFocused();
      await page.keyboard.press("Escape");
      await focusList(page);
    });
    await scenario("a person's name: the search first, then their conversations; choosing one opens it in those results", async () => {
      // from a new message in the pane too: it steps aside for the conversation, as for a click on a row
      await page.keyboard.press("c");
      await expect(page.getByTestId("compose-to")).toBeVisible();
      await palette(page, "zzisabel");
      await expect(selected(page)).toHaveAttribute("data-testid", "palette-search-row");
      await expect(selected(page)).toHaveText("Search mail for “zzisabel”");
      const found = page.getByTestId("palette-mail");
      await expect(found).toHaveCount(1);
      await expect(found).toContainText("Sobre el concierto");
      // a row still on screen under what's typed next opens among its own results, and leaves no selection to act on instead
      await page.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>("[data-testid=palette-input]")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "zzotra cosa");
        field.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector<HTMLElement>("[data-testid=palette-mail]")!.click();
      });
      await expect(page.getByTestId("search-input")).toHaveValue("zzisabel");
      await expect(page.getByTestId("reader-subject")).toHaveText("Sobre el concierto");
      await expect(selectedRow(page)).toContainText("Zzisabel Quintana");
    });
    await scenario("Enter on the search row runs the search; Spam and Trash aren't offered", async () => {
      await fresh(page);
      // the filter the results will keep: read mail isn't offered with Unread on
      await focusList(page);
      await page.keyboard.press("Shift+U");
      await palette(page, "zzisabel");
      await page.waitForTimeout(400);
      await expect(page.getByTestId("palette-mail")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await focusList(page);
      await page.keyboard.press("Shift+A");
      const id = sqlDb(server.backend.store).get<{ id: number }>("SELECT thread_id id FROM messages WHERE from_email = 'zzisabel@else.example'")!.id;
      await server.backend.store.threads.act({ threadIds: [id], action: "spam", signal: null, now: 2 });
      await focusList(page);
      await palette(page, "zzisabel");
      await page.waitForTimeout(400);
      await expect(page.getByTestId("palette-mail")).toHaveCount(0);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("search-input")).toHaveValue("zzisabel");
    });
  });

  test("commands: Recent, a synonym, Reply and Forward, what's in it, no draft group, and in Spanish", async ({ app: page }) => {
    await scenario("what you ran leads it under Recent, once; typing hides Recent", async () => {
      await openRow(page, 0);
      await focusList(page);
      await palette(page);
      await expect(group(page, "recent")).toHaveCount(0);
      await input(page).fill("search");
      await expect(page.getByTestId("palette-search-mail")).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("search-input")).toBeFocused();
      await page.keyboard.press("Escape");
      await openRow(page, 0);
      await focusList(page);
      await palette(page);
      const recent = group(page, "recent");
      await expect(recent.getByRole("option")).toHaveCount(1);
      await expect(recent.getByRole("option").first()).toHaveAttribute("data-command", "search.focus");
      // not listed twice, and under the conversation's own actions: Enter on opening is Archive whatever ran before (plan 158)
      await expect(page.locator("[data-command=\"search.focus\"]")).toHaveCount(1);
      await expect(selected(page)).toHaveAttribute("data-command", "thread.archive");
      await input(page).fill("sta");
      await expect(group(page, "recent")).toHaveCount(0);
    });
    await scenario("with a conversation open: its actions first, one row per intent, no \"No results\" above a search", async () => {
      await fresh(page);
      await openRow(page, 0);
      await focusList(page);
      await palette(page);
      await expect(page.locator("[data-group=conversation] [role=option]").first()).toHaveAttribute("data-command", "thread.archive");
      await expect(page.locator("[data-group=goTo]")).toContainText("Reminders");
      await expect(page.locator("[data-group=goTo]")).not.toContainText("Go to Reminders");
      await input(page).fill("arch");
      await expect(selected(page)).toHaveAttribute("data-command", "thread.archive");
      await input(page).fill("go to reminders");
      await expect(selected(page)).toHaveAttribute("data-testid", "palette-go-reminders");
      await input(page).fill("star");
      await expect(page.locator("[data-command=\"go.starred\"]")).toHaveCount(1);
      // the action is what it would do, and "star" finds it either way
      await expect(selected(page)).toHaveAttribute("data-command", "thread.star");
      const was = (await selected(page).textContent())!.includes("Unstar");
      await page.keyboard.press("Enter");
      await palette(page, "star");
      await expect(selected(page)).toHaveAttribute("data-command", "thread.star");
      await expect(selected(page)).toContainText(was ? /\bStar/ : "Unstar");
      await page.keyboard.press("Enter");
      await palette(page);
      await input(page).fill("star");
      await expect(page.getByTestId("palette-filter-starred")).toHaveCount(0);
      await expect(page.locator("[data-command^=design]")).toHaveCount(0);
      await input(page).fill("zqxpago");
      await expect(page.locator("[data-command]")).toHaveCount(0);
      await expect(selected(page)).toContainText("zqxpago");
      await expect(page.locator("[cmdk-empty]")).toHaveCount(0);
      await page.keyboard.press("Escape");
    });
    await scenario("plan 158: a checked row beside another open one isn't named over the open one's actions", async () => {
      await fresh(page);
      await openRow(page, 0);
      await rows(page).nth(1).click({ modifiers: ["Meta"] });
      await rows(page).nth(0).click({ modifiers: ["Meta"] });
      await focusList(page);
      await palette(page);
      await expect(page.getByTestId("palette-print")).toBeVisible();
      await expect(page.getByTestId("palette-target")).toHaveCount(0);
      await page.keyboard.press("Escape");
    });
    await scenario("a synonym finds the command and says so", async () => {
      await fresh(page);
      const id = await rows(page).first().getAttribute("data-thread-id");
      await openRow(page, 0);
      await focusList(page);
      await palette(page, "done");
      await expect(selected(page)).toContainText("Archive");
      // plan 158: the conversation it acts on heads the actions
      await expect(page.getByTestId("palette-target")).toContainText((await rows(page).first().getByTestId("row-subject").textContent())!);
      await expect(selected(page).getByTestId("palette-alias")).toHaveText("(done)");
      await page.keyboard.press("Enter");
      await expect(page.locator(`[data-testid=thread-row][data-thread-id="${id}"]`)).toHaveCount(0);
    });
    await scenario("Reply, Reply all and Forward act on the selected conversation; not on several", async () => {
      await fresh(page);
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
    await scenario("Keyboard shortcuts, Spam and All Mail are in it", async () => {
      await fresh(page);
      await palette(page, "hotkeys");
      await expect(selected(page)).toContainText("Keyboard shortcuts");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
      await page.keyboard.press("Escape");
      await palette(page, "all mail");
      await page.getByTestId("palette-go-all").click();
      await expect(page.getByTestId("list-title")).toHaveText("All Mail");
    });
    await scenario("no draft group without a focused draft", async () => {
      await fresh(page);
      await openRow(page, 0);
      await focusList(page);
      await palette(page);
      await expect(group(page, "draft")).toHaveCount(0);
    });
    await scenario("in Spanish the synonyms are Spanish, and the English ones still match", async () => {
      await fresh(page);
      await page.keyboard.press("Meta+Comma");
      await page.getByTestId("language-select").click();
      await page.getByTestId("language-es").click();
      await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
      await page.keyboard.press("Escape");
      await openRow(page, 0);
      await focusList(page);
      await palette(page, "listo");
      await expect(selected(page)).toContainText("Archivar");
      await expect(selected(page).getByTestId("palette-alias")).toHaveText("(listo)");
      await input(page).fill("done");
      await expect(selected(page)).toContainText("Archivar");
      // the commands' English names match too, new ones included
      await input(page).fill("forward");
      await expect(selected(page)).toHaveAttribute("data-testid", "palette-forward");
      await input(page).fill("reply all");
      await expect(selected(page)).toHaveAttribute("data-testid", "palette-reply-all");
    });
  });

  test("pages: Move to…, Remind me…, going back, ⌘K closes, held Backspace, “move viajes”", async ({ app: page, server }) => {
    await scenario("Move to… takes the category on its own page; Backspace and Esc go back; Esc at the root closes", async () => {
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
    await scenario("Enter on the page's chip goes back, and moves nothing", async () => {
      await fresh(page);
      const db = sqlDb(server.backend.store);
      await openRow(page, 1);
      const id = Number(await selectedRow(page).getAttribute("data-thread-id"));
      const before = db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ?", id);
      await focusList(page);
      await palette(page, "move to");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette-page")).toBeVisible();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("palette-back")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("palette-page")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(db.all<{ category_id: number }>("SELECT category_id FROM thread_categories WHERE thread_id = ?", id)).toEqual(before);
    });
    await scenario("⌘K closes from a page or a query; the next ⌘K starts at the root, empty", async () => {
      await fresh(page);
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
    await scenario("holding Backspace to clear a page's text stays on the page; a fresh Backspace goes back", async () => {
      await fresh(page);
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
    await scenario("“move viajes” moves from the root; a bare “viajes” still goes to the category, however often you moved there", async () => {
      await fresh(page);
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
    await scenario("Remind me… sets a preset from its page, with each moment shown", async () => {
      await fresh(page);
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
  });

  test("a draft's commands: a focused reply, and a new message", async ({ app: page }) => {
    await scenario("a focused reply: ⌘K in the text is the palette with the draft's commands; Add Cc, then Send", async () => {
      await openRow(page, 0);
      await focusList(page);
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.type("Nos vemos el viernes.");
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByTestId("link-popover")).toHaveCount(0);
      await expect(input(page)).toBeFocused();
      const draft = group(page, "draft");
      await expect(draft.getByRole("option")).toHaveText([/Send/, /Draft with AI/, /Insert snippet/, /Attach files/, /Add Cc/, /Add Bcc/, /Insert link/, /Save as snippet/, /Pin draft/, /Discard draft/]);
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
    await scenario("the new message is a draft too: Discard from the palette, with Undo", async () => {
      await fresh(page);
      await focusList(page);
      await page.keyboard.press("c");
      await expect(page.getByTestId("compose-to")).toBeFocused();
      await page.getByTestId("compose-body").fill("Borrador de prueba");
      // ⌘L's link popover: ⌘K from it goes on to the palette
      await page.keyboard.press("ControlOrMeta+l");
      await expect(page.getByTestId("link-popover")).toBeVisible();
      await palette(page, "delete draft");
      await expect(selected(page)).toHaveAttribute("data-testid", "palette-draft-discard");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("composer")).toHaveCount(0);
      await expect(snackWith(page, "Draft discarded")).toBeVisible();
    });
  });

  test.describe("with motion", () => {
    // the dialog fades out: what's typed during its exit must reach the app
    test.use({ reducedMotion: "no-preference" });
    test("closed, the keys leave it at once: ⌘K, Esc, R replies (no wait for its exit)", async ({ app: page }) => {
      // every page focuses its field (the owner), so while the dialog faded out a key pressed right after Esc went into it;
      // and the palette's own focus guard, still listening until React commits, pulled the handed-back keys in again (Codex review)
      await openRow(page, 0);
      await focusList(page);
      await palette(page);
      await page.keyboard.press("Escape");
      await page.keyboard.press("r");
      await expect(page.getByTestId("compose-body")).toBeFocused();
    });
  });

  test("a page and the draft group are axe-clean, in light and dark", async ({ app: page }) => {
    for (const mode of ["light", "dark"] as const) {
      await scenario(mode, async () => {
        await fresh(page);
        await page.emulateMedia({ colorScheme: mode });
        await openRow(page, 0);
        await focusList(page);
        await palette(page, "remind");
        await page.getByTestId("palette-remind").click();
        const wcag = () => new AxeBuilder({ page }).setLegacyMode().include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
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
});
