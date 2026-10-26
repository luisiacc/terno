import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { MAX_MIME_BYTES } from "@terno/core";
import { gmailSendBody } from "./outgoing-wire";
import { createGmailApiProvider } from "./gmail-api";
import type { SendPayload } from "./types";

it("Gmail JSON preserves exact base64url, escaping and optional threadId across chunk and padding boundaries", async () => {
  for (const length of [0, 1, 2, 3, 24575, 24576, 24577, 49153]) {
    const raw = Buffer.alloc(length, 255);
    for (const threadId of [null, "", 'thread"\\\n😀']) {
      const body = await gmailSendBody(raw, threadId);
      expect(typeof body === "string").toBe(length <= 24576);
      const json = JSON.parse(typeof body === "string" ? body : await body.text());
      expect(json).toEqual({ raw: raw.toString("base64url"), ...(threadId === null ? {} : { threadId }) });
    }
  }
  await expect(gmailSendBody(new Uint8Array(MAX_MIME_BYTES + 1), null)).rejects.toMatchObject({ retryable: false });
});

it("Node fetch transmits the reusable Blob body as one JSON POST with exact wire bytes", async () => {
  const raw = Buffer.alloc(2 * 1024 * 1024 + 1, 0xa7);
  const requests: { method?: string; contentType?: string; bytes: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, contentType: req.headers["content-type"], bytes: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" }).end('{"id":"sent"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const threadId = 'thread"\\\n😀';
    const provider = createGmailApiProvider({ account: { id: 1 }, store: {}, fetch } as never, { endpoints: { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => raw });
    await expect(provider.execute({ id: "send", kind: "send", target: {}, payload: { providerThreadId: threadId } as SendPayload })).resolves.toEqual({ providerMsgId: "sent" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", contentType: "application/json" });
    const json = JSON.parse(requests[0]!.bytes.toString());
    expect(json.threadId).toBe(threadId);
    expect(Buffer.from(json.raw, "base64url").equals(raw)).toBe(true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
