/**
 * Plan 66: a hovered row in a sidebar is a step lighter than the selected one, so the open row still reads as
 * open while the pointer rests on another. Checked in every design, in light and dark.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

/** The row's fill composited over its sidebar, as opaque sRGB; a canvas resolves color-mix and oklch for us. */
async function fill(row: Locator, surface: Locator): Promise<[number, number, number]> {
  const under = await surface.evaluate((el) => getComputedStyle(el).backgroundColor);
  return row.evaluate((el, under) => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.fillStyle = under;
    c.fillRect(0, 0, 1, 1);
    c.fillStyle = getComputedStyle(el).backgroundColor;
    c.fillRect(0, 0, 1, 1);
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!] as [number, number, number];
  }, under);
}

const away = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Hover a plain row, then the selected one, and compare both with the bare sidebar. */
async function expectSofterHover(page: Page, surface: Locator, plain: Locator, selected: Locator) {
  const bare = await fill(plain, surface);
  const active = await fill(selected, surface);
  expect(away(active, bare), "the selected row is filled").toBeGreaterThan(4);

  await plain.hover();
  await expect.poll(async () => away(await fill(plain, surface), bare), { message: "a hovered row is filled" }).toBeGreaterThan(2);
  const hovered = await fill(plain, surface);
  expect(away(hovered, bare), "hover is lighter than selected").toBeLessThan(away(active, bare) - 2);

  // hovering the selected row keeps its full fill
  await selected.hover();
  await expect.poll(async () => fill(selected, surface)).toEqual(active);
  await page.mouse.move(0, 0);
}

for (const mode of ["light", "dark"] as const) {
  test(`a hovered sidebar row is lighter than the selected one, ${mode} @design`, async ({ app: page, server }) => {
    await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();

    const sidebar = page.locator("#app-sidebar");
    await expect(page.getByTestId("nav-inbox")).toHaveAttribute("data-active", "true");
    await expectSofterHover(page, sidebar, page.getByTestId("nav-starred"), page.getByTestId("nav-inbox"));

    // dragging is pointer-driven, so the drop target is hovered too: its drop fill must still win
    const starred = page.getByTestId("nav-starred");
    await starred.hover();
    await starred.evaluate((el) => el.setAttribute("data-drop-state", "over"));
    const dropFill = await sidebar.evaluate((el) => {
      const probe = el.appendChild(document.createElement("div"));
      probe.className = "bg-drop-target";
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    });
    await expect.poll(() => starred.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(dropFill);
    await starred.evaluate((el) => el.removeAttribute("data-drop-state"));
    await page.mouse.move(0, 0);

    // Settings has its own sidebar of tabs, and it behaves the same
    await page.getByTestId("open-settings").click();
    await page.getByTestId("tab-appearance").click();
    const nav = page.getByTestId("settings-dialog").locator("nav");
    await expectSofterHover(page, nav, page.getByTestId("tab-general"), page.getByTestId("tab-appearance"));
  });
}
