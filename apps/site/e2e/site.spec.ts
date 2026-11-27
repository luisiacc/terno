/** Plan 97: terno.app as deployed (the built pages behind the Worker). */
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
        // both downloads are a Tab away from the top, Mac first (plan 254)
        const reached: string[] = [];
        for (let i = 0; i < 25 && !reached.includes("/download/linux/"); i++) {
          await page.keyboard.press("Tab");
          reached.push((await page.locator(":focus").getAttribute("href")) ?? "");
        }
        expect(reached).toContain("/download/mac");
        expect(reached.indexOf("/download/mac")).toBeLessThan(reached.indexOf("/download/linux/"));
        // the CSP refuses nothing the page uses
        expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
      });

test("the waitlist joins in place with JS", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("#waitlist form");
  await form.getByLabel("Email").fill("js@example.com");
  // Windows only (plan 254): no platform to choose
  await expect(form.locator("select")).toHaveCount(0);
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
  // plan 254: the Linux page is a page in each language, each package a redirect to its file (or back to the page),
  // and only the Worker's own package paths exist
  for (const path of ["/download/linux/", "/es/download/linux/"]) expect((await request.get(path)).status(), path).toBe(200);
  const bare = await request.get("/download/linux", { maxRedirects: 0 });
  expect(bare.headers().location).toBe("/download/linux/");
  for (const [path, file] of [["/download/linux/deb", "linux-amd64.deb"], ["/download/linux/deb-arm64", "linux-arm64.deb"], ["/download/linux/rpm", "linux-x86_64.rpm"], ["/download/linux/rpm-arm64", "linux-aarch64.rpm"]] as const) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(302);
    expect(res.headers()["cache-control"], path).toBe("no-store");
    expect(res.headers().location, path).toMatch(new RegExp(`/download/linux/#unavailable$|Terno-[\\d.]+-${file.replace(".", "\\.")}$`));
  }
  expect((await request.get("/es/download/linux/no-such-package", { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get("/download/linux/snap", { maxRedirects: 0 })).status()).toBe(404);
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
  expect(sitemap).toContain("<loc>https://terno.app/download/linux/</loc>");
  expect(sitemap).toContain("<loc>https://terno.app/es/download/linux/</loc>");
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

test("every page of the site is dark even when the system is light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  for (const path of ["/", "/es/", "/privacy/", "/es/privacy/", "/terms/", "/download/", "/waitlist/", "/no-such-page/"]) {
    await page.goto(path);
    const [html, text, scheme] = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      return [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(main).color, document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")];
    });
    const sum = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
    expect(sum(html), `${path} background ${html}`).toBeLessThan(100);
    expect(sum(text), `${path} text ${text}`).toBeGreaterThan(500);
    expect(scheme, path).toBe("dark");
  }
});

for (const [path, anchor] of [["/privacy/", "google"], ["/es/privacy/", "google"], ["/terms/", "acceptable-use"], ["/es/terms/", "acceptable-use"]] as const)
  for (const width of [1440, 390])
    test(`the legal page ${path} (${width}px) is axe-clean, fits the screen and its contents scroll to each section`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.locator(`nav a[href="#${anchor}"]`).click();
      await expect(page.locator(`section#${anchor} h2`)).toBeInViewport();
    });

test("the Pro link lands on Terno Pro in every design, clear of a sticky header (plan 97)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const design of DESIGNS)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/designs/${design}/`);
      const link = page.locator('header a[href="#pro"]');
      // Lumen and Midnight keep the phone's bar to Download and the language
      if (!(await link.isVisible())) continue;
      await link.click();
      await expect(page).toHaveURL(/#pro$/);
      const title = page.locator("#pro h2");
      await expect(title).toBeInViewport();
      const [chip, bar] = await page.evaluate(() => [
        document.querySelector("#pro p")!.getBoundingClientRect().top,
        getComputedStyle(document.querySelector("header")!).position === "sticky" ? document.querySelector("header")!.getBoundingClientRect().bottom : 0,
      ]);
      expect(chip, `${design} ${width}`).toBeGreaterThanOrEqual(bar);
    }
});

test("the hero's “What matters” link lands on its section in Pro, in every design, clear of a sticky header", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const design of DESIGNS)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/designs/${design}/`);
      await page.getByRole("link", { name: "New “What matters”: only the email that needs you" }).click();
      await expect(page).toHaveURL(/#what-matters$/);
      const title = page.locator("#what-matters h3").first();
      await expect(title).toBeInViewport();
      const [top, bar] = await page.evaluate(() => [
        document.querySelector("#what-matters")!.getBoundingClientRect().top,
        getComputedStyle(document.querySelector("header")!).position === "sticky" ? document.querySelector("header")!.getBoundingClientRect().bottom : 0,
      ]);
      expect(top, `${design} ${width}`).toBeGreaterThanOrEqual(bar);
    }
});

test("Midnight's header: GitHub and the language menu are named icons; the menu closes on Esc and a click outside, and switches language", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Source code on GitHub" })).toHaveAttribute("href", /github\.com/);
  const menu = page.locator("header details[data-menu]");
  const button = menu.locator("summary");
  await expect(button).toHaveAccessibleName("Language");
  await button.click();
  await expect(menu.locator('a[aria-current="page"]')).toHaveText("English");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open");
  await expect(button).toBeFocused();
  await button.click();
  await page.locator("h1").click();
  await expect(menu).not.toHaveAttribute("open");
  await button.click();
  await menu.getByRole("link", { name: "Español" }).click();
  await expect(page).toHaveURL(/\/es\/$/);
  await page.locator("header summary").click();
  await expect(page.locator('header a[aria-current="page"]')).toHaveText("Español");
  await expect(page.getByRole("link", { name: "Código fuente en GitHub" })).toBeVisible();
});

test("a picture's tools stay out of its way until it's pointed at or tabbed into (plan 194)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const shot = page.locator("[data-shot]").first();
  const tools = shot.locator(".site-shot-tools");
  const opacity = () => tools.evaluate((t) => getComputedStyle(t).opacity);
  await page.mouse.move(0, 0);
  await expect.poll(opacity).toBe("0");
  await shot.locator("img").filter({ visible: true }).first().hover();
  await expect.poll(opacity).toBe("1");
  await page.mouse.move(0, 0);
  await expect.poll(opacity).toBe("0");
  // the keyboard reaches them, and they show while it's there
  await tools.getByRole("button").first().focus();
  await expect.poll(opacity).toBe("1");
});

test("“What matters”, Follow-ups and People have a real light and dark picture, and the switch shows each (plans 224, 288)", async ({ page }) => {
  for (const [path, scheme] of [["/designs/lumen/", "light"], ["/designs/midnight/", "dark"]] as const) {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(path);
    for (const shot of [page.locator("#what-matters [data-shot]"), ...["ai-followups", "ai-people"].map((name) => page.locator(`#pro [data-shot]:has(img[src^='/shots/${name}-'])`))]) {
      const other = scheme === "light" ? "dark" : "light";
      await shot.locator(`img[data-mode=${scheme}]`).scrollIntoViewIfNeeded();
      await expect(shot.locator(`img[data-mode=${scheme}]`), path).toBeVisible();
      await expect(shot.locator(`img[data-mode=${other}]`), path).toBeHidden();
      await shot.getByRole("button", { name: other === "light" ? "Light" : "Dark" }).click();
      await expect(shot.locator(`img[data-mode=${other}]`), path).toBeVisible();
      await expect(shot.locator(`img[data-mode=${scheme}]`), path).toBeHidden();
      // two different captures, not one picture under two names, each served at 1× and 2× (the 2× is what Enlarge opens)
      const files = await Promise.all(
        ["light", "dark"].map(async (m) => {
          const img = shot.locator(`img[data-mode=${m}]`);
          const urls = await Promise.all([img.getAttribute("src"), img.getAttribute("data-full")]);
          const [one, two] = await Promise.all(urls.map((url) => page.request.get(url!)));
          for (const r of [one!, two!]) {
            expect(r.ok(), `${path} ${r.url()}`).toBe(true);
            expect(r.headers()["content-type"], `${path} ${r.url()}`).toBe("image/webp");
          }
          return one!.body();
        }),
      );
      expect(files[0]!.equals(files[1]!), path).toBe(false);
    }
  }
});

test("People's picture is as wide as the drafted reply's in every design (plan 288)", async ({ page }) => {
  for (const design of DESIGNS) {
    await page.goto(`/designs/${design}/`);
    const [reply, people] = await Promise.all(["ai-reply", "ai-people"].map((name) => page.locator(`.site-pro-${name}`).evaluate((b) => b.getBoundingClientRect().width)));
    expect(people, design).toBeGreaterThan(900);
    expect(people, design).toBeCloseTo(reply!, 0);
  }
});

for (const design of DESIGNS)
  test(`${design}: on a phone, People's picture is the person's page, as large as the drafted reply's (plan 288)`, async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/designs/${design}/`);
      for (const name of ["ai-reply", "ai-people"]) {
        const box = page.locator(`.site-pro-${name}`);
        await box.scrollIntoViewIfNeeded();
        const fit = await box.evaluate((b) => {
          const outer = b.getBoundingClientRect();
          const img = [...b.querySelectorAll("img")].find((i) => i.checkVisibility())!.getBoundingClientRect();
          // the 602×750 box at x 658, y 50 of the 1280×800 shot (styles.css)
          return { ratio: outer.width / outer.height, scale: img.width / outer.width, x: (outer.left - img.left) / outer.width, y: (outer.top - img.top) / outer.height };
        });
        expect(fit.ratio, `${name} ${width}`).toBeCloseTo(602 / 750, 2);
        expect(fit.scale, `${name} ${width}`).toBeCloseTo(1280 / 602, 2);
        expect(fit.x, `${name} ${width}`).toBeCloseTo(658 / 602, 2);
        expect(fit.y, `${name} ${width}`).toBeCloseTo(50 / 750, 2);
      }
    }
  });

for (const colorScheme of ["light", "dark"] as const)
  for (const width of [1440, 390, 320])
    test(`/es/ (${colorScheme}, ${width}px) is axe-clean and fits: the longer Spanish copy (plan 224)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/es/");
      await expect(page.locator("#pro #what-matters h3")).toHaveText("Cientos de correos. Solo unos pocos te necesitan.");
      const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });

for (const path of ["/download/linux/", "/es/download/linux/"])
  for (const width of [1440, 390])
    test(`the Linux page ${path} (${width}px) is axe-clean, fits, and links each package with its command (plan 254)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const query = path.startsWith("/es/") ? "?lang=es" : "";
      // each package's button and, beside it in the same item, the command for that very file
      for (const [pkg, command] of [
        ["deb", "sudo apt install ./Terno-*-linux-amd64.deb"],
        ["deb-arm64", "sudo apt install ./Terno-*-linux-arm64.deb"],
        ["rpm", "sudo dnf install ./Terno-*-linux-x86_64.rpm"],
        ["rpm-arm64", "sudo dnf install ./Terno-*-linux-aarch64.rpm"],
      ] as const) {
        const item = page.locator("li").filter({ has: page.locator(`a[href="/download/linux/${pkg}${query}"]`) });
        await expect(item).toHaveCount(1);
        await expect(item.locator("code")).toHaveText(command);
      }
      // a command's copy button puts exactly that command on the clipboard and says so to screen readers (what it
      // writes is recorded: the site's Permissions-Policy blocks clipboard-read, writing is allowed)
      await page.context().grantPermissions(["clipboard-write"]);
      await page.evaluate(() => {
        const write = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = (text) => ((window as { copied?: string }).copied = text, write(text));
      });
      const arm = page.locator("li").filter({ has: page.locator(`a[href="/download/linux/rpm-arm64${query}"]`) });
      await arm.locator("button[data-copy]").click();
      await expect(arm.locator("[data-copy-status]")).toHaveText(path.startsWith("/es/") ? "Copiado" : "Copied");
      expect(await page.evaluate(() => (window as { copied?: string }).copied)).toBe("sudo dnf install ./Terno-*-linux-aarch64.rpm");
      // the notice shows only when a package couldn't be reached (#unavailable), and links to GitHub
      await expect(page.locator("#unavailable")).toBeHidden();
      await page.goto(`${path}#unavailable`);
      await expect(page.locator("#unavailable")).toBeVisible();
      await expect(page.locator('#unavailable a[href="https://github.com/luisiacc/terno/releases"]')).toHaveCount(1);
      const axeNotice = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(axeNotice.violations.map((v) => v.id)).toEqual([]);
    });
