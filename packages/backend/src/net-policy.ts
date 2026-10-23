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
  readonly localMode: boolean;
}

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

export interface NetworkPolicyOptions {
  localMode: () => boolean;
  /** injectable for tests (resolve a name to a LAN address without real DNS) */
  lookup?: LookupAll;
  fetch?: typeof fetch;
}

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true });

export function isLoopbackIp(ip: string): boolean {
  const v = ip.toLowerCase();
  return v === "::1" || /^127\.\d+\.\d+\.\d+$/.test(v) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(v);
}

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
    if (purpose === "mail" || !options.localMode()) return {};
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
    get localMode() {
      return options.localMode();
    },
    fetchFor(purpose, meta) {
      const policed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = requestUrl(input);
        const { pinnedHost } = await assert(purpose, url, meta);
        if (!pinnedHost) return baseFetch(input, init);
        // Connect to the address we just checked, so a DNS answer can't change between check and connect.
        url.hostname = pinnedHost.includes(":") ? `[${pinnedHost}]` : pinnedHost;
        if (typeof input === "string" || input instanceof URL) return baseFetch(url, init);
        return baseFetch(new Request(url, input), init);
      };
      return policed as typeof fetch;
    },
  };
}

