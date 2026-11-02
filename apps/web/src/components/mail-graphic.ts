import { SVG_APPEARANCE } from "./mail-sections";

interface Graphic { source: Element; shell: Element }

/** Yield between bounded copies; never serialize or deep-clone a graphic. */
export async function copyMailTree(source: Node, target: Node, signal: AbortSignal, tabs = new WeakMap<Node, string | null>(), graphics?: Map<string, Graphic>) {
  const channel = new MessageChannel();
  let resume: (() => void) | null = null;
  channel.port1.onmessage = () => { resume?.(); resume = null; };
  const pause = () => new Promise<void>((resolve) => { resume = resolve; channel.port2.postMessage(null); });
  let current: Node | null = source.firstChild;
  let parent = target;
  let work = 0;
  try {
    while (current) {
      signal.throwIfAborted();
      const graphic = graphics && current.nodeType === Node.ELEMENT_NODE && (current as Element).localName === "svg";
      let copied: Node;
      if (current.nodeType === Node.TEXT_NODE) {
        const text = current.nodeValue!;
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(text.length, offset + 4096);
          if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
          parent.appendChild(target.ownerDocument!.createTextNode(text.slice(offset, end)));
          offset = end;
          await pause(); signal.throwIfAborted(); work = 0;
        }
        copied = parent;
      } else {
        copied = target.ownerDocument!.importNode(current, false);
        if (tabs.has(current)) {
          const tab = tabs.get(current);
          if (tab === null) (copied as Element).removeAttribute("tabindex");
          else (copied as Element).setAttribute("tabindex", tab!);
        }
        if (graphic) {
          const key = String(graphics.size);
          const original = current as SVGSVGElement;
          const shell = copied as SVGSVGElement;
          if (!original.hasAttribute("viewBox") && original.clientWidth > 0 && original.clientHeight > 0) shell.setAttribute("viewBox", `0 0 ${original.clientWidth} ${original.clientHeight}`);
          const inherited = new Set<string>();
          for (let context: Element | null = original; context && context !== source; context = context.parentElement) {
            const style = (context as HTMLElement | SVGElement).style;
            if (!style) continue;
            const properties = context === original ? SVG_APPEARANCE : SVG_APPEARANCE.filter((name) => !["filter", "clip-path", "mask", "opacity"].includes(name));
            for (const name of new Set([...properties, ...Array.from(style).filter((name) => name.startsWith("--"))])) {
              if (inherited.has(name)) continue;
              let value = style.getPropertyValue(name) || (context.namespaceURI === original.namespaceURI ? context.getAttribute(name) : context.localName === "font" && name === "color" ? context.getAttribute("color") : null);
              if (!value && name === "color" && context.localName === "a" && context.hasAttribute("href")) value = "var(--m-link)";
              if (!value || value === "inherit" || (name === "color" && value === "currentColor")) continue;
              if (name === "font-size") value = original.ownerDocument.defaultView?.getComputedStyle(original).fontSize || value;
              shell.style.setProperty(name, value); inherited.add(name);
            }
          }
          graphics.set(key, { source: original, shell });
          (copied as Element).setAttribute("data-terno-graphic", key);
        }
        parent.appendChild(copied);
        if (++work === 64) { await pause(); signal.throwIfAborted(); work = 0; }
      }
      if (!graphic && current.firstChild) { current = current.firstChild; parent = copied; continue; }
      while (current && current !== source && !current.nextSibling) { current = current.parentNode; parent = parent.parentNode!; }
      current = current && current !== source ? current.nextSibling : null;
    }
  } finally { channel.port1.close(); channel.port2.close(); }
}

async function visitGraphic(source: Element, signal: AbortSignal, visit: (element: Element) => void) {
  const channel = new MessageChannel();
  let resume: (() => void) | null = null;
  channel.port1.onmessage = () => { resume?.(); resume = null; };
  const walker = source.ownerDocument.createTreeWalker(source, NodeFilter.SHOW_ELEMENT);
  let current: Element | null = source;
  let work = 0;
  try {
    while (current) {
      signal.throwIfAborted(); visit(current);
      if (++work === 64) { await new Promise<void>((resolve) => { resume = resolve; channel.port2.postMessage(null); }); work = 0; }
      current = walker.nextNode() as Element | null;
    }
  } finally { channel.port1.close(); channel.port2.close(); }
}

export async function prepareMailDisplay(source: { root: HTMLElement; tabs: WeakMap<Node, string | null> }, signal: AbortSignal) {
  const template = document.createElement("template");
  const graphics = new Map<string, Graphic>();
  await copyMailTree(source.root, template.content, signal, source.tabs, graphics);
  let ids: Map<string, Graphic> | null = null;
  return {
    root: template.content,
    async hydrate(doc: Document, cancellation: AbortSignal) {
      const placeholders = [...doc.querySelectorAll("svg[data-terno-graphic]")];
      if (!placeholders.length) return;
      if (!ids) {
        const index = new Map<string, Graphic>();
        for (const graphic of graphics.values()) await visitGraphic(graphic.source, cancellation, (element) => {
          if (element.id && !index.has(element.id)) index.set(element.id, graphic);
        });
        cancellation.throwIfAborted(); ids = index;
      }
      const owners = new Set(placeholders.map((element) => graphics.get(element.getAttribute("data-terno-graphic")!)!));
      const initial = new Set(owners);
      for (const owner of owners) await visitGraphic(owner.source, cancellation, (element) => {
        for (const { name, value } of element === owner.source ? [...element.attributes, ...owner.shell.attributes] : element.attributes) {
          const references = [...value.matchAll(/url\(\s*["']?#([^\s"'()]+)["']?\s*\)/gi)].map((match) => match[1]!);
          if ((name === "href" || name === "xlink:href") && value.startsWith("#")) references.push(value.slice(1));
          for (let id of references) {
            try { id = decodeURIComponent(id); } catch { /* Keep literal non-encoded IDs. */ }
            const dependency = ids!.get(id);
            if (dependency) owners.add(dependency);
          }
        }
      });
      const dependencies = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      dependencies.setAttribute("width", "0"); dependencies.setAttribute("height", "0");
      dependencies.style.position = "absolute"; dependencies.style.overflow = "hidden";
      dependencies.setAttribute("aria-hidden", "true");
      dependencies.setAttribute("data-mail-context", "");
      const definitions = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
      dependencies.appendChild(definitions);
      doc.body.appendChild(dependencies);
      for (const owner of owners) if (!initial.has(owner)) {
        const root = doc.importNode(owner.shell, false);
        root.removeAttribute("data-terno-graphic");
        definitions.appendChild(root);
        await copyMailTree(owner.source, root, cancellation, source.tabs);
      }
      for (const placeholder of placeholders) {
        const original = graphics.get(placeholder.getAttribute("data-terno-graphic")!)!.source;
        await copyMailTree(original, placeholder, cancellation, source.tabs);
        placeholder.removeAttribute("data-terno-graphic");
      }
    },
  };
}
