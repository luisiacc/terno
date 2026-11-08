/**
 * Plan 160: the shared lines hold on every main screen, the way menu-corners.spec.ts holds corners (plan 119). In every
 * design: pane titles share an x and a baseline, the reading text one measure in one column, floating things one inset
 * (never over rows, never cut mid-row, never over their own row), and every floating card's four edges are drawn.
 * Geometry only: light (a palette changes no line).
 */
import type { Locator, Page } from "@playwright/test";
import type { DevServer } from "../../backend-dev/src/server";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, fresh, focusList, openReview, rows, scenario, selectRows, test } from "./fixtures";

/** Where a title's text starts and its first baseline sits: a zero-size inline-block at the start of its text, read and removed. */
async function line(title: Locator): Promise<{ x: number; y: number }> {
  return title.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0";
    el.insertBefore(probe, el.firstChild);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { x: r.left, y: r.top };
  });
}

/** A token resolved to px on an element (a length custom property, through a probe's width) */
async function token(page: Page, name: string, fallback: number, at = "body"): Promise<number> {
  return page.evaluate(([name, fallback, at]) => {
    const host = document.querySelector(at) ?? document.body;
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`;
    host.appendChild(probe);
    const w = getComputedStyle(probe).getPropertyValue(name).trim() ? probe.getBoundingClientRect().width : Number(fallback);
    probe.remove();
    return w;
  }, [name, String(fallback), at] as const);
}

/** Every opening animation inside it finished (a zoom would scale the rects) */
const settled = (l: Locator) => l.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity && a.id !== "snack-countdown").map((a) => a.finished))).catch(() => {});

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const fmt = (n: number) => Math.round(n * 10) / 10;

/** The last row wholly inside the list's viewport that a pointer reaches (nothing floating over it), and where to click it */
async function lastReachableRow(page: Page): Promise<{ id: string; x: number; y: number }> {
  return page.evaluate(() => {
    const list = document.querySelector("[role=listbox]")!.getBoundingClientRect();
    const found = [...document.querySelectorAll<HTMLElement>("[data-testid=thread-row]")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.top >= list.top - 0.5 && r.bottom <= list.bottom + 0.5)
      .sort((a, b) => b.r.top - a.r.top)
      .map(({ el, r }) => ({ el, x: r.left + r.width * 0.6, y: r.top + r.height / 2 }))
      .find(({ el, x, y }) => el.contains(document.elementFromPoint(x, y)))!;
    return { id: found.el.dataset.threadId!, x: found.x, y: found.y };
  });
}

/**
 * A floating card's four edges: inside the window (its ring's spread too), not cut by a scrolling or clipping ancestor,
 * and drawn: along each edge (its corners left out), a 1 px band differs from what's behind it on ≥ 95% of its length.
 */
async function edges(page: Page, card: Locator, name: string, design: string): Promise<void> {
  await settled(card);
  const geo = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    let clip: string | null = null;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      // its ring is drawn a pixel outside the box
      if (r.left - 1 < c.left - 0.5 || r.top - 1 < c.top - 0.5 || r.right + 1 > c.right + 0.5 || r.bottom + 1 > c.bottom + 0.5) {
        clip = `${a.tagName.toLowerCase()}${a.dataset.testid ? `[${a.dataset.testid}]` : ""} (${Math.round(c.top)}..${Math.round(c.bottom)})`;
        break;
      }
    }
    return { r: r.toJSON() as DOMRect, radius, clip, w: innerWidth, h: innerHeight };
  });
  const { r } = geo;
  expect.soft(r.left - 1 >= 0 && r.top - 1 >= 0 && r.right + 1 <= geo.w && r.bottom + 1 <= geo.h, `${design}: ${name}'s edges are inside the window (${fmt(r.left)},${fmt(r.top)} to ${fmt(r.right)},${fmt(r.bottom)} in ${geo.w}x${geo.h})`).toBe(true);
  expect.soft(geo.clip, `${design}: no ancestor cuts ${name}'s edge`).toBeNull();
  const shot = (await page.screenshot({ animations: "disabled", caret: "hide" })).toString("base64");
  const drawn = await page.evaluate(async ({ shot, r, radius }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${shot}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const scale = img.width / innerWidth;
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const px = (x: number, y: number) => {
      const i = (Math.round(y * scale) * img.width + Math.round(x * scale)) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    const dist = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
    // per edge: the line's points (corners left out), and the outward normal
    const sides = {
      top: { from: [r.left + radius, r.top], to: [r.right - radius, r.top], n: [0, -1] },
      bottom: { from: [r.left + radius, r.bottom - 1], to: [r.right - radius, r.bottom - 1], n: [0, 1] },
      left: { from: [r.left, r.top + radius], to: [r.left, r.bottom - radius], n: [-1, 0] },
      right: { from: [r.right - 1, r.top + radius], to: [r.right - 1, r.bottom - radius], n: [1, 0] },
    };
    const out: Record<string, number> = {};
    for (const [side, { from, to, n }] of Object.entries(sides)) {
      const len = Math.max(Math.abs(to[0]! - from[0]!), Math.abs(to[1]! - from[1]!));
      let hit = 0, total = 0;
      for (let s = 0; s <= len; s += 2) {
        const x = from[0]! + ((to[0]! - from[0]!) * s) / Math.max(1, len);
        const y = from[1]! + ((to[1]! - from[1]!) * s) / Math.max(1, len);
        if (x < 1 || y < 1 || x > innerWidth - 2 || y > innerHeight - 2) continue;
        const behind = px(x + n[0]! * 8, y + n[1]! * 8);
        // the edge band: the card's last pixel and the ring's, just outside it
        const band = [0, 1].map((d) => px(x + n[0]! * d, y + n[1]! * d));
        total++;
        if (band.some((p) => dist(p, behind) >= 6)) hit++;
      }
      out[side] = total ? hit / total : 0;
    }
    return out;
  }, { shot, r, radius: geo.radius });
  for (const [side, share] of Object.entries(drawn)) expect.soft(share, `${design}: ${name}'s ${side} edge is drawn (${Math.round(share * 100)}% of it)`).toBeGreaterThanOrEqual(0.95);
}

/** What a toast holds to: one inset from the bottom it rests on, centred on the reader's column over the reader, never over a row */
async function toast(page: Page, design: string, where: string): Promise<void> {
  const card = page.locator("[data-snack-card][data-state=open]");
  await expect(card).toBeVisible();
  await settled(card);
  const inset = await token(page, "--float-inset", 12);
  const m = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const dock = el.closest<HTMLElement>("[data-testid=snack-dock]")!;
    const pane = dock.parentElement!.getBoundingClientRect();
    const column = dock.dataset.over === "reader" ? document.querySelector("[data-testid=reader] [data-reader-column], [data-testid=composer] [data-reader-column], [data-testid=selection-bar] [data-reader-column]") : null;
    const c = column?.getBoundingClientRect();
    const list = document.querySelector("[role=listbox]")?.getBoundingClientRect();
    const covered = list && !document.querySelector("[data-list-section][data-covered]")
      ? [...document.querySelectorAll("[data-testid=thread-row]")].filter((row) => {
          const b = row.getBoundingClientRect();
          // the part of the row the list shows
          const top = Math.max(b.top, list.top), bottom = Math.min(b.bottom, list.bottom), left = Math.max(b.left, list.left), right = Math.min(b.right, list.right);
          return bottom - top > 0.5 && right - left > 0.5 && top < r.bottom && bottom > r.top && left < r.right && right > r.left;
        }).length
      : 0;
    return { gap: pane.bottom - r.bottom, centre: (r.left + r.right) / 2, column: c ? (c.left + c.right) / 2 : null, covered, over: dock.dataset.over };
  });
  expect.soft(near(m.gap, inset, 1), `${design} ${where}: the toast sits --float-inset (${inset}px) above the pane's bottom: ${fmt(m.gap)}px`).toBe(true);
  if (m.column !== null) expect.soft(near(m.centre, m.column, 1), `${design} ${where}: over the reader, the toast is centred on its column: ${fmt(m.centre)} vs ${fmt(m.column)}`).toBe(true);
  expect.soft(m.covered, `${design} ${where}: no row the list shows is under the toast`).toBe(0);
}

/** Every row of a scrolled panel that's in view is whole: never cut at its edge */
async function wholeRows(panel: Locator, items: string, name: string, design: string): Promise<void> {
  const cut = await panel.evaluate((el, items) => {
    const p = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>(items)]
      .map((i) => i.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.bottom > p.top + 0.5 && r.top < p.bottom - 0.5)
      .filter((r) => r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5)
      .map((r) => `${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(p.top)}..${Math.round(p.bottom)}`);
  }, items);
  expect.soft(cut, `${design}: ${name} ends on a whole row`).toEqual([]);
}

async function rightClickLastRow(page: Page): Promise<string> {
  const { id, x, y } = await lastReachableRow(page);
  await page.mouse.click(x, y, { button: "right" });
  return id;
}

/** The right-click menu: whole rows, an inset from every window edge, and its row's text left in view */
async function menuOnItsRow(page: Page, id: string, design: string, where: string): Promise<void> {
  const menu = page.locator("[data-slot=context-menu-content]");
  await expect(menu).toBeVisible();
  await settled(menu);
  const inset = await token(page, "--float-inset", 12);
  await wholeRows(menu, "[role=menuitem]", `${where}: the row menu`, design);
  const m = await menu.evaluate((el, id) => {
    const r = el.getBoundingClientRect();
    const row = document.querySelector(`[data-testid=thread-row][data-thread-id="${id}"]`)!;
    const text = [...row.querySelectorAll("[data-testid=row-from],[data-testid=row-subject],[data-testid=row-snippet],[data-testid=row-date]")].map((t) => t.getBoundingClientRect()).filter((t) => t.width > 0);
    const over = text.some((t) => t.top < r.bottom && t.bottom > r.top && t.left < r.right && t.right > r.left);
    const fits = el.scrollHeight <= el.clientHeight + 1;
    return { over, fits, left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
  }, id);
  expect.soft(m.fits, `${design} ${where}: the row menu shows every row`).toBe(true);
  expect.soft(m.over, `${design} ${where}: the row menu leaves its own row's text in view`).toBe(false);
  for (const side of ["left", "top", "right", "bottom"] as const) expect.soft(m[side] >= inset - 0.5, `${design} ${where}: the row menu is ≥ ${inset}px from the window's ${side} edge: ${fmt(m[side])}px`).toBe(true);
}

/** The reading column and the measure: one column for everything in the conversation, the text in it at one measure */
async function measure(page: Page, design: string, where: string): Promise<void> {
  const readerMax = await token(page, "--reader-max", 704, "[data-testid=reader]");
  const m = await page.evaluate(() => {
    const column = document.querySelector("[data-testid=reader] [data-reader-column]")!;
    const c = column.getBoundingClientRect();
    const s = getComputedStyle(column);
    const content = { left: c.left + parseFloat(s.paddingLeft), right: c.right - parseFloat(s.paddingRight) };
    const at = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, max: parseFloat(getComputedStyle(el).maxWidth) };
    };
    return { width: c.width, content, slot: at("[data-testid=draft-slot]"), body: at("[data-testid=message-text]"), toolbar: at("[data-reader-toolbar]") };
  });
  expect.soft(m.width <= readerMax + 0.5, `${design} ${where}: the reading column is at most --reader-max (${readerMax}px): ${fmt(m.width)}px`).toBe(true);
  if (m.slot) expect.soft(near(m.slot.left, m.content.left, 1) && near(m.slot.right, m.content.right, 1), `${design} ${where}: the reply card spans the column (${fmt(m.slot.left)}..${fmt(m.slot.right)} vs ${fmt(m.content.left)}..${fmt(m.content.right)})`).toBe(true);
  if (m.body) expect.soft(near(m.body.left, m.content.left, 1), `${design} ${where}: the text starts on the column's edge`).toBe(true);
}

/** In an open reply: the editor's text and the quoted text at the body's measure */
async function draftMeasure(page: Page, design: string, where: string): Promise<void> {
  const quote = page.getByTestId("compose-quote");
  if (await quote.count()) {
    if ((await quote.getAttribute("aria-expanded")) !== "true") await quote.click();
  }
  const m = await page.evaluate(() => {
    const max = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).maxWidth) : null);
    return {
      body: max(document.querySelector("[data-testid=message-text]")),
      editor: max(document.querySelector("[data-testid=draft-slot] [data-testid=compose-body] > *")),
      quote: max(document.querySelector("[data-testid=draft-slot] [data-testid=compose-quote-text]")),
      readMax: (() => {
        const el = document.querySelector("[data-testid=message-text]");
        if (!el) return null;
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;width:var(--read-max)";
        el.appendChild(probe);
        const w = getComputedStyle(probe).width;
        probe.remove();
        return parseFloat(w);
      })(),
    };
  });
  expect.soft(m.body !== null && Number.isFinite(m.body) && m.body === m.readMax, `${design} ${where}: the message text is capped at --read-max (${m.readMax}px): ${m.body}`).toBe(true);
  expect.soft(m.editor, `${design} ${where}: the draft's text has the message's measure`).toBe(m.body);
  expect.soft(m.quote, `${design} ${where}: the quoted text has the message's measure`).toBe(m.body);
}

/** Two suggestions for Facturas, so it has a Review to open */
async function suggest(page: Page, server: DevServer): Promise<number> {
  const db = sqlDb(server.backend.store);
  const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const threads = db.all<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 2");
  for (const t of threads) db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.91, '[]', ?)", t.id, facturas, Date.now());
  await fresh(page);
  return facturas;
}

const OPEN = "Isabella"; // a plain-text conversation, its reply quoting it

async function openConversation(page: Page): Promise<void> {
  const row = rows(page).filter({ hasText: OPEN }).first();
  await row.dispatchEvent("mousedown");
  await row.dispatchEvent("click");
  await expect(page.getByTestId("reader-subject")).toBeVisible();
  await expect(page.getByTestId("message-text").first()).toBeVisible();
  await focusList(page);
}

async function closeCompose(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("compose-title")).toHaveCount(0);
}

test.describe("precision across screens (plan 160)", { tag: "@design" }, () => {
  test("Split: titles share a line, the text one measure, toasts one inset, cards whole edges", async ({ app: page, server, design }) => {
    const facturas = await suggest(page, server);
    await openConversation(page);
    const subject = await line(page.getByTestId("reader-subject"));

    await scenario("the reader pane's titles: the subject, New message and the selection share an x and a baseline", async () => {
      await page.keyboard.press("c");
      const title = page.getByTestId("compose-title");
      await expect(title).toBeVisible();
      await settled(page.getByTestId("composer"));
      const compose = await line(title);
      expect.soft(near(compose.x, subject.x, 0.5), `${design}: New message starts at the subject's x: ${fmt(compose.x)} vs ${fmt(subject.x)}`).toBe(true);
      expect.soft(near(compose.y, subject.y, 0.5), `${design}: New message sits on the subject's baseline: ${fmt(compose.y)} vs ${fmt(subject.y)}`).toBe(true);
      await scenario("New message's card: four edges drawn", () => edges(page, page.getByTestId("composer-card"), "New message's card", design));
      await closeCompose(page);

      const ids = await rows(page).evaluateAll((els) => els.slice(1, 4).map((r) => (r as HTMLElement).dataset.threadId!));
      await selectRows(page, ids);
      const count = page.getByTestId("selection-count");
      await expect(count).toBeVisible();
      const selection = await line(count);
      expect.soft(near(selection.x, subject.x, 0.5), `${design}: the selection's title starts at the subject's x: ${fmt(selection.x)} vs ${fmt(subject.x)}`).toBe(true);
      expect.soft(near(selection.y, subject.y, 0.5), `${design}: the selection's title sits on the subject's baseline: ${fmt(selection.y)} vs ${fmt(subject.y)}`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(count).toHaveCount(0);
    });

    await scenario("the list pane's titles start where the rows' content does", async () => {
      const title = await line(page.getByTestId("list-title"));
      const start = await rows(page).first().evaluate((r) => [...r.children].find((c) => getComputedStyle(c).position !== "absolute" && c.getBoundingClientRect().width > 0)!.getBoundingClientRect().left);
      expect.soft(near(title.x, start, 0.5), `${design}: the list's title starts on the rows' content: ${fmt(title.x)} vs ${fmt(start)}`).toBe(true);
      // a category's review: the same line
      await openReview(page, facturas);
      await expect(page.getByTestId("list-title")).toContainText("Facturas");
      const review = await line(page.getByTestId("list-title"));
      expect.soft(near(review.x, start, 0.5), `${design}: the review's title starts on the rows' content: ${fmt(review.x)} vs ${fmt(start)}`).toBe(true);
      expect.soft(near(review.y, title.y, 0.5), `${design}: the review's title sits on the mailbox title's baseline: ${fmt(review.y)} vs ${fmt(title.y)}`).toBe(true);
      await page.getByTestId("nav-inbox").click();
      await expect(page.getByTestId("list-title")).not.toContainText("Facturas");
    });

    await scenario("one measure: the column, the reply card, the text, the draft and its quote", async () => {
      await openConversation(page);
      await measure(page, design, "Split");
      await page.keyboard.press("r");
      await expect(page.locator("[data-testid=draft-slot][data-state=open]")).toBeVisible();
      await draftMeasure(page, design, "Split");
      await measure(page, design, "Split, replying");
      await scenario("the reply card: four edges drawn", () => edges(page, page.locator("[data-testid=draft-slot]"), "the reply card", design));
      await page.keyboard.press("Escape");
      await focusList(page);
    });

    await scenario("a toast over the reader: one inset from its foot, centred on the column, its edges whole", async () => {
      await openConversation(page);
      await page.keyboard.press("e");
      await toast(page, design, "Split");
      await edges(page, page.locator("[data-snack-card][data-state=open]"), "the toast", design);
      await page.keyboard.press("z");
    });

    await scenario("the palette and a row's menu: whole edges", async () => {
      await focusList(page);
      await page.keyboard.press("ControlOrMeta+k");
      const dialog = page.locator("[data-slot=dialog-content]").filter({ has: page.locator("[data-slot=command]") });
      await expect(dialog).toBeVisible();
      await edges(page, dialog, "the palette", design);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      const id = await rightClickLastRow(page);
      await menuOnItsRow(page, id, design, "Split 1440x900");
      await edges(page, page.locator("[data-slot=context-menu-content]"), "the row menu", design);
      await page.keyboard.press("Escape");
    });
  });

  test("small windows: the palette and menus end on whole rows, the menu beside its row, the reply card in view", async ({ app: page, design }) => {
    for (const [width, height] of [[1100, 700], [1100, 560]] as const) {
      await page.setViewportSize({ width, height });
      const size = `${width}x${height}`;
      await scenario(`${size}: the palette ends on a whole row, an inset above the window's foot`, async () => {
        await focusList(page);
        await page.keyboard.press("ControlOrMeta+k");
        const dialog = page.locator("[data-slot=dialog-content]").filter({ has: page.locator("[data-slot=command]") });
        await expect(dialog).toBeVisible();
        await settled(dialog);
        await wholeRows(dialog.locator("[data-slot=command-list]"), "[data-slot=command-item]", `${size}: the palette`, design);
        const inset = await token(page, "--float-inset", 12);
        const gap = await dialog.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
        expect.soft(gap >= inset - 0.5, `${design} ${size}: the palette is ≥ ${inset}px above the window's foot: ${fmt(gap)}px`).toBe(true);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      });
      await scenario(`${size}: the menu on the last row shows whole rows, an inset from the window, its row in view`, async () => {
        const id = await rightClickLastRow(page);
        await menuOnItsRow(page, id, design, size);
        // a resize: the menu goes (it would be left where the row was)
        await page.setViewportSize({ width: width - 40, height });
        await expect(page.locator("[data-slot=context-menu-content]")).toHaveCount(0);
        await page.setViewportSize({ width, height });
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-slot=context-menu-content]")).toHaveCount(0);
      });
    }
    await scenario("1100x700: an open reply's card is wholly in view", async () => {
      await page.setViewportSize({ width: 1100, height: 700 });
      await openConversation(page);
      await page.keyboard.press("r");
      const slot = page.locator("[data-testid=draft-slot][data-state=open]");
      await expect(slot).toBeVisible();
      await page.waitForTimeout(250);
      await edges(page, slot, "the reply card at 1100x700", design);
      await page.keyboard.press("Escape");
    });
  });
});

test.describe("precision across screens: List (plan 160)", { tag: "@design" }, () => {
  test.use({ layout: "list" });
  test("List: titles on the rows' line, one column on the page, toasts clear of the rows", async ({ app: page, design }) => {
    await scenario("the list's titles: the mailbox, the selection toolbar and a review start on the rows' content, on one baseline", async () => {
      const title = await line(page.getByTestId("list-title"));
      const start = await rows(page).first().evaluate((r) => [...r.children].find((c) => getComputedStyle(c).position !== "absolute" && c.getBoundingClientRect().width > 0)!.getBoundingClientRect().left);
      expect.soft(near(title.x, start, 0.5), `${design} List: the mailbox title starts on the rows' content: ${fmt(title.x)} vs ${fmt(start)}`).toBe(true);
      // List: ⌘-click checks each (a plain click opens the page)
      for (const i of [1, 2, 3]) await rows(page).nth(i).click({ modifiers: ["ControlOrMeta"] });
      const count = page.getByTestId("selection-count");
      await expect(count).toBeVisible();
      const selection = await line(count);
      expect.soft(near(selection.x, start, 0.5), `${design} List: the selection toolbar's title starts on the rows' content: ${fmt(selection.x)} vs ${fmt(start)}`).toBe(true);
      expect.soft(near(selection.y, title.y, 0.5), `${design} List: the selection toolbar's title sits on the header's baseline: ${fmt(selection.y)} vs ${fmt(title.y)}`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(count).toHaveCount(0);
    });

    await scenario("previews start on one x (a reserved subject column)", async () => {
      const lefts = await rows(page).evaluateAll((els) => els.slice(0, 14).map((r) => r.querySelector("[data-testid=row-snippet]")?.getBoundingClientRect().left).filter((x): x is number => x !== undefined));
      const spread = Math.max(...lefts) - Math.min(...lefts);
      expect.soft(spread, `${design} List: every preview starts at one x (spread ${fmt(spread)}px)`).toBeLessThanOrEqual(0.5);
    });

    await scenario("a toast over the list: an inset from the foot, no row under it", async () => {
      await rows(page).nth(2).dispatchEvent("mousedown");
      await rows(page).nth(2).dispatchEvent("click");
      // List opens the page: back to the rows, then archive from there
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("reader")).toHaveCount(0);
      await focusList(page);
      await page.keyboard.press("e");
      await toast(page, design, "List");
      await page.keyboard.press("z");
    });

    await scenario("the page: the reader subject and New message share a line; one column, one measure", async () => {
      await openConversation(page);
      const subject = await line(page.getByTestId("reader-subject"));
      await measure(page, design, "List");
      await page.keyboard.press("r");
      await expect(page.locator("[data-testid=draft-slot][data-state=open]")).toBeVisible();
      await draftMeasure(page, design, "List");
      await measure(page, design, "List, replying");
      await page.keyboard.press("Escape");
      await focusList(page);
      await page.keyboard.press("c");
      const title = page.getByTestId("compose-title");
      await expect(title).toBeVisible();
      await settled(page.getByTestId("composer"));
      const compose = await line(title);
      expect.soft(near(compose.x, subject.x, 0.5), `${design} List: New message starts at the subject's x: ${fmt(compose.x)} vs ${fmt(subject.x)}`).toBe(true);
      expect.soft(near(compose.y, subject.y, 0.5), `${design} List: New message sits on the subject's baseline: ${fmt(compose.y)} vs ${fmt(subject.y)}`).toBe(true);
      await closeCompose(page);
    });
  });
});
