// @vitest-environment jsdom
import type { MessageDetail, ThreadDetail } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import es from "@terno/i18n/locales/es";
import { afterEach, describe, expect, it } from "vitest";
import { htmlBodyText, plainBodyText, threadText } from "./thread-text";

afterEach(() => setLocale("en", en));

const html = (body: string) => htmlBodyText(body, true);

describe("HTML to text: lines and paragraphs", () => {
  it("sets paragraphs apart by one blank line, however much space the mail leaves", () => {
    expect(html("<p>One</p>\n\n<p>Two</p><p></p><p>&nbsp;</p><p>Three</p><h2>Title</h2>Four")).toBe("One\n\nTwo\n\nThree\n\nTitle\n\nFour");
  });

  it("reads Gmail's divs as lines and its <div><br></div> as the one blank line", () => {
    expect(html("<div>Hi Ana,</div><div><br></div><div>Line one</div><div>Line two</div><div><br></div><div><br></div><div>Bye</div>")).toBe("Hi Ana,\n\nLine one\nLine two\n\nBye");
  });

  it("ends a line at <br>, and a <br> at the end of a block adds nothing", () => {
    expect(html("<div>a<br>b<br></div><div>c<br><br>d</div>")).toBe("a\nb\nc\n\nd");
  });

  it("reads Outlook's MsoNormal as lines, its &nbsp; paragraph as the blank one", () => {
    expect(html('<p class="MsoNormal">Hi,<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Ana Ruiz<o:p></o:p></p><p class="MsoNormal">CEO<o:p></o:p></p>')).toBe("Hi,\n\nAna Ruiz\nCEO");
  });

  it("reads a zero margin as a line and a div's margin as a paragraph", () => {
    expect(html('<p style="margin:0">a</p><p style="margin:0">b</p>')).toBe("a\nb");
    expect(html('<div style="margin-bottom:16px">a</div><div>b</div>')).toBe("a\n\nb");
  });

  it("lets display override the tag", () => {
    expect(html('<div style="display:inline">Hel</div><div style="display:inline">lo</div>')).toBe("Hello");
    expect(html('<span style="display:block">a</span><span style="display:block">b</span>')).toBe("a\nb");
  });

  it("separates inline-block columns even when font-size:0 removed the space between them", () => {
    expect(html('<div style="font-size:0"><div style="display:inline-block;font-size:14px">Left</div><div style="display:inline-block;font-size:14px">Right</div></div>')).toBe("Left Right");
  });
});

describe("HTML to text: inline text", () => {
  it("collapses whitespace across elements, &nbsp; is a space, invisible characters go", () => {
    expect(html("<p>  a   <b> b</b>\n\t<i>c </i> d&nbsp;&nbsp;e&#8203;f soft&shy;ly </p>")).toBe("a b c d ef softly");
  });

  it("keeps a word whole across inline elements", () => {
    expect(html("<p>un<b>believ</b><i>able</i></p>")).toBe("unbelievable");
  });

  it("makes a link its text and an image its description, spacers leaving nothing", () => {
    expect(html('<p>See <a href="https://track.example/abc?x=1">the report</a>.</p><img src="a.png" alt="Logo"><img src="b.png" alt="">')).toBe("See the report.\n\nLogo");
  });
});

describe("HTML to text: lists", () => {
  it("marks lists, and numbers from start", () => {
    expect(html('<p>Do:</p><ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li><li>four</li></ol>End')).toBe("Do:\n\n- one\n- two\n\n3. three\n4. four\n\nEnd");
  });

  it("nests by two spaces with no blank line, wherever the mail put the nested list", () => {
    expect(html("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toBe("- a\n  - b\n- c");
    // Word's and Outlook's: straight in the list
    expect(html("<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>")).toBe("- a\n  - b\n- c");
  });

  it("aligns an item's further lines under its text", () => {
    expect(html("<ol><li>first<br>second<p>third</p></li></ol>")).toBe("1. first\n   second\n\n   third");
  });
});

describe("HTML to text: tables", () => {
  it("writes a row of one-line cells as one line", () => {
    expect(html("<table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td> $3 </td></tr></table>")).toBe("Item | Price\nTea | $3");
  });

  it("reads a layout table's multi-line cells as blocks, in order", () => {
    expect(html("<table><tr><td><p>Left one</p><p>Left two</p></td><td>Right</td></tr></table>")).toBe("Left one\n\nLeft two\n\nRight");
  });

  it("drops empty cells from a row and reads an empty row as a gap", () => {
    expect(html('<table><tr><td width="20"></td><td>a</td><td>&nbsp;</td></tr><tr><td height="20">&nbsp;</td></tr><tr><td>b</td></tr></table>')).toBe("a\n\nb");
  });

  it("unwraps nested layout tables", () => {
    expect(html("<table><tr><td><table><tr><td>Hello</td></tr></table><table><tr><td>World</td></tr></table></td></tr></table>")).toBe("Hello\n\nWorld");
  });
});

describe("HTML to text: as written", () => {
  it("keeps <pre> exactly, blank runs and indentation included", () => {
    expect(html("<p>Log:</p><pre>a  b\n\n\n    c</pre><p>End</p>")).toBe("Log:\n\na  b\n\n\n    c\n\nEnd");
  });

  it("keeps pre-wrap, and pre-line's breaks with its spaces collapsed", () => {
    expect(html('<div style="white-space:pre-wrap">a  b\n  c</div>')).toBe("a  b\n  c");
    expect(html('<div style="white-space:pre-line">a   b\nc</div>')).toBe("a b\nc");
  });

  it("marks quotes, nested ones too", () => {
    expect(html("<p>Mine</p><blockquote><p>Theirs</p><p>More</p><blockquote>Older</blockquote></blockquote>")).toBe("Mine\n\n> Theirs\n>\n> More\n>\n> > Older");
  });
});

describe("HTML to text: what isn't shown", () => {
  it("leaves out what mail hides", () => {
    for (const hidden of ["display:none", "visibility:hidden", "opacity:0", "font-size:0", "max-height:0;overflow:hidden"]) {
      expect(html(`<div style="${hidden}">preheader</div><p>Visible</p>`), hidden).toBe("Visible");
    }
    expect(html("<div hidden>preheader</div><p>Visible</p>")).toBe("Visible");
    expect(html("<html><head><title>T</title><style>p{color:red}</style></head><body><script>x()</script><noscript>n</noscript><p>Visible</p></body></html>")).toBe("Visible");
  });

  it("shows a descendant that undoes what it inherited, but nothing undoes display:none", () => {
    expect(html('<div style="font-size:0">gap<span style="font-size:14px">shown</span></div>')).toBe("shown");
    expect(html('<div style="visibility:hidden">no<span style="visibility:visible">shown</span></div>')).toBe("shown");
    expect(html('<div style="display:none"><span style="display:block">gone</span></div><p>Visible</p>')).toBe("Visible");
  });
});

describe("quoted history", () => {
  const reply = '<div>My answer</div><br><div class="gmail_quote"><div>On Mon, Ana wrote:</div><blockquote>Her question</blockquote></div>';

  it("goes when asked, with its attribution, and stays otherwise", () => {
    expect(htmlBodyText(reply, false)).toBe("My answer");
    expect(htmlBodyText(reply, true)).toContain("Her question");
    expect(plainBodyText("My answer\n\nOn Mon, Ana wrote:\n> Her question\n", false)).toBe("My answer");
    expect(plainBodyText("My answer\n\nOn Mon, Ana wrote:\n> Her question\n", true)).toContain("> Her question");
  });

  it("stays when it is all a message has: a bare forward", () => {
    expect(htmlBodyText('<div class="gmail_quote">---------- Forwarded message ---------<br>The contract</div>', false)).toContain("The contract");
    expect(htmlBodyText('<div id="divRplyFwdMsg">From: Ana</div><div>The contract</div>', false)).toContain("The contract");
    expect(plainBodyText("> The contract\n", false)).toBe("> The contract");
  });

  it("keeps an inline reply whole", () => {
    expect(htmlBodyText("<blockquote type=cite>Question?</blockquote><div>Answer.</div><blockquote type=cite>Another?</blockquote><div>Yes.</div>", false)).toBe("> Question?\n\nAnswer.\n\n> Another?\n\nYes.");
  });
});

describe("plain text bodies", () => {
  it("tidies line endings, line ends and blank runs, and keeps indentation", () => {
    expect(plainBodyText("\r\n\r\nHi,  \r\n\r\n\r\n\r\n    code here\n​Bye\n\n", true)).toBe("Hi,\n\n    code here\nBye");
  });
});

const person = (email: string, name = "") => ({ email, name });
const DATE = Date.UTC(2026, 10, 3, 10, 12);
function message(id: number, o: Partial<MessageDetail>): MessageDetail {
  return { id, threadId: 1, accountId: 1, from: person("ana@acme.com", "Ana Ruiz"), replyTo: [], to: [person("l@x.io", "Luis")], cc: [], subject: "S", date: DATE, snippet: "", bodyText: null, bodyHtml: null, bodyState: "full", isRead: true, isStarred: false, isSent: false, hasAttachments: false, rfcMessageId: null, references: [], listId: null, attachments: [], ...o } as MessageDetail;
}
const thread = (messages: MessageDetail[], subject = "Contract renewal") => ({ thread: { subject }, messages }) as unknown as ThreadDetail;
const QUOTING = "My answer\n\nOn Mon, Ana wrote:\n> First words\n";

describe("the conversation", () => {
  it("is the subject, then each message's headers and body, oldest first", async () => {
    const { text, messages, missing } = await threadText(thread([message(1, { bodyText: "First words", cc: [person("b@x.io"), person("c@x.io", "c@x.io")] }), message(2, { bodyHtml: "<p>Second <b>words</b></p>", from: person("l@x.io"), to: [] })]));
    expect(text).toMatch(/^Subject: Contract renewal\n\nFrom: Ana Ruiz <ana@acme\.com>\nTo: Luis <l@x\.io>\nCc: b@x\.io, c@x\.io\nDate: .*2026.*\n\nFirst words\n\n---\n\nFrom: l@x\.io\nDate: .*\n\nSecond words$/);
    expect([messages, missing]).toEqual([2, 0]);
  });

  it("leaves a message's history out only when the messages above cover it", async () => {
    const first = message(1, { bodyText: `Added late\n\nOn Sun, Bob wrote:\n> Bob's only copy\n` });
    const second = message(2, { bodyText: QUOTING });
    const { text } = await threadText(thread([first, second]));
    expect(text).toContain("> Bob's only copy");
    expect(text).toContain("My answer");
    expect(text).not.toContain("> First words");
  });

  it("keeps the history below a body it doesn't have", async () => {
    const { text, missing } = await threadText(thread([message(1, { bodyState: "none" }), message(2, { bodyText: QUOTING })]));
    expect(text).toContain("[Content not downloaded yet]");
    expect(text).toContain("> First words");
    expect(missing).toBe(1);
  });

  it("says what it couldn't have, and counts it; an empty mail isn't missing", async () => {
    const { text, missing } = await threadText(thread([message(1, { bodyText: "" }), message(2, { bodyState: "none", bodyUnavailable: "size" }), message(3, { bodyState: "partial", bodyText: "The start" })]));
    expect(text).toContain("[This message has no text body.]");
    expect(text).toContain("[This message exceeds the local content limit.");
    expect(text).toContain("The start\n\n[Only part of this message has downloaded]");
    expect(missing).toBe(2);
  });

  it("uses the text body when the HTML holds no words", async () => {
    const { text } = await threadText(thread([message(1, { bodyHtml: '<img src="x.png" alt="">', bodyText: "Plain words" })]));
    expect(text).toContain("Plain words");
  });

  it("lists attachments by name, not the images the mail shows in place", async () => {
    const attachments = [{ id: 1, filename: "terms.pdf", mime: "application/pdf", size: 9 }, { id: 2, filename: "logo.png", mime: "image/png", size: 9, contentId: "<logo@x>" }, { id: 3, filename: "chart.png", mime: "image/png", size: 9, contentId: "<unused@x>" }];
    const { text } = await threadText(thread([message(1, { bodyHtml: '<p>Hi</p><img src="cid:logo@x">', attachments })]));
    expect(text).toMatch(/^Attachments: terms\.pdf, chart\.png$/m);
  });

  it("has no subject line without a subject, no separator with one message", async () => {
    const { text } = await threadText(thread([message(1, { bodyText: "Hi" })], "  "));
    expect(text).toMatch(/^From: /);
    expect(text).not.toContain("---");
  });

  it("speaks the UI's language", async () => {
    setLocale("es", es);
    const { text } = await threadText(thread([message(1, { bodyText: "Hola" })], "Contrato"));
    expect(text).toMatch(/^Asunto: Contrato\n\nDe: Ana Ruiz <ana@acme\.com>\nPara: Luis <l@x\.io>\nFecha: /);
  });
});
