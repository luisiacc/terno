import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, test } from "@playwright/test";

type Dark = typeof import("../src/lib/mail-dark");

/**
 * Plan 295: a designed mail is darkened on the main thread when it opens in a dark theme, before its first frame. In
 * Chromium: an ordinary newsletter costs a few ms, a mail just under the walk's bound stays well inside a slow frame,
 * and one over it bails out without walking.
 */
test("darkening a designed mail: a newsletter ≤ 8 ms, 39,000 elements ≤ 150 ms, over the bound a cheap bail-out (median of 5)", async ({ page }) => {
  const bundle = await build({ configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' }, build: { write: false, lib: { entry: fileURLToPath(new URL("../src/lib/mail-dark.ts", import.meta.url)), name: "TernoDark", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0]!.output : "output" in bundle ? bundle.output : [];
  const code = output.find((chunk) => chunk.type === "chunk")!;
  if (code.type !== "chunk") throw new Error("Missing browser bundle");
  const server = createServer((req, res) => {
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><meta charset="utf-8"><body><script src="/dark.js"></script>');
    if (req.url === "/dark.js") return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(code.code);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const time = (rows: number) =>
      page.evaluate((count) => {
        const { darkenMail } = (window as unknown as { TernoDark: Dark }).TernoDark;
        // a newsletter's shape: a grey page, a white card, rows of cells with their own colors, borders, links and pictures
        const row = (i: number) => `<tr><td style="padding:8px;border-bottom:1px solid #e6e6e6"><table width="100%"><tr><td style="color:#222222;font-size:14px">Item ${i}: a line of the newsletter with <a href="https://x.test/${i}" style="color:#1d5bb0">a link</a> and <b>bold words</b></td><td bgcolor="${i % 7 ? "#ffffff" : "#ec008c"}" style="color:#ffffff;padding:4px">${i % 7 ? "" : "Buy"}</td></tr></table><img width="24" height="24" alt="" src="data:,"></td></tr>`;
        const html = `<table bgcolor="#f2f2f2" width="100%"><tr><td><table style="background-color:#ffffff;width:600px">${Array.from({ length: count }, (_, i) => row(i)).join("")}</table></td></tr></table>`;
        const runs: number[] = [];
        let elements = 0;
        let converted = false;
        for (let k = 0; k < 5; k++) {
          const root = document.createElement("div");
          root.innerHTML = html;
          document.body.replaceChildren(root);
          elements = root.getElementsByTagName("*").length;
          const start = performance.now();
          const result = darkenMail(root, { background: "#282a36", card: "#2f3142", foreground: "#f8f8f2", muted: "#a9bbf2", link: "#bd93f9", border: "#3a3c4e" });
          runs.push(performance.now() - start);
          converted = result.converted;
        }
        runs.sort((a, b) => a - b);
        return { median: runs[2]!, elements, converted };
      }, rows);
    const newsletter = await time(120);
    expect(newsletter.converted).toBe(true);
    expect(newsletter.elements).toBeGreaterThan(1000);
    expect(newsletter.median, `newsletter (${newsletter.elements} elements)`).toBeLessThanOrEqual(8);
    const bound = await time(3500);
    expect(bound.converted).toBe(true);
    expect(bound.elements).toBeLessThan(40_000);
    expect(bound.elements).toBeGreaterThan(35_000);
    expect(bound.median, `near the bound (${bound.elements} elements)`).toBeLessThanOrEqual(150);
    const over = await time(5000);
    expect(over.converted).toBe(false);
    expect(over.median, `over the bound (${over.elements} elements)`).toBeLessThanOrEqual(5);
  } finally {
    server.close();
  }
});
