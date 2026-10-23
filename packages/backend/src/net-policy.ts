import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Why a connection is being made. Every outbound call path names its purpose
 * and goes through this module (an architecture test enforces it), so local
 * mode is one decision in one place instead of a convention.
 */
export type NetPurpose = "mail" | "ai" | "remote-content" | "telemetry" | "update" | "cloud";

export interface NetMeta {
  /** declared locality of the AI provider making the call */
  providerLocality?: "local" | "cloud";
}

export class NetworkPolicyError extends Error {
  constructor(
    message: string,
    readonly purpose: NetPurpose,
    readonly host: string,
  ) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export interface NetworkPolicy {
  /** Throws NetworkPolicyError when the connection is not allowed; for local AI returns the loopback IP to connect to. */
  assert(purpose: NetPurpose, url: string | URL, meta?: NetMeta): Promise<{ pinnedHost?: string }>;
  /** A fetch that asserts every request (and pins local AI to the IP it checked) before any socket opens. */
  fetchFor(purpose: NetPurpose, meta?: NetMeta): typeof fetch;
  /** whether every address of the URL's host is loopback (what local mode would accept for AI) */
  isLoopbackEndpoint(url: string): Promise<boolean>;
  isLocalMode(): Promise<boolean>;
}

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

export interface NetworkPolicyOptions {
  localMode: () => boolean | Promise<boolean>;
  /** injectable for tests (resolve a name to a LAN address without real DNS) */
  lookup?: LookupAll;
  fetch?: typeof fetch;
}

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true });

export function isLoopbackIp(ip: string): boolean {
  const v = ip.toLowerCase();
  return v === "::1" || /^127\.\d+\.\d+\.\d+$/.test(v) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(v);
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"];

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(String(input));
  return new URL(input.url);
}

export function createNetworkPolicy(options: NetworkPolicyOptions): NetworkPolicy {
  const lookup = options.lookup ?? defaultLookup;
  const baseFetch = options.fetch ?? globalThis.fetch;

  /** The IP to connect to when every address of the host is loopback, else null. */
  async function loopbackTarget(hostname: string): Promise<string | null> {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return isLoopbackIp(host) ? host : null;
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host);
    } catch {
      return null;
    }
    if (addresses.length === 0 || !addresses.every((a) => isLoopbackIp(a.address))) return null;
    // Local servers (Ollama, LM Studio) bind 127.0.0.1 by default: prefer IPv4 when both exist.
    return (addresses.find((a) => !a.address.includes(":")) ?? addresses[0]!).address;
  }

  async function assert(purpose: NetPurpose, target: string | URL, meta: NetMeta = {}): Promise<{ pinnedHost?: string }> {
    const url = new URL(String(target));
    if (purpose === "mail" || !(await options.localMode())) return {};
    if (purpose !== "ai") throw new NetworkPolicyError(`El modo local bloquea las conexiones de tipo «${purpose}» (${url.host}).`, purpose, url.host);
    if (meta.providerLocality !== "local") {
      throw new NetworkPolicyError(`El modo local no permite IA en la nube (${url.host}). Desactívalo en Ajustes → General para usarla.`, purpose, url.host);
    }
    const ip = await loopbackTarget(url.hostname);
    if (!ip) throw new NetworkPolicyError(`El modo local solo permite IA en este Mac; ${url.hostname} no es una dirección local.`, purpose, url.host);
    return { pinnedHost: ip };
  }

  return {
    assert,
    async isLoopbackEndpoint(url) {
      try {
        return (await loopbackTarget(new URL(url).hostname)) !== null;
      } catch {
        return false;
      }
    },
    async isLocalMode() {
      return options.localMode();
    },
    fetchFor(purpose, meta) {
      const policed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        // Request objects carry a one-shot body: normalise to url + init so a redirect can be re-sent.
        let url = requestUrl(input);
        let request: RequestInit = input instanceof Request ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init } as RequestInit : { ...init };
        for (let hop = 0; ; hop++) {
          const { pinnedHost } = await assert(purpose, url, meta);
          const target = new URL(url);
          // Connect to the address we just checked, so a DNS answer can't change between check and connect.
          if (pinnedHost) target.hostname = pinnedHost.includes(":") ? `[${pinnedHost}]` : pinnedHost;
          // Never let fetch follow a redirect on its own: every hop must pass the policy (a loopback
          // server could otherwise forward the prompt to any host).
          const res = await baseFetch(target, { ...request, redirect: "manual" });
          const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
          if (!location) return res;
          if (hop >= MAX_REDIRECTS) throw new TypeError(`Too many redirects (${url.host})`);
          await res.body?.cancel();
          const next = new URL(location, url);
          if (next.origin !== url.origin) {
            // as fetch itself does across origins: credentials never follow a redirect to another host
            const headers = new Headers(request.headers);
            for (const h of SENSITIVE_HEADERS) headers.delete(h);
            request = { ...request, headers };
          }
          url = next;
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && request.method && request.method !== "GET" && request.method !== "HEAD")) {
            request = { ...request, method: "GET", body: undefined };
          } else if (request.body instanceof ReadableStream) {
            throw new TypeError("Cannot re-send a streamed body across a redirect");
          }
        }
      };
      return policed as typeof fetch;
    },
  };
}

