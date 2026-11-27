// @vitest-environment jsdom
/** Plan 284: what a right-click on a link offers, and how the frame's replay keeps what it was on. */
import { describe, expect, it } from "vitest";
import { linkAt, menuLink } from "./menu-link";
import { menuOrigin, replayMenu } from "./menu-origin";

describe("menuLink", () => {
  it("is an address to write to, a page to open, or nothing", () => {
    expect(menuLink("mailto:ana@x.example?subject=Hi")).toEqual({ kind: "mail", to: "ana@x.example", subject: "Hi" });
    expect(menuLink("https://x.example/a?b#c")).toEqual({ kind: "web", href: "https://x.example/a?b#c" });
    expect(menuLink("HTTP://x.example")).toEqual({ kind: "web", href: "HTTP://x.example" });
    for (const href of ["mailto:a@x.example,b@x.example", "tel:+15550100", "javascript:alert(1)", "#top", "", "/relative", "https://", "ftp://x.example"]) expect(menuLink(href)).toBeNull();
  });
});

describe("linkAt", () => {
  it("reads the link as the mail wrote it, from the element or inside it", () => {
    document.body.innerHTML = `<a id="mail" href=" mailto:ana@x.example "><span id="inner">Ana</span></a><a id="frag" href="#top">top</a><a id="empty" href="">x</a><p id="text">text</p>`;
    const at = (id: string) => linkAt(document.getElementById(id));
    expect(at("inner")).toEqual({ kind: "mail", to: "ana@x.example", subject: "" });
    // (resolved, these would be the app's own address)
    expect(at("frag")).toBeNull();
    expect(at("empty")).toBeNull();
    expect(at("text")).toBeNull();
    expect(linkAt(null)).toBeNull();
  });
});

describe("menuOrigin", () => {
  it("is what a replayed right-click was on, else the event's own target", () => {
    document.body.innerHTML = `<div id="frame"></div><a id="link" href="https://x.example">x</a>`;
    const frame = document.getElementById("frame")!, link = document.getElementById("link")!;
    const seen: (Element | null)[] = [];
    document.addEventListener("contextmenu", (e) => seen.push(menuOrigin(e)));
    replayMenu(frame, link, 10, 20);
    frame.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(seen).toEqual([link, frame]);
  });
});
