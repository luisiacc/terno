import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, test } from "@playwright/test";

test("browser complete maximum CID resolution yields through final serialization under 15 ms", async ({ page }) => {
  const bundle = await build({ configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' }, resolve: { alias: [{ find: "~/rpc/connection", replacement: fileURLToPath(new URL("./cid-rpc-fixture.ts", import.meta.url)) }, { find: /^~\//, replacement: fileURLToPath(new URL("../src/", import.meta.url)) }] }, build: { write: false, lib: { entry: fileURLToPath(new URL("./cid-render-fixture.ts", import.meta.url)), name: "TernoCid", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0]!.output : "output" in bundle ? bundle.output : [];
  const code = output.find((chunk) => chunk.type === "chunk")!;
  if (code.type !== "chunk") throw new Error("Missing browser fixture");
  const server = createServer((req, res) => {
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><meta charset="utf-8"><script src="/fixture.js"></script>');
    if (req.url === "/fixture.js") return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(code.code);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.context().route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    expect(await page.evaluate(() => document.characterSet)).toBe("UTF-8");
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { TernoCid: typeof import("./cid-render-fixture") }).TernoCid.unicodeSentinel)).toBe("caf\u00e9 \u65e5\u672c\u8a9e \u0300\u036f");
    for (const fixture of [
      { mime: "image/png", sizes: [4 * 1024 * 1024] },
      { mime: "image/png", sizes: [4 * 1024 * 1024, 4 * 1024 * 1024] },
      { mime: "image/png", sizes: [4 * 1024 * 1024, 2 * 1024 * 1024 - 64] },
      { mime: "image/jpeg", sizes: [4 * 1024 * 1024] },
    ]) {
      const prepared = fixture.sizes.map((size, i) => {
        const ref = { id: i + 1, assetId: `asset-${i}`, filename: "photo", mime: fixture.mime, size, contentId: `photo-${i}` };
        const bytes = Buffer.alloc(size, 0xa7);
        if (fixture.mime === "image/jpeg") {
          bytes.set([255,216]);
          for (let offset = 2; offset < bytes.length - 10; offset += 4) bytes.set([255,224,0,2], offset);
          bytes.set([255,192,0,8,8,0,1,0,1,0], bytes.length - 10);
        } else { bytes.set([137,80,78,71,13,10,26,10]); bytes.writeUInt32BE(1024, 16); bytes.writeUInt32BE(1024, 20); }
        const chunks = Array.from({ length: Math.ceil(size / (48 * 1024)) }, (_, j) => bytes.subarray(j * 48 * 1024, (j + 1) * 48 * 1024).toString("base64"));
        return { ref, chunks };
      });
      // The transport supplies stored strings; generating millions of fixture strings on the page taints its GC.
      await page.evaluate((parts) => {
        const { resources, reads } = (window as unknown as { TernoCid: typeof import("./cid-render-fixture") }).TernoCid;
        resources.clear(); reads.length = 0;
        for (const part of parts) resources.set(part.ref.assetId, part);
      }, prepared);
      const result = await page.evaluate(async ({ mime, sizes }) => {
        const { resources, reads, resolveCidHtml } = (window as unknown as { TernoCid: typeof import("./cid-render-fixture") }).TernoCid;
        const refs = [...resources.values()].map((r) => r.ref);
        const html = refs.map((r) => `<img src="cid:${r.contentId}" alt="${r.contentId}">`).join("");
        let turns = 0; let maxGap = 0; let gapReadCount = 0; let previous = performance.now();
        const record = () => { const now = performance.now(); if (now - previous > maxGap) { maxGap = now - previous; gapReadCount = reads.length; } previous = now; };
        const heartbeat = setInterval(() => { record(); turns++; }, 0);
        let resolved: string;
        try { resolved = await resolveCidHtml(html, 7, refs, () => true); record(); }
        finally { clearInterval(heartbeat); }
        const dom = document.createElement("template"); dom.innerHTML = resolved;
        const exact = [...dom.content.querySelectorAll("img")].every((img, i) => {
          const src = img.getAttribute("src");
          return src === null || src === `data:${mime};base64,${resources.get(refs[i]!.assetId)!.chunks.join("")}`;
        });
        return { turns, maxGap, gapReadCount, exact, outputLength: resolved.length, reads: reads.length, expectedReads: sizes.reduce((n, size) => n + Math.ceil(size / (48 * 1024)), 0), limit: 8 * 1024 * 1024 + html.length };
      }, fixture);
      console.log(`complete browser CID ${fixture.mime} ${fixture.sizes.join("+")}: ${JSON.stringify(result)}`);
      expect(result.exact).toBe(true);
      expect(result.reads).toBe(result.expectedReads);
      expect(result.outputLength).toBeGreaterThan(4 * 1024 * 1024);
      expect(result.outputLength).toBeLessThanOrEqual(result.limit);
      expect(result.turns).toBeGreaterThan(100);
      expect(result.maxGap).toBeLessThanOrEqual(15);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
