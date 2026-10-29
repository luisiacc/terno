import { CODE_WORDS, LOCALE_IDS } from "@terno/i18n";
import { describe, expect, it } from "vitest";
import { CODE_MAX_AGE, codeFresh, findCode, htmlText } from "./codes";

const text = (body: string, subject = "Hello") => findCode(subject, body, null);
const html = (body: string, subject = "Hello") => findCode(subject, null, body);

describe("verification codes (plan 69)", () => {
  it("finds six digits next to a word that announces them, in English and Spanish", () => {
    expect(text("Your verification code is 482913.")).toBe("482913");
    expect(text("Code: 482913")).toBe("482913");
    expect(text("Use 482913 as your passcode")).toBe("482913");
    expect(text("Your OTP is 482913")).toBe("482913");
    expect(text("Tu código de verificación es 482913")).toBe("482913");
    expect(text("TU CÓDIGO: 482913")).toBe("482913");
    expect(text("Tu codigo es 482913")).toBe("482913");
    expect(text("Ingresa tu clave de verificación 482913")).toBe("482913");
    expect(text("Your code is\n\n482913\n\nIt expires in 10 minutes.")).toBe("482913");
  });

  it("reads codes split 3+3 or one digit per box, and gives them back without separators", () => {
    expect(text("Your code: 482 913")).toBe("482913");
    expect(text("Your code: 482-913")).toBe("482913");
    expect(text("Your code: 0 4 8 2 9 1")).toBe("048291");
  });

  it("keeps leading zeros", () => {
    expect(text("code 012345")).toBe("012345");
  });

  it("looks at the subject first", () => {
    expect(findCode("482913 is your Instagram code", "Someone tried code 111222 earlier", null)).toBe("482913");
    expect(findCode("Your sign-in code", "Hi,\n\nEnter 482913 to continue.\n\nThanks", null)).toBe("482913");
    // a subject that announces a code still needs exactly one candidate in the body
    expect(findCode("Your sign-in code", "Enter 482913 or 555111", null)).toBeNull();
  });

  it("takes the code closest to its word", () => {
    expect(text("Order 777888 shipped. Your security code is 482913.")).toBe("482913");
  });

  it("needs a word that announces it, close enough", () => {
    expect(text("Your order 482913 has shipped.")).toBeNull();
    expect(text(`code${" lorem".repeat(40)} 482913`)).toBeNull();
    expect(text("Codes and decoder rings: 482913")).toBeNull();
    expect(text("La clave del éxito: 482913")).toBeNull();
  });

  it("is not fooled by other six-digit numbers", () => {
    expect(text("code 12345")).toBeNull();
    expect(text("code 1234567")).toBeNull();
    expect(text("Promo code: $123456")).toBeNull();
    expect(text("code: 123,456.00")).toBeNull();
    expect(text("code: 12.123456")).toBeNull();
    expect(text("code: 123456.78")).toBeNull();
    expect(text("Call +1 650 253 0000 for your code")).toBeNull();
    expect(text("Your code expires 2026/10/29")).toBeNull();
    expect(text("code: 123456/789")).toBeNull();
    expect(text("code: #123456")).toBeNull();
    expect(text("code: A123456")).toBeNull();
    expect(text("code: 123456A")).toBeNull();
    expect(text("code: 123456%")).toBeNull();
    expect(text("Use code at 12:30:45")).toBeNull();
  });

  it("ignores codes inside links", () => {
    expect(text("Verify: https://example.com/verify?code=482913")).toBeNull();
  });

  it("ignores quoted mail, so a reply never brings an old code back", () => {
    expect(text("Thanks, that worked!\n\nOn Tue, Oct 28, 2026 at 9:00 AM Bank <no-reply@bank.test> wrote:\n> Your code is 482913")).toBeNull();
    expect(text("Thanks!\n> Your code is 482913")).toBeNull();
    expect(html("<p>Thanks!</p><blockquote><p>Your code is 482913</p></blockquote>")).toBeNull();
  });

  it("reads HTML as it is shown: the word in a <code> tag is not the word", () => {
    expect(html("<code>x = 482913</code>")).toBeNull();
    expect(html('<p class="code">Order 482913</p>')).toBeNull();
    expect(html("<style>.code { color: #123456 }</style><p>Hi 482913</p>")).toBeNull();
    expect(html('<a href="https://x.test/?code=482913">Verify</a>')).toBeNull();
  });

  it("finds codes in typical HTML templates", () => {
    expect(html("<table><tr><td>Your verification code</td></tr><tr><td><strong>482913</strong></td></tr></table>")).toBe("482913");
    expect(html("<p>Your code is<b>482913</b></p>")).toBe("482913");
    expect(html("<p>Code: <span>482</span><span>913</span></p>")).toBe("482913");
    expect(html("<p>Your code</p>\n<table><tr>\n  <td>4</td>\n  <td>8</td>\n  <td>2</td>\n  <td>9</td>\n  <td>1</td>\n  <td>3</td>\n</tr></table>")).toBe("482913");
    expect(html("<p>Tu código&nbsp;es&nbsp;482913</p>")).toBe("482913");
    expect(html("<p>C&#243;digo: 482913</p>")).toBe("482913");
  });

  it("prefers the HTML the reader shows over the plain-text alternative", () => {
    expect(findCode("Hi", "Your code is 111222", "<p>Your code is 482913</p>")).toBe("482913");
  });

  // Codex review (plan 69)
  it("never reads hidden HTML: the code shown is the one copied", () => {
    expect(html('<div style="display:none">code 111222.</div><p>Your code is 482913.</p>')).toBe("482913");
    expect(html('<span style="font-size: 0px">code 111222</span><p>Your code is 482913.</p>')).toBe("482913");
    expect(html("<div hidden>code 111222</div><p>Your code is 482913.</p>")).toBe("482913");
    expect(html('<div style="display:none"><div>code 111222</div></div><p>Your code is 482913.</p>')).toBe("482913");
  });

  it("skips nested quotes whole", () => {
    expect(html("<p>Thanks!</p><blockquote><blockquote>Older message</blockquote><p>Your code is 482913.</p></blockquote>")).toBeNull();
  });

  it("decodes named entities before matching", () => {
    expect(html("<p>Tu c&oacute;digo: 482913</p>")).toBe("482913");
    expect(html("<p>Your code: &pound;123456</p>")).toBeNull();
    expect(html("<p>Your code: &euro;123456</p>")).toBeNull();
  });

  it("doesn't take a code from a reply's or forward's subject", () => {
    expect(findCode("Re: Your verification code 482913", "Thanks, that worked!", null)).toBeNull();
    expect(findCode("Fwd: Your verification code 482913", "FYI", null)).toBeNull();
    expect(findCode("RE: Your verification code", "Enter 482913 to continue", null)).toBeNull();
  });

  it("stays linear on hostile HTML", () => {
    for (const hostile of [" ".repeat(200_000), "<".repeat(200_000), "<a".repeat(100_000), "<a>".repeat(66_000), "<blockquote>".repeat(16_000), "&".repeat(200_000), "<!--".repeat(50_000), "1 ".repeat(100_000), `code ${"1 ".repeat(100_000)}`]) {
      const start = performance.now();
      findCode("Hi", null, hostile);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });

  it("htmlText drops what isn't shown", () => {
    expect(htmlText("<head><title>code</title></head><script>code 1</script><!-- code --><p>Hi</p>").trim()).toBe("Hi");
  });

  it("has words for every language Terno ships", () => {
    for (const id of LOCALE_IDS) expect(CODE_WORDS[id].length).toBeGreaterThan(0);
  });
});

describe("fresh codes", () => {
  const now = Date.UTC(2026, 9, 29, 12);
  it("are at most two hours old", () => {
    expect(codeFresh(now, now)).toBe(true);
    expect(codeFresh(now - CODE_MAX_AGE, now)).toBe(true);
    expect(codeFresh(now - CODE_MAX_AGE - 1, now)).toBe(false);
  });
  it("allow a few minutes of the sender's clock running ahead, no more", () => {
    expect(codeFresh(now + 60_000, now)).toBe(true);
    expect(codeFresh(now + 3_600_000, now)).toBe(false);
    expect(codeFresh(Number.NaN, now)).toBe(false);
  });
});
