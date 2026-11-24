import { describe, expect, it } from "vitest";
import { iconDomain, registrableDomain, senderHost } from "./domain";
import { isFreemail } from "./freemail";

describe("sender domains (plan 22)", () => {
  it("a sender's registrable domain: eTLD+1 from the suffix list, never the address", () => {
    expect(iconDomain("info@mail.netflix.com")).toBe("netflix.com");
    expect(iconDomain("no-reply@a.b.news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(iconDomain("pedidos@envios.amazon.com.mx")).toBe("amazon.com.mx");
    // private suffixes (github.io pages) count as their ICANN parent
    expect(iconDomain("me@someone.github.io")).toBe("github.io");
  });

  it("normalizes case, whitespace and the trailing dot, and turns IDN into punycode", () => {
    expect(senderHost("  Ana@Correo.Ñandú.MX. ")).toBe("correo.xn--and-6ma2c.mx");
    expect(iconDomain("ana@correo.ñandú.mx")).toBe("xn--and-6ma2c.mx");
    expect(iconDomain("X@NETFLIX.COM")).toBe("netflix.com");
  });

  it("no site for what isn't a public domain: bare suffixes, IPs, local names, garbage", () => {
    for (const email of ["a@co.uk", "a@com", "a@[127.0.0.1]", "a@10.0.0.1", "a@localhost", "a@printer.local", "a@box.internal", "a@x.test", "no-at-sign", "a@", "a@exa mple.com", "a@foo/bar.com"]) {
      expect(iconDomain(email), email).toBeNull();
    }
    expect(registrableDomain("co.uk")).toBeNull();
  });

  it("freemail: a person at a mailbox provider gets no provider icon (their initials)", () => {
    for (const email of ["luis@gmail.com", "x@googlemail.com", "x@outlook.com", "x@hotmail.com", "x@hotmail.co.uk", "x@live.com.mx", "x@yahoo.com.mx", "x@icloud.com", "x@me.com", "x@proton.me", "x@gmx.de", "x@yandex.ru", "x@prodigy.net.mx"]) {
      expect(iconDomain(email), email).toBeNull();
    }
    for (const d of ["google.com", "microsoft.com", "apple.com", "netflix.com", "livenation.com", "acme.studio"]) expect(isFreemail(d), d).toBe(false);
  });
});
