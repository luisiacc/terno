/**
 * Plan 21. Part A: only Inbox and Starred are always in the sidebar; Sent,
 * Archive, All Mail, Spam and Trash wait behind a quiet More, which takes no
 * space while closed: opening slides what's below down (plan 40). Part B: the sidebar's and the
 * list's widths follow their edges (pointer and keyboard), clamp to the
 * window, and are remembered. Both run in every design (@design).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import type { DesignDefinition } from "../../../packages/ui/src/designs/types";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, navTo, openRow, selectedRow, test } from "./fixtures";

const HIDDEN = ["sent", "archive", "all", "spam", "trash"] as const;
const designOf = async (page: Page): Promise<DesignDefinition> => {
  const id = await page.locator("html").getAttribute("data-design");
  return DESIGNS.find((d) => d.id === id)!;
};
const reload = async (page: Page) => {
  await page.reload();
  await page.locator("[data-ready]").waitFor();
};

test.describe("Part A: More", { tag: "@design" }, () => {
  const more = (page: Page) => page.getByTestId("nav-more");
  const slot = (page: Page, view: string) => page.locator(`[data-more-slot="${view}"]`);

  test("closed by default: Inbox and Starred shown, the five hidden and out of the Tab order, More a disclosure", async ({ app: page }) => {
    await expect(page.getByTestId("nav-inbox")).toBeVisible();
    await expect(page.getByTestId("nav-starred")).toBeVisible();
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");
    await expect(more(page)).toHaveAttribute("aria-controls", "sidebar-more-folders");
    await expect(more(page)).toHaveAccessibleName("More");
    await expect(page.getByRole("group", { name: "More folders" })).toHaveAttribute("id", "sidebar-more-folders");
    for (const v of HIDDEN) {
      await expect(page.getByTestId(`nav-${v}`)).toBeHidden();
      await expect(slot(page, v)).toHaveAttribute("inert", "");
    }
    // Tab: Starred → More → the Categories section's + (the first control after it), never a hidden folder
    await page.getByTestId("nav-starred").focus();
    await page.keyboard.press("Tab");
    await expect(more(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("new-category")).toBeFocused();
  });

  test("toggles, says Less while open, and is remembered across a reload", async ({ app: page }) => {
    await more(page).click();
    await expect(more(page)).toHaveAttribute("aria-expanded", "true");
    await expect(more(page)).toHaveAccessibleName("Less");
    for (const v of HIDDEN) await expect(page.getByTestId(`nav-${v}`)).toBeVisible();
    await more(page).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("nav-sent")).toBeFocused();
    await reload(page);
    await expect(more(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await more(page).click();
    await reload(page);
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("nav-trash")).toBeHidden();
  });

  /** the boxes that tell where things sit: More, the Categories and Accounts titles, the first and last category, Trash's slot */
  const layout = (page: Page) =>
    page.evaluate(() => {
      const sidebar = document.querySelector("[data-testid=sidebar]")!;
      const title = (text: string) => [...sidebar.querySelectorAll("span")].find((s) => s.textContent === text)!.getBoundingClientRect();
      const cats = [...sidebar.querySelectorAll("[data-testid^=nav-category-]")];
      const more = document.querySelector("[data-testid=nav-more]")!.getBoundingClientRect();
      return {
        moreBottom: more.bottom,
        rowH: more.height,
        categoriesTop: title("Categories").top,
        accountsTop: title("Accounts").top,
        firstCategoryTop: cats[0]!.getBoundingClientRect().top,
        // a category's box includes its review row (macOS draws it under the row)
        lastCategoryBottom: cats.at(-1)!.parentElement!.getBoundingClientRect().bottom,
        trashBottom: document.querySelector('[data-more-slot="trash"]')!.getBoundingClientRect().bottom,
        // the end of the sidebar's content (the nav's scrollHeight only grows once it overflows)
        contentBottom: sidebar.querySelector("[data-more-below]")!.getBoundingClientRect().bottom,
      };
    });

  test("closed, the group takes no space: Categories sit under More at the gap between sections; open, under Trash, five rows lower (plan 40)", async ({ app: page }) => {
    const closed = await layout(page);
    // the design's gap between sections: the same as between the last category and Accounts
    const gap = closed.accountsTop - closed.lastCategoryBottom;
    expect(gap).toBeGreaterThan(0);
    expect(closed.categoriesTop - closed.moreBottom).toBeCloseTo(gap, 0);
    await more(page).click();
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    const open = await layout(page);
    expect(open.categoriesTop - open.trashBottom).toBeCloseTo(gap, 0);
    expect(open.firstCategoryTop - closed.firstCategoryTop).toBeCloseTo(5 * closed.rowH, 0);
    expect(open.contentBottom - closed.contentBottom).toBeCloseTo(5 * closed.rowH, 0);
    expect(open.moreBottom).toBe(closed.moreBottom);
    await more(page).click();
    await expect(page.getByTestId("nav-trash")).toBeHidden();
    expect((await layout(page)).firstCategoryTop).toBeCloseTo(closed.firstCategoryTop, 1);
  });

  test("what's below is its own compositor layer, so the slide moves it without repainting it (the measured cost, plan 40)", async ({ app: page }) => {
    const below = page.locator("[data-more-below]");
    await expect(below).toHaveCSS("will-change", "transform");
    // it holds both sections
    await expect(below.locator("[data-testid^=nav-category-]").first()).toBeAttached();
    await expect(below.getByTestId("nav-account-all")).toBeAttached();
    // and Chromium really promoted it (a hint alone proves nothing): a layer of its own in the layer tree
    const cdp = await page.context().newCDPSession(page);
    const layers = new Promise<{ backendNodeId?: number }[]>((resolve) => cdp.on("LayerTree.layerTreeDidChange", (e) => e.layers && resolve(e.layers)));
    await cdp.send("DOM.getDocument");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-more-below]" });
    const { node } = await cdp.send("DOM.describeNode", { nodeId });
    await cdp.send("LayerTree.enable");
    await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=nav-more]")!.click());
    expect((await layers).some((l) => l.backendNodeId === node.backendNodeId)).toBe(true);
  });

  test.describe("with motion on", () => {
    test.use({ reducedMotion: "no-preference" });
    /**
     * Clicks More (or not) and freezes its transitions at `at` of their duration: what's below is where that moment
     * puts it. Deterministic, unlike sampling frames on a loaded machine (the ui-perf gate times the real thing).
     */
    const freeze = (page: Page, at: number, click = true) =>
      page.evaluate(
        async ({ at, click }) => {
          if (click) document.querySelector<HTMLButtonElement>("[data-testid=nav-more]")!.click();
          const group = document.getElementById("sidebar-more-folders")!;
          let anims: Animation[] = [];
          // React commits the click in a microtask; the transitions exist from the next style read
          for (let i = 0; i < 10 && !anims.length; i++) {
            await Promise.resolve();
            anims = group.getAnimations({ subtree: true });
          }
          for (const a of anims) {
            a.pause();
            a.currentTime = Number(a.effect!.getTiming().duration) * at;
          }
          return {
            durations: anims.map((a) => Number(a.effect!.getTiming().duration) + Number(a.effect!.getTiming().delay ?? 0)),
            top: document.querySelector("[data-testid^=nav-category-]")!.getBoundingClientRect().top,
          };
        },
        { at, click },
      );
    const finish = (page: Page) => page.evaluate(() => document.getElementById("sidebar-more-folders")!.getAnimations({ subtree: true }).forEach((a) => a.finish()));

    test("opening and closing slide what's below through the positions between, within the motion cap", async ({ app: page }) => {
      const { firstCategoryTop: closed, rowH } = await layout(page);
      const opened = closed + 5 * rowH;
      for (const [from, to] of [
        [closed, opened],
        [opened, closed],
      ] as const) {
        const mid = await freeze(page, 0.5);
        expect(mid.durations.length, "it animates with motion on").toBeGreaterThan(0);
        expect(Math.max(...mid.durations)).toBeLessThanOrEqual(100);
        // halfway in time: strictly between, and (an ease-out curve) past the middle
        expect(mid.top).toBeGreaterThan(Math.min(from, to) + 1);
        expect(mid.top).toBeLessThan(Math.max(from, to) - 1);
        expect(Math.abs(mid.top - from)).toBeGreaterThan(Math.abs(to - from) / 2);
        await finish(page);
        expect((await layout(page)).firstCategoryTop).toBeCloseTo(to, 0);
      }
    });

    test("a click mid-way turns it back from where it is, both ways, and it ends exactly where it started", async ({ app: page }) => {
      const { firstCategoryTop: closed, rowH } = await layout(page);
      for (const end of [closed, closed + 5 * rowH]) {
        const mid = await freeze(page, 0.4);
        // the second click: the new transitions start from the frozen position, not from either end
        const back = await freeze(page, 0);
        expect(back.top).toBeCloseTo(mid.top, 0);
        await finish(page);
        expect((await layout(page)).firstCategoryTop).toBeCloseTo(end, 0);
        if (end === closed) {
          // then open it for the other direction
          await more(page).click();
          await finish(page);
          await expect.poll(async () => (await layout(page)).firstCategoryTop).toBeCloseTo(closed + 5 * rowH, 0);
        }
      }
    });

    test("the user's motion setting scales it: at 100 ms the slowest is 100, at 50 it's 67; at 0 it's instant", async ({ app: page, server }) => {
      for (const [ms, cap] of [
        [100, 100],
        [50, 67],
        [0, 0],
      ] as const) {
        await server.backend.server.invoke("settings.update", { motionMs: ms }, { clientId: "setup", origin: "dev" as const });
        await reload(page);
        const closed = await layout(page);
        const r = await freeze(page, 0);
        if (cap) expect(Math.max(...r.durations), `at ${ms}`).toBeLessThanOrEqual(cap);
        else {
          expect(r.durations, "nothing animates at 0").toEqual([]);
          expect(r.top).toBeCloseTo(closed.firstCategoryTop + 5 * closed.rowH, 0);
        }
        await finish(page);
        await more(page).click();
        await finish(page);
      }
    });

    test("the OS asking for reduced motion mid-slide ends it at once, in place", async ({ app: page }) => {
      const closed = await layout(page);
      await freeze(page, 0.3);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(() => page.evaluate(() => document.getElementById("sidebar-more-folders")!.getAnimations({ subtree: true }).length)).toBe(0);
      expect((await layout(page)).firstCategoryTop).toBeCloseTo(closed.firstCategoryTop + 5 * closed.rowH, 0);
    });
  });

  test("with reduced motion it opens in the same frame: what's below already at its place, nothing animating", async ({ app: page }) => {
    const closed = await layout(page);
    const r = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("[data-testid=nav-more]")!.click();
      return new Promise<{ opacity: string; visibility: string; top: number; animations: number }>((resolve) =>
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>('[data-more-slot="trash"]')!;
          const cs = getComputedStyle(el);
          resolve({
            opacity: cs.opacity,
            visibility: cs.visibility,
            top: document.querySelector("[data-testid^=nav-category-]")!.getBoundingClientRect().top,
            animations: document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).closest("#sidebar-more-folders, [data-testid=nav-more]")).length,
          });
        }),
      );
    });
    expect(r).toEqual({ opacity: "1", visibility: "visible", top: expect.closeTo(closed.firstCategoryTop + 5 * closed.rowH, 0), animations: 0 });
  });

  test("the folder you're in shows alone while More is closed (one row lower for what's below); reached by a key, it goes when you leave", async ({ app: page }) => {
    const closed = await layout(page);
    await page.mouse.move(900, 400); // the pointer over the list, not the sidebar
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("#");
    await expect(page.getByTestId("list-title")).toHaveText("Trash");
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await expect(page.getByTestId("nav-trash")).toHaveAttribute("data-active");
    await expect(slot(page, "trash")).not.toHaveAttribute("inert");
    for (const v of ["sent", "archive", "all", "spam"]) await expect(page.getByTestId(`nav-${v}`)).toBeHidden();
    expect((await layout(page)).firstCategoryTop).toBeCloseTo(closed.firstCategoryTop + closed.rowH, 0);
    // the shortcuts keep working with More closed
    for (const [key, title] of [["t", "Sent"], ["a", "Archive"]] as const) {
      await page.keyboard.press("g");
      await page.keyboard.press(key);
      await expect(page.getByTestId("list-title")).toHaveText(title);
      await expect(page.getByTestId(`nav-${title.toLowerCase()}`)).toBeVisible();
    }
    await expect(page.getByTestId("nav-trash")).toBeHidden();
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.getByTestId("nav-archive")).toBeHidden();
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");
    expect((await layout(page)).firstCategoryTop).toBeCloseTo(closed.firstCategoryTop, 1);
  });

  test("leaving that folder with a click in the sidebar moves nothing under the pointer: it stays (in the Tab order) until the pointer leaves the sidebar", async ({ app: page }) => {
    await page.mouse.move(900, 400);
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("#");
    await expect(page.getByTestId("nav-trash")).toHaveAttribute("data-active");
    const category = page.locator("[data-testid^=nav-category-]").first();
    const before = (await category.boundingBox())!;
    await category.click();
    await expect(category).toHaveAttribute("data-active");
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await expect(page.getByTestId("nav-trash")).not.toHaveAttribute("data-active");
    await expect(slot(page, "trash")).not.toHaveAttribute("inert");
    expect(await category.boundingBox()).toEqual(before);
    // reachable like any shown row
    await more(page).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("nav-trash")).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // the pointer leaves: it goes, and what's below moves up a row
    await page.mouse.move(900, 400);
    await expect(page.getByTestId("nav-trash")).toBeHidden();
    await expect(slot(page, "trash")).toHaveAttribute("inert", "");
    expect((await category.boundingBox())!.y).toBeCloseTo(before.y - before.height, 0);
  });

  /** with the pointer over the list, `g #`: Trash is the folder you're in, shown alone */
  const intoTrash = async (page: Page) => {
    await page.mouse.move(900, 400);
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("#");
    await expect(page.getByTestId("nav-trash")).toHaveAttribute("data-active");
  };

  test("a click on the folder you're in holds nothing: leaving it by a key then hides it (Codex review)", async ({ app: page }) => {
    await intoTrash(page);
    await page.getByTestId("nav-trash").click();
    await expect(page.getByTestId("nav-trash")).toBeFocused();
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("data-active");
    await expect(page.getByTestId("nav-trash")).toBeHidden();
    await expect(slot(page, "trash")).toHaveAttribute("inert", "");
    await expect(more(page)).toBeFocused();
  });

  test("toggling More lets a held folder go: closing it on purpose closes it (the one you're in stays)", async ({ app: page }) => {
    await intoTrash(page);
    await page.locator("[data-testid^=nav-category-]").first().click();
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await more(page).click();
    await expect(page.getByTestId("nav-sent")).toBeVisible();
    await more(page).click();
    // the pointer is still on the sidebar, and Trash is gone with the rest
    await expect(page.getByTestId("nav-trash")).toBeHidden();
    await expect(page.getByTestId("nav-sent")).toBeHidden();
    // the folder you're in stays through a close
    await intoTrash(page);
    await more(page).click();
    await more(page).click();
    await expect(page.getByTestId("nav-trash")).toBeVisible();
  });

  test("a held folder with keyboard focus stays when the pointer leaves, and goes when focus does (Codex review)", async ({ app: page }) => {
    await intoTrash(page);
    await page.locator("[data-testid^=nav-category-]").first().click();
    await more(page).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("nav-trash")).toBeFocused();
    await page.mouse.move(900, 400);
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await expect(page.getByTestId("nav-trash")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(more(page)).toBeFocused();
    await expect(page.getByTestId("nav-trash")).toBeHidden();
  });

  test("only a mouse or pen click holds: Enter on a category, with the mouse resting on the sidebar, lets the folder go (Codex review)", async ({ app: page }) => {
    await intoTrash(page);
    const category = page.locator("[data-testid^=nav-category-]").first();
    await category.hover();
    await category.focus();
    await page.keyboard.press("Enter");
    await expect(category).toHaveAttribute("data-active");
    await expect(page.getByTestId("nav-trash")).toBeHidden();
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });
    test("a tap holds nothing: no pointer rests on the sidebar (Codex review)", async ({ app: page }) => {
      await intoTrash(page);
      await page.locator("[data-testid^=nav-category-]").first().tap();
      await expect(page.locator("[data-testid^=nav-category-]").first()).toHaveAttribute("data-active");
      await expect(page.getByTestId("nav-trash")).toBeHidden();
    });
  });

  test("dragging a row while More's folders change size: the highlighted category is the one under the pointer (Codex review)", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const viajes = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Viajes'")!.id;
    const target = page.getByTestId(`nav-category-${viajes}`);
    const row = page.locator(`[data-testid=thread-row]:not(:has([data-cat-dot="${viajes}"]))`).first();
    const r = (await row.boundingBox())!;
    const t = (await target.boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 6, r.y + r.height / 2 + 2, { steps: 2 });
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
    await expect(target).toHaveAttribute("data-drop-state", "over");
    // Trash appears above (a key mid-drag), sliding the categories a row down without any scroll
    await page.keyboard.press("g");
    await page.keyboard.press("#");
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await page.mouse.move(t.x + t.width / 2 + 1, t.y + t.height / 2);
    // under the pointer now: the category that was a row above Viajes, not Viajes at its old place
    const under = await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.closest("[data-drop-target]")?.getAttribute("data-testid"), [t.x + t.width / 2 + 1, t.y + t.height / 2]);
    expect(under).not.toBe(`nav-category-${viajes}`);
    await expect(target).not.toHaveAttribute("data-drop-state", "over");
    await expect(page.getByTestId(under!)).toHaveAttribute("data-drop-state", /over|already/);
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });

  test("with no categories, Categories (its empty note) still sits right under More at the gap between sections", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    db.run("DELETE FROM thread_categories");
    db.run("DELETE FROM cls_decisions");
    db.run("DELETE FROM categories");
    await reload(page);
    await expect(page.locator("[data-testid^=nav-category-]")).toHaveCount(0);
    const g = await page.evaluate(() => {
      const sidebar = document.querySelector("[data-testid=sidebar]")!;
      const span = (text: string) => [...sidebar.querySelectorAll("span")].find((s) => s.textContent === text)!.getBoundingClientRect();
      const empty = sidebar.querySelector("nav p")!.getBoundingClientRect();
      return { underMore: span("Categories").top - document.querySelector("[data-testid=nav-more]")!.getBoundingClientRect().bottom, betweenSections: span("Accounts").top - empty.bottom };
    });
    expect(g.underMore).toBeCloseTo(g.betweenSections, 0);
  });

  test.describe("a long sidebar (80 more categories)", () => {
    test.beforeEach(async ({ app: page, server }) => {
      const db = sqlDb(server.backend.store);
      for (let i = 0; i < 80; i++) db.run("INSERT INTO categories (name, color, position) VALUES (?, 'cyan', ?)", `Long ${String(i).padStart(2, "0")}`, 100 + i);
      await reload(page);
      await page.getByText("Long 79").waitFor({ state: "attached" });
    });
    const nav = (page: Page) => page.getByTestId("sidebar").locator("nav");

    test("scrolled a little, toggling keeps the scroll position and More where it is", async ({ app: page }) => {
      await nav(page).evaluate((el) => (el.scrollTop = 30));
      const top = (await more(page).boundingBox())!.y;
      for (let i = 0; i < 2; i++) {
        await more(page).click();
        expect(await nav(page).evaluate((el) => el.scrollTop)).toBe(30);
        expect((await more(page).boundingBox())!.y).toBe(top);
      }
    });

    test("scrolled past More, a folder appearing above (a shortcut) doesn't move the rows in view", async ({ app: page }) => {
      await nav(page).evaluate((el) => (el.scrollTop = 600));
      const row = page.getByText("Long 40", { exact: true });
      const before = (await row.boundingBox())!.y;
      await page.mouse.move(900, 400);
      await focusList(page);
      await page.keyboard.press("g");
      await page.keyboard.press("#");
      await expect(page.getByTestId("list-title")).toHaveText("Trash");
      await expect(slot(page, "trash")).toHaveAttribute("data-shown");
      expect((await row.boundingBox())!.y).toBeCloseTo(before, 0);
    });

    test.describe("with motion on", () => {
      test.use({ reducedMotion: "no-preference" });
      test("scrolled to the end, closing keeps the rows in view where they are (Codex review)", async ({ app: page }) => {
        await more(page).click();
        await nav(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
        const row = page.getByText("Long 70", { exact: true });
        const before = (await row.boundingBox())!.y;
        await more(page).evaluate((el) => (el as HTMLElement).click());
        await expect(slot(page, "trash")).toHaveAttribute("inert", "");
        // the slide over (on a loaded machine a fixed wait isn't)
        await expect.poll(() => page.evaluate(() => document.getElementById("sidebar-more-folders")!.getAnimations({ subtree: true }).length)).toBe(0);
        expect((await row.boundingBox())!.y).toBeCloseTo(before, 0);
        // still at the end, with no blank space under the last row
        const end = await nav(page).evaluate((el) => ({ gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
        expect(end.gap).toBeLessThanOrEqual(1);
      });
    });

    test("the sidebar's edge still resizes it with More open", async ({ app: page }) => {
      await more(page).click();
      const h = page.getByTestId("pane-handle-sidebar");
      const w0 = (await page.getByTestId("sidebar").boundingBox())!.width;
      await h.focus();
      await page.keyboard.press("ArrowRight");
      expect((await page.getByTestId("sidebar").boundingBox())!.width).toBeCloseTo(w0 + 16, 0);
      await page.keyboard.press("Enter");
    });
  });

  test.describe("with motion on, a sidebar that overflows only while More is open", () => {
    test.use({ reducedMotion: "no-preference" });
    test("scrolled to its end, closing brings it back to the top with nothing cut off or left blank (Codex review)", async ({ app: page }) => {
      await more(page).click();
      const nav = page.getByTestId("sidebar").locator("nav");
      // fully open before measuring (Codex review: mid-slide, the room left looks larger than it is)
      const rowH = (await more(page).boundingBox())!.height;
      await expect.poll(async () => (await slot(page, "trash").boundingBox())?.height).toBeCloseTo(rowH, 0);
      await page.waitForTimeout(150);
      // a window just short enough that the open sidebar overflows by less than the five rows
      // the room left under the open sidebar's content (its nav pads 12 px at the end)
      const slack = await nav.evaluate((el) => el.getBoundingClientRect().bottom - el.querySelector("[data-more-below]")!.getBoundingClientRect().bottom - 12);
      const vp = page.viewportSize()!;
      await page.setViewportSize({ width: vp.width, height: Math.round(vp.height - slack - 60) });
      await expect.poll(() => nav.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
      await nav.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await more(page).evaluate((el) => (el as HTMLElement).click());
      await expect(slot(page, "trash")).toHaveAttribute("inert", "");
      await expect.poll(() => page.evaluate(() => document.getElementById("sidebar-more-folders")!.getAnimations({ subtree: true }).length)).toBe(0);
      const r = await nav.evaluate((el) => ({ top: el.scrollTop, over: el.scrollHeight - el.clientHeight }));
      expect(r.over).toBe(0);
      expect(r.top).toBe(0);
      await expect(page.getByTestId("nav-inbox")).toBeInViewport();
    });
  });

  for (const mode of ["light", "dark"] as const) {
    test(`axe in ${mode}: the sidebar with More open and closed`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, { clientId: "setup", origin: "dev" as const });
      await reload(page);
      const wcag = () => new AxeBuilder({ page }).include("[data-testid=sidebar]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["scrollable-region-focusable"]);
      expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
      await more(page).click();
      await expect(page.getByTestId("nav-trash")).toBeVisible();
      expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
      // closed again, with Trash held after a click took you elsewhere
      await more(page).click();
      await page.keyboard.press("g");
      await page.keyboard.press("#");
      await page.locator("[data-testid^=nav-category-]").first().click();
      await expect(page.getByTestId("nav-trash")).toBeVisible();
      expect((await wcag().analyze()).violations.map((v) => v.id)).toEqual([]);
    });
  }

  test("a category (\"all\" underneath) or its suggestions never reveal All Mail", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    await page.getByTestId(`nav-category-${facturas}`).click();
    await expect(page.getByTestId("list-title")).toContainText("Facturas");
    await expect(page.getByTestId("nav-all")).toBeHidden();
    // its suggestions: view "all", no category selected
    const t = db.get<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1")!.id;
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.8, '[]', ?)", t, facturas, Date.now());
    await reload(page);
    await page.getByTestId(`nav-review-${facturas}`).click();
    await expect(page.getByTestId(`nav-review-${facturas}`)).toHaveAttribute("data-active");
    await expect(page.getByTestId("nav-all")).toBeHidden();
    await more(page).click();
    await expect(page.getByTestId("nav-all")).not.toHaveAttribute("data-active");
  });

  test("a focused folder that hides (you went elsewhere with a key) leaves focus on More, not lost", async ({ app: page }) => {
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("#");
    await page.getByTestId("nav-trash").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.getByTestId("nav-trash")).toBeHidden();
    await expect(more(page)).toBeFocused();
  });
});

test.describe("Part B: resizable panes", { tag: "@design" }, () => {
  const sidebar = (page: Page) => page.getByTestId("sidebar");
  const list = (page: Page) => page.locator("#app-list");
  const reader = (page: Page) => page.locator("main");
  const handle = (page: Page, pane: "sidebar" | "list") => page.getByTestId(`pane-handle-${pane}`);
  const width = async (l: Locator) => (await l.boundingBox())!.width;
  const stored = (page: Page) => page.evaluate(() => localStorage.getItem("terno:panes"));
  /** a drag by dx from the handle's middle, in steps like a hand */
  const drag = async (page: Page, pane: "sidebar" | "list", dx: number, opts: { release?: boolean } = {}) => {
    const b = (await handle(page, pane).boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + 400;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 4 });
    // the width is written in the next frame
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    if (opts.release !== false) await page.mouse.up();
  };

  test("dragging an edge resizes its pane by the pointer's distance; the other pane keeps its width", async ({ app: page }) => {
    const s0 = await width(sidebar(page));
    const l0 = await width(list(page));
    const r0 = await width(reader(page));
    await drag(page, "sidebar", 60);
    expect(await width(sidebar(page))).toBeCloseTo(s0 + 60, 0);
    expect(await width(list(page))).toBeCloseTo(l0, 0);
    expect(await width(reader(page))).toBeCloseTo(r0 - 60, 0);
    await drag(page, "list", 80);
    expect(await width(list(page))).toBeCloseTo(l0 + 80, 0);
    expect(await width(sidebar(page))).toBeCloseTo(s0 + 60, 0);
    await expect(handle(page, "sidebar")).toHaveAttribute("aria-valuenow", String(Math.round(s0 + 60)));
    // remembered: the same widths after a reload
    await reload(page);
    expect(await width(sidebar(page))).toBeCloseTo(s0 + 60, 0);
    expect(await width(list(page))).toBeCloseTo(l0 + 80, 0);
    await expect(handle(page, "list")).toHaveAttribute("aria-valuenow", String(Math.round(l0 + 80)));
  });

  test("a click or a double-click without moving stores nothing; a double-click resets to the design's width", async ({ app: page }) => {
    const s0 = await width(sidebar(page));
    await handle(page, "sidebar").dblclick();
    expect(await stored(page)).toBeNull();
    await drag(page, "sidebar", 50);
    expect(JSON.parse((await stored(page))!)).toMatchObject({ v: 1, sidebar: Math.round(s0 + 50) });
    await handle(page, "sidebar").dblclick();
    expect(await width(sidebar(page))).toBeCloseTo(s0, 0);
    expect(await stored(page)).toBeNull();
  });

  test("the keyboard: a separator with its values; arrows, Shift, Home, End, and Enter to reset", async ({ app: page }) => {
    const d = await designOf(page);
    const h = handle(page, "sidebar");
    await expect(h).toHaveAttribute("role", "separator");
    await expect(h).toHaveAttribute("aria-orientation", "vertical");
    await expect(h).toHaveAttribute("aria-controls", "app-sidebar");
    await expect(h).toHaveAccessibleName("Resize sidebar");
    await expect(handle(page, "list")).toHaveAccessibleName("Resize message list");
    const s0 = Math.round(await width(sidebar(page)));
    await expect(h).toHaveAttribute("aria-valuenow", String(s0));
    await expect(h).toHaveAttribute("aria-valuemin", "200");
    await expect(h).toHaveAttribute("aria-valuemax", "360");
    await openRow(page, 1);
    const open = await selectedRow(page).getAttribute("data-thread-id");
    await h.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(h).toHaveAttribute("aria-valuenow", String(s0 + 48));
    expect(await width(sidebar(page))).toBeCloseTo(s0 + 48, 0);
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(h).toHaveAttribute("aria-valuenow", String(s0 + 48 - 64));
    await page.keyboard.press("Home");
    await expect(h).toHaveAttribute("aria-valuenow", "200");
    await page.keyboard.press("End");
    await expect(h).toHaveAttribute("aria-valuenow", "360");
    expect(JSON.parse((await stored(page))!)).toMatchObject({ sidebar: 360 });
    await page.keyboard.press("Enter");
    await expect(h).toHaveAttribute("aria-valuenow", String(parseFloat(d.layout.sidebar)));
    expect(await stored(page)).toBeNull();
    // the keys were the handle's: the list's selection didn't move, nothing else ran
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open!);
    await expect(h).toBeFocused();
  });

  test("Esc mid-drag puts the width back, stores nothing, and leaves the open thread alone", async ({ app: page }) => {
    await openRow(page, 1);
    const open = await selectedRow(page).getAttribute("data-thread-id");
    const l0 = await width(list(page));
    await drag(page, "list", 120, { release: false });
    expect(await width(list(page))).toBeCloseTo(l0 + 120, 0);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await width(list(page))).toBeCloseTo(l0, 0);
    expect(await stored(page)).toBeNull();
    await expect(page.locator("html")).not.toHaveAttribute("data-resizing");
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open!);
  });

  test("clamped: past the limits it stops; at the minimum window nothing overflows and the reader keeps its minimum; a wide window gives the widths back", async ({ app: page }) => {
    const d = await designOf(page);
    await drag(page, "sidebar", 400);
    expect(await width(sidebar(page))).toBeCloseTo(360, 0);
    await drag(page, "sidebar", -400);
    expect(await width(sidebar(page))).toBeCloseTo(200, 0);
    await handle(page, "sidebar").focus();
    await page.keyboard.press("End");
    await handle(page, "list").focus();
    await page.keyboard.press("End");
    expect(await width(list(page))).toBeCloseTo(640, 0);
    const before = await stored(page);
    // the list's max follows the window though neither pane changes width yet (1440 → 1300: 1300 − reader − 360)
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect(handle(page, "list")).toHaveAttribute("aria-valuemax", String(Math.min(640, 1300 - d.layout.readerMin - 360)));

    await page.setViewportSize({ width: 980, height: 600 });
    await openRow(page, 2);
    const overflow = await page.evaluate(() => [document.documentElement.scrollWidth - document.documentElement.clientWidth, ...["sidebar", "thread-list", "reader"].map((id) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!).map((el) => el.scrollWidth - el.clientWidth)]);
    overflow.forEach((extra, i) => expect(extra, ["document", "sidebar", "thread-list", "reader"][i]).toBeLessThanOrEqual(0));
    expect(await width(reader(page))).toBeGreaterThanOrEqual(d.layout.readerMin - 0.5);
    const r = (await reader(page).boundingBox())!;
    for (const id of ["action-archive", "action-reply", "action-forward", "action-print"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.x + b.width, id).toBeLessThanOrEqual(r.x + r.width + 0.5);
    }
    // the stored widths are the user's, untouched by the narrow window
    expect(await stored(page)).toBe(before);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await width(sidebar(page))).toBeCloseTo(360, 0);
    expect(await width(list(page))).toBeCloseTo(640, 0);
  });

  test("one pointer drives a drag: a second finger touching and lifting on the handle neither ends nor restarts it (Codex review)", async ({ app: page }) => {
    const l0 = Math.round(await width(list(page)));
    const r = await page.evaluate(() => {
      const h = document.querySelector<HTMLElement>("[data-testid=pane-handle-list]")!;
      const b = h.getBoundingClientRect();
      const fire = (type: string, pointerId: number, isPrimary: boolean, dx: number) =>
        h.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, isPrimary, pointerType: "touch", button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, clientX: b.x + b.width / 2 + dx, clientY: b.y + 300 }));
      fire("pointerdown", 11, true, 0);
      fire("pointermove", 11, true, 40);
      fire("pointerdown", 12, false, 0);
      fire("pointerup", 12, false, 0);
      const still = h.hasAttribute("data-dragging");
      fire("pointermove", 11, true, 80);
      fire("pointerup", 11, true, 80);
      return { still, after: h.hasAttribute("data-dragging"), stored: localStorage.getItem("terno:panes") };
    });
    expect(r.still, "the second finger didn't end the drag").toBe(true);
    expect(r.after).toBe(false);
    expect(JSON.parse(r.stored!)).toMatchObject({ list: l0 + 80 });
  });

  test("the handles are hairlines, quiet at rest, never a window drag area (desktop's title band)", async ({ app: page }) => {
    const h = handle(page, "sidebar");
    await expect(h).toHaveCSS("cursor", "col-resize");
    expect(await h.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region"))).toBe("no-drag");
    await expect(h.locator("span")).toHaveCSS("opacity", "0");
    // the top of the boundary (over the sidebar's drag region) is the handle's
    const b = (await h.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.closest("[data-testid]")?.getAttribute("data-testid"), [b.x + b.width / 2, b.y + 10]);
    expect(hit).toBe("pane-handle-sidebar");
  });
});

test("a hovered row next to the selected one: a hairline between their fills, the rows' pitch unchanged", { tag: "@design" }, async ({ app: page }) => {
  const rows = page.locator('[data-testid^="nav-account-"]:not([data-testid="nav-account-all"])');
  const [selected, hovered] = [rows.nth(0), rows.nth(1)];
  await selected.click();
  await expect(selected).toHaveAttribute("data-active", "true");
  await hovered.hover();
  const fill = (l: Locator) =>
    l.evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // the background paints the padding box: inside the borders
      return { top: r.top, height: r.height, paintTop: r.top + parseFloat(s.borderTopWidth), paintBottom: r.bottom - parseFloat(s.borderBottomWidth), clip: s.backgroundClip, bg: s.backgroundColor, navH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-h")) * parseFloat(getComputedStyle(document.documentElement).fontSize) };
    });
  const [a, b] = [await fill(selected), await fill(hovered)];
  // both filled, the case the seam is for; hover a step softer than selected (plan 63)
  expect([a.bg, b.bg]).not.toContain("rgba(0, 0, 0, 0)");
  expect(b.bg).not.toBe(a.bg);
  expect(a.clip).toBe("padding-box");
  expect(b.paintTop - a.paintBottom).toBeGreaterThanOrEqual(1);
  // the spacing stays: rows still touch, at the design's height
  expect(b.top - a.top).toBeCloseTo(a.height, 1);
  expect(a.height).toBeCloseTo(a.navH, 1);
});

test.describe("found along the way", () => {
  test("a folder whose first page arrives while the list is scrolled to its end keeps paging (the same row count, the same last row)", async ({ app: page, server }) => {
    // hold the next list's first page, so the old list is scrolled to its end meanwhile
    const handlers = (server.backend.server as unknown as { handlers: Record<string, (...a: unknown[]) => unknown> }).handlers;
    const original = handlers["threads.list"]!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handlers["threads.list"] = async (...args: unknown[]) => {
      await gate;
      return original(...args);
    };
    await navTo(page, "all");
    const listbox = page.getByRole("listbox");
    const before = await listbox.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollHeight;
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    handlers["threads.list"] = original;
    release();
    await expect(page.getByTestId("thread-list")).toHaveAttribute("data-results-for", /^\["all"/);
    await expect.poll(() => listbox.evaluate((el) => el.scrollHeight)).toBeGreaterThan(before);
  });
});
