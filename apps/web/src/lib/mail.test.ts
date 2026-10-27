import { describe, expect, it } from "vitest";
import { csp } from "./mail";

// hasOwnColors and hasRemoteContent parse HTML with the browser's DOMParser: covered in e2e/themes.spec.ts and e2e/reader.spec.ts

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
});
