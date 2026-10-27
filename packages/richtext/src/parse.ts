import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { isSafeHref } from "./links";
import { schema } from "./schema";

/**
 * HTML into the composer's document (plan 16 §3): a draft's stored HTML and
 * whatever is pasted. A cleaning pass first (what can't be in mail goes, with
 * its content when that is a script or an image; Word's and Docs' markup is
 * undone), then the schema's parse rules decide what stays. Terno's own HTML
 * (a draft, a copy from a Terno editor) keeps its colors, fonts, sizes,
 * alignment and indents; anything else keeps bold, italic, underline,
 * strikethrough, lists, links, quotes and headings (as size).
 */

/** elements that go with everything inside them */
const DROP = new Set([
  "script", "style", "head", "meta", "link", "title", "base", "img", "picture", "source", "video", "audio", "track", "iframe", "frame", "frameset",
  "object", "embed", "applet", "svg", "math", "canvas", "map", "area", "input", "button", "select", "option", "optgroup", "textarea", "template",
  "noscript", "hr", "dialog", "datalist", "output", "progress", "meter",
]);

/** what a paste from outside Terno keeps of a style attribute */
const FOREIGN_STYLE = ["font-weight", "font-style", "text-decoration", "text-decoration-line"];
/** what Terno's own HTML keeps (everything its parse rules read) */
const OWN_STYLE = [...FOREIGN_STYLE, "color", "background-color", "font-family", "font-size", "text-align", "margin-left"];

const BLOCK = new Set(["p", "div", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "section", "article", "header", "footer", "nav", "aside", "figure", "figcaption", "address", "dl", "dt", "dd", "body", "main"]);

/** A heading's line: h1 huge and bold, h2 large and bold, h3–h6 bold. */
const HEADING_SIZE: Record<string, string | null> = { h1: "2em", h2: "1.4em", h3: null, h4: null, h5: null, h6: null };

const TAB = "";

export interface ParseOptions {
  /** Terno's own HTML: its colors, fonts, sizes, alignment and indents are read */
  own: boolean;
}

/** An inert document for markup we don't trust: nothing in it loads or runs. */
function inert(html: string, impl?: DOMImplementation): Document {
  const doc = (impl ?? document.implementation).createHTMLDocument("");
  doc.body.innerHTML = html;
  return doc;
}

function filterStyle(el: HTMLElement, keep: readonly string[]): void {
  const style = el.style;
  const kept: string[] = [];
  for (const prop of keep) {
    const v = style.getPropertyValue(prop);
    if (v) kept.push(`${prop}:${v}`);
  }
  if (kept.length) el.setAttribute("style", kept.join(";"));
  else el.removeAttribute("style");
}

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

/** The cleaning pass, in place. */
export function cleanDom(body: HTMLElement, { own }: ParseOptions): void {
  const doc = body.ownerDocument;
  // comments (Word's conditional ones included) and processing instructions
  const walker = doc.createTreeWalker(body, 128 /* SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);

  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (!el.isConnected) continue;
    const name = el.localName.toLowerCase();
    if (DROP.has(name)) {
      el.remove();
      continue;
    }
    // containers that mean nothing in mail: their text stays
    if (name === "form" || name === "fieldset" || name === "label" || name === "legend") {
      unwrap(el);
      continue;
    }
    const html = el as HTMLElement;
    // Word: list bullets typed as text, and its empty <o:p> paragraphs' filler
    if (/mso-list\s*:\s*ignore/i.test(html.getAttribute("style") ?? "")) {
      el.remove();
      continue;
    }
    if (name === "o:p" || name.includes(":")) {
      if (!/\S/.test((el.textContent ?? "").replace(/ /g, ""))) el.remove();
      else unwrap(el);
      continue;
    }
    if (html.style) filterStyle(html, own ? OWN_STYLE : FOREIGN_STYLE);
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      // data-rt-auto (Terno's copy of an autolink) only makes a link follow its text: harmless from anywhere
      const keep = n === "style" || n === "data-pm-slice" || (name === "a" && ((n === "href" && isSafeHref(attr.value)) || n === "data-rt-auto")) || (n === "start" && name === "ol") || (own && name === "font" && (n === "face" || n === "size" || n === "color"));
      if (!keep) el.removeAttribute(attr.name);
    }
  }

  // headings → a bold line (sized for h1/h2): the composer has lines, not heading blocks
  for (const h of Array.from(body.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const p = doc.createElement("p");
    const b = doc.createElement("b");
    const size = HEADING_SIZE[h.localName];
    const inner = size ? doc.createElement("span") : b;
    if (size) {
      inner.setAttribute("style", `font-size:${size}`);
      b.appendChild(inner);
    }
    inner.append(...Array.from(h.childNodes));
    p.appendChild(b);
    h.replaceWith(p);
  }
  // preformatted text keeps its lines, in fixed width
  for (const pre of Array.from(body.querySelectorAll("pre"))) {
    const frag = doc.createDocumentFragment();
    for (const line of (pre.textContent ?? "").replace(/\n$/, "").split("\n")) {
      const div = doc.createElement("div");
      if (line) {
        const span = doc.createElement("span");
        span.setAttribute("style", "font-family:monospace");
        span.textContent = line;
        div.appendChild(span);
      }
      frag.appendChild(div);
    }
    pre.replaceWith(frag);
  }
  // a table's rows as lines, its cells side by side
  for (const cell of Array.from(body.querySelectorAll("td, th"))) {
    const span = doc.createElement("span");
    span.append(...Array.from(cell.childNodes), doc.createTextNode(" "));
    cell.replaceWith(span);
  }
  for (const row of Array.from(body.querySelectorAll("tr"))) {
    const div = doc.createElement("div");
    div.append(...Array.from(row.childNodes));
    row.replaceWith(div);
  }

  // a <br> that ends its block draws nothing in a browser (it closes the line): it isn't a line break of the text
  for (const br of Array.from(body.querySelectorAll("br"))) if (endsBlock(br)) br.remove();

  if (own) {
    // tabs survive the whitespace collapse as a placeholder (they're <span style="white-space:pre"> in mail)
    const texts = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
    while (texts.nextNode()) {
      const t = texts.currentNode as Text;
      if (t.data.includes("\t")) t.data = t.data.replace(/\t/g, TAB);
    }
  }
}

function endsBlock(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    let next = cur.nextSibling;
    while (next && next.nodeType === 3 && !/[^ \t\r\n\f]/.test((next as Text).data)) next = next.nextSibling;
    if (next) return next.nodeType === 1 && BLOCK.has((next as Element).localName);
    const parent = cur.parentNode;
    if (!parent || parent.nodeType !== 1 || BLOCK.has((parent as Element).localName)) return true;
    cur = parent;
  }
}

/** NBSP from collapsed-space encoding back to spaces, tab placeholders back to tabs. */
function restoreText(fragment: Fragment): Fragment {
  let changed = false;
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const text = node.text!.replace(/ /g, " ").replace(//g, "\t");
      if (text !== node.text) changed = true;
      nodes.push(text === node.text ? node : schema.text(text, node.marks));
    } else {
      const content = restoreText(node.content);
      if (content !== node.content) changed = true;
      nodes.push(content === node.content ? node : node.copy(content));
    }
  });
  return changed ? Fragment.from(nodes) : fragment;
}

const parser = PMDOMParser.fromSchema(schema);

/** A stored draft's HTML (Terno's own) as a document. */
export function parseHtml(html: string, impl?: DOMImplementation): PMNode {
  const doc = inert(html, impl);
  cleanDom(doc.body, { own: true });
  const parsed = parser.parse(doc.body);
  return parsed.copy(restoreText(parsed.content));
}

/** A paste's HTML, cleaned for ProseMirror's own clipboard parser (it reads data-pm-slice for the slice's depth). */
export function cleanPastedHtml(html: string, impl?: DOMImplementation): string {
  const own = /data-pm-slice/.test(html);
  const doc = inert(html, impl);
  cleanDom(doc.body, { own });
  return doc.body.innerHTML;
}

/** A pasted slice: NBSP as spaces. */
export function restoreSlice(slice: Slice): Slice {
  const content = restoreText(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}
