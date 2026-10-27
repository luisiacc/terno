import type { Locator, Page } from "@playwright/test";
import { expect, rows, search, test } from "./fixtures";

// plan 52: a list, menu or scrolling pane never paints a focus effect around itself; its highlighted row is the focus
const CONTAINERS = '[role="listbox"], [role="list"], [role="tree"], [role="grid"], [role="treegrid"], [role="menu"], [role="menubar"], [role="tablist"], [role="radiogroup"], [data-slot="scroll-area-viewport"]';

const paint = (el: Locator) => el.evaluate((node) => {
  const s = getComputedStyle(node);
  return { outline: s.outlineStyle, shadow: s.boxShadow, focusVisible: node.matches(":focus-visible") };
});

async function trashed(page: Page) {
  await expect(page.getByText("Moved to Trash").first()).toBeVisible();
}

test.describe("no focus ring around the conversation list @design", () => {
  test("after trashing with the keyboard, the list keeps focus without a ring", async ({ app: page }) => {
    const list = page.getByRole("listbox", { name: "Conversations", exact: true });
    await rows(page).nth(1).click();
    await page.keyboard.press("#");
    await trashed(page);
    await expect(list).toBeFocused();
    expect(await paint(list)).toEqual({ outline: "none", shadow: "none", focusVisible: true });
  });

  test("after trashing from the toolbar, no ring either", async ({ app: page }) => {
    const list = page.getByRole("listbox", { name: "Conversations", exact: true });
    await rows(page).nth(1).click();
    await page.getByTestId("action-trash").click();
    await trashed(page);
    const { outline, shadow } = await paint(list);
    expect([outline, shadow]).toEqual(["none", "none"]);
  });

  test("every list-like container stays unpainted under keyboard focus, menus included", async ({ app: page }) => {
    const sweep = () => page.evaluate((selector) => {
      // a focus effect is an outline or a ring in the theme's ring color (a popover's own drop shadow is not one)
      const probe = document.body.appendChild(document.createElement("span"));
      probe.style.color = "var(--ring)";
      const ring = getComputedStyle(probe).color;
      probe.remove();
      const painted: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (el.tabIndex < -1 || !el.isConnected) continue;
        el.focus({ preventScroll: true });
        if (document.activeElement !== el) continue;
        const s = getComputedStyle(el);
        if (s.outlineStyle !== "none" || s.boxShadow.includes(ring)) painted.push(`${el.getAttribute("role") ?? el.dataset.slot} ${el.getAttribute("aria-label") ?? el.className}`);
      }
      return painted;
    }, CONTAINERS);
    await page.keyboard.press("Shift"); // keyboard modality: programmatic focus now matches :focus-visible
    expect(await sweep()).toEqual([]);
    await rows(page).nth(2).click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Shift");
    expect(await sweep()).toEqual([]);
  });

  test("trashing the last conversation hands keyboard focus to a visible control, not the empty list", async ({ app: page }) => {
    const list = page.getByRole("listbox", { name: "Conversations", exact: true });
    await search(page, "291 gadgets");
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().click();
    await page.keyboard.press("#");
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await expect(list).not.toBeFocused();
    expect(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && el !== document.body && el.checkVisibility() && el.closest("#app-sidebar") !== null;
    })).toBe(true);
    expect(await list.getAttribute("tabindex")).toBe("-1");
  });

  test("Tab skips an empty list", async ({ app: page }) => {
    const list = page.getByRole("listbox", { name: "Conversations", exact: true });
    await search(page, "zzqx-no-such-mail");
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await expect(list).toHaveAttribute("tabindex", "-1");
    await page.getByTestId("nav-inbox").focus();
    for (let step = 0; step < 40; step++) {
      await page.keyboard.press("Tab");
      expect(await list.evaluate((node) => node === document.activeElement)).toBe(false);
    }
    // a programmatic focus (a page closing) is handed on too
    await list.evaluate((node) => node.focus());
    await expect(list).not.toBeFocused();
  });
});
