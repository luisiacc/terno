import { describe, expect, it } from "vitest";
import { findUnsubscribeLink, mailtoParts, parseListUnsubscribe, UNSUBSCRIBE_URI_MAX, unsubscribeOffer, unsubscribePlan, type UnsubscribeSource } from "./unsubscribe";

describe("List-Unsubscribe (plan 94)", () => {
  it("keeps the first mailto and the first web URI, in the header's order", () => {
    expect(parseListUnsubscribe("<mailto:off@list.example?subject=stop>, <https://list.example/u/1>, <https://other.example/u>", null)).toEqual({ mailto: "mailto:off@list.example?subject=stop", url: "https://list.example/u/1" });
    expect(parseListUnsubscribe("<https://list.example/u>", "")).toEqual({ url: "https://list.example/u" });
    expect(parseListUnsubscribe("<mailto:off@list.example>", null)).toEqual({ mailto: "mailto:off@list.example" });
  });

  it("one-click only with List-Unsubscribe-Post and an https URI", () => {
    expect(parseListUnsubscribe("<https://list.example/u?t=1>", "List-Unsubscribe=One-Click")).toEqual({ oneClick: "https://list.example/u?t=1", url: "https://list.example/u?t=1" });
    expect(parseListUnsubscribe("<http://list.example/u>", "List-Unsubscribe=One-Click")).toEqual({ url: "http://list.example/u" });
    expect(parseListUnsubscribe("<https://list.example/u>", "List-Unsubscribe=Something")).toEqual({ url: "https://list.example/u" });
    expect(parseListUnsubscribe("<mailto:off@list.example>", "List-Unsubscribe=One-Click")).toEqual({ mailto: "mailto:off@list.example" });
  });

  it("reads folded headers and whitespace inside the brackets", () => {
    expect(parseListUnsubscribe("<https://list.example/\r\n  u/abc>,\r\n <mailto:off@list.example>", "List-Unsubscribe=One-Click")).toEqual({ oneClick: "https://list.example/u/abc", url: "https://list.example/u/abc", mailto: "mailto:off@list.example" });
  });

  it("drops what isn't http(s) or mailto, credentials in URLs, and URIs over the cap", () => {
    expect(parseListUnsubscribe("<javascript:alert(1)>, <ftp://x.example/u>, <file:///etc/passwd>", null)).toBeNull();
    expect(parseListUnsubscribe("<https://user:pw@list.example/u>", null)).toBeNull();
    expect(parseListUnsubscribe(`<https://list.example/${"a".repeat(UNSUBSCRIBE_URI_MAX)}>`, null)).toBeNull();
    expect(parseListUnsubscribe("https://no-brackets.example/u", null)).toBeNull();
    expect(parseListUnsubscribe("", null)).toBeNull();
    expect(parseListUnsubscribe(null, "List-Unsubscribe=One-Click")).toBeNull();
  });

  it("mailto: one address, its subject and body, defaults", () => {
    expect(mailtoParts("mailto:off@list.example?subject=Stop%20it&body=id%3D42")).toEqual({ to: "off@list.example", subject: "Stop it", body: "id=42" });
    expect(mailtoParts("mailto:off@list.example")).toEqual({ to: "off@list.example", subject: "unsubscribe", body: "unsubscribe" });
    expect(mailtoParts("mailto:a@x.example,b@x.example")).toBeNull();
    expect(mailtoParts("mailto:not-an-address")).toBeNull();
    expect(mailtoParts("mailto:off@list.example?subject=%E0%A4%A")).toBeNull();
    // one recipient only, never extra headers, no line breaks in the subject, the first of a repeated field
    expect(mailtoParts("mailto:off@list.example?cc=boss@corp.example&bcc=x@y.example&subject=a%0D%0ABcc:%20x@y.example&subject=second")).toEqual({ to: "off@list.example", subject: "a Bcc: x@y.example", body: "unsubscribe" });
    expect(mailtoParts("mailto:off%0D%0A@list.example")).toBeNull();
  });
});

describe("the link in the mail (plan 94)", () => {
  it("finds the last anchor that says unsubscribe, by text, title or aria-label", () => {
    const html = `<p><a href="https://shop.example/">Shop</a></p><a href="https://a.example/unsub?x=1&amp;y=2"><span>Unsubscribe</span></a> · <a title="Opt out" href='https://b.example/o'>here</a>`;
    expect(findUnsubscribeLink(html, null)).toBe("https://b.example/o");
    expect(findUnsubscribeLink(`<a aria-label="unsubscribe" href=https://c.example/u>x</a>`, null)).toBe("https://c.example/u");
    expect(findUnsubscribeLink(`<a href="https://a.example/unsub?x=1&amp;y=2">UNSUBSCRIBE</a>`, null)).toBe("https://a.example/unsub?x=1&y=2");
  });

  it("Spanish, with and without accents", () => {
    expect(findUnsubscribeLink(`<a href="https://es.example/baja">Darse de baja</a>`, null)).toBe("https://es.example/baja");
    expect(findUnsubscribeLink(`<a href="https://es.example/c">Cancelar suscripción</a>`, null)).toBe("https://es.example/c");
    expect(findUnsubscribeLink(`<a href="https://es.example/d">desuscribirse</a>`, null)).toBe("https://es.example/d");
  });

  it("ignores links that aren't http(s) and words that only look alike", () => {
    expect(findUnsubscribeLink(`<a href="javascript:void(0)">Unsubscribe</a>`, null)).toBeNull();
    expect(findUnsubscribeLink(`<a href="mailto:x@y.example">Unsubscribe</a>`, null)).toBeNull();
    expect(findUnsubscribeLink(`<a href="https://x.example/">Subscribe now</a>`, null)).toBeNull();
    expect(findUnsubscribeLink(null, null)).toBeNull();
  });

  it("a text body: a URL right after the words, on the same line", () => {
    expect(findUnsubscribeLink(null, "Hello\n\nUnsubscribe: https://news.example/u\n")).toBe("https://news.example/u");
    expect(findUnsubscribeLink(null, "Darse de baja: https://boletin.example/u")).toBe("https://boletin.example/u");
    expect(findUnsubscribeLink(null, "Unsubscribe below\nhttps://news.example/not-this")).toBeNull();
    expect(findUnsubscribeLink(null, "Read more https://news.example/post")).toBeNull();
  });

  it("the HTML wins over the text", () => {
    expect(findUnsubscribeLink(`<a href="https://h.example/u">unsubscribe</a>`, "Unsubscribe: https://t.example/u")).toBe("https://h.example/u");
  });
});

describe("what Unsubscribe does (plan 94 §1)", () => {
  const src = (o: Partial<UnsubscribeSource>): UnsubscribeSource => ({ messageId: 7, accountId: 1, fromName: "News", fromEmail: "news@news.example", unsubscribe: null, bodyHtml: null, bodyText: null, ...o });
  it("one-click, then mail, then the header's page, then the link in the mail", () => {
    expect(unsubscribePlan(src({ unsubscribe: { oneClick: "https://a.example/u", url: "https://a.example/u", mailto: "mailto:off@a.example" } }))).toEqual({ messageId: 7, name: "News", method: "oneClick", target: "a.example", url: "https://a.example/u", page: "https://a.example/u" });
    expect(unsubscribePlan(src({ unsubscribe: { url: "https://a.example/u", mailto: "mailto:off@a.example?subject=bye" } }))).toMatchObject({ method: "mailto", target: "off@a.example", mail: { to: "off@a.example", subject: "bye", body: "unsubscribe" } });
    expect(unsubscribePlan(src({ unsubscribe: { url: "https://a.example/u" }, bodyHtml: '<a href="https://b.example/x">unsubscribe</a>' }))).toMatchObject({ method: "page", target: "a.example", url: "https://a.example/u" });
    expect(unsubscribePlan(src({ bodyHtml: '<a href="https://b.example/x">unsubscribe</a>' }))).toMatchObject({ method: "page", target: "b.example", url: "https://b.example/x" });
    expect(unsubscribePlan(src({ bodyText: "nothing here" }))).toBeNull();
  });
  it("names the sender by address when the name is empty; only a page's offer carries its URL", () => {
    const plan = unsubscribePlan(src({ fromName: " ", unsubscribe: { url: "https://a.example/u" } }))!;
    expect(unsubscribeOffer(plan)).toEqual({ messageId: 7, method: "page", target: "a.example", name: "news@news.example", url: "https://a.example/u" });
    expect(unsubscribeOffer(unsubscribePlan(src({ unsubscribe: { oneClick: "https://a.example/u", url: "https://a.example/u", mailto: "mailto:off@a.example" } }))!)).toEqual({ messageId: 7, method: "oneClick", target: "a.example", name: "News" });
    expect(unsubscribeOffer(unsubscribePlan(src({ unsubscribe: { mailto: "mailto:off@a.example?body=token" } }))!)).toEqual({ messageId: 7, method: "mailto", target: "off@a.example", name: "News" });
  });
});
