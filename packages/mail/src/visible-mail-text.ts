// oxlint-disable-next-line typescript/triple-slash-reference -- DefinitelyTyped omits css-tree's public subpath declarations.
/// <reference path="./css-tree-subpaths.d.ts" />
import parseCss from "css-tree/parser";
import { tokenize, tokenTypes } from "css-tree/tokenizer";
import { ident } from "css-tree/utils";
import { parse, type DefaultTreeAdapterTypes as Html } from "parse5";

// Public DOMPurify3.4.17 reader policy, audited in Chromium; unknown HTML tags unwrap.
const RETAINED = new Set("a abbr acronym address area article aside audio b bdi bdo big blink blockquote br button canvas caption center cite code col colgroup content data datalist dd del details dfn dialog dir div dl dt em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 header hgroup hr i image img input ins kbd label legend li main map mark marquee menu menuitem meter nav nobr ol optgroup option output p picture pre progress q rp rt ruby s samp search section select shadow slot small source spacer span strike strong sub summary sup table tbody td textarea tfoot th thead time title tr track tt u ul var video wbr".split(" "));
const DROP_CONTENT = new Set(["head", "script", "style", "template", "plaintext", "noscript", "iframe", "noembed", "noframes", "xmp", "frame", "frameset"]);
const DEFAULT_BLOCKS = new Set(["center", "dir", "menu", "hgroup", "search", "legend", "summary", "details", "dialog", "optgroup", "option", "address", "article", "aside", "blockquote", "caption", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "th", "thead", "tr", "ul"]);
const DISPLAYS = new Set(["none", "contents", "block", "inline", "inline-block", "flow-root", "list-item", "flex", "inline-flex", "grid", "inline-grid", "table", "inline-table", "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-column-group", "table-column", "table-cell", "table-caption"]);
const INLINE_DISPLAYS = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "inline-table", "contents"]);
const HEIGHT_BOXES = new Set(["block", "flow-root", "list-item", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "table-caption"]);
const DEFAULT_DISPLAY = new Map([["rp", "none"], ["br", "inline"], ["title", "none"], ["slot", "contents"], ["button", "inline-block"], ["input", "inline-block"], ["marquee", "inline-block"], ["meter", "inline-block"], ["progress", "inline-block"], ["select", "inline-block"], ["textarea", "inline-block"], ["table", "table"], ["caption", "table-caption"], ["thead", "table-header-group"], ["tbody", "table-row-group"], ["tfoot", "table-footer-group"], ["tr", "table-row"], ["td", "table-cell"], ["th", "table-cell"], ["col", "table-column"], ["colgroup", "table-column-group"]]);
// Chromium's retained legend rendering normalizes these authored values before box decisions.
const LEGEND_DISPLAY = new Map([["none", "none"], ["contents", "contents"], ["inline", "block"], ["inline-block", "block"], ["block", "block"], ["flow-root", "flow-root"], ["list-item", "list-item"], ["flex", "flex"], ["grid", "grid"], ["inline-flex", "flex"], ["inline-grid", "grid"], ["table", "table"], ["inline-table", "table"], ["table-row-group", "block"], ["table-header-group", "block"], ["table-footer-group", "block"], ["table-row", "block"], ["table-cell", "block"], ["table-column", "block"], ["table-column-group", "block"], ["table-caption", "block"]]);
const LENGTHS = new Set(["px", "em", "rem", "ex", "ch", "cap", "ic", "lh", "rlh", "vw", "vh", "vmin", "vmax", "svh", "lvh", "dvh", "cm", "mm", "q", "in", "pt", "pc"]);
const PROPERTIES = new Set(["display", "visibility", "opacity", "max-height", "overflow", "overflow-x", "overflow-y"]);
const INITIAL = new Map([["display", "inline"], ["opacity", "positive"], ["max-height", "none"], ["overflow", "visible"], ["overflow-x", "visible"], ["overflow-y", "visible"]]);
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
    if (value === "initial" || value === "unset") {
      if (property === "visibility") return value === "initial" ? "visible" : "inherit";
      return INITIAL.get(property);
    }
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
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || DROP_CONTENT.has(node.tagName)) continue;
    if (!RETAINED.has(node.tagName)) {
      if (node.childNodes.length) stack.push({ children: node.childNodes, index: 0, invisible: frame.invisible, block: false });
      continue;
    }
    const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
    const source = attrs.get("style");
    const style = source ? inlineStyle(source) : EMPTY_STYLE;
    const authoredDisplay = style.get("display")?.value;
    const specifiedDisplay = authoredDisplay ?? DEFAULT_DISPLAY.get(node.tagName) ?? (DEFAULT_BLOCKS.has(node.tagName) ? "block" : "inline");
    const display = node.tagName === "legend" ? LEGEND_DISPLAY.get(specifiedDisplay) ?? specifiedDisplay : specifiedDisplay;
    const hidden = attrs.get("hidden")?.trim().toLowerCase();
    const overflow = verticalOverflow(style);
    if (display === "none" || display === "table-column" || display === "table-column-group" || (attrs.has("hidden") && (!authoredDisplay || hidden === "until-found")) || (display !== "contents" && style.get("opacity")?.value === "0") || (HEIGHT_BOXES.has(display) && style.get("max-height")?.value === "0" && overflow !== "visible")) continue;
    const visibility = style.get("visibility")?.value;
    const invisible = visibility === "hidden" || visibility === "collapse" || (visibility !== "visible" && visibility !== "initial" && frame.invisible);
    const block = node.tagName === "br" || !INLINE_DISPLAYS.has(display);
    if (block) output.push(" ");
    if (node.childNodes.length) stack.push({ children: node.childNodes, index: 0, invisible, block });
  }
  return output.join("").replace(/[\t\n\f\r \u00a0]+/g, " ").trim();
}
