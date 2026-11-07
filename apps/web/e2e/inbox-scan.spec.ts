/**
 * Plan 158: the inbox as a working surface. In every design: enough whole rows at a laptop's size, the three lines of a
 * row, one unread mark, a header that gives way to the list. The filter's state, its overflow and the suggestions' mark
 * go through the design's variants.
 */
import type { Locator } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, fresh, freshNoDrafts, pickFilter, rows, scenario, test } from "./fixtures";

/** Whole rows at 1440x900 with a suggestion and no drafts, the plan's bar. */
const WHOLE_ROWS = { lumen: 10, atelier: 10, macos: 11, graphite: 11, luma: 10 } as const;
const box = async (l: Locator) => (await l.boundingBox())!;
const weight = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).fontWeight));

test.describe("the inbox list", { tag: "@design" }, () => {
  test("enough whole rows, three lines each, one unread mark, and a header that gives way as the list scrolls", async ({ app: page, server, design }) => {
    const list = page.locator("[data-testid=thread-list] [data-keep-scroll=list]");
    const banner = page.getByTestId("learned-banner");
    await scenario("the bar: whole rows under a one-line suggestion that doesn't outrank them", async () => {
      await freshNoDrafts(page, server);
      await expect(banner).toBeVisible();
      expect((await box(banner)).height).toBeLessThanOrEqual(36);
      const whole = await list.evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect();
        return [...el.querySelectorAll("[data-testid=thread-row]")].filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top >= top - 1 && b.bottom <= bottom + 1;
        }).length;
      });
      expect(whole).toBeGreaterThanOrEqual(WHOLE_ROWS[design ?? "macos"]);
    });
    await scenario("a row reads sender, subject, preview, each on its own line; unread is stronger and has one dot, off any avatar; read has none", async () => {
      const unread = page.locator("[data-testid=thread-row][data-unread]").first();
      const read = page.locator("[data-testid=thread-row]:not([data-unread])").first();
      const [from, subject, snippet] = await Promise.all(["row-from", "row-subject", "row-snippet"].map((id) => box(read.getByTestId(id))));
      expect(subject!.y).toBeGreaterThanOrEqual(from!.y + from!.height - 1);
      expect(snippet!.y).toBeGreaterThanOrEqual(subject!.y + subject!.height - 1);
      expect(await weight(unread.getByTestId("row-from"))).toBeGreaterThan(await weight(read.getByTestId("row-from")));
      expect(await weight(unread.getByTestId("row-subject"))).toBeGreaterThan(await weight(read.getByTestId("row-subject")));
      await expect(read.getByTestId("row-unread-dot")).toHaveCount(0);
      await expect(unread.getByTestId("row-unread-dot")).toHaveCount(1);
      const dot = await box(unread.getByTestId("row-unread-dot"));
      const name = await box(unread.getByTestId("row-from"));
      expect(Math.abs(dot.y + dot.height / 2 - (name.y + name.height / 2))).toBeLessThanOrEqual(2);
      expect(dot.x + dot.width).toBeLessThan(name.x);
      const avatar = unread.getByTestId("sender-avatar");
      if (await avatar.count()) expect(dot.x + dot.width).toBeLessThanOrEqual((await box(avatar)).x);
    });
    await scenario("a draft's tag is small, on the row's own scale, and its row's lines stay on the others' rhythm", async () => {
      const list = page.getByRole("listbox");
      const firstRow = rows(page).first();
      await firstRow.dispatchEvent("mousedown");
      await page.getByTestId("reader-subject").waitFor();
      const [fromBefore, subjectBefore, snippetBefore] = await Promise.all(["row-from", "row-subject", "row-snippet"].map((id) => box(firstRow.getByTestId(id))));
      await focusList(page);
      await page.keyboard.press("r");
      await page.getByTestId("compose-body").waitFor();
      await page.keyboard.type("Hola");
      await page.keyboard.press("Escape");
      const tag = firstRow.getByTestId("row-draft");
      await expect(tag).toHaveText("Draft");
      const size = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(await size(tag)).toBeLessThanOrEqual(await size(firstRow.getByTestId("row-subject")));
      const [from, subject, snippet] = await Promise.all(["row-from", "row-subject", "row-snippet"].map((id) => box(firstRow.getByTestId(id))));
      expect([from.y, subject.y, snippet.y]).toEqual([fromBefore!.y, subjectBefore!.y, snippetBefore!.y]);
      await list.evaluate((el) => el.scrollTo(0, 0));
      await freshNoDrafts(page, server);
    });
    await scenario("scrolled, the suggestion and the subtitle give way and the list has their room; at the top they come back", async () => {
      const top = (await box(list)).y;
      await list.evaluate((el) => el.scrollTo(0, 300));
      await expect(banner).toBeHidden();
      await expect.poll(async () => (await box(list)).y).toBeLessThan(top);
      await list.evaluate((el) => el.scrollTo(0, 0));
      await expect(banner).toBeVisible();
      await expect.poll(async () => (await box(list)).y).toBe(top);
    });
  });
});

test.describe("the filters and the suggestions", () => {
  test("one filter control, a real target with its state in words: turning it on moves nothing but itself, every filter is in its menu, × clears it", { tag: "@design" }, async ({ app: page, design }) => {
    test.skip(design === "lumen", "Lumen's filters are chips");
    const title = page.getByTestId("list-title");
    const list = page.locator("[data-testid=thread-list] [data-keep-scroll=list]");
    const control = page.getByTestId("filter-menu");
    const before = await box(title);
    const listTop = (await box(list)).y;
    await expect(control).toHaveText("Filter");
    expect((await box(control)).height).toBeGreaterThanOrEqual(24);
    await control.click();
    for (const f of ["all", "unread", "people", "attachments", "starred"]) await expect(page.getByTestId(`filter-option-${f}`)).toBeVisible();
    await page.getByTestId("filter-option-unread").click();
    await expect(control).toHaveText("Unread");
    expect((await box(title)).y).toBe(before.y);
    expect((await box(list)).y).toBe(listTop);
    expect((await box(page.getByTestId("filter-clear"))).height).toBeGreaterThanOrEqual(24);
    await page.getByTestId("filter-clear").click();
    await expect(control).toHaveText("Filter");
    await expect(control).toBeFocused();
    expect((await box(list)).y).toBe(listTop);
  });

  test("the rule offer says what its button does; a rule comes with Undo, and z or Undo takes it back and brings the offer back", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const rules = () => db.get<{ c: number }>("SELECT count(*) c FROM filters WHERE source = 'learned'")!.c;
    const banner = page.getByTestId("learned-banner");
    const accept = page.getByTestId("learned-accept");
    const before = rules();
    await expect(accept).toHaveText("Create rule");
    await expect(accept).toHaveAccessibleName("Create rule: Always archive daily.morningbrew.com?");
    expect((await box(page.getByTestId("learned-dismiss"))).height).toBeGreaterThanOrEqual(24);
    await accept.click();
    await expect(banner).toHaveCount(0);
    const snack = page.getByTestId("snack");
    await expect(snack).toContainText("Rule created");
    await expect(snack).toContainText("New mail from daily.morningbrew.com is archived from now on.");
    await expect.poll(rules).toBe(before + 1);
    await snack.getByTestId("snack-action").click();
    await expect.poll(rules).toBe(before);
    await expect(banner).toBeVisible();
    // z too
    await accept.click();
    await expect(snack).toContainText("Rule created");
    await expect.poll(rules).toBe(before + 1);
    await page.keyboard.press("z");
    await expect.poll(rules).toBe(before);
    await expect(banner).toBeVisible();
    // a long name is said whole, not cut
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(() => page.getByTestId("learned-line").evaluate((el) => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("the rule offer: one quiet ×, and what it dismisses doesn't come back", async ({ app: page }) => {
    const banner = page.getByTestId("learned-banner");
    await expect(banner).toContainText("daily.morningbrew.com");
    await page.getByTestId("learned-dismiss").click();
    await expect(banner).toHaveCount(0);
    await fresh(page);
    await expect(rows(page).first()).toBeVisible();
    await expect(banner).toHaveCount(0);
  });

  test("a suggestion's mark is quiet and has no digits, a 24 px target named in full, left of the count, in the sidebar's one column of counts", { tag: "@design" }, async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const t = db.get<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1")!.id;
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.8, '[]', ?)", t, facturas, Date.now());
    await fresh(page);
    const badge = page.getByTestId(`nav-review-${facturas}`);
    await expect(badge).toHaveAccessibleName(/Review \d+ suggestions? in Facturas/);
    // one number at rest: the unread count's; how many suggestions is the sentence, on hover and in its name
    await expect(badge).toHaveText("");
    const b = await box(badge);
    expect(b.height).toBeGreaterThanOrEqual(24);
    expect(b.width).toBeGreaterThanOrEqual(24);
    expect(await badge.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await badge.hover();
    await expect(page.locator("[data-slot=tooltip-content]")).toHaveText(/Review \d+ suggestions? in Facturas/);
    const count = (id: string) => page.getByTestId(id).locator("[data-slot=nav-count]");
    const category = await box(count(`nav-category-${facturas}`));
    const inbox = await box(count("nav-inbox"));
    expect(Math.abs(category.x + category.width - (inbox.x + inbox.width))).toBeLessThanOrEqual(1);
    expect(b.x + b.width).toBeLessThanOrEqual(category.x);
  });

  test.describe("Atelier's display title", () => {
    test.use({ design: "atelier" });
    test("a filter that's on stays said while the list scrolls; the subtitle gives way all the same", async ({ app: page }) => {
      const list = page.locator("[data-testid=thread-list] [data-keep-scroll=list]");
      await list.evaluate((el) => el.scrollTo(0, 300));
      await expect(page.getByTestId("list-subtitle")).toBeHidden();
      await list.evaluate((el) => el.scrollTo(0, 0));
      await pickFilter(page, "unread");
      await expect(page.getByTestId("filter-menu")).toHaveText("Unread");
      await list.evaluate((el) => el.scrollTo(0, 300));
      await expect(page.getByTestId("thread-list")).toHaveAttribute("data-scrolled", "");
      await expect(page.getByTestId("filter-menu")).toHaveText("Unread");
      await expect(page.getByTestId("filter-clear")).toBeVisible();
    });
  });

  test.describe("Lumen's chips at a narrow width", () => {
    test.use({ design: "lumen" });
    test("what doesn't fit goes behind More, never clipped; the chip that's on always shows", async ({ app: page }) => {
      await page.setViewportSize({ width: 1100, height: 700 });
      const more = page.getByTestId("quick-filter-more");
      await expect(more).toBeVisible();
      const strip = await box(page.getByTestId("thread-list"));
      for (const chip of await page.getByTestId("quick-filters").getByRole("button").all()) {
        const b = await box(chip);
        expect(b.x + b.width).toBeLessThanOrEqual(strip.x + strip.width);
      }
      await more.click();
      await page.getByRole("menuitemradio", { name: "Starred" }).click();
      const starred = page.getByTestId("quick-filter-starred");
      await expect(starred).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("quick-filter-all").click();
      await expect(page.getByTestId("quick-filter-all")).toHaveAttribute("aria-pressed", "true");
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    test("the title names the mailbox; the hello is the subtitle's first, quiet words", async ({ app: page }) => {
      await expect(page.getByTestId("list-title")).toHaveText("Inbox");
      await expect(page.getByTestId("list-subtitle")).toContainText(/^Good (morning|afternoon|evening) · /);
    });
  });
});
