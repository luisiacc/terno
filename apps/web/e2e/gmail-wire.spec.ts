import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, test } from "@playwright/test";
import { parseRaw } from "@terno/mail";

test("browser fetch sends a large portable Gmail Blob as one exact JSON request", async ({ page }) => {
  const bundle = await build({ configFile: false, logLevel: "error", build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("./gmail-send-fixture.ts", import.meta.url)), name: "TernoSend", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0]!.output : "output" in bundle ? bundle.output : [];
  const code = output.find((chunk) => chunk.type === "chunk")!;
  if (code.type !== "chunk") throw new Error("Missing browser fixture");
  const requests: { method?: string; contentType?: string; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script src="/fixture.js"></script>');
    if (req.url === "/fixture.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(code.code);
    if (req.url !== "/messages/send") return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, contentType: req.headers["content-type"], body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" }).end('{"id":"sent"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.goto(origin);
    const result = await page.evaluate(async (origin) => {
      const { createGmailApiProvider, buildRawPortable } = (window as unknown as { TernoSend: typeof import("./gmail-send-fixture") }).TernoSend;
      const size = 18 * 1024 * 1024;
      const payload = { from: { name: "Sender", email: "from@test.com" }, to: [{ name: "Recipient", email: "to@test.com" }], cc: [], bcc: [{ name: "Hidden", email: "hidden@test.com" }], subject: "Browser bytes", text: "hello", messageId: "browser@test.com", references: [], inReplyTo: null, providerThreadId: 'thread"\\\n😀', attachments: [{ assetId: "synthetic", filename: "binary.bin", mime: "application/octet-stream", size, dataBase64: "p6en".repeat(size / 3) }, { assetId: "empty", filename: "empty", mime: "text/plain", size: 0, dataBase64: "" }] };
      let turns = 0; let maxDispatch = 0;
      const heartbeat = setInterval(() => turns++, 0);
      const provider = createGmailApiProvider({ account: { id: 1 }, store: {}, fetch: (input, init) => {
        const start = performance.now();
        const pending = fetch(input, init);
        maxDispatch = performance.now() - start;
        return pending;
      } } as Parameters<typeof createGmailApiProvider>[0], { endpoints: { api: origin }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: buildRawPortable });
      try { await provider.execute({ id: "send", kind: "send", target: {}, payload }); }
      finally { clearInterval(heartbeat); }
      return { turns, maxDispatch };
    }, origin);
    expect(result.turns).toBeGreaterThan(10);
    expect(result.maxDispatch).toBeLessThanOrEqual(15);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", contentType: "application/json" });
    const json = JSON.parse(requests[0]!.body.toString());
    expect(json.threadId).toBe('thread"\\\n😀');
    const parsed = await parseRaw(Buffer.from(json.raw, "base64url"));
    expect(Buffer.from(parsed.attachments.find((a) => a.size > 0)!.bytes!).equals(Buffer.alloc(18 * 1024 * 1024, 0xa7))).toBe(true);
    expect(parsed.attachments.find((a) => a.size === 0)?.bytes).toEqual(new Uint8Array());
    expect(parsed.bcc.map((a) => a.email)).toEqual(["hidden@test.com"]);
    console.log(`browser wire: ${requests[0]!.body.length} bytes, ${result.turns} event-loop turns, fetch dispatch ${result.maxDispatch.toFixed(2)} ms`);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
