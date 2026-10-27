import type { Page } from "@playwright/test";
import { expect, openRow, test } from "./fixtures";

// plan 54: a ring only while the user moves with Tab; never after a click, a shortcut or a focus Terno moves itself
const ringed = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const probe = document.body.appendChild(document.createElement("span"));
  probe.style.color = "var(--ring)";
  const ring = getComputedStyle(probe).color;
  probe.remove();
  const s = getComputedStyle(el);
  return { dbg: `${s.outlineStyle} ${s.outlineColor} | ${s.boxShadow} | flag=${document.documentElement.hasAttribute("data-focus-ring")}`, ring: s.outlineStyle !== "none" || s.boxShadow.includes(ring), focusVisible: el.matches(":focus-visible"), tag: `${el.tagName} ${el.dataset.testid ?? ""}` };
});

test.describe("focus rings @design", () => {
  test("r then Esc leaves focus on the reply bar without a ring", async ({ app: page }) => {
    await openRow(page, 0);
    await page.keyboard.press("r");
    await expect(page.getByTestId("compose-body")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("compose-body")).toHaveCount(0);
    const now = (await ringed(page))!;
    expect(now, `${now.tag} ${now.dbg}`).toMatchObject({ ring: false, focusVisible: true });
    // the same control under Tab navigation does show one: the ring is gated, not gone
    await page.evaluate(() => document.documentElement.toggleAttribute("data-focus-ring", true));
    expect((await ringed(page))!.ring).toBe(true);
  });

  test("Tab brings the ring; a shortcut or a click puts it away", async ({ app: page }) => {
    await openRow(page, 0);
    await page.getByTestId("action-archive").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("html")).toHaveAttribute("data-focus-ring", "");
    expect((await ringed(page))!.ring).toBe(true);
    await page.keyboard.press("s"); // star: a shortcut, focus stays where it is
    await expect(page.locator("html")).not.toHaveAttribute("data-focus-ring");
    expect((await ringed(page))!.ring).toBe(false);
    await page.keyboard.press("Shift+Tab");
    expect((await ringed(page))!.ring).toBe(true);
    await page.getByTestId("action-star").click();
    expect((await ringed(page))!.ring).toBe(false);
  });

  test("a text field keeps its ring when clicked", async ({ app: page }) => {
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.dataset.testid = "probe-field";
      input.style.cssText = "position:fixed;top:4px;left:4px;width:120px;height:24px;z-index:9999";
      document.body.append(input);
    });
    await page.getByTestId("probe-field").click();
    await expect(page.locator("html")).not.toHaveAttribute("data-focus-ring");
    expect((await ringed(page))!.ring).toBe(true);
  });

  test("a control revealed by keyboard focus stays visible when a key clears the ring", async ({ app: page }) => {
    const add = page.getByTestId("new-category");
    await page.mouse.move(1200, 600); // not over the sidebar: hover doesn't reveal it
    await page.getByTestId("nav-inbox").focus();
    for (let step = 0; step < 40 && !(await add.evaluate((el) => el === document.activeElement)); step++) await page.keyboard.press("Tab");
    await expect(add).toBeFocused();
    await expect(add).toHaveCSS("opacity", "1");
    await page.keyboard.press("F8"); // not navigating: the ring goes away
    await expect(page.locator("html")).not.toHaveAttribute("data-focus-ring");
    await expect(add).toBeFocused();
    await expect(add).toHaveCSS("opacity", "1");
  });

  test("F6 to the snackbar's Undo shows where focus went", async ({ app: page }) => {
    await page.mouse.move(1300, 100);
    await openRow(page, 1);
    await page.keyboard.press("e"); // archive: a shortcut, no ring
    await expect(page.getByTestId("snack-action")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-focus-ring");
    await page.keyboard.press("F6");
    await expect(page.getByTestId("snack-action")).toBeFocused();
    expect((await ringed(page))!.ring).toBe(true);
  });
});
