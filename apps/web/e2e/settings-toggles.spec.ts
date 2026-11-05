/** Settings' segmented controls (plan 120): the chosen option is plain to see in every palette (a raised thumb), and axe-clean. */
import AxeBuilder from "@axe-core/playwright";
import { expect, stabilize, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };

for (const theme of ["light", "dark"] as const) {
  test(`the chosen option stands out (${theme})`, async ({ app: page, server }, testInfo) => {
    await server.backend.server.invoke("settings.update", { theme }, ctx);
    await page.reload();
    await page.locator("[data-ready]").waitFor();
    await page.keyboard.press("Meta+Comma");
    await page.getByTestId("general-tab").waitFor();
    await page.getByTestId("tab-appearance").click();
    const group = page.getByTestId("motion-toggle");
    await group.scrollIntoViewIfNeeded();
    const on = page.getByTestId("motion-75");
    const off = page.getByTestId("motion-50");
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await expect(off).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(0, 0);
    const look = (el: typeof on) => el.evaluate((e) => ({ fill: getComputedStyle(e).backgroundColor, shadow: getComputedStyle(e).boxShadow }));
    const chosen = await look(on);
    const other = await look(off);
    expect(chosen.fill).not.toBe(other.fill);
    expect(chosen.fill).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(chosen.shadow, "raised off the track").not.toBe("none");
    expect(other.shadow).toBe("none");
    await stabilize(page);
    await page.getByTestId("motion-toggle").locator("xpath=ancestor::section[1]").screenshot({ path: testInfo.outputPath(`toggles-${theme}.png`) });
    const r = await new AxeBuilder({ page }).include("[data-testid=motion-toggle]").include("[data-testid=mode-toggle]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
}
