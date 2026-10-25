/**
 * Plan 15: designs. Tagged @design, the first part runs in every design's
 * project (macOS in `e2e`, then `e2e-lumen` and `e2e-atelier`): layout at
 * the minimum window, row heights, keyboard and scroll, the parts every
 * variant keeps, axe in light and dark, and a baseline of each key screen.
 * The rest (switching live, the default, the move from before designs,
 * fonts) runs once.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { DESIGNS } from "../../../packages/ui/src/designs/index";
import type { DesignDefinition } from "../../../packages/ui/src/designs/types";
import { sqlDb } from "../../backend-dev/src/server";
import { expect, focusList, openRow, rows, selectedRow, stabilize, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const designOf = async (page: Page): Promise<DesignDefinition> => {
  const id = await page.locator("html").getAttribute("data-design");
  return DESIGNS.find((d) => d.id === id)!;
};

test.describe("in every design", { tag: "@design" }, () => {
  test("rows are the design's height in both densities, and j/k keep the open thread in view down the list", async ({ app: page, server }) => {
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

  test("the parts every variant keeps: one compose control, rows as options with their parts, the subject, the chips, the reply controls", async ({ app: page }) => {
    await expect(page.getByTestId("compose-button")).toHaveCount(1);
    await expect(page.getByTestId("compose-button")).toBeVisible();
    const first = rows(page).first();
    await expect(first).toHaveAttribute("role", "option");
    await expect(first.getByTestId("row-from")).toBeVisible();
    await expect(first.getByTestId("row-subject")).toBeVisible();
    await openRow(page, 2);
    await expect(page.getByTestId("reader-subject")).toBeVisible();
    await expect(page.getByTestId("thread-chips")).toBeVisible();
    for (const id of ["action-reply", "action-reply-all", "action-forward", "action-archive", "action-print"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByRole("button", { name: "Reply", exact: true })).toHaveCount(1);
    // c composes from anywhere, whatever the control looks like
    await focusList(page);
    await page.keyboard.press("c");
    await expect(page.getByTestId("compose-title")).toBeVisible();
  });

  test("a category's suggestions are reachable from the sidebar in every design (a sub-row or a badge, the same name)", async ({ app: page, server }) => {
    const db = sqlDb(server.backend.store);
    const facturas = db.get<{ id: number }>("SELECT id FROM categories WHERE name = 'Facturas'")!.id;
    const t = db.get<{ id: number }>("SELECT t.id FROM threads t WHERE t.in_inbox = 1 AND NOT EXISTS (SELECT 1 FROM thread_categories WHERE thread_id = t.id) ORDER BY t.last_date DESC LIMIT 1")!.id;
    db.run("INSERT INTO cls_decisions (thread_id, category_id, kind, p, explain_json, at) VALUES (?, ?, 'suggest', 0.8, '[]', ?)", t, facturas, Date.now());
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const review = page.getByTestId(`nav-review-${facturas}`);
    await expect(review).toBeVisible();
    await review.click();
    await expect(page.getByTestId("list-title")).toContainText("Facturas");
    await expect(review).toHaveAttribute("data-active");
  });

  test("at the minimum window (980×600) nothing overflows: panes, the toolbar, the header, the sidebar", async ({ app: page }) => {
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
    for (const id of ["action-archive", "action-trash", "action-star", "action-reply", "action-reply-all", "action-forward", "action-print"]) {
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
  });

  for (const mode of ["light", "dark"] as const) {
    test(`axe in ${mode}: the main window, the reader, Settings → Appearance and the palette`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.reload();
      await page.locator("[data-ready]").waitFor();
      await openRow(page, 2);
      await expect(page.getByTestId("message").first()).toBeVisible();
      // WCAG A/AA; the list is a listbox driven by the window's keys (j/k, aria-activedescendant), not by Tab, so its scroller isn't a tab stop
      const wcag = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["scrollable-region-focusable"]);
      const main = await wcag().exclude("iframe").analyze();
      expect(main.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 160)).join(", ")}`)).toEqual([]);
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      const settings = await wcag().include("[data-testid=settings-dialog]").analyze();
      expect(settings.violations.map((v) => v.id)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+k");
      const palette = await wcag().include("[role=dialog]").analyze();
      expect(palette.violations.map((v) => v.id)).toEqual([]);
    });
  }

  test.describe("baselines", () => {
    test.use({ deviceScaleFactor: 1 });
    const ready = async (page: Page) => {
      await openRow(page, 2);
      await expect(page.getByTestId("message").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
    };
    for (const mode of ["light", "dark"] as const) {
      test(`inbox with the reader, ${mode}`, async ({ app: page, server }) => {
        await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
        await page.reload();
        await page.locator("[data-ready]").waitFor();
        await ready(page);
        await expect(page).toHaveScreenshot(`design-inbox-${mode}.png`);
      });
    }
    test("inline reply", async ({ app: page }) => {
      await ready(page);
      await page.getByTestId("quick-reply").click();
      await expect(page.getByTestId("compose-body")).toBeFocused();
      await page.keyboard.type("Thanks, I’ll take a look this afternoon.");
      await stabilize(page);
      await expect(page).toHaveScreenshot("design-reply.png");
    });
    test("Settings → Appearance", async ({ app: page }) => {
      await page.getByTestId("open-settings").click();
      await page.getByTestId("tab-appearance").click();
      await page.evaluate(() => document.fonts.ready);
      await stabilize(page);
      await expect(page.getByTestId("settings-dialog")).toHaveScreenshot("design-settings-appearance.png");
    });
    test("the minimum window", async ({ app: page }) => {
      await page.setViewportSize({ width: 980, height: 600 });
      await ready(page);
      await expect(page).toHaveScreenshot("design-980.png");
    });
  });
});

test.describe("switching designs", () => {
  test("live, from Settings: one frame, nothing lost (selection, the list's place, an open message, a draft, the filter), focus stays", async ({ app: page }) => {
    // a place in the list, a thread open, an older message expanded, a draft written, the filter on
    await page.getByRole("listbox").evaluate((el) => el.scrollTo(0, 900));
    const anchorBefore = await page.evaluate(() => {
      const list = document.querySelector("[role=listbox]")!;
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
    await expect(page.getByTestId("compose-body")).toHaveValue("Half a sentence");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();

    for (const id of ["atelier", "lumen", "macos"] as const) {
      const card = page.getByTestId(`design-card-${id}`);
      await card.focus();
      await page.evaluate(() => {
        (window as unknown as { __shifts: number }).__shifts = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) (window as unknown as { __shifts: number }).__shifts += e.value;
        }).observe({ type: "layout-shift" });
      });
      await page.keyboard.press("Enter");
      await expect(page.locator("html")).toHaveAttribute("data-design", id);
      await expect(page.locator("html")).not.toHaveAttribute("data-theme-switching", "");
      await expect(card).toBeFocused();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      // behind the sheet: the same thread open, still where the list was, the draft and its text
      await expect(selectedRow(page)).toHaveAttribute("data-thread-id", open);
      await expect(selectedRow(page)).toBeInViewport();
      await expect(page.getByTestId("compose-body")).toHaveValue("Half a sentence");
      const d = DESIGNS.find((x) => x.id === id)!;
      await expect(rows(page).first()).toHaveCSS("height", `${d.rows.comfortable}px`);
      // after the switch's own frame, nothing moves again (fonts were ready)
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => (window as unknown as { __shifts: number }).__shifts)).toBeLessThan(0.01);
    }
  });

  test("the palette switches design too", async ({ app: page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-design-atelier").click();
    await expect(page.locator("html")).toHaveAttribute("data-design", "atelier");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "atelier-light");
  });

  test("after a reload the design is painted before React mounts", async ({ app: page, server }) => {
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

  test("every face the app declares is a file of its own build: none from a font service", async ({ app: page }) => {
    const faces = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((s) => [...s.cssRules])
        .filter((r): r is CSSFontFaceRule => r instanceof CSSFontFaceRule)
        .map((r) => ({ family: r.style.getPropertyValue("font-family"), src: r.style.getPropertyValue("src") })),
    );
    for (const family of ["Figtree Variable", "Instrument Sans Variable", "Instrument Serif", "Geist Variable"]) expect(faces.some((f) => f.family.includes(family)), family).toBe(true);
    const origin = new URL(page.url()).origin;
    for (const f of faces) {
      for (const [, url] of f.src.matchAll(/url\("?([^")]+)"?\)/g)) expect(new URL(url!, page.url()).origin, `${f.family}: ${url}`).toBe(origin);
      expect(f.src).not.toMatch(/googleapis|gstatic/);
    }
  });

  test("only the design in use loads its faces; a slow face never holds a switch", async ({ app: page }) => {
    // a load that starts in macOS (this window cached it): nothing of Lumen's or Atelier's
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    const loaded = (family: string) => page.evaluate((f) => [...document.fonts].filter((x) => x.family.replace(/"/g, "") === f).some((x) => x.status === "loaded"), family);
    expect(await loaded("Figtree Variable")).toBe(false);
    expect(await loaded("Instrument Serif")).toBe(false);
    await page.route(/instrument-(sans|serif).*\.woff2$/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const t0 = Date.now();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("palette-design-atelier").click();
    await expect(page.locator("html")).toHaveAttribute("data-design", "atelier");
    expect(Date.now() - t0).toBeLessThan(1400);
    // text shows in a fallback meanwhile (swap), then the face arrives
    await expect(page.getByTestId("list-title")).toBeVisible();
    await expect.poll(() => loaded("Instrument Serif"), { timeout: 8000 }).toBe(true);
    expect(await loaded("Figtree Variable")).toBe(false);
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
    await expect(page.getByTestId("search-button")).toBeFocused();
    // a query keeps it open, whatever happens to focus
    await page.getByTestId("search-button").click();
    await page.keyboard.type("factura");
    await expect(page.getByTestId("search-stats")).toBeVisible();
    await focusList(page);
    await expect(input).toHaveValue("factura");
  });
});

test.describe("a new install", () => {
  test.use({ design: null });
  test("opens in Lumen, in its own colors", async ({ app: page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-design", "lumen");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "lumen-light");
    await expect(page.getByTestId("quick-filters")).toBeVisible();
  });
});

test.describe("an install from before designs", () => {
  test.use({ design: null });
  test("moves to Lumen; the theme it had is first under Colors, one click away, not applied", async ({ app: page, server }) => {
    sqlDb(server.backend.store).run("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('app', ?)", JSON.stringify({ theme: "light", lightTheme: "github-light", darkTheme: "dracula" }));
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await expect(page.locator("html")).toHaveAttribute("data-design", "lumen");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "lumen-light");
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();
    await expect(page.getByTestId("theme-card-design-light")).toHaveAttribute("aria-pressed", "true");
    const previous = page.getByTestId("theme-card-previous-light");
    await expect(previous).toContainText("GitHub Light");
    await expect(previous).toContainText("Your previous theme");
    await expect(page.getByTestId("theme-card-previous-dark")).toContainText("Dracula");
    await previous.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
    await expect(page.locator("html")).toHaveAttribute("data-design", "lumen");
  });
});
