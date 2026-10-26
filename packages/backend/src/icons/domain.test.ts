import { beforeAll, describe, expect, it } from "vitest";
import { iconSubject, loadSuffixList, registrableDomain, senderHost } from "./domain";
import { isFreemail } from "./freemail";

beforeAll(() => loadSuffixList());

describe("sender domains (plan 22)", () => {
  it("a sender's registrable domain: eTLD+1 from the suffix list, never the address", () => {
    expect(iconSubject("info@mail.netflix.com")).toEqual({ kind: "site", domain: "netflix.com" });
    expect(iconSubject("no-reply@a.b.news.bbc.co.uk")).toEqual({ kind: "site", domain: "bbc.co.uk" });
    expect(iconSubject("pedidos@envios.amazon.com.mx")).toEqual({ kind: "site", domain: "amazon.com.mx" });
    // private suffixes (github.io pages) count as their ICANN parent
    expect(iconSubject("me@someone.github.io")).toEqual({ kind: "site", domain: "github.io" });
  });

  it("normalizes case, whitespace and the trailing dot, and turns IDN into punycode", () => {
    expect(senderHost("  Ana@Correo.Ñandú.MX. ")).toBe("correo.xn--and-6ma2c.mx");
    expect(iconSubject("ana@correo.ñandú.mx")).toEqual({ kind: "site", domain: "xn--and-6ma2c.mx" });
    expect(iconSubject("X@NETFLIX.COM")).toEqual({ kind: "site", domain: "netflix.com" });
  });

  it("no site for what isn't a public domain: bare suffixes, IPs, local names, garbage", () => {
    for (const email of ["a@co.uk", "a@com", "a@[127.0.0.1]", "a@10.0.0.1", "a@localhost", "a@printer.local", "a@box.internal", "a@x.test", "no-at-sign", "a@", "a@exa mple.com", "a@foo/bar.com"]) {
      expect(iconSubject(email), email).toEqual({ kind: "photo-only" });
    }
    expect(registrableDomain("co.uk")).toBeNull();
  });

  it("freemail: a person at a mailbox provider gets no provider icon", () => {
    for (const email of ["luis@gmail.com", "x@googlemail.com", "x@outlook.com", "x@hotmail.com", "x@hotmail.co.uk", "x@live.com.mx", "x@yahoo.com.mx", "x@icloud.com", "x@me.com", "x@proton.me", "x@gmx.de", "x@yandex.ru", "x@prodigy.net.mx"]) {
      expect(iconSubject(email), email).toEqual({ kind: "photo-only" });
    }
    for (const d of ["google.com", "microsoft.com", "apple.com", "netflix.com", "livenation.com", "acme.studio"]) expect(isFreemail(d), d).toBe(false);
  });
});
