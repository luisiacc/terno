/**
 * The icons a homepage names in its <head> (plan 22): `<link rel=icon>`,
 * `shortcut icon` and `apple-touch-icon`. A tolerant scan of at most what
 * arrived (the fetcher caps it), not a parser: attributes in any order and
 * quoting, `<base href>` honored, everything after `</head>` ignored.
 */
export interface IconLink {
  url: URL;
  rel: "icon" | "apple-touch-icon";
  /** the largest declared size (px), 0 unknown, Infinity for `any` */
  size: number;
  type: string;
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, decode(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

function decode(v: string): string {
  return v.replace(/&amp;/gi, "&").replace(/&#x2f;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/gi, '"').trim();
}

function largest(sizes: string | undefined): number {
  if (!sizes) return 0;
  let best = 0;
  for (const s of sizes.toLowerCase().split(/\s+/)) {
    if (s === "any") return Infinity;
    const m = /^(\d{1,4})x(\d{1,4})$/.exec(s);
    if (m) best = Math.max(best, Math.min(Number(m[1]), Number(m[2])));
  }
  return best;
}

/** Links found, resolved against `<base href>` (when it is https) or the page URL. Only https URLs come back. */
export function iconLinks(html: string, pageUrl: URL): IconLink[] {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  // comments and scripts can hold anything that looks like a tag
  const clean = head.replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/<(script|style|template|noscript)\b[\s\S]*?(<\/\1\s*>|$)/gi, "");
  let base = pageUrl;
  const baseTag = /<base\b([^>]*)>/i.exec(clean);
  if (baseTag) {
    const href = attrs(baseTag[1]!).get("href");
    try {
      const u = href ? new URL(href, pageUrl) : null;
      if (u?.protocol === "https:") base = u;
    } catch {
      // a broken base is ignored, as browsers do
    }
  }
  const out: IconLink[] = [];
  for (const m of clean.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attrs(m[1]!);
    const rels = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
    const rel = rels.includes("apple-touch-icon") || rels.includes("apple-touch-icon-precomposed") ? "apple-touch-icon" : rels.includes("icon") ? "icon" : null;
    const href = a.get("href");
    if (!rel || !href || href.startsWith("data:")) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    out.push({ url, rel, size: largest(a.get("sizes")), type: (a.get("type") ?? "").toLowerCase() });
    if (out.length >= 32) break;
  }
  return out;
}

/** Target size: the largest avatar Terno draws is 64 CSS px, at 2×. */
const TARGET = 128;

/**
 * Best first: an apple-touch-icon (opaque, made to fill a tile), then sized
 * raster icons closest at or above the target, then SVG, then the rest.
 */
export function rankIcons(links: IconLink[]): IconLink[] {
  const score = (l: IconLink): number => {
    const svg = l.type.includes("svg") || /\.svg$/i.test(l.url.pathname);
    if (l.rel === "apple-touch-icon") return 1000 - Math.abs((l.size || 180) - 180);
    if (svg) return 600;
    if (l.size >= TARGET && l.size !== Infinity) return 800 - (l.size - TARGET) / 10;
    if (l.size > 0 && l.size !== Infinity) return 400 + l.size;
    return 100;
  };
  return [...links].sort((a, b) => score(b) - score(a));
}
