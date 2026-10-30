// @vitest-environment jsdom
import { findCode } from "@terno/core";
import { describe, expect, it } from "vitest";
import { mailText } from "./mail-text";

const html = (body: string, subject = "Hello") => findCode(subject, mailText(body));

describe("an HTML body's code (plan 69)", () => {
  it("reads HTML as it is shown: the word in a <code> tag is not the word", () => {
    expect(html("<code>x = 482913</code>")).toBeNull();
    expect(html('<p class="code">Order 482913</p>')).toBeNull();
    expect(html("<style>.code { color: #123456 }</style><p>Hi 482913</p>")).toBeNull();
    expect(html('<a href="https://x.test/?code=482913">Verify</a>')).toBeNull();
    expect(mailText("<head><title>code</title></head><script>code 1</script><!-- code --><p>Hi</p>")).toBe("Hi");
  });

  it("finds codes in typical templates", () => {
    expect(html("<table><tr><td>Your verification code</td></tr><tr><td><strong>482913</strong></td></tr></table>")).toBe("482913");
    expect(html("<p>Your code is<b>482913</b></p>")).toBe("482913");
    expect(html("<p>Code: <span>482</span><span>913</span></p>")).toBe("482913");
    expect(html("<p>Your code</p>\n<table><tr>\n  <td>4</td>\n  <td>8</td>\n  <td>2</td>\n  <td>9</td>\n  <td>1</td>\n  <td>3</td>\n</tr></table>")).toBe("482913");
    expect(html("<p>Tu código&nbsp;es&nbsp;482913</p>")).toBe("482913");
    expect(html("<p>C&#243;digo: 482913</p>")).toBe("482913");
  });

  // Codex review round 1
  it("never reads hidden HTML: the code shown is the one copied", () => {
    expect(html('<div style="display:none">code 111222.</div><p>Your code is 482913.</p>')).toBe("482913");
    expect(html('<span style="font-size: 0px">code 111222</span><p>Your code is 482913.</p>')).toBe("482913");
    expect(html("<div hidden>code 111222</div><p>Your code is 482913.</p>")).toBe("482913");
    expect(html('<div style="display:none"><div>code 111222</div></div><p>Your code is 482913.</p>')).toBe("482913");
  });

  it("skips quoted mail, nested quotes whole", () => {
    expect(html("<p>Thanks!</p><blockquote><p>Your code is 482913</p></blockquote>")).toBeNull();
    expect(html("<p>Thanks!</p><blockquote><blockquote>Older message</blockquote><p>Your code is 482913.</p></blockquote>")).toBeNull();
  });

  it("decodes entities before matching", () => {
    expect(html("<p>Tu c&oacute;digo: 482913</p>")).toBe("482913");
    expect(html("<p>Your code: &pound;123456</p>")).toBeNull();
    expect(html("<p>Your code: &euro;123456</p>")).toBeNull();
  });

  // Codex review round 2: the browser's parser decides what is markup, as in the reader
  it("reads markup as the reader's parser does", () => {
    expect(html('<p title="anything > code 111222">Your verification code is 482913.</p>')).toBe("482913");
    expect(html("<p>İ</p><div hidden>code 111222</div><p>Your code is 482913</p>")).toBe("482913");
    expect(html("<blockquote><!-- </blockquote> -->code 111222</blockquote><p>code is 482913</p>")).toBe("482913");
    expect(html("<div hidden/>code 111222</div><p>Your code is 482913</p>")).toBe("482913");
    expect(html('<p>Visible</p><a title="code 111222')).toBeNull();
    expect(html("<style>code 111222</stylesheet> code 333444</style><p>Your code is 482913</p>")).toBe("482913");
  });

  it("reads hiding from the style attribute only", () => {
    expect(html('<p title=" hidden ">Your code is 482913</p>')).toBe("482913");
    expect(html('<p data-note="display:none">Your code is 482913</p>')).toBe("482913");
  });

  it("stays bounded on hostile HTML", () => {
    for (const hostile of [" ".repeat(200_000), "<".repeat(200_000), "<a".repeat(100_000), "<a>".repeat(66_000), "&".repeat(200_000), "<!--".repeat(50_000), "<b>1</b> ".repeat(20_000)]) {
      const start = performance.now();
      html(hostile);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });
});

// Codex review round 3
describe("an HTML body's boundaries and styles (plan 69)", () => {
  it("separates text on both sides of an element", () => {
    expect(html("<div>Your code</div>482913")).toBe("482913");
    expect(html("<div>code 123</div>456")).toBeNull();
  });

  it("reads inline styles as the browser resolves them", () => {
    expect(html('<div style="display:none;display:block">code 482913</div>')).toBe("482913");
    expect(html('<div style="display:block;display:none">code 111222</div><p>Your code is 482913</p>')).toBe("482913");
  });
});
