// @vitest-environment jsdom
import { rowMatchOf } from "@terno/core";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({}), on: () => () => {} } }));

const { firstHolding, markDocument } = await import("./reader-marks");
const needles = rowMatchOf("pago")!.body;
const root = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
const marks = (el: Element) => [...el.querySelectorAll("mark[data-reader-match]")];

describe("plan 158: a search's marks in a loaded mail", () => {
  it("marks words, leaves tags and links alone, and takes them away to the same text", () => {
    const el = root(`<p>El <b>pago</b> y otro pago, y <a href="https://x.example/pago">un enlace</a></p>`);
    const before = el.innerHTML;
    markDocument(el, needles);
    expect(marks(el).map((m) => m.textContent)).toEqual(["pago", "pago"]);
    expect(el.querySelector("a")!.getAttribute("href")).toBe("https://x.example/pago");
    markDocument(el, undefined);
    expect(marks(el)).toHaveLength(0);
    expect(el.innerHTML).toBe(before);
    // one node again, not pieces of text
    expect(el.querySelector("p")!.childNodes[2]!.textContent).toBe(" y otro pago, y ");
  });

  it("holds its bound inside one long text node, and keeps the rest of the text", () => {
    const text = "pago ".repeat(2000);
    const el = root(`<p>${text}</p>`);
    markDocument(el, needles);
    expect(marks(el).length).toBeLessThanOrEqual(300);
    expect(el.textContent).toBe(text);
  });

  it("the first message that reads as holding it: an entity is the letter it stands for, a tag splits nothing it shouldn't", () => {
    const cafe = rowMatchOf("cafe")!.body;
    const m = (bodyHtml: string | null, bodyText: string | null) => ({ bodyHtml, bodyText });
    const hit = m("<p>un caf&#233; luego</p>", null);
    expect(firstHolding([m(null, "nada"), m("<p>otra cosa</p>", null), hit], cafe)).toBe(hit);
    expect(firstHolding([m("<style>.cafe{}</style><p>nada</p>", null)], cafe)).toBeUndefined();
    const blocks = m("<div>Hola</div><div>cafe pendiente</div>", null);
    expect(firstHolding([blocks], cafe)).toBe(blocks);
  });
});
