import { describe, expect, it } from "vitest";
import { splitTextQuote } from "./quote";

describe("trailing quoted history in plain text", () => {
  it("splits a reply from the quoted history under it, with its attribution line", () => {
    const text = "Perfecto, lo vemos el jueves.\n\nSaludos.\n\nEl mar, 20 oct 2026 a las 10:12, Yuki <yuki@acme.studio> escribió:\n> ¿Lo vemos el jueves?\n>\n> Yuki";
    expect(splitTextQuote(text)).toEqual({
      main: "Perfecto, lo vemos el jueves.\n\nSaludos.",
      quoted: "El mar, 20 oct 2026 a las 10:12, Yuki <yuki@acme.studio> escribió:\n> ¿Lo vemos el jueves?\n>\n> Yuki",
    });
  });

  it("takes an attribution Gmail wrapped onto two lines", () => {
    const text = "Va.\n\nOn Tue, Oct 20, 2026 at 10:12 AM Yuki Gutiérrez <\nyuki@acme.studio> wrote:\n> hola";
    expect(splitTextQuote(text).main).toBe("Va.");
  });

  it("keeps an inline reply whole: answers between quotes are not history", () => {
    const text = "> ¿Cuál es el presupuesto?\n$40,000 MXN.\n\n> ¿Y la fecha?\nEl 3 de noviembre.\n\n> Gracias\n> Yuki";
    expect(splitTextQuote(text)).toEqual({ main: text, quoted: "" });
  });

  it("folds Outlook's plain-text history from its rule", () => {
    const text = "Recibido, gracias.\n\n________________________________\nDe: Ana Ruiz <ana@x.mx>\nEnviado: lunes\n\nTexto anterior";
    expect(splitTextQuote(text)).toEqual({ main: "Recibido, gracias.", quoted: "________________________________\nDe: Ana Ruiz <ana@x.mx>\nEnviado: lunes\n\nTexto anterior" });
    expect(splitTextQuote("Ok\n-----Original Message-----\nFrom: a@b.c\nhola").main).toBe("Ok");
  });

  it("leaves text without history, or with nothing but history, as it is", () => {
    expect(splitTextQuote("Hola\n\nSin citas.")).toEqual({ main: "Hola\n\nSin citas.", quoted: "" });
    expect(splitTextQuote("> todo citado\n> aquí")).toEqual({ main: "> todo citado\n> aquí", quoted: "" });
    expect(splitTextQuote("Una línea que dice: escribió:")).toEqual({ main: "Una línea que dice: escribió:", quoted: "" });
  });

  it("stays linear on hostile input: thousands of rules, blank lines and quotes", () => {
    const time = (n: number) => {
      const text = `${"________\n\n".repeat(n)}Hola\n${"> x\n\n".repeat(n)}`;
      const t0 = performance.now();
      for (let i = 0; i < 3; i++) splitTextQuote(text);
      return (performance.now() - t0) / 3;
    };
    time(2000);
    const small = time(10_000);
    const big = time(40_000);
    // 160k lines: tens of ms, and 4× the input costs ~4× the time (quadratic would be ~16×)
    expect(big).toBeLessThan(150);
    expect(big / Math.max(small, 1)).toBeLessThan(8);
  });
});
