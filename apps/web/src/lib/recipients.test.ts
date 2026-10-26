/**
 * Recipient fields (plan 18): the token at the caret, an accepted suggestion
 * in its place (written so it parses back as one recipient), pasted lists,
 * and the highlight of what was typed. Plus what the phrase model learns
 * from what Terno itself sends: only what the user wrote, in both languages.
 */
import type { Account, ThreadDetail } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { fold } from "@terno/store/fold";
import { ownText } from "@terno/store/autocomplete";
import { afterEach, describe, expect, it } from "vitest";
import { quoteFor } from "./compose-fields";
import { sendBody } from "./drafts";
import { validRecipients } from "./drafts";
import { chipLabel, chipName, chipNoReply, commit, derive, edit, EMPTY, firstInvalid, insert, remove, serialize, type FieldState } from "./recipient-field";
import { emailsIn, highlight, pastedAddresses, tokenAt } from "./recipients";

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

describe("the field's text", () => {
  it("emailsIn lists the addresses of a field, lowercased", () => {
    expect(emailsIn('Ana <ANA@x.io>, "B, C" <b@y.io>, unfinished')).toEqual(["ana@x.io", "b@y.io"]);
  });
});

describe("pasting a list", () => {
  it("parses separators, newlines, mailto: and Name <addr>, and leaves an ordinary paste alone", () => {
    expect(pastedAddresses("ana@x.io; Bob <bob@y.io>\nmailto:carla@z.io")).toEqual([
      { name: "", email: "ana@x.io" },
      { name: "Bob", email: "bob@y.io" },
      { name: "", email: "carla@z.io" },
    ]);
    expect(pastedAddresses("Bob Stone <bob@stone.io>")).toEqual([{ name: "Bob Stone", email: "bob@stone.io" }]);
    expect(pastedAddresses("Ana López")).toBeNull();
    expect(pastedAddresses("ana@x.io")).toBeNull();
    expect(pastedAddresses("not, addresses")).toBeNull();
  });

  it("keeps what isn't an address beside what is (Codex review 8): two recipients, Bob's to fix", () => {
    expect(pastedAddresses("ana@example.com; bob@")).toEqual([
      { name: "", email: "ana@example.com" },
      { name: "", email: "bob@" },
    ]);
  });
});

/** The field's text after a state, read back as a reload would (unfocused). */
const reread = (s: FieldState) => derive(serialize(s), false);
const emailsOf = (s: FieldState) => s.chips.map((c) => c.address.email);

describe("chips (plan 29)", () => {
  it("reads a field's text: unfocused everything is a chip; focused, an entry with no separator after it is still being typed", () => {
    const value = 'Ana <ana@x.io>, "Pérez, Luis" <l@y.com>, bo';
    expect(emailsOf(derive(value, false))).toEqual(["ana@x.io", "l@y.com", "bo"]);
    const typing = derive(value, true);
    expect(emailsOf(typing)).toEqual(["ana@x.io", "l@y.com"]);
    expect(typing.text).toBe("bo");
    expect(serialize(typing)).toBe(value);
    expect(derive("", true)).toEqual({ chips: [], text: "", at: 0 });
  });

  it("commits what was typed: several at once, cleaned like a paste, a duplicate not twice, what isn't an address kept", () => {
    let s = derive("Ana <ana@x.io>", true);
    s = commit({ ...s, text: "bob@y.io carla@z.io" }).state;
    expect(emailsOf(s)).toEqual(["ana@x.io", "bob@y.io", "carla@z.io"]);
    const dup = commit({ ...s, text: "ANA@x.io" });
    expect(dup.added).toEqual([]);
    expect(emailsOf(dup.state)).toEqual(["ana@x.io", "bob@y.io", "carla@z.io"]);
    const smart = commit({ ...s, text: "“Dan” <dan@w.io>" }).state;
    expect(smart.chips.at(-1)!.address).toEqual({ name: "Dan", email: "dan@w.io" });
    const bad = commit({ ...s, text: "esto no es un correo" }).state;
    expect(bad.chips.at(-1)!.valid).toBe(false);
    expect(firstInvalid(serialize(bad))).toBe("esto no es un correo");
  });

  it("an invalid chip round-trips as itself through the draft's text, never as something sendable (Codex review 2)", () => {
    const s = commit({ ...EMPTY, text: '"a@x.com, b@x.com"' }).state;
    expect(s.chips).toHaveLength(1);
    expect(s.chips[0]!.valid).toBe(false);
    const back = reread(insert(s, [{ name: "Ana", email: "ana@x.io" }]).state);
    expect(back.chips.map((c) => [c.address.email, c.valid])).toEqual([
      ["a@x.com, b@x.com", false],
      ["ana@x.io", true],
    ]);
    expect(validRecipients(serialize(back)).map((a) => a.email)).toEqual(["ana@x.io"]);
  });

  it("insert: at the commit place, without what this field or the others have", () => {
    const s = derive("a@x.io, c@x.io", false);
    const r = insert({ ...s, at: 1 }, [{ name: "B", email: "b@x.io" }, { name: "", email: "A@X.IO" }, { name: "", email: "d@x.io" }], ["d@x.io"]);
    expect(emailsOf(r.state)).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
    expect(r.added.map((a) => a.email)).toEqual(["b@x.io"]);
  });

  it("remove and edit: an edited chip turns into text and goes back to its place", () => {
    const s = derive("a@x.io, Bob <b@x.io>, c@x.io", false);
    const [a, b] = s.chips;
    expect(emailsOf(remove(s, new Set([a!.key])))).toEqual(["b@x.io", "c@x.io"]);
    const editing = edit(s, b!.key);
    expect(editing).toMatchObject({ text: "Bob <b@x.io>", at: 1 });
    expect(emailsOf(editing)).toEqual(["a@x.io", "c@x.io"]);
    const back = commit({ ...editing, text: "Bobby <b@x.io>" }).state;
    expect(back.chips.map((c) => c.address.name || c.address.email)).toEqual(["a@x.io", "Bobby", "c@x.io"]);
    expect(back.at).toBe(3);
  });

  it("labels, names for screen readers, the no-reply hint", () => {
    const [named, bare, noreply] = derive("Björn Peña <bjorn.pena@acme.studio>, ana@x.io, no-reply@shop.com", false).chips;
    expect([chipLabel(named!), chipName(named!)]).toEqual(["Björn Peña", "Björn Peña, bjorn.pena@acme.studio"]);
    expect([chipLabel(bare!), chipName(bare!)]).toEqual(["ana@x.io", "ana@x.io"]);
    expect([chipNoReply(named!), chipNoReply(noreply!)]).toEqual([false, true]);
  });

  it("200 recipients read, commit and write in linear time", () => {
    const value = Array.from({ length: 2000 }, (_, i) => `Persona ${i} <p${i}@x.io>`).join(", ");
    const started = performance.now();
    const s = derive(value, true);
    const next = commit({ ...s, text: "new@x.io" }).state;
    expect(serialize(next).length).toBeGreaterThan(value.length);
    expect(performance.now() - started).toBeLessThan(250);
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
