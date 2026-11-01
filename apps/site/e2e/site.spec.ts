/** Plan 96: terno.app as deployed (the built pages behind the Worker). */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { DESIGNS } from "../src/site";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const design of DESIGNS)
  for (const colorScheme of ["light", "dark"] as const)
    for (const width of [1440, 390])
      test(`${design} (${colorScheme}, ${width}px) is axe-clean and reaches the download by keyboard`, async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        await page.goto(`/designs/${design}/`);
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        // nothing wider than the screen
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.keyboard.press("Tab");
        await expect(page.locator(":focus")).toHaveAttribute("href", "#main");
        // the CSP refuses nothing the page uses
        expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
      });

test("the waitlist joins in place with JS", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("#waitlist form");
  await form.getByLabel("Email").fill("js@example.com");
  await form.getByLabel("Platform").selectOption("linux");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByRole("status")).toHaveText("You’re on the list. We’ll write when it’s ready.");
  await expect(page).toHaveURL(/\/$/);
});

test("the waitlist works without JS and says how it went", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/es/");
  const form = page.locator("#waitlist form");
  await form.getByLabel("Correo").fill("nojs@example.com");
  await form.getByRole("button", { name: "Unirme a la lista" }).click();
  await expect(page).toHaveURL(/\/es\/waitlist\/#thanks$/);
  await expect(page.locator("#thanks")).toBeVisible();
  await expect(page.locator("#invalid")).toBeHidden();
  await context.close();
});

test("routing: real 404s, trailing slashes, the download stand-in, robots and sitemap", async ({ request }) => {
  expect((await request.get("/no-such-page/")).status()).toBe(404);
  const privacy = await request.get("/privacy", { maxRedirects: 0 });
  expect(privacy.status()).toBeGreaterThanOrEqual(301);
  expect(privacy.headers().location).toBe("/privacy/");
  expect((await request.get("/download/mac", { maxRedirects: 0 })).headers().location).toMatch(/\/download\/$|Terno-.*-arm64\.dmg$/);
  // previews stay crawlable so search engines can read their noindex (a Disallow would hide it)
  expect(await (await request.get("/robots.txt")).text()).not.toContain("/designs/");
  for (const design of DESIGNS) {
    const preview = await request.get(`/designs/${design}/`);
    expect(preview.status()).toBe(200);
    expect(await preview.text()).toContain('<meta name="robots" content="noindex"/>');
  }
  // the dropped candidates are gone
  for (const gone of ["atelier", "bento"]) expect((await request.get(`/designs/${gone}/`)).status()).toBe(404);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain("<loc>https://terno.app/es/</loc>");
  expect(sitemap).not.toContain("/designs/");
});

test("a picture switches between light and dark and opens full size (click, double-click, Esc)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/designs/lumen/");
  const shot = page.locator("[data-shot]").nth(2);
  // the wrapper has no box (display: contents): scroll its picture
  await shot.locator("img[data-mode=light]").scrollIntoViewIfNeeded();
  await expect(shot.locator("img[data-mode=light]")).toBeVisible();
  await expect(shot.locator("img[data-mode=dark]")).toBeHidden();
  await expect(shot.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  await shot.getByRole("button", { name: "Dark" }).click();
  await expect(shot.locator("img[data-mode=dark]")).toBeVisible();
  await expect(shot.locator("img[data-mode=light]")).toBeHidden();
  await expect(shot.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  const box = page.locator("dialog[data-lightbox]");
  await shot.locator("img[data-mode=dark]").dblclick();
  await expect(box).toBeVisible();
  await expect(box.locator("img")).toHaveAttribute("src", /-dark@2x\.webp$/);
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await shot.getByRole("button", { name: "Enlarge picture" }).click();
  await expect(box).toBeVisible();
  await box.getByRole("button", { name: "Close" }).click();
  await expect(box).toBeHidden();
});

test("Midnight is dark even when the system is light, pictures included", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/designs/midnight/");
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r! + g! + b!).toBeLessThan(60);
  const hero = page.locator("[data-shot]").first();
  await expect(hero.locator("img[data-mode=dark]")).toBeVisible();
  await expect(hero.locator("img[data-mode=light]")).toBeHidden();
});

test("only the shown mode of a picture downloads; the other waits for the switch", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const fetched: string[] = [];
  page.on("request", (r) => r.url().includes("/shots/") && fetched.push(new URL(r.url()).pathname));
  await page.goto("/designs/lumen/");
  await page.waitForLoadState("networkidle");
  expect(fetched.some((f) => f.startsWith("/shots/inbox-light"))).toBe(true);
  expect(fetched.filter((f) => f.includes("-dark"))).toEqual([]);
});

test("on a phone the hero picture's tools stay on screen, and Midnight's stay readable on hover", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const design of DESIGNS) {
    await page.goto(`/designs/${design}/`);
    const box = await page.locator(".site-shot-tools").first().boundingBox();
    expect(box, design).not.toBeNull();
    expect(box!.x, design).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, design).toBeLessThanOrEqual(390);
    // at the bottom right of the picture
    const frame = await page.locator(".site-shot-tools").first().evaluate((t) => (t as HTMLElement).offsetParent!.getBoundingClientRect().bottom);
    expect(frame - (box!.y + box!.height), design).toBeLessThan(40);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/designs/midnight/");
  const inactive = page.locator("[data-shot]").first().getByRole("button", { name: "Light" });
  await inactive.hover();
  // light on the dark toolbar (it was near-black there before), after the 80 ms color transition
  await expect.poll(() => inactive.evaluate((b) => getComputedStyle(b).color)).toBe("rgb(255, 255, 255)");
});
