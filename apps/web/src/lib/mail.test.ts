import { describe, expect, it } from "vitest";
import { csp, hasRemoteContent } from "./mail";

// hasOwnColors parses HTML with the browser's DOMParser: covered in e2e/themes.spec.ts

describe("HTML mail rules", () => {
  it("keeps remote content out unless allowed, and only ever lets images in", () => {
    expect(csp(false)).toContain("img-src data: cid:;");
    expect(csp(false)).not.toMatch(/https?:/);
    expect(csp(true)).toContain("img-src data: cid: https: http:;");
    expect(csp(false)).toContain("default-src 'none'");
    // plan 35 (Codex review): remote stylesheets and fonts stay closed even when images are allowed
    expect(csp(true)).toContain("style-src 'unsafe-inline';");
    expect(csp(true)).toContain("font-src data:;");
  });

  it("detects remote resources", () => {
    expect(hasRemoteContent('<img src="https://t.test/p.gif">')).toBe(true);
    expect(hasRemoteContent('<div style="background:url(https://x.test/a.png)">')).toBe(true);
    expect(hasRemoteContent('<img src="cid:logo">')).toBe(false);
    expect(hasRemoteContent('<table background="http://t.test/bg.png">')).toBe(true);
  });

  it("plan 35: SVG images count; links don't; protocol-relative only where it reaches the web", () => {
    expect(hasRemoteContent('<svg><image href="https://t.test/i.png"/></svg>')).toBe(true);
    expect(hasRemoteContent('<svg><image width="1" xlink:href="https://t.test/i.png"/></svg>')).toBe(true);
    expect(hasRemoteContent('<svg><use href="https://t.test/s.svg#a"/></svg>')).toBe(true);
    expect(hasRemoteContent('<a href="https://acme.test/">Acme</a>')).toBe(false);
    expect(hasRemoteContent('<video poster="https://t.test/p.png"></video>')).toBe(true);
    expect(hasRemoteContent('<img src="//t.test/p.gif">')).toBe(false);
    expect(hasRemoteContent('<img src="//t.test/p.gif">', true)).toBe(true);
    expect(hasRemoteContent('<td style="background:url(//t.test/a.png)">', true)).toBe(true);
    expect(hasRemoteContent('<a href="//acme.test/">Acme</a>', true)).toBe(false);
  });
});
