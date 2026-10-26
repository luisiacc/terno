// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK } from "@terno/core";
import { Blob as NodeBlob } from "node:buffer";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("~/rpc/connection", () => ({ client: { call } }));
const { resolveCidHtml } = await import("./cid");
const size = 4 * 1024 * 1024;
const part = { id: 1, assetId: "local-id", filename: "photo.png", mime: "image/png", size, contentId: "photo" };
const html = '<img src="cid:photo">'.repeat(20);
afterEach(() => { vi.unstubAllGlobals(); call.mockReset(); });

function resource(valid: boolean) {
  vi.stubGlobal("Blob", NodeBlob);
  const bytes = Buffer.alloc(size);
  if (valid) { bytes.set([137,80,78,71,13,10,26,10]); bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20); }
  call.mockImplementation(async (method: string, args: { accountId: number; index: number }) => {
    expect(args.accountId).toBe(7);
    if (method === "attachments.info") return part;
    if (method === "attachments.read") return { dataBase64: bytes.subarray(args.index * ATTACHMENT_CHUNK, (args.index + 1) * ATTACHMENT_CHUNK).toString("base64") };
    throw new Error(method);
  });
}

it("repeated invalid CID reads each asset once and reserves bytes before raster validation", async () => {
  resource(false);
  expect(await resolveCidHtml(html, 7, [part], () => true)).not.toContain("data:image");
  expect(call.mock.calls.filter(([m]) => m === "attachments.read")).toHaveLength(Math.ceil(size / ATTACHMENT_CHUNK));
});

it("failed resource lookups are memoized and stale resolution stops further reads", async () => {
  call.mockRejectedValue(new Error("missing"));
  await resolveCidHtml(html, 7, [part], () => true);
  expect(call).toHaveBeenCalledTimes(1);
  call.mockClear();
  let current = true;
  call.mockImplementation(async () => { current = false; throw new Error("aborted"); });
  await resolveCidHtml(html, 7, [part], () => current);
  expect(call).toHaveBeenCalledTimes(1);
});

it("unique invalid assets share the read reservation and successful repetitions share a serialized byte cap", async () => {
  resource(false);
  await resolveCidHtml(Array.from({ length: 20 }, (_, i) => `<img src="cid:p${i}">`).join(""), 7, Array.from({ length: 20 }, (_, i) => ({ ...part, assetId: `asset-${i}`, contentId: `p${i}` })), () => true);
  expect(call.mock.calls.filter(([m]) => m === "attachments.read").length).toBeLessThanOrEqual(2 * Math.ceil(size / ATTACHMENT_CHUNK));
  call.mockClear(); resource(true);
  const result = await resolveCidHtml(html, 7, [part], () => true);
  expect(result).toContain("data:image/png;base64,");
  expect(result.length).toBeLessThanOrEqual(8 * 1024 * 1024 + html.length);
  expect(call.mock.calls.filter(([m]) => m === "attachments.read")).toHaveLength(Math.ceil(size / ATTACHMENT_CHUNK));
});
