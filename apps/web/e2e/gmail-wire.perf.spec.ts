import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { expect, test } from "@playwright/test";
import { parseRaw } from "@terno/mail";

test("browser fetch sends a large portable Gmail Blob as one exact JSON request", async ({ page }) => {
  const requests: { method?: string; contentType?: string; body: Buffer }[] = [];
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
    plugins: [{ name: "gmail-wire-capture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=utf-8>");
        if (req.url !== "/messages/send") return next();
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({ method: req.method, contentType: req.headers["content-type"], body: Buffer.concat(chunks) });
        res.writeHead(200, { "content-type": "application/json" }).end('{"id":"sent"}');
      });
    } }],
  });
  await server.listen();
  await page.route("**/*", (route) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  try {
    const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    await page.goto(origin);
    const result = await page.evaluate(async (origin) => {
      const entry = `${origin}/e2e/gmail-send-fixture.ts`;
      const { createGmailApiProvider, buildRawPortable } = await import(entry) as typeof import("./gmail-send-fixture");
      const size = 18 * 1024 * 1024;
      const payload = { from: { name: "Sender", email: "from@test.com" }, to: [{ name: "Recipient", email: "to@test.com" }], cc: [], bcc: [{ name: "Hidden", email: "hidden@test.com" }], subject: "Browser bytes", text: "hello", messageId: "browser@test.com", references: [], inReplyTo: null, providerThreadId: 'thread"\\\n😀', attachments: [{ assetId: "synthetic", filename: "binary.bin", mime: "application/octet-stream", size, dataBase64: "p6en".repeat(size / 3) }, { assetId: "empty", filename: "empty", mime: "text/plain", size: 0, dataBase64: "" }] };
      let turns = 0; let maxDispatch = 0; let blobBody = false;
      const heartbeat = setInterval(() => turns++, 0);
      const provider = createGmailApiProvider({ account: { id: 1 }, store: {}, fetch: (input, init) => {
        blobBody = init?.body instanceof Blob;
        const start = performance.now();
        const pending = fetch(input, init);
        maxDispatch = performance.now() - start;
        return pending;
      } } as Parameters<typeof createGmailApiProvider>[0], { endpoints: { api: origin }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: buildRawPortable });
      try { await provider.execute({ id: "send", kind: "send", target: {}, payload }); }
      finally { clearInterval(heartbeat); }
      return { turns, maxDispatch, blobBody };
    }, origin);
    expect(result.blobBody).toBe(true);
    expect(result.turns).toBeGreaterThan(10);
    expect(result.maxDispatch).toBeLessThanOrEqual(15);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", contentType: "application/json" });
    const json = JSON.parse(requests[0]!.body.toString());
    expect(Object.keys(json).sort()).toEqual(["raw", "threadId"]);
    expect(json.threadId).toBe('thread"\\\n😀');
    const parsed = await parseRaw(Buffer.from(json.raw, "base64url"));
    expect(Buffer.from(parsed.attachments.find((a) => a.size > 0)!.bytes!).equals(Buffer.alloc(18 * 1024 * 1024, 0xa7))).toBe(true);
    expect(parsed.attachments.find((a) => a.size === 0)?.bytes).toEqual(new Uint8Array());
    expect(parsed.from).toEqual({ name: "Sender", email: "from@test.com" });
    expect(parsed.to).toEqual([{ name: "Recipient", email: "to@test.com" }]);
    expect(parsed.cc).toEqual([]);
    expect(parsed.subject).toBe("Browser bytes");
    expect(parsed.text).toBe("hello");
    expect(parsed.rfcMessageId).toBe("browser@test.com");
    expect(parsed.inReplyTo).toBeNull();
    expect(parsed.references).toEqual([]);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.bcc.map((a) => a.email)).toEqual(["hidden@test.com"]);
    console.log(`browser wire: ${requests[0]!.body.length} bytes, ${result.turns} event-loop turns, fetch dispatch ${result.maxDispatch.toFixed(2)} ms`);
  } finally { await server.close(); }
});
