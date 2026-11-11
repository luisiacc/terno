/**
 * Plan 15: designs. `e2e` runs every flow once, in macOS. What repeats in the other designs (plan 139) is what they can change:
 *
 * - **@design, all five:** what any design's type, shape, density or palette can change: this file's first part (layout at the
 *   minimum window, row heights, keyboard and scroll, the parts every variant keeps, a baseline of each key screen), other
 *   baselines, the icon line, corners, and the List layout's round trip.
 * - **@variant, Lumen and Atelier:** a flow that goes through a structural variant macOS doesn't hold (designs/types.ts:
 *   compose, listHeader, search, quickFilters, row, readerHeader, replyAction), or a part only
 *   those rows have (an avatar's icon); and the axe sweep (design-axe.spec.ts) and motion, which change only with a structure.
 * - **@variant-graphite, also Graphite:** a flow through its own value, the sidebar's compose row. Luma adds no value.
 *
 * A flow that reads the same in every design takes no tag: one run. A flow tied to one design says so with `test.use({ design })`,
 * and runs once, in `e2e`. Adding a design that holds a new value: its project's grep (playwright.config.ts) and a @variant flow.
 * The rest of this file (switching live, the default, the move from before designs, fonts) runs once.
 */
import type { Page } from "@playwright/test";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import type { DesignDefinition } from "../../../packages/ui/src/designs/types";
import { NO_PREVIEW_GAP } from "../../../packages/ui/src/designs/rows";
import { sqlDb } from "../../backend-dev/src/server";
import { E2E_NOW } from "./constants";
import { expect, focusList, forgetOffer, openRow, rows, scenario, selectedRow, stabilize, test, openReview } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const reload = async (page: Page) => {
  await page.reload();
  await page.locator("[data-ready]").waitFor();
};
const designOf = async (page: Page): Promise<DesignDefinition> => {
  const id = await page.locator("html").getAttribute("data-design");
  return DESIGNS.find((d) => d.id === id)!;
};

test.describe("in every design", { tag: "@design" }, () => {
  test("in every design: Settings' styles", async ({ app: page, server }) => {
    await scenario("Settings' styles sit on one row, every name in full, with the chosen one's description on a line below", async () => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      const cards = page.getByTestId("design-grid").getByRole("radio");
      await expect(cards).toHaveCount(DESIGNS.length);
      const tops = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(new Set(tops).size).toBe(1);
      // a truncated name is wider than its box
      expect(await cards.evaluateAll((els) => els.filter((el) => { const n = el.querySelector(":scope > span"); return n && n.scrollWidth > n.clientWidth; }).length)).toBe(0);
      const description = page.getByTestId("design-description");
      await expect(description).toBeVisible();
      await expect(page.getByTestId("design-grid")).toHaveAccessibleDescription(new RegExp((await description.textContent())!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      // every style's description takes one line at this width, in both languages
      for (const d of DESIGNS) for (const locale of [en, es]) {
        const height = await description.evaluate((el, text) => {
          el.textContent = text;
          return el.getBoundingClientRect().height;
        }, locale[`design.${d.id}.description`]);
        expect(height, d.id).toBeLessThan(20);
      }
    });
    await scenario("Settings' styles never take more than two rows, and a description that wraps moves nothing below it", async () => {
      await server.backend.server.invoke("settings.update", { language: "es" }, ctx);
      await page.setViewportSize({ width: 550, height: 800 });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      const cards = page.getByTestId("design-grid").getByRole("radio");
      await expect(cards).toHaveCount(DESIGNS.length);
      const tops = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(new Set(tops).size).toBeLessThanOrEqual(2);
      // the cell is as tall as its tallest description, whichever is showing
      const cell = await page.getByTestId("design-descriptions").evaluate((el) => ({ height: el.getBoundingClientRect().height, tallest: Math.max(...[...el.children].map((c) => c.getBoundingClientRect().height)), count: el.children.length }));
      expect(cell.count).toBe(DESIGNS.length);
      expect(cell.height).toBe(cell.tallest);
    });
  });

  test("in every design: the list and the reader", async ({ app: page, server }) => {
    await scenario("at the minimum window (980×600) nothing overflows: panes, the toolbar, the header, the sidebar", async () => {
      await page.setViewportSize({ width: 980, height: 600 });
      await openRow(page, 2);
      const overflow = await page.evaluate(() =>
        ["sidebar", "thread-list", "reader"].map((id) => {
          const el = document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
          return [id, el.scrollWidth - el.clientWidth] as const;
        }),
      );
      for (const [id, extra] of overflow) expect(extra, id).toBeLessThanOrEqual(0);
      const reader = (await page.getByTestId("reader").boundingBox())!;
      for (const id of ["action-archive", "action-trash", "action-star", "action-reply", "action-forward", "action-more"]) {
        const b = (await page.getByTestId(id).boundingBox())!;
        expect(b.x, id).toBeGreaterThanOrEqual(reader.x);
        expect(b.x + b.width, id).toBeLessThanOrEqual(reader.x + reader.width + 0.5);
      }
      // the title is one line (truncated if it must), the compose control and the last account reachable
      const title = (await page.getByTestId("list-title").boundingBox())!;
      const lh = await page.getByTestId("list-title").evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || el.getBoundingClientRect().height);
      expect(title.height).toBeLessThanOrEqual(lh * 1.5);
      await expect(page.getByTestId("compose-button")).toBeInViewport();
      await page.getByText("Add account").scrollIntoViewIfNeeded();
      await expect(page.getByText("Add account")).toBeInViewport();
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await scenario("the parts every variant keeps: one compose control, rows as options with their parts, the subject, the chips, the reply controls", async () => {
      await reload(page);
      await expect(page.getByTestId("compose-button")).toHaveCount(1);
      await expect(page.getByTestId("compose-button")).toBeVisible();
      const first = rows(page).first();
      await expect(first).toHaveAttribute("role", "option");
      await expect(first.getByTestId("row-from")).toBeVisible();
      await expect(first.getByTestId("row-subject")).toBeVisible();
      await openRow(page, 2);
      await expect(page.getByTestId("reader-subject")).toBeVisible();
      await expect(page.getByTestId("thread-chips")).toBeVisible();
      for (const id of ["action-reply", "action-forward", "action-archive", "action-more"]) await expect(page.getByTestId(id)).toBeVisible();
      await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(1);
      // plan 21: More (a disclosure) and the two pane edges (separators), named alike everywhere
      await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveCount(1);
      await expect(page.getByRole("separator", { name: "Resize message list" })).toHaveCount(1);
      // c composes from anywhere, whatever the control looks like
      await focusList(page);
      await page.keyboard.press("c");
      await expect(page.getByTestId("compose-title")).toBeVisible();
    });
    await scenario("rows are the design's height in both densities, and j/k keep the open thread in view down the list", async () => {
      await reload(page);
      const d = await designOf(page);
      await expect(rows(page).first()).toHaveCSS("height", `${d.rows.comfortable}px`);
      await expect(rows(page).first()).toHaveAttribute("data-layout", d.variants.row);
      await focusList(page);
      for (let i = 0; i < 25; i++) await page.keyboard.press("j");
      await expect(selectedRow(page)).toBeInViewport();
      await server.backend.server.invoke("settings.update", { density: "compact" }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(rows(page).first()).toHaveCSS("height", `${d.rows.compact}px`);
      await server.backend.server.invoke("settings.update", { density: "comfortable" }, ctx);
    });
    await scenario("plan 187: two preview lines wrap and clamp, the marks and account on the first; with none they end the subject's line", async () => {
      const d = await designOf(page);
      const leading = parseFloat(d.type.rowSnippet.leading) * 16;
      /** a row with marks, an account and a preview long enough for two lines: its parts' boxes */
      const geometry = () =>
        page.evaluate(() => {
          const row = [...document.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].find((r) => r.querySelector("[data-testid=row-marks]") && r.querySelector("[data-testid=account-label]") && (r.querySelector("[data-testid=row-snippet]")?.textContent ?? "").length > 120)!;
          const box = (id: string) => {
            const b = row.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect();
            return b ? { top: b.top, bottom: b.bottom, mid: (b.top + b.bottom) / 2 } : null;
          };
          const snippet = row.querySelector<HTMLElement>("[data-testid=row-snippet]");
          return { id: row.dataset.threadId!, snippet: box("row-snippet"), clamped: snippet ? snippet.scrollHeight > snippet.clientHeight + 1 : false, subject: box("row-subject")!, marks: box("row-marks")!, account: box("account-label")! };
        });
      await server.backend.server.invoke("settings.update", { previewLines: 2 }, ctx);
      await reload(page);
      const two = await geometry();
      // two lines tall, and more text than fits: clamped, not one nowrap line
      expect(two.snippet!.bottom - two.snippet!.top).toBeCloseTo(2 * leading, 0);
      expect(two.clamped).toBe(true);
      // the marks and the account centred on the preview's first line
      for (const part of [two.marks, two.account]) expect(Math.abs(part.mid - (two.snippet!.top + leading / 2))).toBeLessThanOrEqual(2);
      await server.backend.server.invoke("settings.update", { previewLines: 0 }, ctx);
      await reload(page);
      const none = await page.evaluate(() => document.querySelectorAll("[data-testid=row-snippet]").length);
      expect(none).toBe(0);
      // the owner: the subject in the preview's ink and weight, unread too, at the subject's own size
      const unread = page.locator("[data-testid=thread-row][data-unread]").first().getByTestId("row-subject");
      const muted = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.className = "text-muted-foreground";
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      await expect(unread).toHaveCSS("color", muted);
      await expect(unread).toHaveCSS("font-weight", String(d.type.rowSnippet.weight));
      await expect(unread).toHaveCSS("font-size", `${parseFloat(d.type.rowSubject.size) * 16}px`);
      const row = page.locator("[data-testid=thread-row]", { has: page.getByTestId("row-marks") }).filter({ has: page.getByTestId("account-label") }).first();
      const subject = (await row.getByTestId("row-subject").boundingBox())!;
      // the owner: the two lines apart by the gap the row's height allows for
      const from = (await row.getByTestId("row-from").boundingBox())!;
      expect(subject.y - (from.y + from.height)).toBeCloseTo(NO_PREVIEW_GAP, 0);
      for (const id of ["row-marks", "account-label"]) {
        const b = (await row.getByTestId(id).boundingBox())!;
        expect(Math.abs(b.y + b.height / 2 - (subject.y + subject.height / 2)), id).toBeLessThanOrEqual(2);
      }
      await server.backend.server.invoke("settings.update", { previewLines: 1 }, ctx);
    });
    await scenario("a category's suggestions are reachable from the sidebar in every design", async () => {
      const db = sqlDb(server.backend.store);
      const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
      const t = db.get<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1")!.id;
      db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.8, '[]', ?)", t, facturas, Date.now());
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      // plan 159: a row under the heading, to the category with the most; each one's own in its menu
      const review = page.getByTestId("nav-review");
      await expect(review).toHaveText(/^To sort\d+$/);
      await review.click();
      await expect(page.getByTestId("list-title")).toHaveText("Sort into categories");
      await expect(review).toHaveAttribute("data-active");
      await openReview(page, facturas);
      await expect(page.getByTestId("review-category")).toContainText("Facturas");
    });
  });

  test.describe("baselines", () => {
    test.use({ deviceScaleFactor: 1 });
    const ready = async (page: Page) => {
      await openRow(page, 2);
      await expect(page.getByTestId("message").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
    };
    test("the baselines of every key screen", async ({ app: page, server }) => {
      await scenario("inbox with the reader, light", async () => {
        await server.backend.server.invoke("settings.update", { theme: "light" }, ctx);
        await forgetOffer(page);
        await ready(page);
        await expect(page).toHaveScreenshot("design-inbox-light.png");
      });
      await scenario("inbox with the reader, dark", async () => {
        await server.backend.server.invoke("settings.update", { theme: "dark" }, ctx);
        await forgetOffer(page);
        await ready(page);
        await expect(page).toHaveScreenshot("design-inbox-dark.png");
      });
      await scenario("the minimum window", async () => {
        await server.backend.server.invoke("settings.update", { theme: "light" }, ctx);
        await page.setViewportSize({ width: 980, height: 600 });
        await forgetOffer(page);
        await ready(page);
        await expect(page).toHaveScreenshot("design-980.png");
        await page.setViewportSize({ width: 1440, height: 900 });
      });
      await scenario("Settings → Appearance", async () => {
        await forgetOffer(page);
        await page.getByTestId("open-settings").click();
        await page.getByTestId("tab-appearance").click();
        await page.evaluate(() => document.fonts.ready);
        await stabilize(page);
        await expect(page.getByTestId("settings-dialog")).toHaveScreenshot("design-settings-appearance.png");
      });
      await scenario("inline reply", async () => {
        await forgetOffer(page);
        await ready(page);
        await page.getByTestId("quick-reply").click();
        await expect(page.getByTestId("compose-body")).toBeFocused();
        await page.keyboard.type("Thanks, I’ll take a look this afternoon.");
        await stabilize(page);
        await expect(page).toHaveScreenshot("design-reply.png");
      });
    });
  });
});

test.describe("switching designs", () => {
  test("live, from Settings: one frame, nothing lost (selection, the list's place, an open message, a draft, the filter), focus stays", async ({ app: page, server }) => {
    // plan 174 (Codex review): a due reminder on top, so a label and a gap of fixed height sit above the rows, and keep theirs
    const due = Number(await rows(page).nth(6).getAttribute("data-thread-id"));
    await server.backend.server.invoke("reminders.set", { threadIds: [due], dueAt: E2E_NOW, kind: "always" }, ctx);
    await expect(rows(page).first()).toHaveAttribute("data-thread-id", String(due));
    // a place in the list, a thread open, an older message expanded, a draft written, the filter on
    await page.getByRole("listbox").evaluate((el) => el.scrollTo(0, 900));
    const anchorBefore = await page.evaluate(() => {
      const list = document.querySelector("[data-keep-scroll=list]")!;
      const top = list.getBoundingClientRect().top;
      const row = [...document.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].filter((r) => r.getBoundingClientRect().bottom > top + 1).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
      return row.dataset.threadId;
    });
    const firstVisible = page.locator(`[data-thread-id="${anchorBefore}"]`);
    await firstVisible.dispatchEvent("mousedown");
    const open = anchorBefore!;
    await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open);
    await page.getByTestId("quick-reply").click();
    await page.keyboard.type("Half a sentence");
    await expect(page.getByTestId("compose-body")).toHaveText("Half a sentence");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();

    /** the row at the top of the list's viewport, and how far into it the viewport starts (a share of its height) */
    // (the list is behind the modal sheet: found by its role attribute, not the accessibility tree)
    const anchor = () =>
      page.locator("[data-keep-scroll=list]").evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = [...el.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].filter((r) => r.getBoundingClientRect().bottom > top + 0.5).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
        const r = row.getBoundingClientRect();
        return { id: row.dataset.threadId, into: (top - r.top) / r.height };
      });
    // a viewport that starts partway into a row (Codex review #3: the restore must keep the same row, at the same depth)
    await page.locator("[data-keep-scroll=list]").evaluate((el) => {
      // 40% into the row at the top, whatever lies above the rows (plan 158: the rule offer is the list's first item)
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll<HTMLElement>("[data-testid=thread-row]")].map((r) => r.getBoundingClientRect()).filter((r) => r.bottom > top + 0.5).sort((a, b) => a.top - b.top)[0]!;
      el.scrollBy(0, row.top - top + row.height * 0.4);
    });
    for (const id of ["atelier", "lumen", "graphite", "macos"] as const) {
      const before = await anchor();
      expect(before.into).toBeGreaterThan(0.05);
      const card = page.getByTestId(`design-card-${id}`);
      await card.focus();
      await page.evaluate(() => {
        (window as unknown as { __shifts: number }).__shifts = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) (window as unknown as { __shifts: number }).__shifts += e.value;
        }).observe({ type: "layout-shift" });
      });
      await page.keyboard.press("Space"); // a radio: Space chooses it (Enter is the form's)
      await expect(page.locator("html")).toHaveAttribute("data-design", id);
      await expect(page.locator("html")).not.toHaveAttribute("data-theme-switching", "");
      await expect(card).toBeFocused();
      await expect(card).toHaveAttribute("aria-checked", "true");
      // behind the sheet: the same thread open, still where the list was, the draft and its text
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open);
      await expect(selectedRow(page)).toBeInViewport();
      await expect(page.getByTestId("compose-body")).toHaveText("Half a sentence");
      const d = DESIGNS.find((x) => x.id === id)!;
      await expect(rows(page).first()).toHaveCSS("height", `${d.rows.comfortable}px`);
      const after = await anchor();
      expect(after.id, `the same row at the top after ${id}`).toBe(before.id);
      expect(Math.abs(after.into - before.into), `as deep into it after ${id}`).toBeLessThan(0.06);
      // after the switch's own frame, nothing moves again (fonts were ready)
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBeLessThan(0.01);
    }
    // plan 187 (Codex review #2, #3): the preview's lines and the density change the rows' height the same way, and keep
    // the same row at the top at the same depth, the open one on screen (in macOS, where the loop ended)
    const leading = parseFloat(DESIGNS.find((x) => x.id === "macos")!.type.rowSnippet.leading) * 16;
    const choose = async (select: string, option: string) => {
      const before = await anchor();
      await page.getByTestId(select).click();
      await page.getByTestId(option).click();
      return before;
    };
    for (const [option, height] of [["preview-0", 64 - leading + NO_PREVIEW_GAP], ["preview-2", 64 + leading], ["preview-1", 64]] as const) {
      const before = await choose("preview-select", option);
      await expect(rows(page).first()).toHaveCSS("height", `${height}px`);
      const after = await anchor();
      expect(after.id, `the same row at the top after ${option}`).toBe(before.id);
      expect(Math.abs(after.into - before.into), `as deep into it after ${option}`).toBeLessThan(0.06);
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open);
      await expect(selectedRow(page)).toBeInViewport();
    }
    // Compact: the Preview row stays, off, and says why; the top row stays put through density too
    const before = await choose("density-select", "density-compact");
    await expect(rows(page).first()).toHaveCSS("height", "32px");
    expect((await anchor()).id).toBe(before.id);
    await expect(page.getByTestId("preview-select")).toBeDisabled();
    await expect(page.getByTestId("preview-row")).toContainText(en["settings.appearance.preview.compactHint"]);
    await choose("density-select", "density-comfortable");
    await expect(rows(page).first()).toHaveCSS("height", "64px");
    await expect(page.getByTestId("compose-body")).toHaveText("Half a sentence");
  });

  test("the faces, and the design a load paints", async ({ app: page, server }) => {
    await scenario("every face the app declares is a file of its own build: none from a font service", async () => {
      const faces = await page.evaluate(() =>
        [...document.styleSheets]
          .flatMap((s) => [...s.cssRules])
          .filter((r): r is CSSFontFaceRule => r instanceof CSSFontFaceRule)
          .map((r) => ({ family: r.style.getPropertyValue("font-family"), src: r.style.getPropertyValue("src") })),
      );
      for (const family of ["Figtree Variable", "Instrument Sans Variable", "Geist Variable"]) expect(faces.some((f) => f.family.includes(family)), family).toBe(true);
      const origin = new URL(page.url()).origin;
      for (const f of faces) {
        for (const [, url] of f.src.matchAll(/url\("?([^")]+)"?\)/g)) expect(new URL(url!, page.url()).origin, `${f.family}: ${url}`).toBe(origin);
        expect(f.src).not.toMatch(/googleapis|gstatic/);
      }
    });
    await scenario("only the design in use loads its faces; a slow face never holds a switch", async () => {
      // a load that starts in macOS (this window cached it): nothing of Lumen's or Atelier's
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const loaded = (family: string) => page.evaluate((f) => [...document.fonts].filter((x) => x.family.replace(/"/g, "") === f).some((x) => x.status === "loaded"), family);
      expect(await loaded("Figtree Variable")).toBe(false);
      expect(await loaded("Instrument Sans Variable")).toBe(false);
      // the face doesn't come until the switch has happened: a switch that waited for it never would (plan 139: no clock to flake)
      let arrive!: () => void;
      const held = new Promise<void>((r) => (arrive = r));
      await page.route(/instrument-sans.*\.woff2$/, async (route) => {
        await held;
        await route.continue();
      });
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-design-atelier").click();
      await expect(page.locator("html")).toHaveAttribute("data-design", "atelier");
      // text shows in a fallback meanwhile (swap), then the face arrives
      await expect(page.getByTestId("list-title")).toBeVisible();
      expect(await loaded("Instrument Sans Variable")).toBe(false);
      arrive();
      // Atelier is Instrument Sans throughout (649d46cd)
      await expect.poll(() => loaded("Instrument Sans Variable"), { timeout: 8000 }).toBe(true);
      expect(await loaded("Figtree Variable")).toBe(false);
    });
    await scenario("the palette switches design too", async () => {
      await server.backend.server.invoke("settings.update", { design: "macos" }, ctx);
      await reload(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("palette-design-atelier").click();
      await expect(page.locator("html")).toHaveAttribute("data-design", "atelier");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "atelier-light");
    });
    await scenario("after a reload the design is painted before React mounts", async () => {
      await server.backend.server.invoke("settings.update", { design: "atelier" }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      // the next load: what theme.js sets, before any script of the app runs
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => ((window as unknown as { __early: string | null }).__early = document.documentElement.getAttribute("data-design")), { once: true });
      });
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      expect(await page.evaluate(() => (window as unknown as { __early: string | null }).__early)).toBe("atelier");
    });
  });

});

test.describe("Lumen: search behind a button", () => {
  test.use({ design: "lumen" });
  test("/ opens it focused; it stays open while focus steps away; Esc in an empty field closes it, back on the button", async ({ app: page }) => {
    await expect(page.getByTestId("search-input")).toHaveCount(0);
    await focusList(page);
    await page.keyboard.press("/");
    const input = page.getByTestId("search-input");
    await expect(input).toBeFocused();
    await expect(page.getByTestId("search-button")).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId("nav-inbox").focus();
    await expect(input).toBeVisible();
    await input.focus();
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    // the keys are the rows' again, and the button isn't left lit by focus (plan 158)
    await expect(page.locator("[data-testid=thread-list] [data-keep-scroll=list]")).toBeFocused();
    // a query keeps it open, whatever happens to focus
    await page.getByTestId("search-button").click();
    await page.keyboard.type("factura");
    await expect(page.getByTestId("search-stats")).toBeVisible();
    await focusList(page);
    await expect(input).toHaveValue("factura");
    // the button closes it again, and the query goes with it
    await expect(page.getByTestId("search-button")).toHaveAccessibleName("Close search");
    await page.getByTestId("search-button").click();
    await expect(input).toHaveCount(0);
    await expect(page.getByTestId("search-button")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("search-stats")).toHaveCount(0);
    await page.getByTestId("search-button").click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    await page.getByTestId("search-button").click();
    await expect(input).toHaveCount(0);
  });
});

test.describe("a new install", () => {
  test.use({ design: null });
  test("a new install, and an install from before designs", async ({ app: page, server }) => {
    await scenario("opens in Lumen, in the GitHub palettes (plan 98)", async () => {
      await expect(page.locator("html")).toHaveAttribute("data-design", "lumen");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
      await expect(page.getByTestId("quick-filters")).toBeVisible();
    });
    await scenario("Lumen in GitHub goes to Graphite in its own colors, and every style comes back as it was left, in both modes and after a reload", async () => {
      await server.backend.server.invoke("settings.update", { theme: "light", design: "lumen", lightTheme: "github-light", darkTheme: "github-dark" }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      const html = page.locator("html");
      const card = (id: string) => page.getByTestId(`theme-card-${id}`);
      const chooseStyle = async (id: string) => {
        await page.getByTestId(`design-card-${id}`).click();
        await expect(html).toHaveAttribute("data-design", id);
      };
      const chooseMode = async (mode: "light" | "dark") => {
        await page.getByTestId(`mode-${mode}`).click();
        await expect(html).toHaveClass(mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      };
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      await expect(html).toHaveAttribute("data-theme", "github-light");

      // the request's example: Graphite, never used, has its own colors in both modes
      await chooseStyle("graphite");
      await expect(html).toHaveAttribute("data-theme", "graphite-light");
      await expect(card("design-light")).toHaveAttribute("aria-checked", "true");
      await expect(card("design-dark")).toHaveAttribute("aria-checked", "true");

      // what's picked in Graphite stays Graphite's
      await card("solarized-light").click();
      await expect(html).toHaveAttribute("data-theme", "solarized-light");
      await card("dracula").click();

      // Lumen is back as it was left, in both modes
      await chooseStyle("lumen");
      await expect(html).toHaveAttribute("data-theme", "github-light");
      await expect(card("github-light")).toHaveAttribute("aria-checked", "true");
      await expect(card("github-dark")).toHaveAttribute("aria-checked", "true");
      await chooseMode("dark");
      await expect(html).toHaveAttribute("data-theme", "github-dark");

      // another style is independent of both
      await chooseStyle("luma");
      await expect(html).toHaveAttribute("data-theme", "luma-dark");

      await chooseStyle("graphite");
      await expect(html).toHaveAttribute("data-theme", "dracula");
      await expect(card("solarized-light")).toHaveAttribute("aria-checked", "true");

      // all of it survives a reload
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(html).toHaveAttribute("data-design", "graphite");
      await expect(html).toHaveAttribute("data-theme", "dracula");
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      await chooseStyle("lumen");
      await expect(html).toHaveAttribute("data-theme", "github-dark");
    });
    await scenario("moves to Lumen; the theme it had is first under Colors, one click away, not applied", async () => {
      sqlDb(server.backend.store).run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ theme: "light", lightTheme: "github-light", darkTheme: "dracula" }));
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-design", "lumen");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "lumen-light");
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      await expect(page.getByTestId("theme-card-design-light")).toHaveAttribute("aria-checked", "true");
      const previous = page.getByTestId("theme-card-previous-light");
      await expect(previous).toContainText("GitHub Light");
      await expect(previous).toContainText("Your previous theme");
      await expect(page.getByTestId("theme-card-previous-dark")).toContainText("Dracula");
      await previous.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
      await expect(page.locator("html")).toHaveAttribute("data-design", "lumen");
    });
  });
});

