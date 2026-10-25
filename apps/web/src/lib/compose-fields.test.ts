/**
 * What Terno writes into a reply or forward (subject prefix, quote header)
 * follows the language when the draft is created; prefixes already on a
 * subject are recognized in either language.
 */
import type { Account, ThreadDetail } from "@terno/core";
import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { quoteFor, replyFields, subjectFor } from "./compose-fields";
import { fullDate } from "./format";
import { splitTextQuote } from "./quote";

const when = new Date(2026, 9, 20, 10, 12).getTime();
const yuki = { name: "Yuki", email: "yuki@acme.studio" };
const detail = {
  thread: { id: 7, subject: "Propuesta" },
  messages: [{ id: 3, isSent: false, from: yuki, to: [{ name: "Luis", email: "luis@acme.studio" }], cc: [], subject: "Propuesta", date: when, bodyText: "¿Lo vemos el jueves?\nYuki", snippet: "" }],
} as unknown as ThreadDetail;
const me = { id: 1, email: "luis@acme.studio" } as Account;

afterEach(() => setLocale("en", en));

describe("subjects", () => {
  it("adds Re: and Fwd: in both languages", () => {
    expect(subjectFor("reply", "Propuesta")).toBe("Re: Propuesta");
    expect(subjectFor("forward", "Propuesta")).toBe("Fwd: Propuesta");
    expect(subjectFor("new", "Propuesta")).toBe("");
    setLocale("es", es);
    expect(subjectFor("replyAll", "Propuesta")).toBe("Re: Propuesta");
    expect(subjectFor("forward", "Propuesta")).toBe("Fwd: Propuesta");
  });

  it("never doubles a prefix already there, whichever language wrote it", () => {
    for (const s of ["Re: x", "RE: x", "re: x"]) expect(subjectFor("reply", s)).toBe(s);
    for (const s of ["Fwd: x", "FW: x", "Fw: x", "RV: x", "Reenv: x"]) expect(subjectFor("forward", s)).toBe(s);
    // a reply to a forward is still a reply
    expect(subjectFor("reply", "RV: x")).toBe("Re: RV: x");
  });
});

describe("quote headers", () => {
  it("English: “On …, Yuki wrote:” and a forwarded-message block, dated in English", () => {
    const reply = quoteFor("reply", detail);
    expect(reply).toBe(`On ${fullDate(when)}, Yuki wrote:\n> ¿Lo vemos el jueves?\n> Yuki`);
    expect(fullDate(when)).toContain("Oct 20, 2026");
    expect(quoteFor("forward", detail)).toBe(
      `---------- Forwarded message ----------\nFrom: Yuki <yuki@acme.studio>\nDate: ${fullDate(when)}\nSubject: Propuesta\nTo: Luis <luis@acme.studio>\n\n¿Lo vemos el jueves?\nYuki`,
    );
  });

  it("Spanish: the headers Terno always wrote, dated in Spanish", () => {
    setLocale("es", es);
    expect(fullDate(when)).toBe("mar, 20 oct 2026, 10:12");
    expect(quoteFor("reply", detail)).toBe("El mar, 20 oct 2026, 10:12, Yuki escribió:\n> ¿Lo vemos el jueves?\n> Yuki");
    expect(quoteFor("forward", detail)).toBe(
      "---------- Mensaje reenviado ----------\nDe: Yuki <yuki@acme.studio>\nFecha: mar, 20 oct 2026, 10:12\nAsunto: Propuesta\nPara: Luis <luis@acme.studio>\n\n¿Lo vemos el jueves?\nYuki",
    );
  });

  it("a draft keeps the language it was created in", () => {
    setLocale("es", es);
    const draft = replyFields("reply", detail, me);
    setLocale("en", en);
    expect(draft.quotedText).toMatch(/^El .* escribió:/);
    expect(draft.subject).toBe("Re: Propuesta");
  });

  it("the reader folds the history Terno wrote, in either language", () => {
    for (const locale of ["en", "es"] as const) {
      setLocale(locale, locale === "es" ? es : en);
      const sent = `Perfecto.\n\n${quoteFor("reply", detail)}`;
      expect(splitTextQuote(sent)).toEqual({ main: "Perfecto.", quoted: quoteFor("reply", detail) });
    }
  });
});

describe("drafts strip copy", () => {
  it("counts drafts and extra recipients in both languages", () => {
    expect(t("compose.strip.more", { count: 1 })).toBe("+1 draft");
    expect(t("compose.strip.more", { count: 4 })).toBe("+4 drafts");
    expect(t("compose.strip.andMore", { name: "Ana", count: 2 })).toBe("Ana and 2 more");
    setLocale("es", es);
    expect(t("compose.strip.more", { count: 1 })).toBe("+1 borrador");
    expect(t("compose.strip.more", { count: 4 })).toBe("+4 borradores");
    expect(t("compose.strip.andMore", { name: "Ana", count: 2 })).toBe("Ana y 2 más");
  });
});
