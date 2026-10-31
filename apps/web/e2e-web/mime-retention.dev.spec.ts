import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("real browser incoming worker transfers exact backing ownership across failures and reuse", async ({ page, context }) => {
  const unexpected: string[] = [];
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) await route.continue();
    else { unexpected.push("Unexpected external route"); await route.abort(); }
  });
  await page.goto("/e2e-web/mime-retention/index.html");
  const result = await page.evaluate(async () => {
    const module = "/src/web/worker/incoming-runtime.ts";
    const { createBrowserIncomingProcessor } = await import(/* @vite-ignore */ module);
    const processor = createBrowserIncomingProcessor();
    const snapshots: unknown[] = [];
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const data = Uint8Array.from({ length: 256 * 1024 + 7 }, (_, offset) => (offset * 31 + Math.floor(offset / 251) + cycle * 47) % 256);
        let binary = "";
        for (const byte of data) binary += String.fromCharCode(byte);
        const mime = `Subject: cycle-${cycle}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="witness.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(binary)}\r\n`;
        const input = { kind: "mime", chunks: [new TextEncoder().encode(mime)] };
        const parsed = await processor.run(input, new AbortController().signal);
        const bytes = parsed.message.attachments[0].bytes;
        snapshots.push({ detached: input.chunks[0].buffer.byteLength, length: bytes.byteLength, backing: bytes.buffer.byteLength, offset: bytes.byteOffset, exact: bytes.every((byte: number, index: number) => byte === data[index]), subject: parsed.message.subject });
        const backing = new Uint8Array(1024 * 1024).fill(231);
        const partial = backing.subarray(501, 504);
        let refused = "";
        try { await processor.run({ kind: "mime", chunks: [partial] }, new AbortController().signal); }
        catch (error) { refused = (error as { code: string }).code; }
        snapshots.push({ refused, retainedBacking: backing.buffer.byteLength });
        const abort = new AbortController();
        const canceled = processor.run({ kind: "mime", chunks: [new TextEncoder().encode(mime)] }, abort.signal).then(() => "unexpected-success", (error: Error) => error.name);
        abort.abort();
        snapshots.push(await canceled);
        await processor.whenIdle();
        let malformed = "";
        try { await processor.run({ kind: "gmail", expectedId: "expected", chunks: [new TextEncoder().encode("{")] }, new AbortController().signal); }
        catch (error) { malformed = (error as { code: string }).code; }
        snapshots.push(malformed);
      }
      await processor.close(); await processor.close();
      return snapshots;
    } finally { await processor.close(); }
  });
  expect(result).toEqual(Array.from({ length: 3 }, (_, cycle) => [
    { detached: 0, length: 256 * 1024 + 7, backing: 256 * 1024 + 7, offset: 0, exact: true, subject: `cycle-${cycle}` },
    { refused: "input-limit", retainedBacking: 1024 * 1024 }, "AbortError", "malformed-json",
  ]).flat());
  expect(unexpected).toEqual([]);
});

test("measures finite real IndexedDB body/index preparation for a captured-text policy decision", async ({ page, context }) => {
  const unexpected: string[] = [];
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await context.route("**/*", async (route) => { if (new URL(route.request().url()).origin === origin) await route.continue(); else { unexpected.push("Unexpected external route"); await route.abort(); } });
  await page.goto("/e2e-web/mime-retention/index.html");
  const records = await page.evaluate(async () => {
    const module = "/e2e-web/mime-retention/policy.ts";
    return (await import(/* @vite-ignore */ module)).measurePolicy();
  });
  writeFileSync("/tmp/terno-w11-s48/browser-policy-samples.json", JSON.stringify(records, null, 2));
  expect(records).toHaveLength(48);
  expect(unexpected).toEqual([]);
  await test.info().attach("finite-policy-samples.json", { body: JSON.stringify(records), contentType: "application/json" });
});


for (const limit of [65536, 131072]) test(`measures the exact proposed ${limit}-unit boundary in real IndexedDB`, async ({ page, context }) => {
  const unexpected: string[] = [];
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await context.route("**/*", async (route) => { if (new URL(route.request().url()).origin === origin) await route.continue(); else { unexpected.push("Unexpected external route"); await route.abort(); } });
  await page.goto("/e2e-web/mime-retention/index.html");
  const records = await page.evaluate(async (limit) => {
    const module = "/e2e-web/mime-retention/policy.ts";
    return (await import(/* @vite-ignore */ module)).measurePolicy(limit === 65536 ? "boundary64" : "boundary");
  }, limit);
  writeFileSync(`/tmp/terno-w11-s48/browser-policy-boundary-${limit}.json`, JSON.stringify(records, null, 2));
  expect(records).toHaveLength(12);
  expect(records.every((row: { combined: number }) => row.combined === limit)).toBe(true);
  expect(unexpected).toEqual([]);
});
