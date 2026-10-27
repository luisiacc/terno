// oxlint-disable-next-line typescript/triple-slash-reference -- DefinitelyTyped omits css-tree's public subpath declarations.
/// <reference path="./css-tree-subpaths.d.ts" />
import parseCss from "css-tree/parser";
import { tokenize, tokenTypes } from "css-tree/tokenizer";
import { ident } from "css-tree/utils";
import { parse, type DefaultTreeAdapterTypes as Html } from "parse5";

const NON_CONTENT = new Set(["head", "title", "script", "style", "template", "iframe", "object", "embed", "noembed", "noframes", "xmp"]);
const BLOCKS = new Set(["address", "article", "aside", "blockquote", "br", "caption", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "th", "thead", "tr", "ul"]);
const DISPLAYS = new Set(["none", "contents", "block", "inline", "inline-block", "flow-root", "list-item", "flex", "inline-flex", "grid", "inline-grid", "table", "inline-table", "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-column-group", "table-column", "table-cell", "table-caption"]);
const INLINE_DISPLAYS = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "inline-table", "contents"]);
const LENGTHS = new Set(["px", "em", "rem", "ex", "ch", "cap", "ic", "lh", "rlh", "vw", "vh", "vmin", "vmax", "svh", "lvh", "dvh", "cm", "mm", "q", "in", "pt", "pc"]);
const PROPERTIES = new Set(["display", "visibility", "opacity", "max-height", "overflow", "overflow-x", "overflow-y"]);
const OVERFLOWS = new Set(["visible", "hidden", "clip", "scroll", "auto"]);
type Style = Map<string, { value: string; important: boolean }>;
const EMPTY_STYLE: Style = new Map();

function scalar(property: string, source: string): string | undefined {
  const tokens: { type: number; value: string }[] = [];
  tokenize(source, (type, start, end) => {
    if (type !== tokenTypes.WhiteSpace && type !== tokenTypes.Comment && tokens.length < 3) tokens.push({ type, value: source.slice(start, end) });
  });
  if (property === "overflow" && tokens.length === 2) {
    const values = tokens.map((token) => ident.decode(token.value).toLowerCase());
    if (tokens.every((token) => token.type === tokenTypes.Ident) && values.every((value) => OVERFLOWS.has(value))) return values.join(" ");
    return;
  }
  if (tokens.length !== 1) return;
  const token = tokens[0]!;
  if (token.type === tokenTypes.Ident) {
    const value = ident.decode(token.value).toLowerCase();
    if (property === "display" && DISPLAYS.has(value)) return value;
    if (property === "visibility" && ["visible", "hidden", "collapse", "inherit", "unset", "initial"].includes(value)) return value;
    if ((property === "overflow" || property === "overflow-x" || property === "overflow-y") && OVERFLOWS.has(value)) return value;
    if (property === "max-height" && value === "none") return value;
  }
  if (property === "opacity" && (token.type === tokenTypes.Number || token.type === tokenTypes.Percentage)) {
    const number = Number(token.value.replace(/%$/, ""));
    if (Number.isFinite(number)) return number <= 0 ? "0" : "positive";
  }
  if (property === "max-height") {
    if (token.type === tokenTypes.Number && Number(token.value) === 0) return "0";
    if (token.type === tokenTypes.Percentage && Number(token.value.slice(0, -1)) >= 0) return Number(token.value.slice(0, -1)) === 0 ? "0" : "positive";
    if (token.type === tokenTypes.Dimension) {
      // Tokenization established a dimension; decode its unit, including CSS escapes.
      const dimension = /^([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)([\s\S]+)$/i.exec(token.value);
      if (dimension && Number(dimension[1]) >= 0 && LENGTHS.has(ident.decode(dimension[2]!).toLowerCase())) return Number(dimension[1]) === 0 ? "0" : "positive";
    }
  }
}

function setInlineValue(values: Style, property: string, value: string, important: boolean): void {
  if (!values.get(property)?.important || important) values.set(property, { value, important });
}

function inlineStyle(source: string): Style {
  const values: Style = new Map();
  // Values stay Raw: arbitrary nested functions must never recurse through a CSS value parser.
  const ast = parseCss(source, { context: "declarationList", parseValue: false });
  if (ast.type !== "DeclarationList") return values;
  ast.children.forEach((node) => {
    if (node.type !== "Declaration" || node.value.type !== "Raw") return;
    if (typeof node.important === "string" && ident.decode(node.important).toLowerCase() !== "important") return;
    const important = node.important !== false;
    const property = ident.decode(node.property).toLowerCase();
    if (!PROPERTIES.has(property)) return;
    const value = scalar(property, node.value.value);
    if (value === undefined) return;
    if (property === "overflow") {
      const space = value.indexOf(" ");
      setInlineValue(values, "overflow-x", space < 0 ? value : value.slice(0, space), important);
      setInlineValue(values, "overflow-y", space < 0 ? value : value.slice(space + 1), important);
    } else setInlineValue(values, property, value, important);
  });
  return values;
}

function verticalOverflow(style: Style): string {
  const x = style.get("overflow-x")?.value ?? "visible";
  const y = style.get("overflow-y")?.value ?? "visible";
  if (x === "visible" || x === "clip") return y;
  return y === "visible" ? "auto" : y === "clip" ? "hidden" : y;
}

let ready: Promise<void> | undefined;

/** Local inline visibility, not computed layout. See plan36 for supported CSS and renderer limits. */
export async function htmlToText(html: string): Promise<string> {
  // First-use parser initialization and the first parse/store must not share a backend slice.
  ready ??= new Promise<void>((resolve) => setTimeout(resolve, 0));
  await ready;
  const document = parse(html, { scriptingEnabled: false });
  const output: string[] = [];
  const stack: { children: Html.ChildNode[]; index: number; invisible: boolean; block: boolean }[] = [{ children: document.childNodes, index: 0, invisible: false, block: false }];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const node = frame.children[frame.index++];
    if (!node) {
      if (frame.block) output.push(" ");
      stack.pop();
      continue;
    }
    if (node.nodeName === "#text") {
      if (!frame.invisible) output.push((node as Html.TextNode).value);
      continue;
    }
    if (!("tagName" in node)) continue;
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || NON_CONTENT.has(node.tagName)) continue;
    // The reader serializes sanitized children into fresh html/body wrappers.
    const wrapper = node.tagName === "html" || node.tagName === "body";
    const attrs = new Map((wrapper ? [] : node.attrs).map((attr) => [attr.name, attr.value]));
    const source = attrs.get("style");
    const style = source ? inlineStyle(source) : EMPTY_STYLE;
    const display = style.get("display")?.value;
    const hidden = attrs.get("hidden");
    const overflow = verticalOverflow(style);
    if (display === "none" || (attrs.has("hidden") && (!display || hidden?.toLowerCase() === "until-found")) || style.get("opacity")?.value === "0" || (style.get("max-height")?.value === "0" && overflow !== "visible")) continue;
    const visibility = style.get("visibility")?.value;
    const invisible = visibility === "hidden" || visibility === "collapse" || (visibility !== "visible" && visibility !== "initial" && frame.invisible);
    const block = node.tagName === "br" || (display ? !INLINE_DISPLAYS.has(display) : BLOCKS.has(node.tagName));
    if (block) output.push(" ");
    if (node.childNodes.length) stack.push({ children: node.childNodes, index: 0, invisible, block });
  }
  return output.join("").replace(/[\t\n\f\r \u00a0]+/g, " ").trim();
}
