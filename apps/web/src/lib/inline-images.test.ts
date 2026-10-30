import { describe, expect, it } from "vitest";
import { chipRefs, isInlineImage, isOwnImage, markInText, newImageCid, outOfText, sentRefs, withSentImages } from "./inline-images";

const ref = (assetId: string, contentId: string | null = null) => ({ assetId, filename: `${assetId}.png`, mime: "image/png", size: 1, contentId });
const img = (cid: string) => `<img src="cid:${cid}" alt="x" style="max-width:100%;height:auto">`;

describe("inline images (plan 76)", () => {
  it("only types the reader shows inline go in the text", () => {
    for (const type of ["image/png", "image/jpeg", "IMAGE/GIF"]) expect(isInlineImage({ type })).toBe(true);
    for (const type of ["image/webp", "image/heic", "image/svg+xml", "application/pdf", ""]) expect(isInlineImage({ type })).toBe(false);
  });

  it("an image in the text is no chip; one taken out of it stays out of sight for Undo and isn't sent", () => {
    const placed = ref("a", newImageCid());
    const plain = ref("c");
    markInText(placed.contentId!);
    expect(isOwnImage(placed)).toBe(true);
    expect(chipRefs([placed, plain], `<div>${img(placed.contentId!)}</div>`)).toEqual([plain]);
    expect(sentRefs([placed, plain], `<div>${img(placed.contentId!)}</div>`)).toEqual([placed, plain]);
    // taken out of the text (and not put back)
    expect(chipRefs([placed, plain], "<div>gone</div>")).toEqual([plain]);
    expect(outOfText([placed, plain], "<div>gone</div>")).toEqual([placed]);
    expect(sentRefs([placed, plain], "<div>gone</div>")).toEqual([plain]);
  });

  it("a forward of a mail Terno sent keeps that mail's images as files: chips, and sent (Codex review)", () => {
    const forwarded = ref("b", newImageCid());
    const theirs = ref("d", "photo@test");
    expect(chipRefs([forwarded, theirs], "<div>fwd</div>")).toEqual([forwarded, theirs]);
    expect(sentRefs([forwarded, theirs], "<div>fwd</div>")).toEqual([forwarded, theirs]);
    expect(outOfText([forwarded], "<div>fwd</div>")).toEqual([]);
  });

  it("a send's HTML loses an image whose file isn't sent (let go for room, then brought back by Undo)", () => {
    const kept = newImageCid(), gone = newImageCid();
    expect(withSentImages(`<div>a${img(kept)}b${img(gone)}</div>`, [ref("k", kept)])).toBe(`<div>a${img(kept)}b</div>`);
  });
});
