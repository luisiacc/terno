/**
 * Plan 19: Terno's mark where it is shown, in every design (@design), and
 * the page's icons. The mark is decorative next to text that names Terno.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, isolateLocalDiscovery, test } from "./fixtures";

const ctx = { clientId: "setup", origin: "dev" as const };
const wcag = (page: import("@playwright/test").Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

test.describe("the mark @design", () => {
  test.use({ backendOptions: { empty: true, ownerClaims: true } });

  test("first run greets with the mark; the dialog is still named by its title", async ({ app: page, server }) => {
    await isolateLocalDiscovery(server);
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "Welcome to Terno" });
    await expect(dialog).toBeVisible();
    const mark = dialog.getByTestId("first-run-mark");
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("aria-hidden", "true");
    // drawn in the design's text color, not a fixed brand color
    const [fill, color] = await mark.evaluate((el) => [getComputedStyle(el.querySelector("rect:last-of-type")!).fill, getComputedStyle(el).color]);
    expect(fill).toBe(color);
  });

  for (const mode of ["light", "dark"] as const) {
    test(`the empty reader shows the mark above "Terno", ${mode}`, async ({ app: page, server }) => {
      await server.backend.server.invoke("settings.update", { theme: mode }, ctx);
      await page.evaluate(() => localStorage.setItem("terno:first-run", "done"));
      await page.reload();
      const empty = page.getByTestId("reader-empty");
      await expect(empty).toBeVisible();
      const mark = empty.getByTestId("reader-empty-mark");
      await expect(mark).toBeVisible();
      await expect(mark).toHaveAttribute("aria-hidden", "true");
      await expect(mark).not.toHaveAttribute("tabindex");
      await expect(empty.getByText("Terno", { exact: true })).toBeVisible();
      const box = (await mark.boundingBox())!;
      expect(Math.round(box.width)).toBe(40);
      const result = await wcag(page).include("[data-testid=reader-empty]").analyze();
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  }
});

test.describe("page icons", () => {
  test("the favicon, touch icon and theme colors are declared, and each icon loads", async ({ app: page }) => {
    const links = await page.locator("link[rel=icon], link[rel=apple-touch-icon]").evaluateAll((els) => els.map((el) => ({ rel: el.getAttribute("rel"), href: (el as HTMLLinkElement).href, type: el.getAttribute("type") })));
    expect(links.map((l) => l.href.split("/").pop())).toEqual(["favicon-32.png", "favicon.svg", "apple-touch-icon.png"]);
    for (const link of links) {
      const res = await page.request.get(link.href);
      expect(res.status(), link.href).toBe(200);
      expect(res.headers()["content-type"], link.href).toContain(link.href.endsWith(".svg") ? "image/svg+xml" : "image/png");
    }
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
    await expect(page).toHaveTitle("Terno");
  });
});
