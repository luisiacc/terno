/**
 * Plan 22: website icons for E2E without the internet. The backend's real fetcher runs against
 * this transport: a few seeded senders' sites have icons (a full-bleed touch icon, a sized PNG,
 * a tiny 16 px favicon), every other site answers 404. Every request is recorded.
 */
import type { IconRequest, IconResponse, IconTransport } from "../../../packages/backend/src/icons/transport";
import { pngBytes } from "../../../packages/backend/src/test/icons-fixtures";

type Rgba = [number, number, number, number];
const SITES: Record<string, { touch?: Rgba; favicon?: { px: number; rgba: Rgba } }> = {
  "github.com": { touch: [36, 41, 47, 255] },
  "stripe.com": { touch: [99, 91, 255, 255] },
  "figma.com": { favicon: { px: 64, rgba: [242, 78, 30, 255] } },
  "linear.app": { favicon: { px: 64, rgba: [94, 106, 210, 255] } },
  "vercel.com": { touch: [0, 0, 0, 255] },
  "spotify.com": { favicon: { px: 16, rgba: [30, 215, 96, 255] } },
  "uber.com": { favicon: { px: 32, rgba: [0, 0, 0, 255] } },
  "xataka.com": { favicon: { px: 48, rgba: [229, 9, 20, 255] } },
  "substack.com": { favicon: { px: 64, rgba: [255, 103, 25, 255] } },
  "platzi.com": { touch: [152, 202, 63, 255] },
};

export interface IconStub extends IconTransport {
  readonly requests: string[];
  /** the ui-perf test: every site has an icon (its own color) */
  everySite: boolean;
  /** while set, answers wait for it (icons arrive when the test says) */
  hold: Promise<void> | null;
}

export function iconStub(): IconStub {
  const requests: string[] = [];
  const bytes = new Map<string, Uint8Array>();
  const png = (key: string, px: number, rgba: Rgba) => {
    let b = bytes.get(key);
    if (!b) bytes.set(key, (b = pngBytes(px, px, rgba)));
    return b;
  };
  const stub: IconStub = {
    requests,
    everySite: false,
    hold: null,
    async get(r: IconRequest): Promise<IconResponse> {
      requests.push(r.url.href);
      if (stub.hold) await stub.hold;
      const host = r.url.hostname.replace(/^www\./, "");
      const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 255, 7);
      const site = SITES[host] ?? (stub.everySite ? { favicon: { px: 64, rgba: [hue, 255 - hue, 120, 255] as Rgba } } : undefined);
      const ok = (b: Uint8Array): IconResponse => ({ status: 200, location: null, bytes: b, tooLarge: false });
      if (site && r.url.pathname === "/") return ok(new TextEncoder().encode(site.touch ? `<head><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head>` : "<head></head>"));
      if (site?.touch && r.url.pathname === "/apple-touch-icon.png") return ok(png(`${r.url.hostname}:t`, 180, site.touch));
      if (site?.favicon && r.url.pathname === "/favicon.ico") return ok(png(`${r.url.hostname}:f`, site.favicon.px, site.favicon.rgba));
      return { status: 404, location: null, bytes: null, tooLarge: false };
    },
  };
  return stub;
}
