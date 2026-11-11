import { describe, expect, it } from "vitest";
import { contentKind, decodeText, inlineParts, isTextLike, PAGE_CHARS, textPage } from "./attachment-content";

const part = (id: number, contentId: string | null) => ({ id, filename: `p${id}`, mime: "image/png", size: 1, contentId });

describe("plan 185: how an agent gets a file", () => {
  it("text, images every client shows, and the rest as a file; by size too", () => {
    expect(contentKind({ mime: "text/csv", filename: "a.csv", size: 10 })).toBe("text");
    expect(contentKind({ mime: "application/vnd.api+json", filename: "a", size: 10 })).toBe("text");
    expect(contentKind({ mime: "application/octet-stream", filename: "README.md", size: 10 })).toBe("text");
    expect(contentKind({ mime: "text/plain", filename: "big.log", size: 2 * 1024 * 1024 })).toBe("file");
    expect(contentKind({ mime: "image/webp", filename: "a.webp", size: 10 })).toBe("image");
    expect(contentKind({ mime: "image/png", filename: "huge.png", size: 6 * 1024 * 1024 })).toBe("file");
    expect(contentKind({ mime: "image/heic", filename: "a.heic", size: 10 })).toBe("file");
    expect(contentKind({ mime: "application/pdf", filename: "a.pdf", size: 10 })).toBe("file");
    expect(isTextLike("application/octet-stream", "archive.zip")).toBe(false);
  });

  it("decodes UTF-8, else windows-1252", () => {
    expect(decodeText(new TextEncoder().encode("Año ✓"))).toBe("Año ✓");
    expect(decodeText(new Uint8Array([0x41, 0xf1, 0x6f, 0x80]))).toBe("Año€");
  });

  it("pages by characters and by tokens, never splitting a pair, to the end", () => {
    const ascii = "a".repeat(PAGE_CHARS + 5);
    expect(textPage(ascii, 0)).toEqual({ page: "a".repeat(PAGE_CHARS), nextOffset: PAGE_CHARS });
    expect(textPage(ascii, PAGE_CHARS)).toEqual({ page: "aaaaa", nextOffset: null });
    // CJK: about a token a character, so a page is ~8,000 of them
    expect(textPage("字".repeat(20_000), 0).page.length).toBe(8_000);
    const emoji = `${"字".repeat(7_999)}😀x`;
    const first = textPage(emoji, 0);
    expect(first.page.endsWith("\ud83d")).toBe(false);
    expect(first.page + textPage(emoji, first.nextOffset!).page).toBe(emoji);
    expect(textPage("", 0)).toEqual({ page: "", nextOffset: null });
  });

  it("marks a part inline only when an image of the body shows it, once", () => {
    const html = `<p>Hi</p><!-- <img src="cid:hidden@x"> --><img alt="" src = "cid:Logo%40X"><img src='cid:a&amp;b@x'><a href="cid:link@x">x</a><img src=cid:dup@x>`;
    const parts = [part(1, "<logo@x>"), part(2, "hidden@x"), part(3, "a&b@x"), part(4, "link@x"), part(5, "dup@x"), part(6, "dup@x"), part(7, null)];
    expect([...inlineParts(html, parts)].sort()).toEqual([1, 3]);
    expect(inlineParts(null, parts).size).toBe(0);
  });
});
