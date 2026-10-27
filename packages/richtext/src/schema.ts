import { Schema, type Attrs, type DOMOutputSpec, type Mark, type Node as PMNode } from "prosemirror-model";
import { isSafeHref, spelledHref } from "./links";
import { FONT_CSS, fontOf, fontSizeAttrOf, HIGHLIGHT_HEX, HIGHLIGHT_INK, highlightOf, INDENT_PX, MAX_INDENT, SIZE_CSS, sizeOf, TEXT_HEX, textColorOf, type Font, type Highlight, type Size, type TextColor } from "./palette";

/**
 * The composer's document (plan 16 §3). What isn't here can't enter a draft,
 * whatever is pasted: the schema is the sanitizer. A line is a paragraph
 * without margins (Enter starts the next line, an empty line is the gap), as
 * in Gmail and Apple Mail.
 *
 * toDOM is what the editor shows and what a copy carries: the mail's own
 * inline values (so a copy pastes right anywhere), plus data-rt-* attributes
 * the editor's stylesheet themes (a red word in a dark theme).
 */

export type Align = "left" | "center" | "right";
const ALIGNS: readonly Align[] = ["left", "center", "right"];

/** a block's alignment and indent, from its inline style */
export function blockAttrs(dom: HTMLElement): { align: Align; indent: number } {
  const a = dom.style.textAlign;
  const align: Align = a === "center" ? "center" : a === "right" || a === "end" ? "right" : "left";
  const margin = /^(\d+(?:\.\d+)?)px$/.exec(dom.style.marginLeft);
  const indent = margin ? Math.max(0, Math.min(MAX_INDENT, Math.round(Number(margin[1]) / INDENT_PX))) : 0;
  return { align, indent };
}

export function blockStyle(attrs: Attrs): string {
  const parts: string[] = [];
  if (attrs.align && attrs.align !== "left") parts.push(`text-align:${attrs.align}`);
  if (attrs.indent) parts.push(`margin-left:${attrs.indent * INDENT_PX}px`);
  return parts.join(";");
}

const BLOCK_CHILD = /^(P|DIV|UL|OL|LI|BLOCKQUOTE|H[1-6]|PRE|TABLE|SECTION|ARTICLE|HEADER|FOOTER|NAV|ASIDE|FIGURE|ADDRESS|DL|HR)$/;

const paragraphRule = (tag: string) => ({
  tag,
  getAttrs: (dom: HTMLElement) => {
    // a wrapper of blocks isn't a line: its children are (left unmatched, the parser walks into it)
    for (const child of dom.children) if (BLOCK_CHILD.test(child.nodeName)) return false;
    return blockAttrs(dom);
  },
});

const withStyle = (tag: string, attrs: Record<string, string>, style: string): DOMOutputSpec => [tag, style ? { ...attrs, style } : attrs, 0];

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: { align: { default: "left" }, indent: { default: 0 } },
      parseDOM: [paragraphRule("p"), paragraphRule("div")],
      toDOM: (node) => withStyle("p", {}, blockStyle(node.attrs)),
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { start: { default: 1 } },
      parseDOM: [{ tag: "ol", getAttrs: (dom: HTMLElement) => ({ start: dom.hasAttribute("start") ? Math.max(1, Number(dom.getAttribute("start")) || 1) : 1 }) }],
      toDOM: (node) => (node.attrs.start === 1 ? ["ol", 0] : ["ol", { start: String(node.attrs.start) }, 0]),
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },
    list_item: {
      content: "paragraph block*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
  },
  // nesting order, outermost first: a highlight's ink sits outside a chosen color, so the color wins
  marks: {
    // auto (plan 39): Terno made it from typed or pasted text that spells its href, which then follows the text
    link: {
      attrs: { href: {}, auto: { default: false } },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: linkAttrs }],
      toDOM: (mark) => ["a", mark.attrs.auto ? { href: mark.attrs.href, rel: "noopener noreferrer nofollow", "data-rt-auto": "" } : { href: mark.attrs.href, rel: "noopener noreferrer nofollow" }, 0],
    },
    bold: {
      parseDOM: [
        { tag: "strong" },
        // Google Docs wraps a whole copy in <b style="font-weight:normal">
        { tag: "b", getAttrs: (dom: HTMLElement) => dom.style.fontWeight !== "normal" && dom.style.fontWeight !== "400" && null },
        { style: "font-weight=400", clearMark: (m: Mark) => m.type.name === "bold" },
        { style: "font-weight=normal", clearMark: (m: Mark) => m.type.name === "bold" },
        { style: "font-weight", getAttrs: (value: string) => (/^(bold|bolder|[6-9]00)$/.test(value) ? null : false) },
      ],
      toDOM: () => ["b", 0],
    },
    italic: {
      parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }, { style: "font-style=normal", clearMark: (m: Mark) => m.type.name === "italic" }],
      toDOM: () => ["i", 0],
    },
    underline: {
      parseDOM: [
        { tag: "u" },
        { tag: "ins" },
        { style: "text-decoration", consuming: false, getAttrs: (value: string) => (/\bunderline\b/.test(value) ? null : false) },
        { style: "text-decoration-line", consuming: false, getAttrs: (value: string) => (/\bunderline\b/.test(value) ? null : false) },
      ],
      toDOM: () => ["u", 0],
    },
    strike: {
      parseDOM: [
        { tag: "s" },
        { tag: "strike" },
        { tag: "del" },
        { style: "text-decoration", consuming: false, getAttrs: (value: string) => (/\bline-through\b/.test(value) ? null : false) },
        { style: "text-decoration-line", consuming: false, getAttrs: (value: string) => (/\bline-through\b/.test(value) ? null : false) },
      ],
      toDOM: () => ["s", 0],
    },
    font: {
      attrs: { value: {} },
      parseDOM: [
        { style: "font-family", getAttrs: (value: string) => fontAttrs(fontOf(value)) },
        { tag: "font[face]", getAttrs: (dom: HTMLElement) => fontAttrs(fontOf(dom.getAttribute("face") ?? "")) },
        { tag: "code", getAttrs: () => ({ value: "mono" }) },
        { tag: "tt", getAttrs: () => ({ value: "mono" }) },
      ],
      toDOM: (mark) => ["span", { style: `font-family:${FONT_CSS[mark.attrs.value as Font]}`, "data-rt-font": mark.attrs.value }, 0],
    },
    size: {
      attrs: { value: {} },
      parseDOM: [
        { style: "font-size", getAttrs: (value: string) => valueAttrs(sizeOf(value)) },
        { tag: "font[size]", getAttrs: (dom: HTMLElement) => valueAttrs(fontSizeAttrOf(dom.getAttribute("size") ?? "")) },
      ],
      toDOM: (mark) => ["span", { style: `font-size:${SIZE_CSS[mark.attrs.value as Size]}`, "data-rt-size": mark.attrs.value }, 0],
    },
    highlight: {
      attrs: { value: {} },
      parseDOM: [{ style: "background-color", getAttrs: (value: string) => valueAttrs(highlightOf(value)) }],
      toDOM: (mark) => ["span", { style: `background-color:${HIGHLIGHT_HEX[mark.attrs.value as Highlight]};color:${HIGHLIGHT_INK}`, "data-rt-highlight": mark.attrs.value }, 0],
    },
    color: {
      attrs: { value: {} },
      parseDOM: [
        { style: "color", getAttrs: (value: string) => valueAttrs(textColorOf(value)) },
        { tag: "font[color]", getAttrs: (dom: HTMLElement) => valueAttrs(textColorOf(dom.getAttribute("color") ?? "")) },
      ],
      toDOM: (mark) => ["span", { style: `color:${TEXT_HEX[mark.attrs.value as TextColor]}`, "data-rt-color": mark.attrs.value }, 0],
    },
  },
});

/**
 * A link read from HTML. Mail HTML carries only href, so a link whose text
 * spells its href is an autolink again on reopen (the same document back).
 * Terno's own copy marks autolinks (data-rt-auto): one gets the href its
 * text spells, or no link when the copied part spells none (a part of
 * "https://santo.com" never points to santo.com).
 */
function linkAttrs(dom: HTMLElement) {
  const href = (dom.getAttribute("href") ?? "").trim();
  if (!isSafeHref(href)) return false;
  // a line break in it is a delimiter, as in the editor: such a link spells nothing
  const spelled = dom.querySelector("br") ? null : spelledHref(dom.textContent ?? "");
  if (dom.hasAttribute("data-rt-auto")) return spelled ? { href: spelled, auto: true } : false;
  return { href, auto: spelled === href };
}

function fontAttrs(font: Font | null) {
  return font ? { value: font } : false;
}
function valueAttrs(value: string | null) {
  return value ? { value } : false;
}

export type RichDoc = PMNode;

/** An empty document: one empty line. */
export const emptyDoc = (): PMNode => schema.node("doc", null, [schema.node("paragraph")]);

export const ALIGN_VALUES = ALIGNS;
