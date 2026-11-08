import { describe, expect, it } from "vitest";
import { csp, greyOf } from "./mail";

// mailDesign and hasRemoteContent parse HTML with the browser's DOMParser: covered in e2e/themes.spec.ts and e2e/reader.spec.ts

describe("HTML mail rules", () => {
  it("keeps remote content out unless allowed, and only ever lets images in", () => {
    expect(csp(false)).toContain("img-src data: cid:;");
    expect(csp(false)).not.toMatch(/https?:/);
    expect(csp(true)).toContain("img-src data: cid: https: http:;");
    expect(csp(false)).toContain("default-src 'none'");
    // plan 37 (Codex review): remote stylesheets and fonts stay closed even when images are allowed
    expect(csp(true)).toContain("style-src 'unsafe-inline';");
    expect(csp(true)).toContain("font-src data:;");
  });

  it("reads a mail's colors as a grey (and how light), a hue, or nothing, however they're written (plan 158)", () => {
    expect(greyOf("#888")).toEqual({ kind: "grey", light: 136 / 255 });
    expect(greyOf("888888")).toEqual({ kind: "grey", light: 136 / 255 });
    expect(greyOf("rgb(17, 17, 17)")).toEqual({ kind: "grey", light: 17 / 255 });
    expect(greyOf("White")).toEqual({ kind: "grey", light: 1 });
    expect(greyOf("#f7f7f5")).toMatchObject({ kind: "grey" });
    for (const hue of ["red", "#d00", "rgb(26, 115, 232)", "#1a1a6e", "navy"]) expect(greyOf(hue), hue).toEqual({ kind: "hue" });
    for (const none of ["transparent", "rgba(0, 0, 0, 0)", "#0000", "inherit", "currentColor", ""]) expect(greyOf(none), none).toEqual({ kind: "none" });
  });
});
