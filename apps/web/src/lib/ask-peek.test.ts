// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
vi.mock("~/rpc/connection", () => ({ client: { call: async () => ({}), on: () => () => {}, connectionVersion: 1 } }));
const { messageText, needlesOf, passageOf } = await import("./ask-peek");

const q = (terms: string[], anyOf?: string[][]) => ({ terms, anyOf });

describe("a cited message shown in Ask: its passage, from the turn's own searches (plan 161, pass 3)", () => {
  it("the words the searches looked for, folded, once each", () => {
    expect(needlesOf([q(["Pago"], [["payment", "pago"]]), q([], [["factura"]])]).map((n) => n.words)).toEqual([["pago"], ["payment"], ["factura"]]);
    expect(needlesOf([q([])])).toEqual([]);
  });

  it("the passage is the first sentence holding one of them; none when no sentence does", () => {
    const text = "Hola Luis. Hubo un problema con el pago de la renta, ¿lo puedes revisar? Gracias.";
    expect(passageOf(text, needlesOf([q([], [["payment", "pago"]])]))).toBe("Hubo un problema con el pago de la renta, ¿lo puedes revisar?");
    expect(passageOf(text, needlesOf([q(["concierto"])]))).toBeNull();
    expect(passageOf(text, [])).toBeNull();
  });

  it("the text part first, else the HTML's words (scripts and styles left out, nothing fetched), else the snippet", () => {
    expect(messageText({ bodyText: " Plain words ", bodyHtml: "<p>html</p>", snippet: "s" })).toBe("Plain words");
    const html = '<html><head><title>T</title><style>p{color:red}</style></head><body><p>First line</p><script>evil()</script><div>Second<br>third</div><img src="https://tracker.test/x.png"></body></html>';
    expect(messageText({ bodyText: null, bodyHtml: html, snippet: "s" })).toBe("First line\nSecond\nthird");
    expect(messageText({ bodyText: "", bodyHtml: null, snippet: "the snippet" })).toBe("the snippet");
  });
});
