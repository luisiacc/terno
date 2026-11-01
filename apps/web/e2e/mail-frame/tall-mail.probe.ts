/** Manual development probes: two contract REDs remain until the physical-height dependency is designed. */
import { expect, test } from "@playwright/test";

for (const mode of ["light", "dark"] as const) {
  test(`ordinary tall mail uses only the outer reader scroll (${mode})`, async ({ page, browser }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === "http://127.0.0.1:61630" ? route.continue() : route.abort();
    });
    console.log({ browserVersion: browser.version() });
    await page.goto("/e2e/mail-frame/index.html");
    const frame = page.locator("iframe");
    await expect(frame.contentFrame().locator("#last")).toHaveText("Exact final mail text");
    await expect.poll(() => frame.evaluate((f) => f.getBoundingClientRect().height)).toBeGreaterThan(1000);
    const before = await frame.evaluate((f: HTMLIFrameElement) => ({ height: f.getBoundingClientRect().height, content: f.contentDocument!.documentElement.getBoundingClientRect().height, overflow: getComputedStyle(f.contentDocument!.documentElement).overflowY, innerScroll: f.contentWindow!.scrollY }));
    await page.locator("[data-reader-scroller]").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = await frame.contentFrame().locator("#last").boundingBox();
    await page.screenshot({ path: `/tmp/terno-w11-tall-mail-61630/ordinary-${mode}.png` });
    const outer = (await page.locator("[data-reader-scroller]").boundingBox())!;
    const scroll = await page.locator("[data-reader-scroller]").evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }));
    console.log({ before, last, outer, scroll });
    expect(Math.abs(scroll.top + scroll.viewport - scroll.height)).toBeLessThanOrEqual(1);
    // The mail's last line must be visible without scrolling the iframe.
    expect(last!.y).toBeGreaterThanOrEqual(outer.y);
    expect.soft(last!.y + last!.height).toBeLessThanOrEqual(Math.min(800, outer.y + outer.height));
    expect(before.innerScroll).toBe(0);
    expect(before.overflow).toBe("hidden");
  });
}

for (const control of [true, false]) {
  test(`physical height counterfactual (${control ? "below limit control" : "beyond limit dependency"})`, async ({ page, browser }) => {
    await page.route("**/*", (route) => new URL(route.request().url()).origin === "http://127.0.0.1:61630" ? route.continue() : route.abort());
    console.log({ browserVersion: browser.version() });
    await page.goto(`/e2e/mail-frame/index.html?physical${control ? "&control" : ""}`);
    const frame = page.locator("iframe");
    await expect(frame.contentFrame().locator("#last")).toHaveText("Exact final mail text");
    await expect.poll(() => frame.evaluate((f: HTMLIFrameElement) => f.style.height)).toBe("20000px");
    // Browser-only counterfactual: the actual sanitizer/CSP/document remain intact.
    await frame.evaluate((f: HTMLIFrameElement, height) => {
      f.style.height = `${height}px`;
      f.contentDocument!.documentElement.style.overflowY = "hidden";
    }, control ? 2_000_100 : 40_000_100);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.locator("[data-reader-scroller]").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const evidence = await frame.evaluate((f: HTMLIFrameElement) => ({
      requestedHeight: f.style.height,
      physicalHeight: f.getBoundingClientRect().height,
      documentHeight: f.contentDocument!.documentElement.getBoundingClientRect().height,
      lastTop: f.contentDocument!.getElementById("last")!.getBoundingClientRect().top,
      lastBottom: f.contentDocument!.getElementById("last")!.getBoundingClientRect().bottom,
      viewportHeight: f.contentWindow!.innerHeight,
      innerScroll: f.contentWindow!.scrollY,
      overflow: getComputedStyle(f.contentDocument!.documentElement).overflowY,
      sandbox: f.getAttribute("sandbox"),
    }));
    console.log({ control, ...evidence });
    await page.screenshot({ path: `/tmp/terno-w11-tall-mail-61630/physical-${control ? "control" : "limit"}.png` });
    expect(Number.parseFloat(evidence.requestedHeight)).toBe(control ? 2_000_100 : 40_000_100);
    expect(evidence.physicalHeight).toBeGreaterThan(20_000);
    expect(evidence.innerScroll).toBe(0);
    expect(evidence.overflow).toBe("hidden");
    expect(evidence.sandbox).toBe("allow-same-origin allow-popups");
    if (control) {
      expect(evidence.physicalHeight).toBe(2_000_100);
      expect(evidence.lastBottom).toBeLessThan(evidence.viewportHeight);
      const last = await frame.contentFrame().locator("#last").boundingBox();
      const outer = (await page.locator("[data-reader-scroller]").boundingBox())!;
      expect(last!.y).toBeGreaterThanOrEqual(outer.y);
      expect(last!.y + last!.height).toBeLessThan(outer.y + outer.height);
    } else {
      expect(evidence.physicalHeight).toBeLessThan(40_000_000);
      expect(evidence.lastTop).toBeGreaterThanOrEqual(evidence.viewportHeight);
      expect(evidence.lastBottom).toBeGreaterThan(evidence.viewportHeight);
    }
  });
}
