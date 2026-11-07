// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { QUOTE_STYLE, textToHtml } from "@terno/richtext";
import { withoutTrailingQuote } from "./quote-html";

describe("HTML mail's trailing history, the same rule as plain text's", () => {
  it("Gmail's and Apple Mail's quotes fold, the reply stays", () => {
    const gmail = withoutTrailingQuote('<div dir="ltr">Listo.</div><br><div class="gmail_quote"><div class="gmail_attr">El mar, Yuki escribió:<br></div><blockquote class="gmail_quote">Mándame el archivo</blockquote></div>');
    expect(gmail).toContain("Listo.");
    expect(gmail).not.toContain("Mándame");
    const apple = withoutTrailingQuote('<div>Gracias.</div><div>On Oct 20, Yuki wrote:</div><blockquote type="cite">El contrato</blockquote>');
    expect(apple).toContain("Gracias.");
    expect(apple).not.toContain("El contrato");
  });

  it("what Terno itself sends folds too: its quote is a plain blockquote under the attribution", () => {
    const html = `<div>Mi respuesta</div><div><br></div>${textToHtml("On Monday, Ana wrote:\n> la pregunta")}`;
    expect(html).toContain("<blockquote");
    const main = withoutTrailingQuote(html);
    expect(main).toContain("Mi respuesta");
    expect(main).not.toContain("la pregunta");
    expect(main).not.toContain("wrote:");
  });

  it("a quote the sender wrote, with no attribution, is what they said", () => {
    expect(withoutTrailingQuote(`<div>As the poem says:</div><blockquote style="${QUOTE_STYLE}">Caminante, no hay camino</blockquote>`)).toBeNull();
  });

  it("an inline reply, a bare forward and mail with no quote have nothing to fold", () => {
    expect(withoutTrailingQuote('<blockquote type="cite">¿Fecha?</blockquote><div>El 3.</div><blockquote type="cite">Gracias</blockquote>')).toBeNull();
    expect(withoutTrailingQuote('<div class="gmail_quote"><div>---------- Forwarded message ---------</div><div>El contrato</div></div>')).toBeNull();
    expect(withoutTrailingQuote("<p>Hola</p>")).toBeNull();
  });
});
