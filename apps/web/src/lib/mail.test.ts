import { describe, expect, it } from "vitest";
import { csp, hasOwnColors, hasRemoteContent } from "./mail";

describe("HTML mail rules", () => {
  it("keeps remote content out unless allowed (local mode never allows it)", () => {
    expect(csp(false)).toContain("img-src data: cid:;");
    expect(csp(false)).not.toMatch(/https?:/);
    expect(csp(true)).toContain("img-src data: cid: https: http:");
    expect(csp(false)).toContain("default-src 'none'");
  });

  it("tells designed mail (its own colors) from plain mail", () => {
    expect(hasOwnColors('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true);
    expect(hasOwnColors('<font color="red">x</font>')).toBe(true);
    expect(hasOwnColors('<div style="padding:4px; background-color: #eee">x</div>')).toBe(true);
    expect(hasOwnColors('<p style="color:#333">x</p>')).toBe(true);
    expect(hasOwnColors("<p>Hola, <b>Ana</b>: <a href='https://x.test'>enlace</a></p>")).toBe(false);
    expect(hasOwnColors('<p style="margin:0;font-weight:bold">sin colores</p>')).toBe(false);
    expect(hasOwnColors('<p style="border-color:red">x</p>')).toBe(false);
  });

  it("detects remote resources", () => {
    expect(hasRemoteContent('<img src="https://t.test/p.gif">')).toBe(true);
    expect(hasRemoteContent('<div style="background:url(https://x.test/a.png)">')).toBe(true);
    expect(hasRemoteContent('<img src="cid:logo">')).toBe(false);
  });
});
