// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { contrast as ratio, type Rgb } from "@terno/ui/themes/color";
import { darkenMail, mailColor, pictureFix, type DarkPalette } from "./mail-dark";

// Dracula's painted tokens as mailColors gives them (hex)
const DRACULA: DarkPalette = { background: "#282a36", card: "#2f3142", foreground: "#f8f8f2", muted: "#a9bbf2", link: "#bd93f9", border: "#3a3c4e" };
const NORD: DarkPalette = { background: "#2e3440", card: "#3b4252", foreground: "#e5e9f0", muted: "#becce6", link: "#79afff", border: "#3b4252" };

function mail(html: string): HTMLElement {
  document.body.innerHTML = `<div id="flow">${html}</div>`;
  return document.getElementById("flow")!;
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
/** WCAG contrast of two colors as the DOM reports them ("rgb(…)") or as written */
const contrast = (a: string | Rgb, b: string | Rgb) => ratio(typeof a === "string" ? mailColor(a)! : a, typeof b === "string" ? mailColor(b)! : b);
const hexOf = (value: string) => {
  const c = mailColor(value)!;
  return `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
};

const NEWSLETTER = `
  <table bgcolor="#f2f2f2" width="100%"><tr><td>
    <table id="card" style="background-color:#ffffff;width:600px;border:1px solid #e5e5e5"><tr><td>
      <div id="band" style="background-color:#1d5bb0;color:#ffffff;padding:12px">THE WEBINAR SERIES</div>
      <h1 id="title" style="color:#1d5bb0">Clinical pearls</h1>
      <p id="body" style="color:#222222">Evaluating a panel requires looking far beyond one number, with plenty of words to read.</p>
      <p id="quiet" style="color:#888888">You are receiving this because you signed up for our list.</p>
      <p><a id="plain-link" href="https://x.test">Read in the browser</a></p>
      <a id="cta" href="https://x.test/r" style="background-color:#ec008c;color:#ffffff;padding:10px 20px">Register</a>
      <div id="pastel" style="background-color:#fdeef4;color:#333333">A pastel note with some text in it</div>
      <div id="rule" style="background-color:#dddddd;height:1px;line-height:1px"></div>
      <span id="pre" style="color:#ffffff;font-size:1px">hidden preheader</span>
    </td></tr></table>
  </td></tr></table>`;

describe("darkenMail (plan 295)", () => {
  it("maps a light newsletter onto the palette: page, card, ink, quiet ink, links; brand colors stay exactly", () => {
    const root = mail(NEWSLETTER);
    const result = darkenMail(root, DRACULA);
    expect(result.converted).toBe(true);
    // the grey page is the reader's background; the white card on it a raised surface, tinted like the theme
    expect(hexOf(root.querySelector<HTMLElement>("table")!.style.backgroundColor)).toBe(DRACULA.background);
    const card = mailColor($("#card").style.backgroundColor)!;
    expect(contrast(card, DRACULA.background)).toBeLessThan(1.4);
    expect(hexOf($("#card").style.backgroundColor)).not.toBe(DRACULA.background);
    // a vivid band and the white text on it are left exactly as written; the pink button too
    expect(hexOf($("#band").style.backgroundColor)).toBe("#1d5bb0");
    expect(hexOf($("#band").style.color)).toBe("#ffffff");
    expect(hexOf($("#cta").style.backgroundColor)).toBe("#ec008c");
    // text: the theme's ink family, at least AA on its new surface; colored text keeps its hue
    for (const id of ["#body", "#quiet", "#title"]) expect(contrast($(id).style.color, $("#card").style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrast($("#body").style.color, $("#card").style.backgroundColor)).toBeGreaterThan(contrast($("#quiet").style.color, $("#card").style.backgroundColor));
    const title = mailColor($("#title").style.color)!;
    expect(title.b).toBeGreaterThan(title.r);
    // an unstyled link is left to the frame's own rule, which takes the theme's link
    expect($("#plain-link").style.color).toBe("");
    // a pastel keeps a dusky tint of its hue; a thin filled cell is a line; a preheader hidden in the page's color stays hidden
    const pastel = mailColor($("#pastel").style.backgroundColor)!;
    expect(pastel.r).toBeGreaterThan(pastel.g);
    expect(contrast(pastel, DRACULA.background)).toBeLessThan(1.6);
    expect(contrast($("#rule").style.backgroundColor, $("#card").style.backgroundColor)).toBeGreaterThan(1.05);
    expect(hexOf($("#pre").style.color)).toBe(hexOf($("#card").style.backgroundColor));
  });

  it("follows the palette it's given: another theme, another tint", () => {
    darkenMail(mail(NEWSLETTER), NORD);
    expect(hexOf(document.querySelector<HTMLElement>("table")!.style.backgroundColor)).toBe(NORD.background);
  });

  it("puts back exactly what it replaced, keeping what others wrote since; and converts again after", () => {
    const root = mail(`<div id="a" style="background-color:#fff !important;color:#111;padding:4px">Some text that is long enough to count</div>`);
    const before = $("#a").style.cssText;
    const result = darkenMail(root, DRACULA);
    if (!result.converted) throw new Error("expected a conversion");
    // written plainly: inline, it replaces the sender's declaration whatever its priority (and the full view can theme it)
    expect($("#a").style.getPropertyPriority("background-color")).toBe("");
    $("#a").style.setProperty("overflow-y", "clip", "important");
    result.undo();
    expect(hexOf($("#a").style.backgroundColor)).toBe("#ffffff");
    expect($("#a").style.getPropertyPriority("background-color")).toBe("important");
    expect(hexOf($("#a").style.color)).toBe("#111111");
    expect($("#a").style.getPropertyValue("overflow-y")).toBe("clip");
    $("#a").style.removeProperty("overflow-y");
    expect($("#a").style.cssText).toBe(before);
    expect(darkenMail(root, NORD).converted).toBe(true);
  });

  it("puts mixed border sides back exactly: a legacy bordercolor under inline sides, one of them !important", () => {
    const root = mail(`<table><tr><td id="c" bordercolor="#cccccc" style="border-top-color:#ff0000 !important;border-right-color:#0000ff;color:#222">Text in a bordered cell, long enough to count</td></tr></table>`);
    const before = $("#c").style.cssText;
    const result = darkenMail(root, DRACULA);
    if (!result.converted) throw new Error("expected a conversion");
    // the sides the style names keep their own (mapped) colors; the attribute's go to the others
    expect(hexOf($("#c").style.borderTopColor)).toBe("#ff0000");
    expect($("#c").style.borderBottomColor).not.toBe("");
    result.undo();
    expect($("#c").style.cssText).toBe(before);
  });

  it("a gradient with stops a single ink can't read on both ends stays as written; one with no readable stop maps its fill", () => {
    darkenMail(mail(`<p style="color:#222">${"Plenty of ordinary text on the page. ".repeat(6)}</p><div id="g" style="background-image:linear-gradient(#ffffff, #ff0000);color:#111111">On the gradient</div><div id="t" style="background-color:#ffffff;background-image:linear-gradient(transparent, transparent);color:#111">Over a see-through gradient</div>`), DRACULA);
    expect($("#g").style.backgroundImage).toMatch(/255, 255, 255|#ffffff/i);
    expect(hexOf($("#g").style.color)).toBe("#111111");
    expect(hexOf($("#t").style.backgroundColor)).not.toBe("#ffffff");
    expect(contrast($("#t").style.color, $("#t").style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });

  it("a gradient it can't read, or whose stops end up apart, stays as written with its ink; an <hr>'s color leaves a side the style names", () => {
    darkenMail(mail(`<p style="color:#222">${"Plenty of ordinary text on the page. ".repeat(6)}</p>
      <div id="o" style="background-color:#ffffff;background-image:linear-gradient(oklch(0.98 0 0), oklch(0.96 0 0));color:#111111">Over a modern gradient</div>
      <div id="b" style="background-image:linear-gradient(#666666, #ee0000);color:#ffffff">Over a brand gradient</div>
      <hr id="hr" color="#eeeeee" style="border-top:1px solid #ff0000">`), DRACULA);
    expect(hexOf($("#o").style.backgroundColor)).toBe("#ffffff");
    expect(hexOf($("#o").style.color)).toBe("#111111");
    expect(hexOf($("#b").style.color)).toBe("#ffffff");
    expect($("#b").style.backgroundImage).toMatch(/102, 102, 102|#666666/i);
    expect(hexOf($("#hr").style.borderTopColor)).toBe("#ff0000");
    expect(hexOf($("#hr").style.borderBottomColor)).not.toBe("#eeeeee");
  });

  it("turns a black call to action into the theme's light button, and keeps its label readable", () => {
    darkenMail(mail(`<p style="color:#111">Update the app to try the new keyboard in every app you use today.</p><table><tr><td id="btn" style="background-color:#111111"><a id="label" href="https://x.test" style="color:#ffffff">Update app</a></td></tr></table>`), DRACULA);
    const button = mailColor($("#btn").style.backgroundColor)!;
    expect(contrast(button, DRACULA.background)).toBeGreaterThan(7);
    expect(contrast($("#label").style.color, $("#btn").style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });

  it("maps a gradient stop by stop, and a hairline border to the theme's line", () => {
    darkenMail(mail(`<div id="g" style="background-image:linear-gradient(#ffffff, #f0f0f0);color:#222">Ready to try it? There is plenty of text here.</div><div id="b" style="border:1px solid #e6e6e6;color:#222">Bordered text that is long enough</div>`), DRACULA);
    expect($("#g").style.backgroundImage).not.toMatch(/#ffffff|255, 255, 255/i);
    const line = $("#b").style.borderTopColor;
    expect(contrast(line, DRACULA.background)).toBeGreaterThan(1.05);
    expect(contrast(line, DRACULA.background)).toBeLessThan(2);
  });

  it("leaves islands as written: anything over a background picture keeps its colors, pinned", () => {
    darkenMail(mail(`<p style="color:#222">${"Plenty of ordinary text on the page. ".repeat(6)}</p><div id="hero" style="background-image:url(https://x.test/a.png)"><span id="over">On the picture</span></div>`), DRACULA);
    expect(hexOf($("#hero").style.backgroundColor)).toBe("#ffffff");
    expect($("#over").getAttribute("style")).toBeNull();
  });

  it("keeps the paper when converting would do worse, writing nothing", () => {
    const cases: [string, string][] = [
      // already dark
      [`<div style="background-color:#111;color:#eee">${"A dark newsletter with its own dark page. ".repeat(4)}</div><p style="color:#333">fine print</p>`, "already-dark"],
      // its text over pictures
      [`<div style="background-image:url(https://x.test/bg.jpg);color:#fff">${"Words laid over a photograph. ".repeat(4)}</div><p style="color:#333">x</p>`, "background-picture"],
      // sliced pictures
      [`<p style="color:#333">Hi</p><img width="600" src="https://x.test/1.jpg"><img width="600" src="https://x.test/2.jpg">`, "image-only"],
      // most of its text on light brand surfaces
      [`<div style="background-color:#fde68a;color:#3a2a00">${"Text on a yellow sheet the mapping keeps. ".repeat(5)}</div>`, "stays-light"],
    ];
    for (const [html, reason] of cases) {
      const root = mail(html);
      const before = root.innerHTML;
      expect(darkenMail(root, DRACULA)).toEqual({ converted: false, reason });
      expect(root.innerHTML).toBe(before);
    }
  });

  it("reads the colors mail writes, however written", () => {
    expect(mailColor("#FFF")).toEqual({ r: 1, g: 1, b: 1, alpha: 1 });
    expect(mailColor("ffffff")).toEqual({ r: 1, g: 1, b: 1, alpha: 1 });
    expect(mailColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, alpha: 1 });
    expect(mailColor("rgba(0,0,0,.5)")?.alpha).toBe(0.5);
    expect(mailColor("hsl(0, 0%, 100%)")).toEqual({ r: 1, g: 1, b: 1, alpha: 1 });
    expect(mailColor("WhiteSmoke")).toEqual({ r: 245 / 255, g: 245 / 255, b: 245 / 255, alpha: 1 });
    for (const none of ["transparent", "inherit", "var(--x)", "rgba(0,0,0,0)", "", null]) expect(mailColor(none)).toBeNull();
  });
});

describe("pictureFix (plan 295)", () => {
  /** a square picture: `inside` for the pixels of a centered glyph, see-through around it unless `around` */
  const picture = (inside: [number, number, number, number], around: [number, number, number, number] = [0, 0, 0, 0], size = 10) => {
    const out: number[] = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.push(...(x >= 3 && x < 7 && y >= 3 && y < 7 ? inside : around));
    return out;
  };
  const DARK_PAGE = 0.02, LIGHT_PAGE = 0.9;

  it("turns a dark see-through glyph light, plates a mixed one, and leaves the rest", () => {
    expect(pictureFix(picture([0, 0, 0, 255]), DARK_PAGE)).toBe("invert");
    // half a black wordmark, half a colored mark
    const mixed = picture([0, 0, 0, 255]);
    for (let i = 0; i < mixed.length; i += 8) if (mixed[i + 3]) mixed.splice(i, 4, 240, 80, 20, 255);
    expect(pictureFix(mixed, DARK_PAGE)).toBe("plate");
    // a white logo already stands out; an opaque photo brings its own ground; on a light surface nothing is needed
    expect(pictureFix(picture([255, 255, 255, 255]), DARK_PAGE)).toBeNull();
    expect(pictureFix(picture([0, 0, 0, 255], [255, 255, 255, 255]), DARK_PAGE)).toBeNull();
    expect(pictureFix(picture([0, 0, 0, 255]), LIGHT_PAGE)).toBeNull();
    expect(pictureFix([], DARK_PAGE)).toBeNull();
  });
});
