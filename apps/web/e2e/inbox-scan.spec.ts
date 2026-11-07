/**
 * Plan 158: the inbox as a working surface. In every design: enough whole rows at a laptop's size, the three lines of a
 * row, one unread mark, a header that gives way to the list. The filter's state, its overflow and the suggestions' mark
 * go through the design's variants.
 */
import type { Locator } from "@playwright/test";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, fresh, freshNoDrafts, pickFilter, rows, scenario, test, expectFilter } from "./fixtures";

/** Whole rows at 1440x900 with a suggestion and no drafts, the plan's bar. */
const WHOLE_ROWS = { lumen: 10, atelier: 10, macos: 12, graphite: 12, luma: 10 } as const;
/** And at 1100x700 (plan 158: the header gives its spare room to the rows there; the offer is the list's first item) */
const SMALL_ROWS = { lumen: 8, atelier: 8, macos: 9, graphite: 9, luma: 8 } as const;
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
      const whole = () => list.evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect();
        return [...el.querySelectorAll("[data-testid=thread-row]")].filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top >= top - 1 && b.bottom <= bottom + 1;
        }).length;
      });
      expect(await whole()).toBeGreaterThanOrEqual(WHOLE_ROWS[design ?? "macos"]);
      // a laptop's small window still shows a useful list
      await page.setViewportSize({ width: 1100, height: 700 });
      await expect.poll(whole).toBeGreaterThanOrEqual(SMALL_ROWS[design ?? "macos"]);
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await scenario("a row reads sender, subject, preview, each on its own line; unread is stronger and has one dot, off any avatar; read has none", async () => {
      const unread = page.locator("[data-testid=thread-row][data-unread]").first();
      const read = page.locator("[data-testid=thread-row]:not([data-unread])").first();
      const [from, subject, snippet] = await Promise.all(["row-from", "row-subject", "row-snippet"].map((id) => box(read.getByTestId(id))));
      expect(subject!.y).toBeGreaterThanOrEqual(from!.y + from!.height - 1);
      expect(snippet!.y).toBeGreaterThanOrEqual(subject!.y + subject!.height - 1);
      expect(await weight(unread.getByTestId("row-from"))).toBeGreaterThan(await weight(read.getByTestId("row-from")));
      expect(await weight(unread.getByTestId("row-subject"))).toBeGreaterThan(await weight(read.getByTestId("row-subject")));
      // plan 158: a read row has a hierarchy too: the sender anchors it (heavier than the subject, in the same ink), the preview is quieter
      const ink = (id: string) => read.getByTestId(id).evaluate((el) => getComputedStyle(el).color);
      expect(await weight(read.getByTestId("row-from"))).toBeGreaterThan(await weight(read.getByTestId("row-subject")));
      expect(await ink("row-from")).toBe(await ink("row-subject"));
      expect(await ink("row-snippet")).not.toBe(await ink("row-subject"));
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
    await scenario("the suggestion is the list's first item: it goes up with the rows, and comes back at the top", async () => {
      const first = rows(page).first();
      const gap = async () => (await box(first)).y - ((await box(banner)).y + (await box(banner)).height);
      const at = await gap();
      expect(at).toBeGreaterThanOrEqual(-1);
      // part way: it moved as far as the rows did (in the list: a display header's subtitle gives way too, moving the list)
      const inList = () => list.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const y = (id: string) => el.parentElement!.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect().top - top;
        return { banner: y("learned-banner"), row: y("thread-row") };
      });
      const before = await inList();
      await list.evaluate((el) => el.scrollTo(0, 12));
      await expect.poll(async () => before.row - (await inList()).row).toBe(12);
      // (it follows the scroll event, which comes with the next frame)
      await expect.poll(async () => before.banner - (await inList()).banner).toBe(12);
      await list.evaluate((el) => el.scrollTo(0, 300));
      await expect(banner).toBeHidden();
      // its room above the rows takes no pointer once it's gone: what's there is a row (Codex review)
      const hit = await list.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + 10)?.closest("[data-testid=thread-row]") !== null;
      });
      expect(hit).toBe(true);
      // gone while scrolled (here dismissed elsewhere): the mail on screen doesn't move
      const proposal = (await server.backend.server.invoke("learning.proposals", {}, { clientId: "setup", origin: "dev" })) as { key: string }[];
      const firstRow = () => list.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = [...el.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].filter((r) => r.getBoundingClientRect().bottom > top + 0.5).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
        return [row.dataset.threadId, Math.round(row.getBoundingClientRect().top)];
      });
      const was = await firstRow();
      await server.backend.server.invoke("learning.dismiss", { key: proposal[0]!.key }, { clientId: "setup", origin: "dev" });
      const someRow = Number(await rows(page).first().getAttribute("data-thread-id"));
      server.backend.notifyChanged([someRow]);
      await expect(banner).toHaveCount(0);
      expect(await firstRow()).toEqual(was);
      // back while scrolled: nothing on screen moves either
      sqlDb(server.backend.store).run("DELETE FROM dismissed_suggestions WHERE key = ?", proposal[0]!.key);
      server.backend.notifyChanged([someRow]);
      await expect(banner).toHaveCount(1);
      expect(await firstRow()).toEqual(was);
      // reached by Tab while partly scrolled away, it comes back whole (second Codex review)
      await list.evaluate((el) => el.scrollTo(0, 20));
      await page.getByTestId("learned-accept").focus();
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
      // gone at the list's very end, where the shorter list clamps the offset first (second Codex review). Lumen's greeting
      // asks for the counts again when the window comes back, so the offer is asked for again with no refresh of the rows
      // (a refresh at the end of a long list moves it on its own)
      if (design === "lumen") {
        const loaded = () => page.evaluate(() => (window as unknown as { __terno: { loadedIds(): number[] } }).__terno.loadedIds().length);
        for (let i = 0, same = 0, count = -1; i < 120 && same < 3; i++) {
          await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
          await page.waitForTimeout(250);
          const n = await loaded();
          same = n === count ? same + 1 : 0;
          count = n;
        }
        await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        // the last row in view (the rendered ones run past it)
        const lastRow = () => list.evaluate((el) => {
          const bottom = el.getBoundingClientRect().bottom;
          const row = [...el.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].filter((r) => r.getBoundingClientRect().top < bottom - 1).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).at(-1)!;
          return [row.dataset.threadId, Math.round(row.getBoundingClientRect().top)];
        });
        const end = await lastRow();
        await server.backend.server.invoke("learning.dismiss", { key: proposal[0]!.key }, { clientId: "setup", origin: "dev" });
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect(banner).toHaveCount(0);
        expect(await lastRow()).toEqual(end);
      }
    });
  });
});

test.describe("the filters and the suggestions", () => {
  test("a row a filter keeps only because it's open says so; g i in the Inbox keeps the cursor and the conversation", async ({ app: page }) => {
    const first = rows(page).first();
    const id = await first.getAttribute("data-thread-id");
    await first.dispatchEvent("mousedown");
    await page.getByTestId("reader-subject").waitFor();
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.locator("[data-testid=thread-row][data-cursor]")).toHaveAttribute("data-thread-id", id!);
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await pickFilter(page, "attachments");
    const open = page.locator(`[data-thread-id="${id}"]`);
    await expect(open.getByTestId("row-kept")).toHaveText("Opened");
    await expect(page.locator("[data-testid=row-kept]")).toHaveCount(1);
    await page.getByTestId("filter-segment-all").click();
    await expect(page.locator("[data-testid=row-kept]")).toHaveCount(0);
  });

  test("Unread in one click, the rest behind More filters; nothing in the header changes shape with a filter", { tag: "@design" }, async ({ app: page, design }) => {
    test.skip(design === "lumen", "Lumen's filters are chips");
    const header = page.getByTestId("list-header");
    const list = page.locator("[data-testid=thread-list] [data-keep-scroll=list]");
    const segments = page.getByTestId("filter-segments");
    const more = page.getByTestId("filter-menu");
    const shape = async () => [await box(segments), await box(more), await box(page.getByTestId("list-title")), await box(list)].map((b) => [b.x, b.y, b.width, b.height].join()).join("|");
    const before = await shape();
    await expectFilter(page, "all");
    for (const l of [page.getByTestId("filter-segment-unread"), more]) expect((await box(l)).height).toBeGreaterThanOrEqual(24);
    await page.getByTestId("filter-segment-unread").click();
    await expectFilter(page, "unread");
    expect(await shape()).toBe(before);
    await more.click();
    for (const f of ["people", "attachments", "starred"]) await expect(page.getByTestId(`filter-option-${f}`)).toBeVisible();
    await expect(page.getByTestId("filter-option-unread")).toHaveCount(0);
    await page.getByTestId("filter-option-attachments").click();
    await expectFilter(page, "attachments", "With attachments");
    expect(await shape()).toBe(before);
    await page.getByTestId("filter-segment-all").click();
    await expectFilter(page, "all");
    expect(await shape()).toBe(before);
    expect((await box(header)).height).toBeGreaterThan(0);
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
    // one line in a small window too: a long name truncates, and is said whole in the button's name
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect.poll(async () => (await box(banner)).height).toBeLessThanOrEqual(36);
    expect(await page.getByTestId("learned-line").evaluate((el) => el.getClientRects().length)).toBe(1);
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

  test("suggestions are one line in words under the Categories heading, to the category with the most; each category's own is in its menu", { tag: "@design" }, async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const t = db.get<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1")!.id;
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.8, '[]', ?)", t, facturas, Date.now());
    await fresh(page);
    const line = page.getByTestId("nav-review");
    const total = Number(await line.getAttribute("data-count"));
    await expect(line).toHaveText(`Review ${total} suggestion${total === 1 ? "" : "s"}`);
    // on the heading's text column, right under it; no mark on any category row
    const heading = page.getByText("Categories", { exact: true });
    expect(Math.abs((await box(line.locator("span"))).x - (await box(heading)).x)).toBeLessThanOrEqual(1);
    expect((await box(line)).y).toBeGreaterThanOrEqual((await box(heading)).y);
    await expect(page.locator("[data-testid^=nav-review-]")).toHaveCount(0);
    // the most suggestions: its review opens
    const most = await page.locator("[data-suggested]").evaluateAll((els) => els.reduce((a, el) => (Number((el as HTMLElement).dataset.suggested) > Number((a as HTMLElement).dataset.suggested) ? el : a)).querySelector("[data-testid^=nav-category-]")!.textContent!);
    await line.click();
    await expect(page.getByTestId("list-title")).toContainText(most.replace(/\d+$/, ""));
    // a category's own, from its menu, with its count in words
    await page.getByTestId(`nav-category-${facturas}`).click({ button: "right" });
    await expect(page.getByTestId("category-menu-review")).toHaveText(/^Review \d+ suggestions?$/);
    await page.getByTestId("category-menu-review").click();
    await expect(page.getByTestId("list-title")).toHaveText("Review · Facturas");
  });

  test.describe("Atelier's display title", () => {
    test.use({ design: "atelier" });
    test("a filter that's on stays said while the list scrolls; the subtitle gives way all the same", async ({ app: page }) => {
      const list = page.locator("[data-testid=thread-list] [data-keep-scroll=list]");
      await list.evaluate((el) => el.scrollTo(0, 300));
      await expect(page.getByTestId("list-subtitle")).toBeHidden();
      await list.evaluate((el) => el.scrollTo(0, 0));
      await pickFilter(page, "unread");
      await expectFilter(page, "unread");
      await list.evaluate((el) => el.scrollTo(0, 300));
      await expect(page.getByTestId("thread-list")).toHaveAttribute("data-scrolled", "");
      await expectFilter(page, "unread");
      await expect(page.getByTestId("filter-segment-unread")).toBeVisible();
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
