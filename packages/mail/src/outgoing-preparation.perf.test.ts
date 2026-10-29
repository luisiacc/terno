import { expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_MIME_BYTES } from "@terno/core";
import { buildRaw, checkSmtpWire } from "./compose";
import { buildRawPortable } from "./compose-portable";
import { parseRaw } from "./mime";
import type { SendPayload } from "./types";

const base: SendPayload = { from: { name: "Sender", email: "sender@test.com" }, to: [{ name: "Recipient", email: "to@test.com" }], cc: [], bcc: [{ name: "Hidden", email: "bcc@test.com" }], subject: "Exact bytes", text: "hello", messageId: "prepare@test.com", references: [], inReplyTo: null, providerThreadId: null };

async function measured(work: () => Promise<Uint8Array> | Uint8Array) {
  let previous = process.threadCpuUsage(); let wall = performance.now();
  let maxCpu = 0; let maxWall = 0; let turns = 0; let active = true;
  const record = () => {
    const used = process.threadCpuUsage(previous);
    maxCpu = Math.max(maxCpu, (used.user + used.system) / 1000);
    maxWall = Math.max(maxWall, performance.now() - wall);
    previous = process.threadCpuUsage(); wall = performance.now();
  };
  const heartbeat = () => { record(); turns++; if (active) scheduled = setImmediate(heartbeat); };
  let scheduled = setImmediate(heartbeat);
  try { const raw = await work(); record(); return { raw, maxCpu, maxWall, turns }; }
  finally { active = false; clearImmediate(scheduled); }
}

for (const [name, build] of [["Node SMTP", async (p: SendPayload) => { const raw = await buildRaw(p, { smtp: true }); await checkSmtpWire(raw); return raw; }], ["Node Gmail MIME", (p: SendPayload) => buildRaw(p, { keepBcc: true })], ["portable Gmail MIME", buildRawPortable]] as const) {
  it(`${name}: complete allowed attachment preparation yields, bounds slices and preserves exact bytes`, async () => {
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const payload = { ...base, attachments: [{ assetId: "binary", filename: "résumé.bin", mime: "application/octet-stream", size: bytes.length, dataBase64: bytes.toString("base64") }, { assetId: "empty", filename: "empty", mime: "text/plain", size: 0, dataBase64: "" }] };
    global.gc?.();
    const result = await measured(() => build(payload));
    process.stderr.write(`[${name} complete preparation] ${result.turns} turns; max CPU ${result.maxCpu.toFixed(2)} ms; max wall ${result.maxWall.toFixed(2)} ms; wire ${result.raw.length}\n`);
    expect(result.turns).toBeGreaterThan(100);
    expect(result.maxCpu).toBeLessThanOrEqual(15);
    expect(result.raw.length).toBeLessThanOrEqual(MAX_MIME_BYTES);
    const parsed = await parseRaw(result.raw);
    expect(Buffer.from(parsed.attachments.find((a) => a.size === bytes.length)!.bytes!).equals(bytes)).toBe(true);
    expect(parsed.attachments.find((a) => a.size === 0)?.bytes).toEqual(new Uint8Array());
    expect(parsed.bcc.map((a) => a.email)).toEqual(name === "Node SMTP" ? [] : ["bcc@test.com"]);
    expect(payload.attachments[0]!.dataBase64).toBe(bytes.toString("base64"));
  });
}

for (const [name, build] of [["Node Gmail provider", (p: SendPayload) => buildRaw(p, { keepBcc: true })], ["web Gmail provider", buildRawPortable]] as const) {
  it(`${name}: public send preparation includes the final API wire body`, async () => {
    const { createGmailApiProvider } = await import("./gmail-api");
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0xa7);
    const payload = { ...base, attachments: [{ assetId: "large", filename: "large.bin", mime: "application/octet-stream", size: bytes.length, dataBase64: bytes.toString("base64") }] };
    let body: RequestInit["body"];
    const fetch = (async (_url: unknown, init?: RequestInit) => { body = init?.body; return new Response('{"id":"sent","threadId":"thread"}'); }) as typeof globalThis.fetch;
    const provider = createGmailApiProvider({ account: { id: 1 }, store: {}, fetch } as never, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: build });
    global.gc?.();
    const result = await measured(async () => { await provider.execute({ id: "send", kind: "send", target: {}, payload }); return new Uint8Array(); });
    process.stderr.write(`[${name} public send] ${result.turns} turns; max CPU ${result.maxCpu.toFixed(2)} ms; max wall ${result.maxWall.toFixed(2)} ms\n`);
    expect(result.turns).toBeGreaterThan(100);
    expect(result.maxCpu).toBeLessThanOrEqual(15);
    const wire = typeof body === "string" ? body : await new Response(body).text();
    const sent = JSON.parse(wire) as { raw: string };
    const parsed = await parseRaw(Buffer.from(sent.raw, "base64url"));
    expect(Buffer.from(parsed.attachments[0]!.bytes!).equals(bytes)).toBe(true);
    expect(parsed.bcc.map((a) => a.email)).toEqual(["bcc@test.com"]);
  });
}

it("small portable Gmail sends keep the fast string body and throughput", async () => {
  const { createGmailApiProvider } = await import("./gmail-api");
  let posts = 0;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    expect(typeof init?.body).toBe("string");
    posts++;
    return new Response('{"id":"sent"}');
  }) as typeof globalThis.fetch;
  const provider = createGmailApiProvider({ account: { id: 1 }, store: {}, fetch } as never, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: buildRawPortable });
  const start = performance.now();
  for (let i = 0; i < 100; i++) await provider.execute({ id: `send-${i}`, kind: "send", target: {}, payload: base });
  const elapsed = performance.now() - start;
  process.stderr.write(`[small portable sends] ${posts} sends in ${elapsed.toFixed(2)} ms\n`);
  expect(posts).toBe(100);
  expect(elapsed).toBeLessThanOrEqual(500);
});

it("SMTP validator yields over maximum canonical captured bytes and newline-dense preparation", async () => {
  const raw = Buffer.alloc(MAX_MIME_BYTES, 65);
  for (let i = 998; i + 1 < raw.length; i += 1000) { raw[i] = 13; raw[i + 1] = 10; }
  raw[raw.length - 2] = 13; raw[raw.length - 1] = 10;
  const confirmed = Buffer.from(raw);
  const scan = await measured(async () => { await checkSmtpWire(raw); expect(confirmed.equals(raw)).toBe(true); return raw; });
  expect(scan.turns).toBeGreaterThan(100); expect(scan.maxCpu).toBeLessThanOrEqual(15);
  const dense = await measured(async () => { const wire = await buildRaw({ ...base, text: "x\n".repeat(8000) }, { smtp: true }); await checkSmtpWire(wire); return wire; });
  expect(dense.maxCpu).toBeLessThanOrEqual(15);
  expect(Buffer.from(dense.raw).toString()).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
});
