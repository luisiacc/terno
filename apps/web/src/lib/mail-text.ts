/** Read only so far into a message's HTML: a code sits near the top, and the parse stays bounded. */
const HTML_CAP = 200_000;
const TEXT_CAP = 20_000;
/** Never shown, or quoted mail (an old code must not come back in a reply): skipped with everything inside. */
const SKIP = new Set(["HEAD", "TITLE", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "IFRAME", "OBJECT", "SVG", "BLOCKQUOTE"]);
/** Inline elements: between digits they don't split them ("<b>12</b>3456" reads 123456); elsewhere a space. */
const INLINE = new Set(["A", "ABBR", "B", "BIG", "CODE", "EM", "FONT", "I", "KBD", "LABEL", "MARK", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TT", "U", "WBR"]);
/** Cells and images separate words without breaking the line: per-digit boxes read "1 2 3 4 5 6". */
const SPACED = new Set(["TD", "TH", "IMG"]);
const ZERO = /^0(?:\.0+)?(?:px|em|rem|%)?$/;

/** Hidden by its own attributes: `hidden`, or inline styles as the browser resolves them (the last declaration wins). */
function hidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (!el.hasAttribute("style")) return false;
  const s = (el as HTMLElement).style;
  return s.display === "none" || s.visibility === "hidden" || ZERO.test(s.fontSize) || ZERO.test(s.maxHeight) || ZERO.test(s.opacity);
}

let parser: DOMParser | undefined;

/**
 * The text an HTML body shows, for finding its verification code (plan 69). The browser's own parser reads it, as
 * the reader does, so markup tricks (quoted ">", comments, unfinished tags) mean what they mean there. Hidden
 * elements, styles, scripts and quoted mail are left out; tags are never text, so a `<code>` tag isn't the word.
 */
export function mailText(html: string): string {
  parser ??= new DOMParser();
  const doc = parser.parseFromString(html.slice(0, HTML_CAP), "text/html");
  let out = "";
  // what separates the next text from the last: "~" joins digits and is a space otherwise
  // (a property: sep() changes it between reads, which TypeScript's narrowing of a local can't see)
  const at: { gap: "" | "~" | " " | "\n" } = { gap: "" };
  const sep = (kind: "~" | " " | "\n") => {
    if (kind === "\n" || at.gap === "" || (kind === " " && at.gap === "~")) at.gap = kind;
  };
  // depth first with an explicit stack (deep nesting can't overflow); an element separates on the way in and out
  const stack: (Node | { leave: "~" | " " | "\n" })[] = [doc.body];
  while (stack.length && out.length < TEXT_CAP) {
    const item = stack.pop()!;
    if (!(item instanceof Node)) {
      sep(item.leave);
      continue;
    }
    if (item.nodeType === Node.TEXT_NODE) {
      const text = (item.nodeValue ?? "").replace(/\s+/g, " ");
      if (!text.trim()) {
        if (text) sep(" ");
        continue;
      }
      if (at.gap === "\n" || at.gap === " ") out += at.gap;
      else if (at.gap === "~" && !(/\d$/.test(out) && /^\d/.test(text))) out += " ";
      out += text;
      at.gap = "";
      continue;
    }
    if (item.nodeType !== Node.ELEMENT_NODE) continue;
    const el = item as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(el)) {
      sep(" ");
      continue;
    }
    const kind = INLINE.has(tag) ? "~" : SPACED.has(tag) ? " " : "\n";
    sep(kind);
    stack.push({ leave: kind });
    for (let c = el.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
