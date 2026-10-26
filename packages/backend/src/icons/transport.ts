/**
 * How the icon fetcher reaches a site (plan 22). One GET, no redirects
 * followed (the fetcher checks every hop), no cookies, no referrer, no
 * credentials, the body read up to a cap. The Node host's implementation is
 * node-transport.ts; tests and backend-dev pass their own.
 */
export interface IconRequest {
  url: URL;
  accept: string;
  /** a body longer than this is not read: `tooLarge` */
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface IconResponse {
  status: number;
  /** a redirect's Location, as sent */
  location: string | null;
  /** null for redirects and errors, and when the body was too large */
  bytes: Uint8Array | null;
  tooLarge: boolean;
}

export interface IconTransport {
  get(request: IconRequest): Promise<IconResponse>;
}

/** Couldn't talk to the site: retried once the network changes (never cached as "no icon"), except a timeout twice in a row. */
export class IconNetworkError extends Error {
  constructor(
    readonly kind: "timeout" | "network" | "address",
    message: string,
  ) {
    super(message);
    this.name = "IconNetworkError";
  }
}

/** Every request looks like any browser's and says nothing about the user. */
export const ICON_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "accept-language": "en",
  "accept-encoding": "identity",
} as const;

const v4 = (ip: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
};

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false; // CGNAT (Tailscale and carriers)
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/**
 * Whether an address is on the public internet: a sender's domain must never
 * make Terno probe this Mac, its LAN, a VPN or a carrier's private range.
 */
export function isPublicAddress(ip: string): boolean {
  const four = v4(ip);
  if (four) return publicV4(four);
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!v.includes(":")) return false;
  const mapped = /^(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return publicV4(v4(mapped[1]!) ?? [0]);
  if (v === "::" || v === "::1") return false;
  const first = Number.parseInt(v.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (v.startsWith("2001:db8:") || v.startsWith("100::") || v.startsWith("::")) return false;
  return true;
}
