/**
 * One site's icon (plan 22): its homepage's <link rel=icon>s, then
 * /favicon.ico. Every request — the page, each redirect hop, each icon — is
 * https on the default port, to the sender's registrable domain (or a
 * subdomain of it), without query string or fragment, and asked of the
 * network policy first. The homepage may redirect to one other registrable
 * domain (fb.com → facebook.com), which then counts as the site.
 */
import { iconLinks, rankIcons } from "./html";
import { readIcon, type IconImage } from "./image";
import { IconNetworkError, type IconResponse, type IconTransport } from "./transport";

export interface FetchedIcon {
  image: IconImage;
  /** made to fill a tile edge to edge (an apple-touch-icon) */
  full: boolean;
}

export interface SiteFetchDeps {
  transport: IconTransport;
  /** the network policy (purpose "icons"): throws when the request isn't allowed */
  assert(url: URL): Promise<void>;
  registrable(host: string): string | null;
  signal: AbortSignal;
  timeoutMs?: number;
  budgetMs?: number;
  now?: () => number;
}

const MAX_HOPS = 3;
const PAGE_BYTES = 256 * 1024;
const IMAGE_BYTES = 256 * 1024;
const IMAGE_ACCEPT = "image/png,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/jpeg;q=0.8";
const MAX_CANDIDATES = 2;

/** A request the rules refuse (not a network failure: no icon from there). */
class Refused extends Error {}

/** The site's best icon; null when it has none Terno accepts. Throws IconNetworkError when the site couldn't be reached. */
export async function fetchSiteIcon(domain: string, deps: SiteFetchDeps): Promise<FetchedIcon | null> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.budgetMs ?? 12_000;
  const perRequest = deps.timeoutMs ?? 5_000;
  const sites = new Set([domain]);
  let crossed = false;

  const allowed = (url: URL, page: boolean): boolean => {
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
    const host = url.hostname;
    if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false;
    const site = deps.registrable(host);
    if (!site) return false;
    if (sites.has(site)) return true;
    // the homepage may move to one other site, once
    if (page && !crossed) {
      crossed = true;
      sites.add(site);
      return true;
    }
    return false;
  };

  async function get(first: URL, accept: string, maxBytes: number, page: boolean): Promise<{ res: IconResponse; url: URL }> {
    let url = first;
    for (let hop = 0; ; hop++) {
      url = new URL(url);
      url.search = "";
      url.hash = "";
      if (!allowed(url, page)) throw new Refused();
      const left = budget - (now() - started);
      if (left <= 0) throw new IconNetworkError("timeout", "out of time");
      await deps.assert(url);
      const res = await deps.transport.get({ url, accept, maxBytes, timeoutMs: Math.min(perRequest, left), signal: deps.signal });
      if (res.status >= 300 && res.status < 400 && res.location) {
        if (hop >= MAX_HOPS) throw new Refused();
        try {
          url = new URL(res.location, url);
        } catch {
          throw new Refused();
        }
        continue;
      }
      return { res, url };
    }
  }

  /** an image request: the icon, or null (refused, missing, too large, not an image Terno accepts) */
  async function image(url: URL): Promise<IconImage | null> {
    try {
      const { res } = await get(url, IMAGE_ACCEPT, IMAGE_BYTES, false);
      if (!res.bytes) return null;
      const icon = readIcon(res.bytes);
      return typeof icon === "string" ? null : icon;
    } catch (error) {
      if (error instanceof Refused || (error instanceof IconNetworkError && error.kind === "address")) return null;
      throw error;
    }
  }

  let base = new URL(`https://${domain}/`);
  try {
    const { res, url } = await get(base, "text/html,application/xhtml+xml", PAGE_BYTES, true);
    base = url;
    if (res.bytes) {
      const html = new TextDecoder().decode(res.bytes);
      const candidates = rankIcons(iconLinks(html, url)).filter((l) => {
        const site = deps.registrable(l.url.hostname);
        return site !== null && sites.has(site);
      });
      for (const link of candidates.slice(0, MAX_CANDIDATES)) {
        const icon = await image(link.url);
        if (icon) return { image: icon, full: link.rel === "apple-touch-icon" };
      }
    }
  } catch (error) {
    if (!(error instanceof Refused || (error instanceof IconNetworkError && error.kind === "address"))) throw error;
  }
  const ico = await image(new URL("/favicon.ico", base));
  return ico ? { image: ico, full: false } : null;
}
