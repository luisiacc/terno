import { describe, expect, it } from "vitest";
import { iconLinks, rankIcons } from "./html";

const page = new URL("https://www.netflix.com/mx/");

describe("homepage icon links (plan 22)", () => {
  it("finds icon, shortcut icon and apple-touch-icon in any attribute order and quoting", () => {
    const html = `<!doctype html><html><head>
      <meta charset=utf-8>
      <link href="/favicon-32.png" rel="icon" sizes="32x32" type="image/png">
      <LINK REL='shortcut icon' HREF='https://assets.netflix.com/ffe/siteui/common/icons/nficon2016.ico'>
      <link rel=apple-touch-icon sizes=180x180 href=/apple-touch-icon.png>
      <link rel="stylesheet" href="/x.css">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="icon" href="http://www.netflix.com/insecure.png">
    </head><body><link rel="icon" href="/after-head.png"></body></html>`;
    const links = iconLinks(html, page);
    expect(links.map((l) => [l.rel, l.url.href, l.size])).toEqual([
      ["icon", "https://www.netflix.com/favicon-32.png", 32],
      ["icon", "https://assets.netflix.com/ffe/siteui/common/icons/nficon2016.ico", 0],
      ["apple-touch-icon", "https://www.netflix.com/apple-touch-icon.png", 180],
    ]);
  });

  it("honors an https <base href>, resolves protocol-relative hrefs, and ignores comments and scripts", () => {
    const html = `<head><base href="https://static.netflix.com/v2/"><!-- <link rel="icon" href="/commented.png"> -->
      <script>document.write('<link rel="icon" href="/scripted.png">')</script>
      <link rel="icon" href="icons/i.svg" type="image/svg+xml" sizes="any"><link rel="icon" href="//cdn.netflix.com/p.png"></head>`;
    expect(iconLinks(html, page).map((l) => l.url.href)).toEqual(["https://static.netflix.com/v2/icons/i.svg", "https://cdn.netflix.com/p.png"]);
  });

  it("a page without a head is scanned as far as it goes; nothing is found in a page without links", () => {
    expect(iconLinks(`<link rel="icon" href="/a.png">`, page)).toHaveLength(1);
    expect(iconLinks("<html><body>hi</body></html>", page)).toEqual([]);
    expect(iconLinks(`<head>${"<meta name=x content=y>".repeat(10_000)}<link rel="icon" href="/late.png">`, page)).toHaveLength(1);
  });

  it("ranks for a 128 px tile: touch icon, then raster at or above 128, then SVG, then smaller raster, then unsized", () => {
    const links = iconLinks(
      `<head><link rel=icon href=/u.ico><link rel=icon sizes=16x16 href=/16.png><link rel=icon sizes=32x32 href=/32.png><link rel=icon type=image/svg+xml href=/s.svg><link rel=icon sizes=192x192 href=/192.png><link rel=apple-touch-icon href=/t.png></head>`,
      page,
    );
    expect(rankIcons(links).map((l) => l.url.pathname)).toEqual(["/t.png", "/192.png", "/s.svg", "/32.png", "/16.png", "/u.ico"]);
  });
});
