/**
 * `pnpm --filter @terno/site exec tsx scripts/snap.ts <path> <out.png> [--dark] [--width=1440] [--full]`: a
 * picture of a page from the dev server (SITE_DEV_PORT, 5190), to look at while designing.
 */
import { chromium } from "@playwright/test";

const [path = "/", out = "/tmp/site.png"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dark = process.argv.includes("--dark");
const full = process.argv.includes("--full");
const width = Number(process.argv.find((a) => a.startsWith("--width="))?.slice(8) ?? 1440);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: dark ? "dark" : "light" });
await page.goto(`http://127.0.0.1:${process.env.SITE_DEV_PORT ?? 5190}${path}`, { waitUntil: "networkidle" });
// lazy pictures below the fold: load them all before a full-page picture
if (full) {
  await page.evaluate(async () => {
    for (const img of document.images) img.loading = "eager";
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => i.addEventListener("load", r, { once: true })))));
  });
}
await page.screenshot({ path: out, fullPage: full });
await browser.close();
console.log(out);
