/** Full-reader display sections; the original sanitized document is never edited. */
const TEXT_BUDGET = 4096;
const NODE_BUDGET = 64;
const APPEARANCE = ["color", "background-color", "background-image", "background-position", "background-size", "background-repeat", "font-family", "font-weight", "font-style", "text-decoration", "text-align"];
export const SVG_APPEARANCE = ["color", "font-family", "font-size", "font-style", "font-weight", "font-variant", "font-stretch", "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "paint-order", "color-interpolation", "color-interpolation-filters", "filter", "clip-path", "mask", "opacity"];
interface Point { node: Node; offset: number }
interface Section { start: Point; end: Point; offset: number }

export function mailSections(clean: string | DocumentFragment, nodeBudget = NODE_BUDGET) {
  const template = document.createElement("template");
  if (typeof clean === "string") template.innerHTML = clean;
  else template.content.appendChild(clean.cloneNode(true));
  const root = template.content;
  for (const element of root.querySelectorAll("textarea")) {
    const text = root.ownerDocument.createElement("pre");
    for (const { name, value } of element.attributes) text.setAttribute(name, value);
    text.textContent = element.textContent;
    element.replaceWith(text);
  }
  // Background assets are payload, not duplicated ancestor context on every section.
  for (const element of root.querySelectorAll<HTMLElement>("[style], [background]")) {
    const style = element.style;
    const backgrounds = [...style.backgroundImage.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
    const background = element.getAttribute("background");
    if (background) backgrounds.push(background);
    for (const src of backgrounds) {
      const image = root.ownerDocument.createElement("img");
      image.setAttribute("src", src); image.setAttribute("alt", "");
      element.appendChild(image);
    }
  }
  const sections: Section[] = [];
  const numbered = new WeakSet<HTMLOListElement>();
  const ordinals = new WeakMap<Element, number>();
  const ordinal = (list: HTMLOListElement, item: Element) => {
    if (!numbered.has(list)) {
      const items = [...list.children].filter((child) => child.localName === "li");
      let value = list.hasAttribute("start") ? list.start : list.reversed ? items.length : 1;
      for (const child of items) {
        if (child.hasAttribute("value")) value = (child as HTMLLIElement).value;
        ordinals.set(child, value); value += list.reversed ? -1 : 1;
      }
      numbered.add(list);
    }
    return ordinals.get(item)!;
  };
  for (const list of root.querySelectorAll("ol")) {
    for (const child of list.children) if (child.localName === "li") child.setAttribute("data-terno-ordinal", String(ordinal(list, child)));
  }
  const sourceTables = [...root.querySelectorAll("table")];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node.parentElement?.closest("svg")) return NodeFilter.FILTER_REJECT;
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).closest("svg")) return (node as Element).localName === "svg" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      return node.nodeType === Node.TEXT_NODE || !node.hasChildNodes() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  let start: Point | null = null;
  let end: Point | null = null;
  let chars = 0; let nodes = 0; let position = 0; let beginning = 0;
  const flush = () => {
    if (start && end) sections.push({ start, end, offset: beginning });
    start = end = null; chars = nodes = 0;
  };
  const offsets = new WeakMap<Node, number>();
  const indexed = new WeakSet<Node>();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      let offset = 0;
      while (offset < node.textContent!.length) {
        if (chars === TEXT_BUDGET || nodes === nodeBudget) flush();
        let until = Math.min(node.textContent!.length, offset + TEXT_BUDGET - chars);
        // Keep a surrogate pair together, without changing any source code units.
        if (until < node.textContent!.length && /[\uDC00-\uDFFF]/.test(node.textContent![until]!)) until--;
        if (until === offset) { flush(); continue; }
        if (!start) { start = { node, offset }; beginning = position; }
        end = { node, offset: until };
        chars += until - offset; position += until - offset; nodes++; offset = until;
      }
    } else {
      if (nodes === nodeBudget) flush();
      const parent = node.parentNode!;
      if (!indexed.has(parent)) {
        let index = 0;
        for (let child = parent.firstChild; child; child = child.nextSibling) offsets.set(child, index++);
        indexed.add(parent);
      }
      const offset = offsets.get(node)!;
      if (!start) { start = { node: parent, offset }; beginning = position; }
      end = { node: parent, offset: offset + 1 }; nodes++; position++;
    }
  }
  flush();
  return {
    count: sections.length || 1,
    offset(index: number) { return sections[index]?.offset ?? 0; },
    indexAt(offset: number) {
      let low = 0; let high = sections.length;
      while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (sections[middle]!.offset <= offset) low = middle; else high = middle; }
      return low;
    },
    html(index: number) {
      const part = sections[index];
      if (!part) return "";
      const range = document.createRange();
      range.setStart(part.start.node, part.start.offset); range.setEnd(part.end.node, part.end.offset);
      let fragment: Node = range.cloneContents();
      let ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentNode!;
      while (ancestor && ancestor !== root) {
        const wrapper = ancestor.cloneNode(false) as Element;
        wrapper.appendChild(fragment); fragment = wrapper; ancestor = ancestor.parentNode!;
      }
      const output = document.createElement("template");
      output.content.appendChild(fragment);
      for (const list of output.content.querySelectorAll("ol")) {
        const first = [...list.children].find((child) => child.localName === "li");
        const value = first?.getAttribute("data-terno-ordinal");
        if (value !== null && value !== undefined) list.setAttribute("start", value);
      }
      for (const item of output.content.querySelectorAll("[data-terno-ordinal]")) item.removeAttribute("data-terno-ordinal");
      const tables = sourceTables.filter((table) => range.intersectsNode(table));
      let contextChars = 512; let contextNodes = 32;
      for (const [i, table] of [...output.content.querySelectorAll("table")].entries()) {
        const heading = tables[i]?.querySelector(":scope > thead");
        const chars = heading?.textContent?.length ?? 0;
        const nodes = heading ? heading.querySelectorAll("*").length + 1 : 0;
        if (heading && chars <= contextChars && nodes <= contextNodes && !table.querySelector(":scope > thead")) {
          contextChars -= chars; contextNodes -= nodes;
          const context = heading.cloneNode(true) as Element;
          context.setAttribute("data-mail-context", "");
          table.prepend(context);
        }
      }
      for (const element of output.content.querySelectorAll<HTMLElement>("*")) {
        if (element.closest("svg") && element.localName !== "svg") continue;
        const style = element.style;
        const properties = element.localName === "svg" ? [...APPEARANCE, ...SVG_APPEARANCE, ...Array.from(style)].filter((name) => APPEARANCE.includes(name) || SVG_APPEARANCE.includes(name) || name.startsWith("--")) : APPEARANCE;
        const retained = properties.map((name) => [name, style.getPropertyValue(name)] as const);
        element.removeAttribute("style");
        for (const name of ["height", "width", "depth", "voffset", "lspace", "mathsize", "minsize", "maxsize", "rowspacing", "columnspacing", "framespacing"]) element.removeAttribute(name);
        for (const [name, value] of retained) if (value) style.setProperty(name, value);
      }
      return output.innerHTML;
    },
  };
}
