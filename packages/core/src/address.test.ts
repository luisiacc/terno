import { describe, expect, it } from "vitest";
import { asciiEmail, cleanName, formatAddress, formatAddressList, isNoReply, isValidEmail, parseAddressHeader, parseAddressList, repairAddress, repairAddresses, storedAddresses } from "./address";
import { decodeEncodedWords, repairMojibake, repairOrphans } from "./encoded-words";
import type { Address } from "./types";

const A = (name: string, email: string): Address => ({ name, email });
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("addresses", () => {
  it("a display name containing an address and a comma can't inject a recipient", () => {
    const sender = { name: "leak@attacker.example, Support", email: "support@company.example" };
    const formatted = formatAddressList([sender]);
    expect(formatted).toBe('"leak@attacker.example, Support" <support@company.example>');
    expect(parseAddressList(formatted)).toEqual([sender]);
    // nor when it arrives in a header, nor when it was stored like that: no brackets, no evidence of a swallowed list
    expect(parseAddressHeader(formatted)).toEqual([sender]);
    expect(repairAddresses([sender])).toEqual([sender]);
  });

  it("round-trips names with quotes, commas and accents", () => {
    const list = [
      { name: 'Pérez, "Lucho"', email: "luis@x.mx" },
      { name: "Ana", email: "ana@y.com" },
      { name: "", email: "bob@z.com" },
    ];
    expect(parseAddressList(formatAddressList(list))).toEqual(list);
  });

  it("parses typical hand-typed input", () => {
    expect(parseAddressList("ana@y.com; Bob <bob@z.com>\n, ,")).toEqual([
      { name: "", email: "ana@y.com" },
      { name: "Bob", email: "bob@z.com" },
    ]);
  });
});

describe("parseAddressList: typed and pasted text (plan 34)", () => {
  it.each<[string, Address[]]>([
    ["Ana Torres ana@x.com", [A("Ana Torres", "ana@x.com")]],
    ["a@x.com b@y.com", [A("", "a@x.com"), A("", "b@y.com")]],
    ["Ana <a@x.com> Bob <b@y.com>", [A("Ana", "a@x.com"), A("Bob", "b@y.com")]],
    ["mailto:m@x.com", [A("", "m@x.com")]],
    ["<mailto:m@x.com>, <<d@x.com>>", [A("", "m@x.com"), A("", "d@x.com")]],
    ["bob@", [A("", "bob@")]],
    ["esto no es un correo", [A("", "esto no es un correo")]],
    ["Ana <ana@x", [A("Ana", "ana@x")]],
    ['"Unbalanced <u@x.com>, b@x.com', [A("Unbalanced", "u@x.com"), A("", "b@x.com")]],
    ["Team: a@x.com, b@y.com;", [A("", "a@x.com"), A("", "b@y.com")]],
    ["jane@x.com (Jane Doe)", [A("Jane Doe", "jane@x.com")]],
    ["Ana (Acme) <ana@acme.com>", [A("Ana (Acme)", "ana@acme.com")]],
    ["Ana <ana@x.com> extra", [A("Ana", "ana@x.com"), A("", "extra")]],
  ])("%s", (input, expected) => {
    expect(parseAddressList(input)).toEqual(expected);
  });

  it("doesn't decode encoded words someone typed (only headers carry them)", () => {
    expect(parseAddressList("=?UTF-8?Q?Ana?= <a@x.com>")).toEqual([A("=?UTF-8?Q?Ana?=", "a@x.com")]);
  });
});

/** The user's report, verbatim: what a broken client wrote, and what an older parser stored from it. */
const USER_HEADER = '"=?utf-8?Q?Jos=C3=A9?=_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina" <lmedina@sucre.net>';
const USER_STORED = A("_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", "lmedina@sucre.net");

describe("parseAddressHeader: what other clients write (plan 34 §3.6)", () => {
  it.each<[string, string, Address[]]>([
    ["1 the user's mangled Cc", USER_HEADER, [A("José David Sucre L.", "david@sucre.net"), A("Luis Alberto Medina", "lmedina@sucre.net")]],
    ["4 an encoded word without its end", "=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez <jp@x.com>", [A("José Pérez", "jp@x.com")]],
    ["5 adjacent words, UTF-8 split between them", "=?UTF-8?Q?Jos=C3?= =?UTF-8?Q?=A9?= <jp@x.com>", [A("José", "jp@x.com")]],
    ["5 mixed Q and B", "=?UTF-8?B?w4FuZ2Vs?= =?UTF-8?Q?_P=C3=A9rez?= <ap@x.com>", [A("Ángel Pérez", "ap@x.com")]],
    ["6 windows-1252", "=?windows-1252?Q?Fran=E7ois?= <fr@x.com>", [A("François", "fr@x.com")]],
    ["6 iso-8859-1", "=?iso-8859-1?Q?Jos=E9?= <j@x.com>", [A("José", "j@x.com")]],
    ["6 gb2312", "=?gb2312?B?1tDOxA==?= <cn@x.com>", [A("中文", "cn@x.com")]],
    ["6 ks_c_5601-1987", "=?ks_c_5601-1987?B?wMy788fP?= <kr@x.com>", [A("이상하", "kr@x.com")]],
    ["6 an unknown charset: UTF-8, then Latin-1", "=?x-unknown?Q?Jos=E9?= <j@x.com>, =?x-unknown?Q?Jos=C3=A9?= <k@x.com>", [A("José", "j@x.com"), A("José", "k@x.com")]],
    ["6 UTF-8 that is really Latin-1", "=?utf-8?Q?Jos=E9?= <j@x.com>", [A("José", "j@x.com")]],
    ["7 RFC 2231 language", "=?UTF-8*es?Q?Jos=C3=A9?= <j@x.com>", [A("José", "j@x.com")]],
    ["8 an encoded word inside quotes", '"=?UTF-8?Q?Jos=C3=A9?= Pérez" <jp@x.com>', [A("José Pérez", "jp@x.com")]],
    ["10 mojibake", "JosÃ© PÃ©rez <jp@x.com>", [A("José Pérez", "jp@x.com")]],
    ["11 a comma inside quotes", '"Medina, Luis" <l@x.com>', [A("Medina, Luis", "l@x.com")]],
    ["12 an unbalanced quote", '"Unbalanced <u@x.com>, b@x.com', [A("Unbalanced", "u@x.com"), A("", "b@x.com")]],
    ["13 smart and single quotes", "“Smart” <s@x.com>, 'Ana Torres' <a@x.com>", [A("Smart", "s@x.com"), A("Ana Torres", "a@x.com")]],
    ["14 escaped quotes", '"Esc \\"q\\"" <e@x.com>', [A('Esc "q"', "e@x.com")]],
    ["15 the name is the address", '"ANA@x.com" <ana@x.com>, \'b@x.com\' <b@x.com>', [A("", "ana@x.com"), A("", "b@x.com")]],
    ["17 an empty group", "undisclosed-recipients:;", []],
    ["18 a group", "Team: a@x.com, b@y.com;, c@z.com", [A("", "a@x.com"), A("", "b@y.com"), A("", "c@z.com")]],
    ["19 comments as names", "(Jane Doe) jane@x.com, john@x.com (John), Ann <ann@x.com> (work)", [A("Jane Doe", "jane@x.com"), A("John", "john@x.com"), A("Ann", "ann@x.com")]],
    ["20 a source route", "<@relay.x,@r2.y:user@x.com>", [A("", "user@x.com")]],
    ["21 no brackets", "Ana Torres ana@x.com, bob@x.com", [A("Ana Torres", "ana@x.com"), A("", "bob@x.com")]],
    ["22 double brackets, mailto", "<<d@x.com>>, Ana <mailto:ana@x.com>, mailto:m@x.com, “Smart” <s@x.com>", [A("", "d@x.com"), A("Ana", "ana@x.com"), A("", "m@x.com"), A("Smart", "s@x.com")]],
    ["23 Outlook's [mailto:]", "Outlook User [mailto:ol@x.com] <ol@x.com>", [A("Outlook User", "ol@x.com")]],
    ["24 folded", '"Ana\r\n Torres" <ana@x.com>,\r\n\tBob <bob@x.com>', [A("Ana Torres", "ana@x.com"), A("Bob", "bob@x.com")]],
    ["25 a trailing dot", "<a@x.com.>", [A("", "a@x.com")]],
    ["26 the same address twice", "B <B@X.COM>, b@x.com", [A("B", "B@X.COM")]],
    ["28 bidi and zero-width characters", '"\u{202E}gnp.exe\u{200B}" <b@x.com>', [A("gnp.exe", "b@x.com")]],
    ["35 a 2 KB name", `"${"N".repeat(2048)}" <n@x.com>`, [A("N".repeat(256), "n@x.com")]],
    ["a name that is another address", '"boss@corp.com" <attacker@evil.com>', [A("", "attacker@evil.com")]],
    ["a semicolon list (Outlook)", 'a@x.com; b@x.com; "C D" <c@x.com>', [A("", "a@x.com"), A("", "b@x.com"), A("C D", "c@x.com")]],
    ["IDN", "Ünï <user@bücher.de>, <user@xn--bcher-kva.de>", [A("Ünï", "user@bücher.de"), A("", "user@xn--bcher-kva.de")]],
  ])("%s", (_, header, expected) => {
    expect(parseAddressHeader(header)).toEqual(expected);
  });

  it("3 an encoded word can't become the sender's address (the Mailsploit class): structure first, then decoding", () => {
    const spoof = `=?UTF-8?B?${b64("boss@corp.com <boss@corp.com>")}?= <attacker@evil.com>`;
    expect(parseAddressHeader(spoof, { single: true })).toEqual([A("boss@corp.com", "attacker@evil.com")].map((a) => ({ ...a, name: "" })));
    const named = `=?UTF-8?Q?Ana_=3Cana=40x.com=3E?= <real@x.com>`;
    expect(parseAddressHeader(named, { single: true })).toEqual([A("Ana", "real@x.com")]);
    // and an encoded comma never splits a list
    expect(parseAddressHeader(`=?UTF-8?Q?Doe=2C_Jane?= <j@x.com>`)).toEqual([A("Doe, Jane", "j@x.com")]);
  });

  it("a From is never split, its bracketed address never taken: one author, the real address", () => {
    expect(parseAddressHeader(USER_HEADER, { single: true })).toEqual([A("José David Sucre L., Luis Alberto Medina", "lmedina@sucre.net")]);
  });
});

describe("repairAddresses: what an older parser stored (read and reply time)", () => {
  it.each<[string, Address[], Address[]]>([
    ["2 the user's exact stored value", [USER_STORED], [A("David Sucre L.", "david@sucre.net"), A("Luis Alberto Medina", "lmedina@sucre.net")]],
    ["2 postal-mime's version of the same header", [A("José_David_Sucre_L.?= <david@sucre.net> , Luis Alberto Medina", "lmedina@sucre.net")], [A("José David Sucre L.", "david@sucre.net"), A("Luis Alberto Medina", "lmedina@sucre.net")]],
    ["12 a phrase swallowed into the address", [A("", '"luis alberto medina <lmedina"@sucre.net>')], [A("luis alberto medina", "lmedina@sucre.net")]],
    ["13 quotes left in the name", [A("'Ana Torres'", "a@x.com"), A("“Smart”", "s@x.com")], [A("Ana Torres", "a@x.com"), A("Smart", "s@x.com")]],
    ["15 the name is the address", [A("ANA@x.com", "ana@x.com"), A("'b@x.com'", "b@x.com")], [A("", "ana@x.com"), A("", "b@x.com")]],
    ["22 mailto left in the address", [A("Ana", "mailto:ana@x.com"), A(">", "dbl@x.com")], [A("Ana", "ana@x.com"), A(">", "dbl@x.com")]],
    ["25 a trailing dot", [A("", "a@x.com.")], [A("", "a@x.com")]],
    ["26 duplicates; a later name fills an empty one", [A("", "b@x.com"), A("Bea", "B@x.com"), A("Other", "b@x.com")], [A("Bea", "b@x.com")]],
    ["28 a bidi override", [A("\u{202E}gnp.exe", "b@x.com")], [A("gnp.exe", "b@x.com")]],
    ["31 what can't be repaired stays (it shows as invalid)", [A("", "foo bar")], [A("", "foo bar")]],
    ["no address at all: dropped", [A("undisclosed-recipients", "")], []],
    ["a bracketed address without a separator: the name loses it, nothing is added", [A("Bob <bob@x.com>", "bob2@x.com")], [A("Bob", "bob2@x.com")]],
  ])("%s", (_, stored, expected) => {
    expect(repairAddresses(stored)).toEqual(expected);
  });

  it("is idempotent on every scenario", () => {
    const cases = [[USER_STORED], [A("", '"luis alberto medina <lmedina"@sucre.net>')], [A("'Ana'", "a@x.com"), A("JosÃ©", "j@x.com")], parseAddressHeader(USER_HEADER)];
    for (const c of cases) {
      const once = repairAddresses(c);
      expect(repairAddresses(once)).toEqual(once);
    }
  });

  it("leaves clean addresses alone (the same objects: the fast path)", () => {
    const clean = [A("José Pérez", "jp@x.com"), A("", "a@b.co"), A("Ñúñez Zuleika", "z@acme.studio"), A("山田太郎", "y@x.jp")];
    const out = repairAddresses(clean);
    expect(out).toEqual(clean);
    out.forEach((a, i) => expect(a).toBe(clean[i]));
  });

  it("repairAddress (a From): cleaned, never split", () => {
    expect(repairAddress(USER_STORED)).toEqual(A("David Sucre L., Luis Alberto Medina", "lmedina@sucre.net"));
    expect(repairAddress(A("'Ana'", "ana@x.com"))).toEqual(A("Ana", "ana@x.com"));
  });
});

describe("encoded words, orphans, mojibake", () => {
  it.each<[string, string]>([
    ["=?UTF-8?Q?a?= =?UTF-8?Q?b?=", "ab"],
    ["=?UTF-8?Q?a?=  \t =?ISO-8859-1?Q?=E9?=", "aé"],
    ["x =?UTF-8?Q?a?= y", "x a y"],
    ["=?UTF-8?B?not base64!!?=", "=?UTF-8?B?not base64!!?="],
    ["=?UTF-8?Q?Jos=C3=A9 P=C3=A9rez?=", "José Pérez"],
    ["plain", "plain"],
  ])("decodes %s", (input, out) => expect(decodeEncodedWords(input)).toBe(out));

  it("orphan halves are decoded; underscores elsewhere stay", () => {
    expect(repairOrphans("José_David_Sucre_L.?=")).toBe("José David Sucre L.");
    expect(repairOrphans("snake_case =?UTF-8?Q?Jos=C3=A9_P")).toBe("snake_case José P");
    expect(repairOrphans("snake_case name")).toBe("snake_case name");
  });

  it("mojibake is undone only when it is mojibake", () => {
    expect(repairMojibake("JosÃ© PÃ©rez")).toBe("José Pérez");
    expect(repairMojibake("Ã‰milie")).toBe("Émilie");
    for (const real of ["José Pérez", "Ñúñez", "Ãngel", "São Paulo", "Æsir Ö"]) expect(repairMojibake(real)).toBe(real);
  });

  it("cleanName", () => {
    expect(cleanName('  "Ana \\"A\\" Torres"  ')).toBe('Ana "A" Torres');
    expect(cleanName("«Ana»")).toBe("Ana");
    expect(cleanName("Ana\u0000\u0007 Torres")).toBe("Ana Torres");
    // ZWJ sequences (emoji, scripts) survive
    expect(cleanName("👩\u{200D}💻 Ana")).toBe("👩\u{200D}💻 Ana");
  });
});

describe("validity and output", () => {
  it.each<[string, boolean]>([
    ["a@x.com", true],
    ["o'brien@x.ie", true],
    ["a+tag@x.com", true],
    ["a!#$%&*/=?^`{|}~-b@x.com", true],
    ["user@bücher.de", true],
    ["josé@x.com", true],
    ["a_b@my_host.example", true],
    ["a@sub-domain.x-y.co.uk", true],
    ["a@x", false],
    ["a@x.com.", false],
    ["a..b@x.com", false],
    [".a@x.com", false],
    ["a.@x.com", false],
    ['"john doe"@x.com', false],
    ["a@[1.2.3.4]", false],
    ["a@1.2.3.4", false],
    ["a b@x.com", false],
    ["a@-x.com", false],
    ["a@x..com", false],
    ["bob@", false],
    ["@x.com", false],
    [`${"l".repeat(65)}@x.com`, false],
  ])("isValidEmail(%s) = %s", (email, ok) => expect(isValidEmail(email)).toBe(ok));

  it("Unicode domains go out as punycode", () => {
    expect(asciiEmail("user@bücher.de")).toBe("user@xn--bcher-kva.de");
    expect(asciiEmail("ana@x.com")).toBe("ana@x.com");
  });

  it("no-reply addresses", () => {
    for (const e of ["noreply@x.com", "no-reply@x.com", "do-not-reply@x.com", "donotreply@x.com", "noreply+abc@x.com", "MAILER-DAEMON@x.com", "bounces+1@x.com"]) expect(isNoReply(e)).toBe(true);
    for (const e of ["ana@x.com", "replies@x.com", "norah@x.com"]) expect(isNoReply(e)).toBe(false);
  });

  it("formatAddress quotes every special (the dot too), never writes a line break or a bidi control, and round-trips nasty names", () => {
    expect(formatAddress(A("John Q. Public", "j@x.com"))).toBe('"John Q. Public" <j@x.com>');
    expect(formatAddress(A("Ana\r\nBcc: spy@evil.com", "a@x.com"))).toBe('"Ana Bcc: spy@evil.com" <a@x.com>');
    expect(formatAddress(A("\u{202E}abc", "a@x.com"))).toBe("abc <a@x.com>");
    const nasty = [
      A('Pérez, "Lucho" (MX)', "l@x.mx"),
      A("a@b.com <a@b.com>", "c@d.com"),
      A("Back\\slash; semi: colon", "s@x.com"),
      A("山田 太郎", "y@x.jp"),
      A("👩\u{200D}💻 Ana", "a@x.com"),
      A("שלום עליכם", "s@x.co.il"),
      A("=?UTF-8?Q?not_an_encoded_word?=", "e@x.com"),
      A("N".repeat(200), "n@x.com"),
    ];
    expect(parseAddressList(formatAddressList(nasty))).toEqual(nasty);
  });
});

describe("what the Codex review of the plan changed", () => {
  it("1 a bracketed address in a name is no recipient without a separator; one only an encoded word spells is never one", () => {
    expect(parseAddressHeader('"Support <leak@attacker.example>" <support@company.example>')).toEqual([A("Support", "support@company.example")]);
    const encoded = `=?UTF-8?B?${b64("Ana <leak@attacker.example>, Bob")}?= <support@company.example>`;
    const parsed = parseAddressHeader(encoded);
    expect(parsed).toEqual([A("Ana, Bob", "support@company.example")]);
    // and what was stored from it stays one recipient at read time
    expect(repairAddresses(parsed)).toEqual(parsed);
  });

  it("2 an entry that isn't an address round-trips as one entry, never as something sendable", () => {
    for (const entry of [A("", "a@x.com, b@x.com"), A("", "esto no es un correo"), A("", "<a@x.com>; b@x.com"), A("Ana", "bad address"), A("", "bob@")]) {
      const back = parseAddressList(formatAddress(entry));
      expect(back).toHaveLength(1);
      expect(isValidEmail(back[0]!.email)).toBe(false);
      expect(parseAddressList(formatAddressList(back))).toEqual(back);
    }
    expect(parseAddressList(formatAddressList([A("", "a@x.com"), A("", "x, y"), A("B", "b@x.com")]))).toEqual([A("", "a@x.com"), A("", "x, y"), A("B", "b@x.com")]);
  });

  it("7 a recipient swallowed after the name cap is still recovered", () => {
    const long = "N".repeat(300);
    expect(parseAddressHeader(`"${long} <a@x.com>, B" <b@x.com>`)).toEqual([A("N".repeat(256), "a@x.com"), A("B", "b@x.com")]);
  });
});

describe("what the Codex code review changed", () => {
  it("1 an encoded word is opaque: its literal brackets and commas are never structure (the From stays the real one)", () => {
    expect(parseAddressHeader("=?UTF-8?Q?Ana_<ana@x.com>?= <real@x.com>", { single: true })).toEqual([A("Ana", "real@x.com")]);
    expect(parseAddressHeader("=?UTF-8?Q?Doe, Jane <j@evil.com>?= <real@x.com>")).toEqual([A("Doe, Jane", "real@x.com")]);
  });

  it("2 beside a literal bracketed address, one an encoded word spells is still never recovered", () => {
    const header = '"=?UTF-8?Q?Ana_=3Cleak=40attacker.example=3E=2C_Bob?= <literal@company.example>, Real" <real@company.example>';
    const got = parseAddressHeader(header).map((a) => a.email);
    expect(got).not.toContain("leak@attacker.example");
    expect(got).toEqual(["literal@company.example", "real@company.example"]);
  });

  it("3 an entry that isn't an address but reads as one unquoted (a group's colon) round-trips as itself", () => {
    for (const email of ["a:b@x.com", "mailto:", "x: y@z.com", "Team:;"]) {
      const back = parseAddressList(formatAddress(A("", email)));
      expect(back).toEqual([A("", email)]);
      expect(isValidEmail(back[0]!.email)).toBe(false);
    }
  });

  it("4 a typed part that is only a comment is kept as an entry to fix, never dropped", () => {
    expect(parseAddressList("(bob@x.com)")).toEqual([A("", "(bob@x.com)")]);
    expect(parseAddressList(formatAddressList(parseAddressList("ana@x.io, (bob@x.com)")))).toEqual([A("", "ana@x.io"), A("", "(bob@x.com)")]);
  });
});

describe("what the Codex review of the reconciliation with plan 27 changed", () => {
  const stored = A("Support <audit@thirdparty.test>, Helpdesk", "session@help.test");

  it("1 Reply-To is never split: a display name never adds a destination to a plain reply", () => {
    expect(parseAddressHeader('"Support <audit@thirdparty.test>, Helpdesk" <session@help.test>', { split: false })).toEqual([A("Support, Helpdesk", "session@help.test")]);
    expect(storedAddresses({ from_name: "", from_email: "a@x.com", to_json: "[]", cc_json: "[]", reply_to_json: JSON.stringify([stored]) }).replyTo).toEqual([A("Support, Helpdesk", "session@help.test")]);
  });

  it("2 an address valid as stored is kept exactly; only a matching pair of quotes wraps one", () => {
    for (const email of ["'support@example.com", "support'@example.com", "o'brien@x.ie"]) expect(repairAddresses([A("Support", email)])).toEqual([A("Support", email)]);
    expect(repairAddresses([A("", "'a@x.com'")])).toEqual([A("", "a@x.com")]);
    expect(parseAddressHeader("Support <'support@example.com>")).toEqual([A("Support", "'support@example.com")]);
  });
});
