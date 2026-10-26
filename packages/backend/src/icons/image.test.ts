import { describe, expect, it } from "vitest";
import { icoBytes, pngBytes, SAFE_SVG } from "../test/icons-fixtures";
import { MAX_STORED, readIcon } from "./image";

const text = (s: string) => new TextEncoder().encode(s);

describe("icon images (plan 22)", () => {
  it("PNG by its signature, with its size; too small, too large and animated refused", () => {
    expect(readIcon(pngBytes(64))).toMatchObject({ mime: "image/png", px: 64 });
    expect(readIcon(pngBytes(8))).toBe("too-small");
    expect(readIcon(pngBytes(2048, 16))).toBe("too-large");
    expect(readIcon(pngBytes(32, 32, undefined, [{ type: "acTL", data: new Uint8Array(8) }]))).toBe("animated");
  });

  it("JPEG and WebP headers give their dimensions", () => {
    // a minimal JPEG: SOI, an APP0 segment, SOF0 with 48 × 40
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x28, 0x00, 0x30, 0x01, 0x01, 0x11, 0x00]);
    expect(readIcon(jpeg)).toMatchObject({ mime: "image/jpeg", px: 40 });
    const vp8x = new Uint8Array(30);
    vp8x.set(text("RIFF"), 0);
    vp8x.set(text("WEBPVP8X"), 8);
    vp8x.set([63, 0, 0, 99, 0, 0], 24);
    expect(readIcon(vp8x)).toMatchObject({ mime: "image/webp", px: 64 });
    vp8x[20] = 0x02;
    expect(readIcon(vp8x)).toBe("animated");
  });

  it("the bytes decide, not the content-type: HTML, GIF, empty and random bytes are refused", () => {
    expect(readIcon(text("<!doctype html><html><head><title>404</title>"))).toBe("unknown-format");
    expect(readIcon(text("GIF89a\x01\x00\x01\x00\x00\x00\x00"))).toBe("animated");
    expect(readIcon(new Uint8Array())).toBe("unknown-format");
    expect(readIcon(new Uint8Array(100).fill(7))).toBe("unknown-format");
  });

  it("ICO: the largest PNG entry is kept as a PNG; a BMP-only ICO keeps one entry; a broken directory is refused", () => {
    const ico = icoBytes([{ px: 16, bytes: pngBytes(16) }, { px: 48, bytes: pngBytes(48) }, { px: 32, bytes: pngBytes(32) }]);
    expect(readIcon(ico)).toMatchObject({ mime: "image/png", px: 48 });
    const bmp = readIcon(icoBytes([], 32));
    expect(bmp).toMatchObject({ mime: "image/x-icon", px: 32 });
    const one = (bmp as { bytes: Uint8Array }).bytes;
    expect([one[4], one[5], one[6], one[7]]).toEqual([1, 0, 32, 32]);
    // an entry pointing past the end of the file
    const broken = icoBytes([{ px: 16, bytes: pngBytes(16) }]);
    new DataView(broken.buffer).setUint32(6 + 12, 99_999, true);
    expect(readIcon(broken)).toBe("malformed");
    const many = new Uint8Array(6 + 40 * 16);
    many.set([0, 0, 1, 0, 40, 0]);
    expect(readIcon(many)).toBe("malformed");
  });

  it("a stored icon is at most 64 KB", () => {
    const big = pngBytes(1000, 1000, [1, 2, 3, 255]);
    expect(big.length < MAX_STORED || readIcon(big) === "too-large").toBe(true);
    // random pixels don't compress
    const noisy = pngBytes(16);
    const padded = new Uint8Array(MAX_STORED + 10);
    padded.set(noisy);
    expect(readIcon(padded)).toBe("too-large");
  });

  it("SVG: plain shapes pass; anything that runs, loads, animates or costs is refused", () => {
    expect(readIcon(text(SAFE_SVG))).toMatchObject({ mime: "image/svg+xml" });
    const svg = (body: string) => text(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);
    for (const bad of [
      "<script>alert(1)</script>",
      `<rect onload="alert(1)" width="1" height="1"/>`,
      "<foreignObject><div>x</div></foreignObject>",
      `<image href="https://tracker.example/p.png"/>`,
      `<use xlink:href="https://evil.example/s.svg#a"/>`,
      `<a href="javascript:alert(1)"><rect/></a>`,
      `<style>@import url(https://evil.example/x.css)</style>`,
      `<rect style="fill:url(https://evil.example/x)"/>`,
      `<rect fill="url('https://evil.example/x')"/>`,
      `<filter id="f"><feTurbulence/></filter>`,
      `<animate attributeName="x"/>`,
      `<image href="data:image/png;base64,AAAA"/>`,
    ]) {
      expect(readIcon(svg(bad)), bad).toBe("unsafe-svg");
    }
    expect(readIcon(text(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>`))).toBe("unsafe-svg");
    expect(readIcon(svg("<g/>".repeat(1600)))).toBe("too-large");
  });
});
