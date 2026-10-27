import { expect, it, vi } from "vitest";
import PostalMime from "postal-mime";
import { parseRaw } from "./mime";
import { visiblePolicyCases, visibleReviewCases } from "./test/visible-review-cases";
import { visibleSource } from "./test/visible-store";

it("excludes hidden descendants and keeps useful decoded HTML-only text", async () => {
  const parsed = await parseRaw(visibleSource('<div hidden><b>secret</b></div><div style="display:none">secret</div><p>VISible&nbsp; phrase &amp; caf&#233;</p>'));
  expect(parsed.text).toBe("VISible phrase & café");
});

it("retains visible text after valid inline overrides and ignores invalid trailing declarations", async () => {
  const html = [
    '<div style="display:none;display:bogus!important">secret</div>',
    '<div hidden style="display:block">Shown</div>',
    '<div style="max-height:0;max-height:50%;overflow:hidden">height reset</div>',
    '<div style="max-height:0;max-height:-1px;overflow:hidden">secret</div>',
    '<div style="max-height:0;overflow-y:hidden;overflow:visible">overflow reset</div>',
    '<div style="font-size:0"><span style="font-size:14px">font reset</span></div>',
  ].join("");
  expect((await parseRaw(visibleSource(html))).text).toBe("Shown height reset overflow reset font reset");
});

for (const [name, html, expected] of [
  ["inline word joins and block boundaries", '<p>un<b>broken</b> &amp;lt; &#x1F600;</p><table><tr><td>two</td><td>words</td></tr></table><div>next<br>line</div>', 'unbroken &lt; 😀 two words next line'],
  ["metadata and inert subtrees", '<head><title>secret</title><style>.x{content:"secret"}</style></head><body><!--secret--><script>secret</script><template>secret</template><iframe src="https://invalid.test">secret</iframe><object>secret</object><p>Useful</p></body>', 'secret Useful'],
  ["reader ignores stylesheet class and media hiding", '<style>.hidden{display:none}@media screen{p{visibility:hidden}}</style><p class="hidden">Still visible</p>', 'Still visible'],
  ["inherited visibility with visible descendant", '<div style="visibility:hidden">secret<span style="visibility:visible">Shown</span><b>secret</b></div><p>Tail</p>', 'Shown Tail'],
  ["ancestor display cannot be undone", '<div style="display:none"><span style="display:block;visibility:visible">secret</span></div><p>Tail</p>', 'Tail'],
  ["case, decoded attributes, CSS escapes and comments", '<div style="D&#73;SPLAY: n&#111;ne">secret</div><div style="d\\69splay: n\\6f ne/**/!important;display:block">secret</div><p>Useful</p>', 'Useful'],
  ["email preheaders with opacity or clipped height", '<div style="opacity:0"><span style="opacity:1">secret</span></div><div style="max-height:0px;overflow:hidden">secret</div><p>Useful</p>', 'Useful'],
  ["malformed nesting", '<div hidden><b>secret</div>Useful</b><p>tail', 'Useful tail'],
  ["malformed head reparenting and noscript", '<head><p>Useful</p></head><noscript><b>Fallback</b></noscript><p>tail</p>', 'Useful tail'],
  ["unsupported foreign namespace text is excluded", '<svg><text>secret</text><foreignObject><p>secret</p></foreignObject></svg><math><mtext>secret</mtext></math><p>Useful</p>', 'Useful'],
] as const) it(name, async () => {
  expect((await parseRaw(visibleSource(html))).text).toBe(expected);
});

const alternative = (plain: string, html: string) => `MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--b--`;
it("preserves public plain text precedence and the parser's omitted-empty alternative behavior", async () => {
  expect((await parseRaw(alternative("Author's Plain TEXT", '<p>Different HTML</p>'))).text).toBe("Author's Plain TEXT");
  expect((await parseRaw(alternative("", '<span hidden>secret</span><p>Useful fallback</p>'))).text).toBe("Useful fallback");
  expect((await parseRaw(visibleSource('<div hidden>secret</div>'))).text).toBe("");
});

it("does not recursively parse irrelevant deeply nested CSS functions", async () => {
  const css = `color:${"f(".repeat(10000)}red${")".repeat(10000)};display:none`;
  expect((await parseRaw(visibleSource(`<div style="${css}">secret</div><p>Useful</p>`))).text).toBe("Useful");
});


it("preserves an explicitly supplied empty public plain result", async () => {
  const source = visibleSource("<p>HTML fallback</p>");
  const parsed = await PostalMime.parse(source);
  const spy = vi.spyOn(PostalMime, "parse").mockResolvedValueOnce({ ...parsed, text: "" });
  try { expect((await parseRaw(source)).text).toBe(""); }
  finally { spy.mockRestore(); }
});

it("never fetches or activates resources while extracting hostile HTML", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
  try {
    const source = '<link rel="stylesheet" href="https://invalid.test/style"><img src="https://invalid.test/pixel" onerror="fetch(1)"><script>fetch(2)</script><style>@import "https://invalid.test/x";</style><p style="background:url(https://invalid.test/y)">Useful</p>';
    expect((await parseRaw(visibleSource(source))).text).toBe("Useful");
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it("excludes title metadata even when malformed mail places it inside the body", async () => {
  expect((await parseRaw(visibleSource('<body><p>Useful</p><title>secret title</title><p>tail</p></body>'))).text).toBe("Useful tail");
});

for (const fixture of [...visibleReviewCases, ...visiblePolicyCases]) it(fixture.name, async () => {
  expect((await parseRaw(visibleSource(fixture.html))).text).toBe(fixture.text);
});

for (const [name, html, expected] of [
  ["visibility block descendants can restore text", '<div style="visibility:hidden">secret<span style="visibility:visible">Shown</span></div>', "Shown"],
  ["visibility atomic descendants can restore text", '<span style="visibility:hidden;display:inline-block"><div style="visibility:visible">Shown</div></span>', "Shown"],
  ["opacity block descendants cannot restore text", '<div style="opacity:0">secret<span style="opacity:1;visibility:visible">secret</span></div><p>Shown</p>', "Shown"],
  ["clipped block descendants cannot restore text", '<div style="max-height:0;overflow:hidden">secret<span style="visibility:visible">secret</span></div><p>Shown</p>', "Shown"],
] as const) it(`R3-F2 ${name}`, async () => {
  expect((await parseRaw(visibleSource(html))).text).toBe(expected);
});
