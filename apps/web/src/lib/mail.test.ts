import { describe, expect, it } from "vitest";
import { csp, hasRemoteContent } from "./mail";

// hasOwnColors parses HTML with the browser's DOMParser: covered in e2e/themes.spec.ts

describe("HTML mail rules", () => {
  it("keeps remote content out unless allowed (local mode never allows it)", () => {
    expect(csp(false)).toContain("img-src data: cid:;");
    expect(csp(false)).not.toMatch(/https?:/);
    expect(csp(true)).toContain("img-src data: cid: https: http:");
    expect(csp(false)).toContain("default-src 'none'");
  });

  it("detects remote resources", () => {
    expect(hasRemoteContent('<img src="https://t.test/p.gif">')).toBe(true);
    expect(hasRemoteContent('<div style="background:url(https://x.test/a.png)">')).toBe(true);
    expect(hasRemoteContent('<img src="cid:logo">')).toBe(false);
  });
});
