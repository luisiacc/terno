/**
 * Recipient fields (plan 18): the token at the caret, an accepted suggestion
 * in its place (written so it parses back as one recipient), pasted lists,
 * and the highlight of what was typed. Plus what the phrase model learns
 * from what Terno itself sends: only what the user wrote, in both languages.
 */
import { parseAddressList, type Account, type ThreadDetail } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { fold } from "@terno/store/fold";
import { ownText } from "@terno/store/autocomplete";
import { afterEach, describe, expect, it } from "vitest";
import { quoteFor } from "./compose-fields";
import { sendBody } from "./drafts";
import { acceptAt, emailsIn, highlight, insertPasted, pastedAddresses, pasteInto, tokenAt } from "./recipients";

afterEach(() => setLocale("en", en));

describe("the token at the caret", () => {
  it("is the address being typed, between separators outside quotes and brackets", () => {
    const text = '"Pérez, Luis" <l@y.com>, an';
    expect(tokenAt(text, text.length)).toEqual({ start: 24, end: text.length, query: "an" });
    // a chosen recipient: nothing to complete
    expect(tokenAt(text, 5).query).toBe("");
    expect(tokenAt("ana@x.io; bo, cy", 11)).toEqual({ start: 9, end: 12, query: "bo" });
    expect(tokenAt("", 0).query).toBe("");
  });
});

describe("accepting a suggestion", () => {
  it("replaces the token, quotes names that need it, and leaves the caret after a separator", () => {
    const r = acceptAt("ana@x.io, pe", tokenAt("ana@x.io, pe", 12), { name: "Pérez, Luis", email: "l@y.com" });
    expect(r.text).toBe('ana@x.io, "Pérez, Luis" <l@y.com>, ');
    expect(r.caret).toBe(r.text.length);
    // it parses back as two recipients, the comma in the name included
    expect(parseAddressList(r.text)).toEqual([
      { name: "", email: "ana@x.io" },
      { name: "Pérez, Luis", email: "l@y.com" },
    ]);
  });

  it("in the middle of the field, keeps what follows", () => {
    const text = "bo, carla@x.io";
    const r = acceptAt(text, tokenAt(text, 2), { name: "Bob Stone", email: "bob@stone.io" });
    expect(r.text).toBe("Bob Stone <bob@stone.io>, carla@x.io");
    expect(r.caret).toBe("Bob Stone <bob@stone.io>, ".length);
  });

  it("emailsIn lists the addresses of a field, lowercased", () => {
    expect(emailsIn('Ana <ANA@x.io>, "B, C" <b@y.io>, unfinished')).toEqual(["ana@x.io", "b@y.io"]);
  });
});

describe("pasting a list", () => {
  it("parses separators, newlines and mailto:, and leaves an ordinary paste alone", () => {
    expect(pastedAddresses("ana@x.io; Bob <bob@y.io>\nmailto:carla@z.io")).toEqual([
      { name: "", email: "ana@x.io" },
      { name: "Bob", email: "bob@y.io" },
      { name: "", email: "carla@z.io" },
    ]);
    expect(pastedAddresses("Ana López")).toBeNull();
    expect(pastedAddresses("ana@x.io")).toBeNull();
    expect(pastedAddresses("not, addresses")).toBeNull();
  });

  it("inserts formatted, skipping addresses already in the draft", () => {
    const r = insertPasted("ana@x.io", 8, 8, [{ name: "Bob", email: "bob@y.io" }, { name: "", email: "ANA@x.io" }, { name: "", email: "carla@z.io" }], ["ana@x.io"]);
    expect(r.text).toBe("ana@x.io, Bob <bob@y.io>, carla@z.io, ");
    expect(r.caret).toBe(r.text.length);
  });
});

describe("pasting over a selection (codex review)", () => {
  it("doesn't drop an address the paste replaces; still skips what stays and the other fields", () => {
    const text = "Ana <ana@x.io>";
    expect(pasteInto(text, 0, text.length, pastedAddresses("mailto:ana@x.io")!.concat(), []).text).toBe("ana@x.io, ");
    expect(pasteInto(text, 0, text.length, [{ name: "", email: "ana@x.io" }, { name: "", email: "bob@y.io" }], ["Bob <bob@y.io>"]).text).toBe("ana@x.io, ");
    const two = "Ana <ana@x.io>, carla@z.io";
    expect(pasteInto(two, 0, 14, [{ name: "", email: "CARLA@z.io" }, { name: "", email: "dan@w.io" }], []).text).toBe("dan@w.io, carla@z.io");
  });
});

describe("highlight", () => {
  it("marks word starts that match what was typed, ignoring case and diacritics", () => {
    expect(highlight("Ana Martínez", "mart", fold)).toEqual([
      { text: "Ana ", match: false },
      { text: "Mart", match: true },
      { text: "ínez", match: false },
    ]);
    expect(highlight("José Núñez", "nun", fold)).toEqual([
      { text: "José ", match: false },
      { text: "Núñ", match: true },
      { text: "ez", match: false },
    ]);
    expect(highlight("ana.martinez@acme.studio", "acme", fold).find((r) => r.match)?.text).toBe("acme");
    expect(highlight("Banana", "ana", fold)).toEqual([{ text: "Banana", match: false }]);
  });
});

describe("what the phrase model learns from mail Terno sent", () => {
  const when = new Date(2026, 9, 20, 10, 12).getTime();
  const detail = {
    thread: { id: 7, subject: "Propuesta" },
    messages: [{ id: 3, isSent: false, from: { name: "Yuki", email: "yuki@acme.studio" }, to: [{ name: "Luis", email: "luis@acme.studio" }], cc: [], subject: "Propuesta", date: when, bodyText: "The received text that must never be learned.\nYuki", snippet: "" }],
  } as unknown as ThreadDetail;
  void ({ id: 1 } as Account);

  for (const [lang, catalog] of [
    ["en", en],
    ["es", es],
  ] as const) {
    it(`keeps only what the user wrote in a reply and a forward (${lang})`, () => {
      setLocale(lang, catalog);
      for (const mode of ["reply", "forward"] as const) {
        const body = sendBody({ bodyText: "Sounds good, thanks.", quotedText: quoteFor(mode, detail), includeQuote: true }, "Luis Cordero\nAcme");
        expect(ownText(body).trim(), `${lang} ${mode}`).toBe("Sounds good, thanks.");
      }
      // without a signature too
      expect(ownText(sendBody({ bodyText: "Ok.", quotedText: quoteFor("forward", detail), includeQuote: true })).trim()).toBe("Ok.");
    });
  }
});
