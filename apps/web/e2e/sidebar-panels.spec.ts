/**
 * Plan 21. Part A: only Inbox and Starred are always in the sidebar; Sent,
 * Archive, All Mail, Spam and Trash wait behind a quiet More, in slots that
 * keep their space (nothing below moves). Part B: the sidebar's and the
 * list's widths follow their edges (pointer and keyboard), clamp to the
 * window, and are remembered. Both run in every design (@design).
 */
import type { Locator, Page } from "@playwright/test";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import type { DesignDefinition } from "../../../packages/ui/src/designs/types";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, openRow, selectedRow, test } from "./fixtures";

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

  test.describe("with motion on", () => {
    test.use({ reducedMotion: "no-preference" });
    test("nothing below moves, in any frame of the transition; the transition stays within the motion cap", async ({ app: page }) => {
      await page.evaluate(() => {
        const w = window as unknown as { __boxes: string[]; __durations: number[]; __stop: boolean };
        w.__boxes = [];
        w.__durations = [];
        w.__stop = false;
        const seen = new WeakSet<Animation>();
        const ids = ["nav-account-all", "new-category"];
        const tick = () => {
          const first = document.querySelector("[data-testid^=nav-category-]")!;
          const nav = document.querySelector("[data-testid=sidebar] nav")!;
          const box = [...ids.map((id) => document.querySelector(`[data-testid=${id}]`)!), first].map((el) => {
            const r = el.getBoundingClientRect();
            return `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`;
          });
          w.__boxes.push(`${box.join("|")}|${nav.scrollHeight}`);
          for (const a of document.getAnimations()) {
            if (seen.has(a)) continue;
            seen.add(a);
            // More's own (an account's sync ping elsewhere in the sidebar is a loop, not this transition)
            const target = (a.effect as KeyframeEffect | null)?.target;
            if (!(target instanceof Element) || !target.closest("#sidebar-more-folders, [data-testid=nav-more]")) continue;
            const t = a.effect?.getTiming();
            if (t) w.__durations.push(Number(t.duration) + Number(t.delay ?? 0));
          }
          if (!w.__stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await more(page).click();
      await expect(page.getByTestId("nav-spam")).toBeVisible();
      await page.waitForTimeout(250);
      await more(page).click();
      await expect(page.getByTestId("nav-spam")).toBeHidden();
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const w = window as unknown as { __boxes: string[]; __durations: number[]; __stop: boolean };
        w.__stop = true;
        return { boxes: [...new Set(w.__boxes)], durations: w.__durations };
      });
      expect(r.boxes, "Categories and Accounts never moved").toHaveLength(1);
      expect(r.durations.length, "the reveal animates with motion on").toBeGreaterThan(0);
      expect(Math.max(...r.durations)).toBeLessThanOrEqual(100);
    });
  });

  test("with reduced motion the folders appear in the same frame, with nothing animating", async ({ app: page }) => {
    const r = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("[data-testid=nav-more]")!.click();
      return new Promise<{ opacity: string; visibility: string; animations: number }>((resolve) =>
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>('[data-more-slot="trash"]')!;
          const cs = getComputedStyle(el);
          resolve({ opacity: cs.opacity, visibility: cs.visibility, animations: document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).closest("#sidebar-more-folders, [data-testid=nav-more]")).length });
        }),
      );
    });
    expect(r).toEqual({ opacity: "1", visibility: "visible", animations: 0 });
  });

  test("the folder you're in stays shown while More is closed (by a shortcut), in its own slot; the others stay hidden", async ({ app: page }) => {
    const firstCategory = page.locator("[data-testid^=nav-category-]").first();
    const before = await firstCategory.boundingBox();
    await focusList(page);
    await page.keyboard.press("g");
    await page.keyboard.press("#");
    await expect(page.getByTestId("list-title")).toHaveText("Trash");
    await expect(page.getByTestId("nav-trash")).toBeVisible();
    await expect(page.getByTestId("nav-trash")).toHaveAttribute("data-active");
    await expect(slot(page, "trash")).not.toHaveAttribute("inert");
    for (const v of ["sent", "archive", "all", "spam"]) await expect(page.getByTestId(`nav-${v}`)).toBeHidden();
    expect(await firstCategory.boundingBox()).toEqual(before);
    // the shortcuts keep working with More closed
    for (const [key, title] of [["t", "Sent"], ["a", "Archive"]] as const) {
      await page.keyboard.press("g");
      await page.keyboard.press(key);
      await expect(page.getByTestId("list-title")).toHaveText(title);
      await expect(page.getByTestId(`nav-${title.toLowerCase()}`)).toBeVisible();
    }
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.getByTestId("nav-archive")).toBeHidden();
    await expect(more(page)).toHaveAttribute("aria-expanded", "false");
  });

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
