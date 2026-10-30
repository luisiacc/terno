import { CODE_WORDS, LOCALE_IDS } from "@terno/i18n";
import { describe, expect, it } from "vitest";
import { CODE_MAX_AGE, codeFresh, findCode } from "./codes";

const text = (body: string, subject = "Hello") => findCode(subject, body);

describe("verification codes (plan 72)", () => {
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
    expect(findCode("482913 is your Instagram code", "Someone tried code 111222 earlier")).toBe("482913");
    expect(findCode("Your sign-in code", "Hi,\n\nEnter 482913 to continue.\n\nThanks")).toBe("482913");
    // a subject that announces a code still needs exactly one candidate in the body
    expect(findCode("Your sign-in code", "Enter 482913 or 555111")).toBeNull();
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
  });




  // Codex review (plan 72)



  it("doesn't take a code from a reply's or forward's subject", () => {
    expect(findCode("Re: Your verification code 482913", "Thanks, that worked!")).toBeNull();
    expect(findCode("Fwd: Your verification code 482913", "FYI")).toBeNull();
    expect(findCode("RE: Your verification code", "Enter 482913 to continue")).toBeNull();
  });



  it("stays linear on long or hostile text", () => {
    // Codex review round 2: every code against every word was quadratic
    for (const hostile of ["code 123456;".repeat(20_000), " ".repeat(200_000), "1 ".repeat(100_000), `code ${"1 ".repeat(100_000)}`, "<".repeat(200_000)]) {
      const start = performance.now();
      findCode(hostile, hostile);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });

  // Codex review round 4: a list snippet runs the body's lines together
  it("ignores quoted history in a snippet too", () => {
    expect(text("Thanks On Thu, Oct 29, 2026 at 9:00 AM Acme <no-reply@acme.test> wrote: Your code is 111111")).toBeNull();
    expect(text("Gracias El jue, 29 oct 2026 a las 9:00, Acme escribió: Tu código es 111111")).toBeNull();
    expect(text("FYI ---------- Forwarded message --------- Your code is 111111")).toBeNull();
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
