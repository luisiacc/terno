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

/** Its box the same over three frames (a menu that re-anchors once it knows its height moves a frame after opening) */
const still = (l: Locator) =>
  l.evaluate(
    (el) =>
      new Promise<void>((done) => {
        let last = "", same = 0, frames = 0;
        const tick = () => {
          const r = el.getBoundingClientRect();
          const now = `${r.top},${r.left},${r.width},${r.height}`;
          same = now === last ? same + 1 : 0;
          last = now;
          if (same >= 3 || ++frames > 60) done();
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );

/** Every opening animation inside it finished (a zoom would scale the rects) */
const settled = (l: Locator) => l.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity && a.id !== "snack-countdown").map((a) => a.finished))).catch(() => {});

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
/** What was measured, in the report (the plan's before and after) */
const note = (what: string, value: string) => test.info().annotations.push({ type: "measured", description: `${what}: ${value}` });
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
 * drawn by a border or a ring on every side (its computed style), and visible: along each edge (its corners left out),
 * the stroke's own pixel (the border's inside the box, the ring's just outside it) differs from what's behind it on
 * ≥ 95% of its length. Returns what's wrong (empty: whole), so a test can also show it catches a missing edge.
 */
async function edgeReport(page: Page, card: Locator): Promise<string[]> {
  await settled(card);
  const geo = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    // a ring: an outer shadow with no offset or blur and a spread (Tailwind's ring, our hairline shadows)
    const ring = s.boxShadow.split(/,(?![^(]*\))/).some((sh) => !/inset/.test(sh) && /(^|\s)0px 0px 0px [\d.]+px/.test(sh.replace(/rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)/g, "").trim()) && !/0px 0px 0px 0px/.test(sh));
    const by = (["top", "right", "bottom", "left"] as const).map((side) => [side, parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 ? "border" : ring ? "ring" : "none"] as const);
    let clip: string | null = null;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === "visible" && as.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      // its ring is drawn a pixel outside the box
      if (r.left - 1 < c.left - 0.5 || r.top - 1 < c.top - 0.5 || r.right + 1 > c.right + 0.5 || r.bottom + 1 > c.bottom + 0.5) {
        clip = `${a.tagName.toLowerCase()}${a.dataset.testid ? `[${a.dataset.testid}]` : ""} (${Math.round(c.top)}..${Math.round(c.bottom)})`;
        break;
      }
    }
    return { r: r.toJSON() as DOMRect, radius, clip, by: Object.fromEntries(by) as Record<string, "border" | "ring" | "none">, w: innerWidth, h: innerHeight };
  });
  const { r } = geo;
  const problems: string[] = [];
  if (!(r.left - 1 >= 0 && r.top - 1 >= 0 && r.right + 1 <= geo.w && r.bottom + 1 <= geo.h)) problems.push(`outside the window (${fmt(r.left)},${fmt(r.top)} to ${fmt(r.right)},${fmt(r.bottom)} in ${geo.w}x${geo.h})`);
  if (geo.clip) problems.push(`cut by ${geo.clip}`);
  for (const [side, by] of Object.entries(geo.by)) if (by === "none") problems.push(`no border or ring on its ${side}`);
  const shot = (await page.screenshot({ animations: "disabled", caret: "hide" })).toString("base64");
  const drawn = await page.evaluate(async ({ shot, r, radius, by }) => {
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
      // the stroke's pixel: a border's is the box's last, a ring's the first outside it; behind is 4 px further out
      const d = by[side] === "ring" ? 1 : 0;
      const len = Math.max(Math.abs(to[0]! - from[0]!), Math.abs(to[1]! - from[1]!));
      let hit = 0, total = 0;
      for (let s = 0; s <= len; s += 2) {
        const x = from[0]! + ((to[0]! - from[0]!) * s) / Math.max(1, len);
        const y = from[1]! + ((to[1]! - from[1]!) * s) / Math.max(1, len);
        if (x < 6 || y < 6 || x > innerWidth - 7 || y > innerHeight - 7) continue;
        total++;
        if (dist(px(x + n[0]! * d, y + n[1]! * d), px(x + n[0]! * (d + 4), y + n[1]! * (d + 4))) >= 6) hit++;
      }
      out[side] = total ? hit / total : 0;
    }
    return out;
  }, { shot, r, radius: geo.radius, by: geo.by });
  for (const [side, share] of Object.entries(drawn)) if (share < 0.95) problems.push(`its ${side} edge drawn on ${Math.round(share * 100)}% of it`);
  return problems;
}

async function edges(page: Page, card: Locator, name: string, design: string): Promise<void> {
  expect.soft(await edgeReport(page, card), `${design}: ${name}'s four edges are whole`).toEqual([]);
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
  note(`${where} toast (gap, centre vs column, rows under)`, `${fmt(m.gap)}, ${fmt(m.centre)} vs ${m.column === null ? "-" : fmt(m.column)}, ${m.covered}`);
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
  await still(menu);
  const inset = await token(page, "--float-inset", 12);
  await wholeRows(menu, "[role=menuitem]", `${where}: the row menu`, design);
  const m = await menu.evaluate((el, [id, inset]) => {
    const r = el.getBoundingClientRect();
    const row = document.querySelector(`[data-testid=thread-row][data-thread-id="${id}"]`)!;
    const text = [...row.querySelectorAll("[data-testid=row-from],[data-testid=row-subject],[data-testid=row-snippet],[data-testid=row-date]")].map((t) => t.getBoundingClientRect()).filter((t) => t.width > 0);
    const over = text.some((t) => t.top < r.bottom && t.bottom > r.top && t.left < r.right && t.right > r.left);
    const fits = el.scrollHeight <= el.clientHeight + 1;
    // the window holds the whole menu (then it must show whole, over its row if need be: revision 4)
    const holds = el.scrollHeight + 2 * inset <= innerHeight;
    // room for the whole menu under the row or over it, an inset from the window's edge
    const b = row.getBoundingClientRect();
    const room = Math.max(innerHeight - b.bottom, b.top) - inset - 4 >= el.scrollHeight;
    return { over, fits, holds, room, left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
  }, [id, inset] as const);
  note(`${where} menu (over its row, edge gaps l/t/r/b)`, `${m.over}, ${[m.left, m.top, m.right, m.bottom].map(fmt).join("/")}`);
  if (m.holds) expect.soft(m.fits, `${design} ${where}: the row menu shows every row`).toBe(true);
  // only a window too short for it on either side lets it cover the row (revision 4)
  if (m.room) expect.soft(m.over, `${design} ${where}: the row menu leaves its own row's text in view`).toBe(false);
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
  note(`${where} column width (max ${readerMax})`, fmt(m.width));
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
    // the text's own measure: the box's max-width less its padding and border (box-sizing: border-box)
    const max = (el: Element | null) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return Math.round((parseFloat(s.maxWidth) - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth)) * 10) / 10;
    };
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
        return Math.round(parseFloat(w) * 10) / 10;
      })(),
    };
  });
  expect.soft(m.body !== null && Number.isFinite(m.body) && m.body === m.readMax, `${design} ${where}: the message text is capped at --read-max (${m.readMax}px): ${m.body}`).toBe(true);
  expect.soft(m.editor, `${design} ${where}: the draft's text has the message's measure`).toBe(m.body);
  expect.soft(m.quote, `${design} ${where}: the quoted text has the message's measure`).toBe(m.body);
}

/**
 * Two suggestions for Facturas, so it has a Review to open: not on the conversation the titles are measured on, whose
 * header stays at rest (Atelier's chips line is 20 px at rest, a chip's 24 with one: revision 2, written down in the plan)
 */
async function suggest(page: Page, server: DevServer): Promise<number> {
  const db = sqlDb(server.backend.store);
  const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
  const threads = db.all<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND t.last_from_name NOT LIKE ? AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 2", `${OPEN}%`);
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

/** The reader pane's three titles at this size: the subject, New message and the selection, on one x and baseline */
async function titlesAgree(page: Page, design: string, where: string): Promise<void> {
  await openConversation(page);
  const subject = await line(page.getByTestId("reader-subject"));
  await page.keyboard.press("c");
  const title = page.getByTestId("compose-title");
  await expect(title).toBeVisible();
  await settled(page.getByTestId("composer"));
  const compose = await line(title);
  await closeCompose(page);
  const ids = await rows(page).evaluateAll((els) => els.slice(1, 4).map((r) => (r as HTMLElement).dataset.threadId!));
  await selectRows(page, ids);
  const count = page.getByTestId("selection-count");
  await expect(count).toBeVisible();
  const selection = await line(count);
  await page.keyboard.press("Escape");
  await expect(count).toHaveCount(0);
  const reader = await page.locator("main").evaluate((el) => el.getBoundingClientRect().width);
  note(`${where} titles (reader ${fmt(reader)} px): subject, New message, selection`, `${fmt(subject.x)},${fmt(subject.y)}; ${fmt(compose.x)},${fmt(compose.y)}; ${fmt(selection.x)},${fmt(selection.y)}`);
  for (const [name, at] of [["New message", compose], ["the selection's title", selection]] as const) {
    expect.soft(near(at.x, subject.x, 0.5) && near(at.y, subject.y, 0.5), `${design} ${where} (reader ${fmt(reader)} px): ${name} on the subject's line: ${fmt(at.x)},${fmt(at.y)} vs ${fmt(subject.x)},${fmt(subject.y)}`).toBe(true);
  }
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
      note("Split New message vs subject (x, baseline)", `${fmt(compose.x)},${fmt(compose.y)} vs ${fmt(subject.x)},${fmt(subject.y)}`);
      expect.soft(near(compose.x, subject.x, 0.5), `${design}: New message starts at the subject's x: ${fmt(compose.x)} vs ${fmt(subject.x)}`).toBe(true);
      expect.soft(near(compose.y, subject.y, 0.5), `${design}: New message sits on the subject's baseline: ${fmt(compose.y)} vs ${fmt(subject.y)}`).toBe(true);
      await scenario("New message's card: four edges drawn", () => edges(page, page.getByTestId("composer-card"), "New message's card", design));
      await scenario("the edge check catches a card with no ring (its own proof)", async () => {
        const off = await page.addStyleTag({ content: "[data-testid=composer-card]{box-shadow:none!important;border:0!important}" });
        const report = await edgeReport(page, page.getByTestId("composer-card"));
        await off.evaluate((el) => el.remove());
        for (const side of ["top", "right", "bottom", "left"]) expect.soft(report.some((p) => p.includes(side)), `${design}: a ringless card's ${side} edge is reported (${report.join("; ")})`).toBe(true);
      });
      await closeCompose(page);

      const ids = await rows(page).evaluateAll((els) => els.slice(1, 4).map((r) => (r as HTMLElement).dataset.threadId!));
      await selectRows(page, ids);
      const count = page.getByTestId("selection-count");
      await expect(count).toBeVisible();
      const selection = await line(count);
      note("Split selection vs subject (x, baseline)", `${fmt(selection.x)},${fmt(selection.y)} vs ${fmt(subject.x)},${fmt(subject.y)}`);
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
      const mailbox = await page.getByTestId("list-title").textContent();
      await openReview(page, facturas);
      // (plan 159: the review's own title, its category in a switcher)
      await expect(page.getByTestId("list-title")).not.toHaveText(mailbox ?? "");
      const review = await line(page.getByTestId("list-title"));
      expect.soft(near(review.x, start, 0.5), `${design}: the review's title starts on the rows' content: ${fmt(review.x)} vs ${fmt(start)}`).toBe(true);
      expect.soft(near(review.y, title.y, 0.5), `${design}: the review's title sits on the mailbox title's baseline: ${fmt(review.y)} vs ${fmt(title.y)}`).toBe(true);
      await page.getByTestId("nav-inbox").click();
      await expect(page.getByTestId("list-title")).toHaveText(mailbox ?? "");
    });

    await scenario("one measure: the column, the reply card, the text, the draft and its quote", async () => {
      await openConversation(page);
      await measure(page, design, "Split");
      await page.keyboard.press("r");
      await expect(page.locator("[data-testid=draft-slot][data-state=open]")).toBeVisible();
      // as it opened (the quote, opened below, grows it past the window like any long content)
      await scenario("the reply card: four edges drawn", () => edges(page, page.locator("[data-testid=draft-slot]"), "the reply card", design));
      await draftMeasure(page, design, "Split");
      await measure(page, design, "Split, replying");
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
      await expect(page.locator("[data-slot=context-menu-content]")).toHaveCount(0);
      // a scroll that lands just before the right-click (its event a frame later) keeps the menu; one after it closes it
      await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>("[role=listbox]")!;
        list.scrollTop += 120;
        const v = list.getBoundingClientRect();
        const row = [...list.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].find((r) => r.getBoundingClientRect().top > v.top + 40)!;
        const b = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 60, clientY: b.top + b.height / 2, button: 2 }));
      });
      const menu = page.locator("[data-slot=context-menu-content]");
      await expect(menu).toBeVisible();
      await page.waitForTimeout(150);
      expect.soft(await menu.count(), `${design}: a scroll that landed before the right-click leaves its menu open`).toBe(1);
      await page.locator("[role=listbox]").evaluate((el) => (el.scrollTop += 60));
      await expect(menu, `${design}: the list scrolled under it: the menu goes`).toHaveCount(0);
    });
  });

  test("small windows: the palette and menus end on whole rows, the menu beside its row, the reply card in view", async ({ app: page, design }) => {
    // (420 tall: every design's menu scrolls there, capped at a whole row, which rows added later must keep)
    for (const [width, height] of [[1100, 700], [1100, 560], [1100, 420]] as const) {
      await page.setViewportSize({ width, height });
      const size = `${width}x${height}`;
      await scenario(`${size}: the palette ends on a whole row, an inset above the window's foot`, async () => {
        await focusList(page);
        await page.keyboard.press("ControlOrMeta+k");
        const dialog = page.locator("[data-slot=dialog-content]").filter({ has: page.locator("[data-slot=command]") });
        await expect(dialog).toBeVisible();
        await settled(dialog);
        await still(dialog.locator("[data-slot=command-list]"));
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
        // rows that arrive while it's open (Reply all, once the conversation loads) re-place it: still whole rows (Codex review)
        const menu = page.locator("[data-slot=context-menu-content]");
        await menu.evaluate((el) => {
          const row = el.querySelector("[role=menuitem]")!;
          for (let i = 0; i < 4; i++) el.insertBefore(row.cloneNode(true), row);
        });
        await still(menu);
        await wholeRows(menu, "[role=menuitem]", `${size}: the row menu, rows added while open`, design);
        // a resize: the menu goes (it would be left where the row was)
        await page.setViewportSize({ width: width - 40, height });
        await expect(page.locator("[data-slot=context-menu-content]")).toHaveCount(0);
        await page.setViewportSize({ width, height });
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-slot=context-menu-content]")).toHaveCount(0);
      });
    }
    // the container's narrow steps (a smaller title under 560 px, less margin under 420 px) keep the line too
    for (const [width, height] of [[1100, 700], [960, 700]] as const) {
      await page.setViewportSize({ width, height });
      await scenario(`${width}x${height}: the reader pane's titles share a line`, () => titlesAgree(page, design, `${width}x${height}`));
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

test.describe("precision across screens: compact rows (plan 160)", { tag: "@design" }, () => {
  test("a narrow Split list in compact density: previews on one x, nothing over the date", async ({ app: page, server, design }) => {
    await server.backend.server.invoke("settings.update", { density: "compact" }, { clientId: "setup", origin: "dev" as const });
    for (const [width, height] of [[1100, 700], [1060, 700]] as const) {
      await page.setViewportSize({ width, height });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await rows(page).first().waitFor();
      const m = await rows(page).evaluateAll((els) => {
        const list = document.querySelector("[role=listbox]")!.getBoundingClientRect();
        return els.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= list.top && b.bottom <= list.bottom; }).map((r) => {
          const box = (id: string) => r.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect();
          const subject = box("row-subject")!, snippet = box("row-snippet"), date = box("row-date")!, account = box("account-label");
          const meta = Math.min(date.left, account && account.width > 0 ? account.left : Infinity);
          return { snippet: snippet && snippet.width > 0 ? snippet.left : null, over: subject.right > meta + 0.5 || (snippet ? snippet.right > meta + 0.5 : false), listWidth: list.width };
        });
      });
      const lefts = m.map((r) => r.snippet).filter((x): x is number => x !== null);
      const spread = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 0;
      note(`compact ${width} (list ${fmt(m[0]?.listWidth ?? 0)}): preview spread, rows over the meta`, `${fmt(spread)}, ${m.filter((r) => r.over).length}`);
      expect.soft(spread, `${design} compact ${width}: previews start at one x`).toBeLessThanOrEqual(0.5);
      expect.soft(m.filter((r) => r.over).length, `${design} compact ${width}: no subject or preview runs over the account or the date`).toBe(0);
    }
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
      note("List header, toolbar and rows' start (x, baseline)", `${fmt(title.x)},${fmt(title.y)}; ${fmt(selection.x)},${fmt(selection.y)}; ${fmt(start)}`);
      expect.soft(near(selection.x, start, 0.5), `${design} List: the selection toolbar's title starts on the rows' content: ${fmt(selection.x)} vs ${fmt(start)}`).toBe(true);
      expect.soft(near(selection.y, title.y, 0.5), `${design} List: the selection toolbar's title sits on the header's baseline: ${fmt(selection.y)} vs ${fmt(title.y)}`).toBe(true);
      await page.keyboard.press("Escape");
      await expect(count).toHaveCount(0);
    });

    await scenario("previews start on one x (a reserved subject column)", async () => {
      const lefts = await rows(page).evaluateAll((els) => els.slice(0, 14).map((r) => r.querySelector("[data-testid=row-snippet]")?.getBoundingClientRect().left).filter((x): x is number => x !== undefined));
      const spread = Math.max(...lefts) - Math.min(...lefts);
      note("List preview x spread", fmt(spread));
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

    await scenario("a toast that grows leaves a list scrolled away from its open row where it was", async () => {
      await page.setViewportSize({ width: 1440, height: 500 });
      const row = rows(page).nth(14);
      await row.dispatchEvent("mousedown");
      await row.dispatchEvent("click");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("reader")).toHaveCount(0);
      await focusList(page);
      await page.keyboard.press("e");
      const card = page.locator("[data-snack-card][data-state=open]");
      await expect(card).toBeVisible();
      await still(card);
      // the open row 50 px under the viewport's foot: out of view by the user's own scroll
      const list = page.locator("[role=listbox]");
      const top = await list.evaluate((el) => {
        const cursor = el.querySelector<HTMLElement>("[data-testid=thread-row][data-cursor]")!;
        const r = cursor.getBoundingClientRect(), v = el.getBoundingClientRect();
        el.scrollTop = Math.max(0, el.scrollTop + (r.top - v.bottom) - 50);
        return el.scrollTop;
      });
      await page.waitForTimeout(100);
      await page.getByTestId("snackbar-similar").click();
      await still(card);
      await page.waitForTimeout(100);
      const after = await list.evaluate((el) => el.scrollTop);
      note("List scrolled away, toast grown (scrollTop before, after)", `${fmt(top)}, ${fmt(after)}`);
      expect.soft(after, `${design} List: the toast growing leaves the list where the user scrolled it`).toBe(top);
      await page.keyboard.press("z");
      await page.setViewportSize({ width: 1440, height: 900 });
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
      note("List New message vs subject (x, baseline)", `${fmt(compose.x)},${fmt(compose.y)} vs ${fmt(subject.x)},${fmt(subject.y)}`);
      expect.soft(near(compose.x, subject.x, 0.5), `${design} List: New message starts at the subject's x: ${fmt(compose.x)} vs ${fmt(subject.x)}`).toBe(true);
      expect.soft(near(compose.y, subject.y, 0.5), `${design} List: New message sits on the subject's baseline: ${fmt(compose.y)} vs ${fmt(subject.y)}`).toBe(true);
      await closeCompose(page);
    });
  });
});
