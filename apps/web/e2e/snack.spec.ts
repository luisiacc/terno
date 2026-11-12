/**
 * The docked snackbar (plan 13): one snack at a time, embedded at the bottom
 * of the thread list; its Undo's border is the countdown, which waits
 * while hovered, focused or covered by a dialog. The list keeps room for it.
 */
import type { Page } from "@playwright/test";
import { axeBothModes, expect, focusList, openRow, rows, search, selectedRow, test, searchBox, fresh, scenario, openOffers } from "./fixtures";
import { sqlDb } from "../../backend-dev/src/server";
import { UNDO_KEYS } from "./constants";

const dock = (page: Page) => page.getByTestId("snack");
/** How much of the ring has drained (0–100; the dash moves from 0 to −100). */
const drained = (page: Page) => page.getByTestId("countdown-ring").first().evaluate((p) => -parseFloat(getComputedStyle(p).strokeDashoffset));
/** The ring's Web Animation: paused whenever the store's countdown is (the unit tests hold what that does to the lifetime). */
const ringState = (page: Page) => page.evaluate(() => document.getAnimations().find((a) => a.id === "pill-countdown")?.playState);
const renders = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __renders?: Record<string, number> }).__renders?.[n] ?? 0, name);

async function archiveOne(page: Page, index = 1) {
  await openRow(page, index);
  await focusList(page);
  await page.keyboard.press("e");
  await expect(dock(page)).toContainText("Archived");
}

function handlers(server: { backend: { server: unknown } }) {
  return (server.backend.server as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
}

test.describe("the docked snackbar", () => {
  test("the bar: where it sits, Undo and z, one at a time, F6, an error, the categorization offers", async ({ app: page, server }) => {
    await scenario("archive: in Split the bar sits at the reader's foot, compact, over neither the rows nor the sidebar (plan 158)", async () => {
      await page.mouse.move(1300, 100);
      const listbox = page.getByRole("listbox", { name: "Conversations" });
      const room = await listbox.evaluate((el) => el.scrollHeight);
      await archiveOne(page);
      // plan 63: one line, what could follow behind "Archive similar…" (plan 158; named by its action since plan 173); plan 91: open, one compact line each, as the category snackbar's
      await expect(dock(page).getByTestId("similar-snackbar")).toBeVisible();
      // plan 173 (the owner): the way to more is named by what was just done
      await expect(dock(page).getByTestId("snackbar-similar")).toHaveText("Archive similar…");
      expect((await dock(page).boundingBox())!.height).toBeLessThanOrEqual(40);
      await openOffers(page);
      await page.mouse.move(1300, 100);
      const bar = (await dock(page).boundingBox())!;
      const list = (await page.getByTestId("thread-list").boundingBox())!;
      const reader = (await page.locator("main").boundingBox())!;
      const offers = (await dock(page).getByTestId("similar-offers").boundingBox())!;
      const lines = await dock(page).getByTestId("similar-offers").locator("button").count();
      expect(bar.height - offers.height).toBeLessThanOrEqual(40);
      expect(offers.height).toBeLessThanOrEqual(lines * 28 + 8);
      expect(bar.x).toBeGreaterThanOrEqual(list.x + list.width);
      expect(bar.x + bar.width).toBeLessThanOrEqual(reader.x + reader.width);
      expect(bar.y + bar.height).toBeLessThanOrEqual(reader.y + reader.height);
      expect(bar.y + bar.height).toBeGreaterThan(reader.y + reader.height - 16);
      // the rows keep their room (the reader's end scrolls clear of the bar instead)
      expect(await listbox.evaluate((el) => el.scrollHeight)).toBeLessThanOrEqual(room);
      await expect.poll(() => page.locator("[data-reader-scroller]").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))).toBeGreaterThanOrEqual(bar.height);
      // the action says what it takes back, and z is its key while it is
      const undo = dock(page).getByTestId("snack-action");
      await expect(undo).toHaveAccessibleName("Undo archive");
      await expect(undo).toHaveAttribute("aria-keyshortcuts", UNDO_KEYS);
      // plan 188: and how to reach it, said with it
      await expect(page.getByTestId("snack-live")).toHaveText("Archived. Undo archive: press Z, or F6 to reach it.");
    });
    await scenario("Undo restores the row; z does too and takes the bar with it", async () => {
      await fresh(page);
      const first = await openRow(page, 1);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(0);
      await dock(page).getByTestId("snack-action").click();
      await expect(page.locator(`[data-thread-id="${first}"]`)).toHaveCount(1);
      // plan 158: the offer goes, and a word says it worked, with nothing more to do
      await expect(dock(page)).toHaveText(/Restored 1 conversation/);
      await expect(dock(page).getByTestId("snack-action")).toHaveCount(0);
      // plan 158: the pointer still on it after the click doesn't hold it; another list makes it stale at once
      await page.keyboard.press("Shift+U");
      // (well inside its own 2.5 s)
      await expect(dock(page)).toHaveCount(0, { timeout: 1000 });
      await page.keyboard.press("Shift+A");

      const second = await openRow(page, 2);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(dock(page)).toContainText("Archived");
      await page.keyboard.press("z");
      await expect(page.locator(`[data-thread-id="${second}"]`)).toHaveCount(1);
      await expect(dock(page)).toHaveText(/Restored 1 conversation/);
      // z again has nothing left: the undo ran once
      await page.keyboard.press("z");
      await expect(page.locator(`[data-thread-id="${second}"]`)).toHaveCount(1);
    });
    await scenario("a new snack replaces the current one: one bar, the newest", async () => {
      await fresh(page);
      await archiveOne(page, 1);
      await page.keyboard.press("#");
      await expect(dock(page)).toContainText("Moved to Trash");
      await expect(page.getByTestId("snack-dock").getByTestId("snack-message")).toHaveCount(1);
    });
    await scenario("F6 goes to Undo without the bar ever taking focus; Esc closes it and focus goes back", async () => {
      await fresh(page);
      await page.mouse.move(1300, 100);
      await archiveOne(page);
      // showing it took nothing: focus is where it was
      await expect(page.locator("body")).toBeFocused();
      // from the search field (F6 works while typing), and back to it
      const input = await searchBox(page);
      await input.focus();
      await page.keyboard.press("F6");
      await expect(dock(page).getByTestId("snack-action")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dock(page)).toHaveCount(0);
      await expect(input).toBeFocused();
      // Esc there closed the bar only: the open thread is still open
      await expect(selectedRow(page)).toHaveCount(1);
    });
    await scenario("an error says so assertively, in the destructive ink", async () => {
      await fresh(page);
      const h = handlers(server);
      const original = h["threads.act"]!;
      h["threads.act"] = async () => {
        throw new Error("no connection");
      };
      try {
        await openRow(page, 1);
        await focusList(page);
        await page.keyboard.press("e");
        await expect(dock(page)).toHaveAttribute("data-tone", "error");
        await expect(page.getByTestId("snack-alert")).toContainText("Couldn’t complete: no connection");
        await expect(page.getByTestId("snack-live")).toHaveText("");
      } finally {
        h["threads.act"] = original;
      }
    });
    await scenario("the categorization snackbar lives in the bar: its offers stacked, 1 and z still work", async () => {
      await fresh(page);
      const db = sqlDb(server.backend.store);
      const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first();
      const id = Number(await row.getAttribute("data-thread-id"));
      await row.dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("l");
      await page.getByTestId(`pick-category-${facturas}`).click();
      const snack = page.getByTestId("snack-dock").getByTestId("category-snackbar");
      await expect(snack).toBeVisible();
      await openOffers(page);
      const box = (await dock(page).boundingBox())!;
      const reader = (await page.locator("main").boundingBox())!;
      // plan 81: a title row and one 28 px line per offer; the topic's words get up to two more lines under it
      await expect(snack.getByTestId("snackbar-offers")).toBeVisible();
      const lines = await snack.getByTestId("snackbar-offers").evaluate((el) => el.children.length);
      expect(box.height).toBeLessThanOrEqual(40 + lines * 28 + 2 * 24 + 8);
      expect(box.x).toBeGreaterThanOrEqual(reader.x);
      expect(box.x + box.width).toBeLessThan(reader.x + reader.width);
      expect(box.y + box.height).toBeLessThanOrEqual(reader.y + reader.height);
      await expect(snack.getByTestId("snackbar-undo")).toHaveAccessibleName(/^Undo: Added to Facturas/);
      await page.keyboard.press("z");
      await expect(snack).toHaveCount(0);
      await expect(dock(page)).toContainText("Undone: Facturas");
      await expect.poll(() => db.get("SELECT 1 FROM thread_categories WHERE thread_id = ? AND category_id = ?", id, facturas)).toBeUndefined();
    });
  });

  test("the ring drains over the lifetime and holds while hovered; it goes when it's over", async ({ app: page }) => {
    // flowing (reduced motion steps it once a second: motion.spec)
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    // the ring's offset is set on its first frame: until then it reads as nothing (NaN), not as full
    // (the value the poll saw: the ring can restart between two reads, and read as nothing again)
    let a = NaN;
    await expect.poll(async () => (a = await drained(page))).not.toBeNaN();
    await expect.poll(() => drained(page)).toBeGreaterThan(a + 5);
    await dock(page).hover();
    await expect.poll(() => ringState(page)).toBe("paused");
    const c = await drained(page);
    // past its whole lifetime on the page's clock (the store's timer, what expires it) and a moment on the ring's own
    await page.clock.fastForward(7000);
    await page.waitForTimeout(100);
    expect(Math.abs((await drained(page)) - c)).toBeLessThan(0.5);
    await expect(dock(page)).toContainText("Archived");
    // the rows don't re-render while it counts down
    const before = await renders(page, "ThreadRow");
    await page.mouse.move(1300, 100);
    await expect.poll(() => drained(page)).toBeGreaterThan(c + 5);
    expect(await renders(page, "ThreadRow")).toBe(before);
    await page.clock.fastForward(7000);
    await expect(dock(page)).toHaveCount(0);
  });

  test("the ring's drained part is a faint track on the pill, in light and dark (plan 161, the owner)", { tag: "@design" }, async ({ app: page }) => {
    await page.mouse.move(1300, 100);
    await archiveOne(page);
    await expect(page.getByTestId("countdown-ring")).toBeVisible();
    // held while focused (a program's focus: no ring), so both modes are read on the same snack
    await dock(page).getByTestId("snack-action").focus();
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      // what the eye sees: the track painted over the pill's card over the dock, against the card alone; and the ring
      const [track, ring] = await page.getByTestId("countdown-ring").evaluate((ringPath) => {
        const pill = ringPath.closest("button")!;
        const surface = pill.closest<HTMLElement>(".snack-surface")!;
        const trackPath = ringPath.previousElementSibling as SVGPathElement;
        const x = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
        const paint = (...colors: string[]) => {
          x.clearRect(0, 0, 1, 1);
          for (const c of colors) {
            x.fillStyle = "#000";
            x.fillStyle = c;
            x.fillRect(0, 0, 1, 1);
          }
          return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const lum = (rgb: number[]) => rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        const under = [getComputedStyle(surface).backgroundColor, getComputedStyle(pill).backgroundColor];
        const card = paint(...under);
        return [ratio(paint(...under, getComputedStyle(trackPath).stroke), card), ratio(paint(...under, getComputedStyle(ringPath).stroke), card)];
      });
      // contrast.ts SNACK_TRACK_FLOOR (1.8), less a little for the page's 8-bit blend; and a track, never the time left
      expect(track, mode).toBeGreaterThanOrEqual(1.75);
      expect(track, mode).toBeLessThanOrEqual(ring / 2);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test.describe("List: the bar over the one pane", () => {
  // plan 158: Split's bar is over the reader; List's is over its rows, which keep room under them for it
  test.use({ layout: "list" });
  test("the last row and the keyboard's row stay above the bar, and above the taller categorization bar", async ({ app: page, server }) => {
    await scenario("the last row and the keyboard's row stay above the bar", async () => {
      // a sender with a few screens of mail: the list has an end
      const { email } = sqlDb(server.backend.store).get<{ email: string }>(
        "SELECT last_from_email AS email FROM threads WHERE in_inbox = 1 GROUP BY 1 HAVING count(*) BETWEEN 20 AND 90 ORDER BY count(*) DESC LIMIT 1",
      )!;
      await search(page, `in:inbox from:${email}`);
      // List: the cursor is placed, not opened (a click would open its page)
      await rows(page).nth(1).dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("e");
      await expect(dock(page)).toContainText("Archived");
      // the pointer over the bar keeps it up for as long as this takes
      await dock(page).hover();
      const top = (await dock(page).boundingBox())!.y;
      // scrolled to the end, the last row ends above the bar
      const list = page.getByRole("listbox", { name: "Conversations" });
      let height = -1;
      for (let i = 0; i < 20 && height !== (await list.evaluate((el) => el.scrollHeight)); i++) {
        height = await list.evaluate((el) => el.scrollHeight);
        await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await page.waitForTimeout(150);
      }
      const last = (await rows(page).last().boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(top + 0.5);
      // back at the top: j onto the row under the bar brings it up above it
      await list.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(100);
      const boxes = await rows(page).evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-thread-id"), ...e.getBoundingClientRect().toJSON() })));
      const under = boxes.findIndex((b) => b.y + b.height > top);
      expect(under).toBeGreaterThan(0);
      await page.locator(`[data-thread-id="${boxes[under - 1]!.id}"]`).dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("j");
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", boxes[under]!.id!);
      await page.waitForTimeout(100);
      const sel = (await selectedRow(page).boundingBox())!;
      expect(sel.y + sel.height).toBeLessThanOrEqual(top + 0.5);
    });
    await scenario("plan 81: the taller categorization bar still leaves the last row and the keyboard's row above it", async () => {
      await fresh(page);
      const db = sqlDb(server.backend.store);
      const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      const { email } = db.get<{ email: string }>(
        "SELECT last_from_email AS email FROM threads WHERE in_inbox = 1 GROUP BY 1 HAVING count(*) BETWEEN 20 AND 90 ORDER BY count(*) DESC LIMIT 1",
      )!;
      await search(page, `in:inbox from:${email}`);
      await rows(page).first().dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("l");
      await page.getByTestId(`pick-category-${facturas}`).click();
      const snack = dock(page).getByTestId("category-snackbar");
      await openOffers(page);
      await expect(snack.getByTestId("snackbar-count-loading")).toHaveCount(0);
      await dock(page).hover();
      const top = (await dock(page).boundingBox())!.y;
      const list = page.getByRole("listbox", { name: "Conversations" });
      let height = -1;
      for (let i = 0; i < 20 && height !== (await list.evaluate((el) => el.scrollHeight)); i++) {
        height = await list.evaluate((el) => el.scrollHeight);
        await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await page.waitForTimeout(150);
      }
      const last = (await rows(page).last().boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(top + 0.5);
      await list.evaluate((el) => (el.scrollTop = 0));
      await page.waitForTimeout(100);
      const boxes = await rows(page).evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-thread-id"), ...e.getBoundingClientRect().toJSON() })));
      const under = boxes.findIndex((b) => b.y + b.height > top);
      expect(under).toBeGreaterThan(0);
      await page.locator(`[data-thread-id="${boxes[under - 1]!.id}"]`).dispatchEvent("mousedown");
      await focusList(page);
      await page.keyboard.press("j");
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", boxes[under]!.id!);
      await page.waitForTimeout(100);
      const sel = (await selectedRow(page).boundingBox())!;
      expect(sel.y + sel.height).toBeLessThanOrEqual(top + 0.5);
    });
  });
  });

  test("the countdown waits under a dialog, and under any modal", async ({ app: page }) => {
    await scenario("a dialog over the app holds the countdown; the bar is still there after it closes", async () => {
      await page.mouse.move(1300, 100);
      await archiveOne(page);
      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("settings-dialog")).toBeVisible();
      const held = await drained(page);
      await expect.poll(() => ringState(page)).toBe("paused");
      await page.clock.fastForward(6500);
      expect(Math.abs((await drained(page)) - held)).toBeLessThan(0.5);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
      await expect(dock(page)).toContainText("Archived");
    });
    await scenario("any modal holds it, not only the app's dialogs: Base UI's aria-hidden on the bar is the signal; F6 waits too", async () => {
      await fresh(page);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.mouse.move(1300, 100);
      await archiveOne(page);
      // a modal marks the bar hidden (the first run and a report preview aren't app dialogs)
      const hidden = () => dock(page).evaluate((el) => el.closest("[aria-hidden=true]") !== null);
      await page.getByTestId("open-settings").click();
      // (on the card, or on the reader column that holds it)
      await expect.poll(hidden).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(hidden).toBe(false);
      // the same mark without an app dialog behind it holds the countdown and keeps F6 out
      await dock(page).evaluate((el) => el.setAttribute("aria-hidden", "true"));
      await expect.poll(() => ringState(page)).toBe("paused");
      const held = await drained(page);
      await page.clock.fastForward(7000);
      await page.waitForTimeout(100);
      expect(Math.abs((await drained(page)) - held)).toBeLessThan(0.5);
      await page.keyboard.press("F6");
      await expect(dock(page).getByTestId("snack-action")).not.toBeFocused();
      await dock(page).evaluate((el) => el.removeAttribute("aria-hidden"));
      await expect.poll(() => drained(page)).toBeGreaterThan(held + 3);
    });
  });

  test("a slow bulk undo's outcome waits behind what the user did meanwhile", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const target = db.get<{ id: number }>(
      `SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_email = 'uber.receipts@uber.com'
       AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id AND category_id = ?) ORDER BY t.last_date DESC LIMIT 1`,
      facturas,
    )!.id;
    await search(page, "in:inbox from:uber.receipts@uber.com");
    await page.locator(`[data-thread-id="${target}"]`).dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    await openOffers(page);
    await expect(page.getByTestId("snackbar-sender-count")).toBeVisible();
    await focusList(page);
    await page.keyboard.press("1");
    await expect(dock(page)).toContainText("added to Facturas");
    // the bulk undo is slow; meanwhile the user archives something
    const h = handlers(server);
    const original = h["categorize.undo"]!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let answered!: () => void;
    const answer = new Promise<void>((r) => (answered = r));
    h["categorize.undo"] = async (...args: unknown[]) => {
      await gate;
      const r = await original(...args);
      answered();
      return r;
    };
    try {
      await dock(page).getByTestId("snack-action").click();
      await openRow(page, 1);
      await focusList(page);
      await page.keyboard.press("e");
      await expect(dock(page)).toContainText("Archived");
      release();
      await answer;
      // (the answer's on its way to the page: a frame or two)
      await page.waitForTimeout(100);
      await expect(dock(page)).toContainText("Archived");
      await dock(page).getByTestId("snack-close").click();
      // plan 81: 1 is "now and future mail"; its undo says so in one line
      await expect(dock(page)).toContainText("Undone: Facturas");
    } finally {
      release();
      h["categorize.undo"] = original;
    }
  });

  test("axe: plain, error and categorization bars, in light and dark", async ({ app: page, server }) => {
    await page.mouse.move(1300, 100);
    const check = () => axeBothModes(page, "[data-testid=snack-dock]");
    await archiveOne(page);
    await dock(page).hover();
    await check();
    await page.mouse.move(1300, 100);
    const h = handlers(server);
    const original = h["threads.act"]!;
    h["threads.act"] = async () => {
      throw new Error("no connection");
    };
    await openRow(page, 2);
    await focusList(page);
    await page.keyboard.press("e");
    await expect(dock(page)).toHaveAttribute("data-tone", "error");
    await check();
    h["threads.act"] = original;
    const facturas = sqlDb(server.backend.store).get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${facturas}"]))`).first().dispatchEvent("mousedown");
    await focusList(page);
    await page.keyboard.press("l");
    await page.getByTestId(`pick-category-${facturas}`).click();
    await openOffers(page);
    await expect(page.getByTestId("snackbar-sender-count")).toBeVisible();
    await check();
  });
});
