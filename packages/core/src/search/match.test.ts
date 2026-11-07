import { describe, expect, it } from "vitest";
import { matchExcerpt, matchFocus, matchParts, rowExplains, rowMatchOf } from "./match";

const hits = (text: string, needles: Parameters<typeof matchParts>[1]) => matchParts(text, needles)?.filter((p) => p.hit).map((p) => p.text) ?? [];

describe("rowMatchOf", () => {
  it("marks free text everywhere, a field only in its place, and never what's negated", () => {
    const m = rowMatchOf("pago from:ana subject:recibo -spam to:bob")!;
    expect(m.from.map((n) => n.words)).toEqual([["pago"], ["ana"]]);
    expect(m.subject.map((n) => n.words)).toEqual([["pago"], ["recibo"]]);
    expect(m.body.map((n) => n.words)).toEqual([["pago"]]);
  });

  it("has nothing to mark for what no row shows", () => {
    expect(rowMatchOf("is:unread has:attachment in:all")).toBeNull();
    expect(rowMatchOf("-pago")).toBeNull();
  });
});

describe("matchParts", () => {
  const body = (q: string) => rowMatchOf(q)!.body;

  it("finds through case and accents, and keeps the mail's own spelling", () => {
    expect(hits("La REUNIÓN de hoy", body("reunion "))).toEqual(["REUNIÓN"]);
    // decomposed mail reads the same
    expect(hits("La reunión de hoy", body("reunion "))).toEqual(["reunión"]);
  });

  it("whole words, except the one being typed, of which only what's typed", () => {
    expect(hits("pagos y pago", body("pago "))).toEqual(["pago"]);
    expect(hits("pagos y apagón", body("pag"))).toEqual(["pag"]);
    expect(matchParts("pagos", body("pag"))).toEqual([{ text: "pag", hit: true }, { text: "os", hit: false }]);
  });

  it("a phrase is its words side by side", () => {
    expect(hits("el pago final, final pago", body('"pago final"'))).toEqual(["pago final"]);
  });

  it("any of a comma's words, overlaps merged, in order", () => {
    const n = body("pago,factura ");
    expect(hits("factura y pago", n)).toEqual(["factura", "pago"]);
    expect(hits("pago pago", [...n, ...n])).toEqual(["pago", "pago"]);
  });

  it("nothing found is nothing to cut", () => {
    expect(matchParts("hola", body("pago "))).toBeNull();
    expect(matchParts("", body("pago "))).toBeNull();
    expect(matchParts("hola", [])).toBeNull();
  });
});

describe("rowExplains", () => {
  it("every term must show on the row; one of a comma's words is enough", () => {
    const both = rowMatchOf("pago factura ")!;
    expect(rowExplains(both, ["Ana", "El pago", "de la factura"])).toBe(true);
    expect(rowExplains(both, ["Ana", "El pago", "de hoy"])).toBe(false);
    expect(rowExplains(rowMatchOf("pago,factura ")!, ["Ana", "El pago", "de hoy"])).toBe(true);
    // a field's own term asks for no excerpt: the engines found it where it shows, or where no row shows it
    expect(rowExplains(rowMatchOf("from:ana ")!, ["Bob", "Hola", ""])).toBe(true);
  });
});

describe("matchExcerpt", () => {
  const body = (q: string) => rowMatchOf(q)!.body;

  it("the sentence the match is in", () => {
    expect(matchExcerpt("Hola Luis. Falta el pago de mayo. Saludos.", body("pago "))).toBe("Falta el pago de mayo.");
    expect(matchExcerpt("Primera línea\nFalta el pago\nÚltima", body("pago "))).toBe("Falta el pago");
  });

  it("a match deep in a very long sentence keeps what's near it", () => {
    const out = matchExcerpt(`${"una cosa y otra ".repeat(30)}falta el pago de mayo.`, body("pago "))!;
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("el pago de mayo.")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(181);
  });

  it("keeps a long sentence short, the match in it", () => {
    const out = matchExcerpt(`Falta el pago ${"y otra cosa más ".repeat(40)}fin.`, body("pago "))!;
    expect(out.length).toBeLessThanOrEqual(181);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("pago");
  });

  it("no match, no excerpt", () => {
    expect(matchExcerpt("Hola", body("pago "))).toBeNull();
  });
});

describe("matchFocus", () => {
  const body = (q: string) => rowMatchOf(q)!.body;

  it("brings the match to the start of a short row, at a word", () => {
    const out = matchFocus("Qué tal Luis, hubo un problema con el pago de mayo", body("pago "), 12);
    expect(out).toBe("…con el pago de mayo");
  });

  it("leaves alone a line whose match already shows, or that has none", () => {
    expect(matchFocus("Falta el pago", body("pago "), 12)).toBe("Falta el pago");
    expect(matchFocus("Una línea bastante larga sin nada", body("pago "), 12)).toBe("Una línea bastante larga sin nada");
  });
});
