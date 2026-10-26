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
