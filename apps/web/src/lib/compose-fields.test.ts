/**
 * What Terno writes into a reply or forward (subject prefix, quote header)
 * follows the language when the draft is created; prefixes already on a
 * subject are recognized in either language.
 */
import { parseAddressList, type Account, type ThreadDetail } from "@terno/core";
import { setLocale, t } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { autoRecipients, convertFields, quoteFor, replyFields, subjectFor } from "./compose-fields";
import { fullDate } from "./format";
import { splitTextQuote } from "./quote";

const when = new Date(2026, 9, 20, 10, 12).getTime();
const yuki = { name: "Yuki", email: "yuki@acme.studio" };
const detail = {
  thread: { id: 7, subject: "Propuesta" },
  messages: [{ id: 3, isSent: false, from: yuki, to: [{ name: "Luis", email: "luis@acme.studio" }], cc: [], subject: "Propuesta", date: when, bodyText: "¿Lo vemos el jueves?\nYuki", snippet: "", attachments: [] }],
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


describe("reply destinations", () => {
  const session = { name: "Support, Session", email: "session@help.test" };
  const list = { name: "List", email: "list@help.test" };
  const other = { name: "Other", email: "other@help.test" };
  const incoming = { ...detail.messages[0]!, from: { name: "No reply", email: "noreply@help.test" }, replyTo: [session, list, { ...session, email: "SESSION@HELP.TEST" }], to: [{ name: "Me", email: "LUIS@ACME.STUDIO" }, list, other], cc: [other, session], bcc: [{ name: "Secret", email: "secret@help.test" }] };
  const thread = { ...detail, messages: [incoming] };

  it.each(["reply", "replyAll"] as const)("%s uses all Reply-To addresses exactly once and keeps quoted commas", (mode) => {
    const draft = replyFields(mode, thread, me);
    expect(parseAddressList(draft.toText)).toEqual([session, list]);
    expect(parseAddressList(draft.ccText)).toEqual(mode === "replyAll" ? [other] : []);
    expect(draft.bccText).toBe("");
    expect(draft.auto).toEqual({ to: ["session@help.test", "list@help.test"], cc: mode === "replyAll" ? ["other@help.test"] : [], bcc: [] });
  });

  it.each(["reply", "replyAll"] as const)("%s excludes the account from a received Reply-To list, including an all-self list", (mode) => {
    expect(autoRecipients(mode, { ...thread, messages: [{ ...incoming, replyTo: [{ name: "Me", email: "LUIS@ACME.STUDIO" }, session] }] }, me.email)).toEqual({ to: [session], cc: mode === "replyAll" ? [list, other] : [] });
    expect(autoRecipients(mode, { ...thread, messages: [{ ...incoming, replyTo: [{ name: "Me", email: "LUIS@ACME.STUDIO" }], to: [], cc: [] }] }, me.email)).toEqual({ to: [], cc: [] });
  });

  it("falls back to From for empty or older missing Reply-To", () => {
    for (const replyTo of [[], undefined]) {
      expect(autoRecipients("reply", { ...thread, messages: [{ ...incoming, replyTo } as unknown as ThreadDetail["messages"][number]] }, me.email)).toEqual({ to: [incoming.from], cc: [] });
    }
  });

  it("continues sent mail to its original To, preserving note-to-self, never Reply-To or Bcc", () => {
    const sent = { ...incoming, isSent: true, from: { name: "Me", email: me.email }, to: [other, { ...other, email: "OTHER@HELP.TEST" }], cc: [other, list, { name: "Me", email: me.email }] };
    expect(autoRecipients("reply", { ...thread, messages: [sent] }, me.email)).toEqual({ to: [other], cc: [] });
    expect(autoRecipients("replyAll", { ...thread, messages: [sent] }, me.email)).toEqual({ to: [other], cc: [list] });
    expect(autoRecipients("reply", { ...thread, messages: [{ ...sent, to: [sent.from] }] }, me.email)).toEqual({ to: [sent.from], cc: [] });
  });

  it("keeps replying to the last received message after an outgoing response", () => {
    const sent = { ...incoming, id: 4, isSent: true, from: { name: "Me", email: me.email }, to: [other], replyTo: [] };
    expect(autoRecipients("reply", { ...thread, messages: [incoming, sent] }, me.email)).toEqual({ to: [session, list], cc: [] });
    expect(replyFields("reply", { ...thread, messages: [incoming, sent] }, me).inReplyToMessageId).toBe(incoming.id);
  });

  it("mode conversion retains typed recipients and deduplicates new automatic destinations", () => {
    const draft = replyFields("reply", thread, me);
    const converted = convertFields({ ...draft, toText: `${draft.toText}, Manual <manual@help.test>`, ccText: "Session <SESSION@HELP.TEST>", bccText: "Private <private@help.test>" }, "replyAll", thread, me);
    expect(parseAddressList(converted.toText)).toEqual([{ name: "Manual", email: "manual@help.test" }, list]);
    expect(parseAddressList(converted.ccText)).toEqual([{ name: "Session", email: "SESSION@HELP.TEST" }, other]);
    expect(parseAddressList(converted.bccText)).toEqual([{ name: "Private", email: "private@help.test" }]);
    const forward = convertFields(converted, "forward", thread, me);
    expect(parseAddressList(forward.toText)).toEqual([{ name: "Manual", email: "manual@help.test" }]);
    expect(parseAddressList(forward.ccText)).toEqual([{ name: "Session", email: "SESSION@HELP.TEST" }]);
    expect(forward.bccText).toBe("Private <private@help.test>");
  });
});
