/** Read only so far into a message's HTML: a code sits near the top, and the parse stays bounded. */
const HTML_CAP = 200_000;
const TEXT_CAP = 20_000;
/** Never shown, or quoted mail (an old code must not come back in a reply): skipped with everything inside. */
const SKIP = new Set(["HEAD", "TITLE", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "IFRAME", "OBJECT", "SVG", "BLOCKQUOTE"]);
/** Inline elements: between digits they don't split them ("<b>12</b>3456" reads 123456); elsewhere a space. */
const INLINE = new Set(["A", "ABBR", "B", "BIG", "CODE", "EM", "FONT", "I", "KBD", "LABEL", "MARK", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TT", "U", "WBR"]);
/** Cells and images separate words without breaking the line: per-digit boxes read "1 2 3 4 5 6". */
const SPACED = new Set(["TD", "TH", "IMG"]);
/** Inline styles that hide an element, read from its style attribute only. */
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:max-height|font-size|opacity)\s*:\s*0(?:\.0+)?(?:px|em|rem|%)?)\s*(?:!important\s*)?(?:;|$)/i;

let parser: DOMParser | undefined;

/**
 * The text an HTML body shows, for finding its verification code (plan 69). The browser's own parser reads it, as
 * the reader does, so markup tricks (quoted ">", comments, unfinished tags) mean what they mean there. Hidden
 * elements, styles, scripts and quoted mail are left out; tags are never text, so a `<code>` tag isn't the word.
 */
export function mailText(html: string): string {
  parser ??= new DOMParser();
  const doc = parser.parseFromString(html.slice(0, HTML_CAP), "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = node as Element;
      if (SKIP.has(el.tagName.toUpperCase()) || el.hasAttribute("hidden") || HIDDEN_STYLE.test(el.getAttribute("style") ?? "")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let out = "";
  // what separates the next text from the last: "~" joins digits and is a space otherwise
  let gap: "" | "~" | " " | "\n" = "";
  for (let node = walker.nextNode(); node && out.length < TEXT_CAP; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? "").replace(/\s+/g, " ");
      if (!text.trim()) {
        if (text && gap === "") gap = " ";
        continue;
      }
      if (gap === "\n" || gap === " ") out += gap;
      else if (gap === "~" && !(/\d$/.test(out) && /^\d/.test(text))) out += " ";
      out += text;
      gap = "";
      continue;
    }
    const tag = (node as Element).tagName.toUpperCase();
    const kind = INLINE.has(tag) ? "~" : SPACED.has(tag) ? " " : "\n";
    if (kind === "\n" || gap === "" || (kind === " " && gap === "~")) gap = kind;
  }
  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
