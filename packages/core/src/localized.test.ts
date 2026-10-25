import { L, setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { decodeText, encodeText, messageOf, textRef } from "./localized";
import { customThemeSchema, customThemesSchema } from "./themes";

afterEach(() => setLocale("en", en));

describe("catalog messages from the backend", () => {
  it("textRef keeps the key and params of an L() message, nothing for plain text", () => {
    expect(textRef(L("errors.alreadyOwner", { email: "a@b.mx" }))).toEqual({ key: "errors.alreadyOwner", params: { email: "a@b.mx" } });
    expect(textRef(L("errors.ai.off"))).toEqual({ key: "errors.ai.off" });
    expect(textRef("plain")).toBeUndefined();
    expect(textRef({ key: "x", params: { a: {} } })).toBeUndefined();
  });

  it("messageOf: an error's message with its reference, so wrapping keeps the language", () => {
    const e = Object.assign(new Error("AI is turned off."), { i18n: { key: "errors.ai.off" } });
    expect(messageOf(e)).toEqual({ key: "errors.ai.off", message: "AI is turned off." });
    expect(messageOf(new Error("ECONNRESET"))).toBe("ECONNRESET");
    expect(messageOf("oops")).toBe("oops");
    expect(messageOf(Object.assign(new Error("x"), { i18n: "not a ref" }))).toBe("x");
  });

  it("a catalog message survives a free-text column; plain text, and text that only looks like JSON, stays as it is", () => {
    const m = L("errors.smtp.notDeliveredTo", { recipients: "a@b.mx" });
    const stored = encodeText(m);
    expect(decodeText(stored)).toEqual({ message: "Not delivered to: a@b.mx", i18n: { key: "errors.smtp.notDeliveredTo", params: { recipients: "a@b.mx" } } });
    expect(decodeText(encodeText(L("errors.gmail.revoked")))).toEqual({ message: "Gmail access was revoked; reconnect the account.", i18n: { key: "errors.gmail.revoked" } });
    expect(encodeText("IMAP: Mailbox is full")).toBe("IMAP: Mailbox is full");
    expect(decodeText("IMAP: Mailbox is full")).toEqual({ message: "IMAP: Mailbox is full" });
    expect(decodeText('{"key": broken')).toEqual({ message: '{"key": broken' });
    expect(decodeText('{"key":"x"}')).toEqual({ message: '{"key":"x"}' });
  });
});

describe("theme validation messages", () => {
  it("are built when a check fails, in the active language", () => {
    const valid = { id: "mi-tema", name: "Mi tema", mode: "light", extends: "terno-light", tokens: { primary: "#ff0000" } };
    const issue = (v: unknown) => customThemeSchema.safeParse(v).error?.issues[0]?.message;
    expect(issue({ ...valid, tokens: { primary: "red" } })).toBe("Invalid color: use #rrggbb or oklch(L C H)");
    expect(issue({ ...valid, tokens: {} })).toBe("The theme doesn’t change any color");
    expect(customThemesSchema.safeParse([valid, valid]).error?.issues[0]?.message).toBe("Repeated theme ids");
    setLocale("es", es);
    expect(issue({ ...valid, tokens: { primary: "red" } })).toBe("Color no válido: usa #rrggbb u oklch(L C H)");
    expect(issue({ ...valid, id: "Mi Tema" })).toBe("El id solo admite a-z, 0-9 y guiones (máx. 40)");
    expect(issue({ ...valid, extends: "terno-dark" })).toBe("El tema base debe ser del mismo modo");
    expect(customThemesSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ ...valid, id: `t${i}` }))).error?.issues[0]?.message).toBe("Máximo 20 temas");
  });
});
