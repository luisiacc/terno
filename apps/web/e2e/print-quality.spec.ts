/**
 * Print quality (plan 09 §9.11): every print fixture's fitted document, as
 * the sheet would print it, through Chromium's own PDF output (page.pdf, the
 * page geometry and footer the desktop uses) in both modes and both papers.
 * Each PDF is read back (page size, text present and absent, footer, nothing
 * outside the printable box), then rendered by the pinned pdfjs-dist on a
 * canvas inside Chromium and compared with baselines: the first and last
 * page of each, so page breaks show.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Page } from "@playwright/test";
import { PRINT_FIXTURE_KEYS, printFixtures } from "@terno/mock-data";
import { footerTemplate } from "../../desktop/src/print-policy";
import { expect, ingestPrintFixtures, selectThread, test } from "./fixtures";
import { pdfProblems, QUERY, readPdf } from "./print-pdf";

const PDFJS = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const fixtures = new Map(printFixtures({ name: "Luis Cordero", email: "" }).map((f) => [f.key, f]));
const VIEWER = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#8e8e93}canvas{display:block;margin:0 0 8px}</style>
<script type="module">
import * as pdfjs from "/build/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/build/pdf.worker.mjs";
window.renderPdf = async (b64) => {
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const doc = await pdfjs.getDocument({ data, cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
  document.body.replaceChildren();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.dataset.page = String(n);
    document.body.append(canvas);
    await page.render({ canvas, viewport }).promise;
  }
  return doc.numPages;
};
window.viewerReady = true;
</script>`;
const TYPES: Record<string, string> = { ".mjs": "text/javascript", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf" };

/** A page that renders PDFs with the pinned pdfjs-dist, served from node_modules (no network). */
async function viewer(page: Page) {
  await page.route("http://pdfjs.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: VIEWER });
    return route.fulfill({ contentType: TYPES[extname(path)] ?? "application/octet-stream", body: readFileSync(join(PDFJS, path)) });
  });
  await page.goto("http://pdfjs.test/");
  await page.waitForFunction(() => (window as unknown as { viewerReady?: boolean }).viewerReady);
}

test.use({ deviceScaleFactor: 1 });

for (const key of PRINT_FIXTURE_KEYS) {
  test(`${key}: real PDFs read back and rendered, with headers and content only, on Letter and A4`, async ({ app: page, server, context }) => {
    test.setTimeout(90_000);
    const f = fixtures.get(key)!;
    const ids = await ingestPrintFixtures(server);
    await selectThread(page, ids[key], QUERY[key]);
    await page.keyboard.press("ControlOrMeta+p");
    const pdfPage = await context.newPage();
    const render = await context.newPage();
    await viewer(render);
    for (const content of ["headers", "body"] as const) {
      for (const paper of ["letter", "a4"] as const) {
        await page.getByTestId(`print-content-${content}`).click();
        await page.getByTestId(`print-paper-${paper}`).click();
        await expect(page.getByTestId("print-preview")).toHaveAttribute("data-ready", "true");
        // what the sheet would print: the fitted preview, serialized
        const html = await page.getByTestId("print-preview").evaluate((frame: HTMLIFrameElement) => `<!doctype html>${frame.contentDocument!.documentElement.outerHTML}`);
        await pdfPage.setContent(html, { waitUntil: "load" });
        const headers = content === "headers";
        const pdf = await pdfPage.pdf({
          preferCSSPageSize: true,
          printBackground: true,
          margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
          displayHeaderFooter: headers,
          headerTemplate: "<span></span>",
          footerTemplate: headers ? footerTemplate(f.subject) : "<span></span>",
        });
        const pages = await readPdf(pdf);
        expect(pdfProblems(pages, { key, headers, paper, subject: f.subject, sender: f.messages[0]!.from.email }), `${key} ${content} ${paper}`).toEqual([]);

        const count = await render.evaluate((b64) => (window as unknown as { renderPdf(b: string): Promise<number> }).renderPdf(b64), Buffer.from(pdf).toString("base64"));
        expect(count).toBe(pages.length);
        for (const n of new Set([1, count])) {
          await expect(render.locator(`canvas[data-page="${n}"]`)).toHaveScreenshot(`${key}-${content}-${paper}-p${n}.png`, { maxDiffPixelRatio: 0.01 });
        }
      }
    }
  });
}
