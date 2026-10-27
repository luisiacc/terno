// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
const { attachmentBlob } = vi.hoisted(() => ({ attachmentBlob: vi.fn() }));
vi.mock("./attachments", () => ({ attachmentBlob }));
const { inlineRaster, resolveCidHtml } = await import("./cid");

const png = new Uint8Array(24);
png.set([137,80,78,71,13,10,26,10]);
new DataView(png.buffer).setUint32(16, 1); new DataView(png.buffer).setUint32(20, 1);
const part = { id: 1, assetId: "local-id", filename: "photo.png", mime: "image/png", size: 24, contentId: "Photo@Test" };

it("CID resolution normalizes case/percent encoding, uses only message refs and refuses duplicate identities", async () => {
  attachmentBlob.mockResolvedValue({ arrayBuffer: async () => png.buffer });
  const html = '<img src="CID:photo%40test"><img src="https://pixel.invalid/a">';
  expect(await resolveCidHtml(html, 7, [part], () => true)).toContain("data:image/png;base64,");
  expect(attachmentBlob).toHaveBeenCalledWith(7, part);
  attachmentBlob.mockClear();
  expect(await resolveCidHtml(html, 7, [part, { ...part, id: 2, contentId: "photo@test" }], () => true)).not.toContain("data:image");
  expect(attachmentBlob).not.toHaveBeenCalled();
  expect(await resolveCidHtml(html, 7, [], () => true)).not.toContain("data:image");
});

it("inline raster policy refuses SVG, fake signatures, huge dimensions and stale completions", async () => {
  expect(inlineRaster("image/png", png)).toBe(true);
  expect(inlineRaster("image/svg+xml", png)).toBe(false);
  expect(inlineRaster("image/png", new Uint8Array(24))).toBe(false);
  const huge = new Uint8Array(png); new DataView(huge.buffer).setUint32(16, 100_000);
  expect(inlineRaster("image/png", huge)).toBe(false);
  attachmentBlob.mockClear();
  expect(await resolveCidHtml('<img src="cid:photo@test">', 7, [part], () => false)).not.toContain("data:image");
  expect(attachmentBlob).not.toHaveBeenCalled();
});

it("dense JPEG metadata keeps the same raster policy and stops validation when the render is stale", async () => {
  const bytes = new Uint8Array(128 * 1024);
  bytes.set([255,216]);
  for (let offset = 2; offset < bytes.length - 10; offset += 4) bytes.set([255,224,0,2], offset);
  bytes.set([255,192,0,8,8,0,1,0,1,0], bytes.length - 10);
  expect(inlineRaster("image/jpeg", bytes)).toBe(true);
  const ref = { ...part, mime: "image/jpeg", size: bytes.length };
  attachmentBlob.mockResolvedValue({ arrayBuffer: async () => bytes.buffer });
  let active = true;
  const timer = globalThis.setTimeout;
  let yields = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, delay) => timer(() => { yields++; active = false; if (typeof fn === "function") fn(); }, delay));
  const input = '<img src="cid:photo@test">';
  try {
    expect(await resolveCidHtml(input, 7, [ref], () => active)).toBe(input);
    expect(yields).toBe(1);
  } finally { vi.restoreAllMocks(); }
});

it("decodes CID URI references once while preserving literal percent header IDs", async () => {
  attachmentBlob.mockClear();
  attachmentBlob.mockResolvedValue({ arrayBuffer: async () => png.buffer });
  const literal = { ...part, contentId: "part%25@test" };
  expect(await resolveCidHtml('<img src="cid:part%2525%40test">', 7, [literal], () => true)).toContain("data:image/png;base64,");
  expect(attachmentBlob).toHaveBeenCalledTimes(1);
  attachmentBlob.mockClear();
  expect(await resolveCidHtml('<img src="cid:part%25%40test">', 7, [literal], () => true)).not.toContain("data:image");
  expect(await resolveCidHtml('<img src="cid:part%broken">', 7, [literal], () => true)).not.toContain("data:image");
  expect(attachmentBlob).not.toHaveBeenCalled();
  expect(await resolveCidHtml('<img src="CID:part%25%40test">', 7, [{ ...part, contentId: "part%@test" }], () => true)).toContain("data:image/png;base64,");
});
