import { describe, expect, it } from "vitest";
import { chipRefs, isInlineImage, isOwnImage, newImageCid, sentRefs } from "./inline-images";

const ref = (assetId: string, contentId: string | null = null) => ({ assetId, filename: `${assetId}.png`, mime: "image/png", size: 1, contentId });

describe("inline images (plan 76)", () => {
  it("only types the reader shows inline go in the text", () => {
    for (const type of ["image/png", "image/jpeg", "IMAGE/GIF"]) expect(isInlineImage({ type })).toBe(true);
    for (const type of ["image/webp", "image/heic", "image/svg+xml", "application/pdf", ""]) expect(isInlineImage({ type })).toBe(false);
  });

  it("a forward's own cid parts are chips and are always sent; ours live in the text and go only while it shows them", () => {
    const own = ref("a", newImageCid());
    const forwarded = ref("b", "photo@test");
    const plain = ref("c");
    expect(isOwnImage(own)).toBe(true);
    expect(isOwnImage(forwarded)).toBe(false);
    expect(chipRefs([own, forwarded, plain])).toEqual([forwarded, plain]);
    expect(sentRefs([own, forwarded, plain], `<img src="cid:${own.contentId}">`)).toEqual([own, forwarded, plain]);
    // taken out of the text (and not put back): not sent
    expect(sentRefs([own, forwarded, plain], "<div>no image</div>")).toEqual([forwarded, plain]);
    expect(sentRefs([own, plain], undefined)).toEqual([plain]);
  });
});
