import { ProviderCooldownError, RequestNotDispatchedError, requestHttp, type ProviderRequests, type RequestDescriptor } from "@terno/mail/portable";
import { textRef, type TextRef } from "@terno/core";
import { L, type Localized } from "@terno/i18n";

/**
 * Why a connection is being made. Every outbound call path names its purpose
 * and goes through this module (an architecture test enforces it), so local
 * mode is one decision in one place instead of a convention.
 */
export type NetPurpose = "mail" | "ai" | "remote-content" | "telemetry" | "update" | "cloud" | "icons";

export interface NetMeta {
  /** declared locality of the AI provider making the call */
  providerLocality?: "local" | "cloud";
}

export class NetworkPolicyError extends Error {
  /** a policy decision (local mode), not a failure */
  readonly expected = true;
  /** set when the message is a catalog message (L()): the renderer translates it */
  readonly i18n?: TextRef;
  constructor(
    message: string | Localized,
    readonly purpose: NetPurpose,
    readonly host: string,
  ) {
    super(typeof message === "string" ? message : message.message);
    this.name = "NetworkPolicyError";
    const i18n = textRef(message);
    if (i18n) this.i18n = i18n;
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
  fetchGoogle(policy: ProviderRequests, descriptor: RequestDescriptor): typeof fetch;
  googlePending(): number;
}

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

export interface NetworkPolicyOptions {
  localMode: () => boolean | Promise<boolean>;
  /**
   * Plan 22: website icons are allowed (the setting: in connected mode unless turned off, in local
   * mode only when the user turned them on). Without it, never.
   */
  siteIcons?: () => boolean | Promise<boolean>;
  /**
   * DNS (Node: dns.lookup; tests resolve names without real DNS). Browsers
   * have none: then only literal loopback hosts (127.x, ::1, localhost) count
   * as local, nothing is pinned, and policed requests refuse redirects,
   * because a browser hides where a redirect goes.
   */
  lookup?: LookupAll;
  fetch?: typeof fetch;
  googleChanged?: () => void;
}

/** 4 or 6 for an IP literal, 0 otherwise (node:net's isIP, portably). */
export function ipFamily(host: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) return 4;
  if (!host.includes(":") || !/^[0-9a-f:.]+$/i.test(host)) return 0;
  try {
    return new URL(`http://[${host}]/`).hostname ? 6 : 0;
  } catch {
    return 0;
  }
}

/** Without DNS: a browser resolves localhost and *.localhost to loopback itself (and nothing else is knowable). */
const literalLookup: LookupAll = async (host) => (host === "localhost" || host.endsWith(".localhost") ? [{ address: "127.0.0.1", family: 4 }] : []);

export function isLoopbackIp(ip: string): boolean {
  const v = ip.toLowerCase();
  return v === "::1" || /^127\.\d+\.\d+\.\d+$/.test(v) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(v);
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
/** Every header a credential travels in: Bearer keys (OpenAI-style APIs, Anthropic), Azure's api-key, x-api-key, cookies. */
const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"];

function carriesCredential(headers: RequestInit["headers"]): boolean {
  const h = new Headers(headers);
  return SENSITIVE_HEADERS.some((name) => h.has(name));
}

/**
 * An AI request that carries a key is never redirected: the key is bound to
 * the origin it was saved for, and a browser re-sends custom headers
 * (api-key, x-api-key) to wherever a cross-origin 307/308 points.
 */
function redirectRefused(purpose: NetPurpose, from: URL, to: URL | null): NetworkPolicyError {
  return new NetworkPolicyError(to ? L("errors.net.redirect", { from: from.host, to: to.host }) : L("errors.net.redirectNowhere", { from: from.host }), purpose, from.host);
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(String(input));
  return new URL(input.url);
}

export function createNetworkPolicy(options: NetworkPolicyOptions): NetworkPolicy {
  const browser = !options.lookup;
  const lookup = options.lookup ?? literalLookup;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const NativeRequest = globalThis.Request;
  const NativeResponse = globalThis.Response;

  let googlePending = 0;
  const physical = (request: Request, release: () => void) => (response: Response): Response => {
    if (!response.body) { release(); return response; }
    const reader = response.body.getReader();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (!cancelled && !request.signal.aborted) release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          if (!cancelled && !request.signal.aborted) release();
          controller.error(error);
        }
      },
      cancel(reason) {
        cancelled = true;
        // A control-body limit may leave a small tail. Only native EOF/error proves termination;
        // ordinary cancellation (including abort) still retains the physical capacity slot.
        if (reason instanceof Error && reason.name === "ResponseBodyLimitError") {
          return (async () => {
            let bytes = 0;
            try {
              for (let chunks = 0; chunks < 32 && bytes < 256 * 1024 && !request.signal.aborted; chunks++) {
                const chunk = await reader.read();
                if (chunk.done) { if (!request.signal.aborted) release(); return; }
                bytes += chunk.value.byteLength;
              }
            } catch { if (!request.signal.aborted) release(); return; }
            await reader.cancel(reason);
          })();
        }
        return reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    return new NativeResponse(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  /** The IP to connect to when every address of the host is loopback, else null. */
  async function loopbackTarget(hostname: string): Promise<string | null> {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (ipFamily(host)) return isLoopbackIp(host) ? host : null;
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
    // sender icons are their own decision in both modes: the user's explicit choice in local mode
    if (purpose === "icons") {
      if (!(await options.siteIcons?.())) throw new NetworkPolicyError(L("errors.net.iconsOff", { host: url.host }), purpose, url.host);
      return {};
    }
    if (purpose === "mail" || !(await options.localMode())) return {};
    if (purpose !== "ai") throw new NetworkPolicyError(L("errors.net.localModeBlocks", { purpose, host: url.host }), purpose, url.host);
    if (meta.providerLocality !== "local") {
      throw new NetworkPolicyError(L("errors.net.localModeCloudAi", { host: url.host }), purpose, url.host);
    }
    const ip = await loopbackTarget(url.hostname);
    if (!ip) throw new NetworkPolicyError(L("errors.net.localModeNotLocal", { host: url.hostname }), purpose, url.host);
    return { pinnedHost: ip };
  }

  return {
    assert,
    googlePending: () => googlePending,
    fetchGoogle(policy, descriptor) {
      return (input, init) => {
        // Snapshot mutable init/Headers/body before the first asynchronous policy step.
        const request = new NativeRequest(input, { ...init, redirect: "error" });
        const run = async () => {
          await assert("mail", new URL(request.url));
          let release: (() => void) | undefined;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let received = false;
          let hasBody = false;
          try {
            const response = await requestHttp(policy, descriptor, () => {
              if (request.signal.aborted) throw new RequestNotDispatchedError(L("errors.accountGone"));
              if (googlePending >= 64) throw new ProviderCooldownError(descriptor.request.endpoint, "0", "capacity");
              googlePending++;
              if (googlePending === 64) options.googleChanged?.();
              let released = false;
              release = () => {
                if (released) return;
                released = true;
                const wasFull = googlePending === 64;
                googlePending--;
                if (wasFull) options.googleChanged?.();
              };
              return baseFetch(request).then((response) => {
                received = true;
                hasBody = response.body !== null;
                // Hold the native body until admission publishes or rejects the response.
                reader = response.body?.getReader();
                return response;
              }, (error: unknown) => {
                if (!request.signal.aborted) release!();
                throw error;
              });
            }, Date.now);
            reader?.releaseLock();
            return physical(request, release!)(response);
          } catch (error) {
            if (received) {
              if (reader) {
                const owned = reader;
                void (async () => {
                  try { while (!(await owned.read()).done) { /* discard without buffering */ } }
                  catch { /* A non-aborted read failure is terminal. */ }
                  finally {
                    owned.releaseLock();
                    if (!request.signal.aborted) release!();
                  }
                })();
              } else if (!hasBody && !request.signal.aborted) release!();
            }
            throw error;
          }
        };
        return run();
      };
    },
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
        let request: RequestInit = input instanceof NativeRequest ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init } as RequestInit : { ...init };
        // the SDKs' own redirect mode is never trusted: an AI key doesn't follow any redirect, here or in a browser
        const keyed = purpose === "ai" && carriesCredential(request.headers);
        for (let hop = 0; ; hop++) {
          const { pinnedHost } = await assert(purpose, url, meta);
          if (browser) {
            if (keyed) {
              // a browser hides where a redirect goes (an opaque response): enough to refuse it, with the key not re-sent
              const res = await baseFetch(url, { ...request, redirect: "manual" });
              if (res.type === "opaqueredirect" || REDIRECT_STATUS.has(res.status)) {
                await res.body?.cancel();
                throw redirectRefused(purpose, url, null);
              }
              return res;
            }
            // no pinning and no manual redirects in a browser (they come back opaque): a vetted request may not be redirected at all
            const vetted = purpose === "ai" && (await options.localMode());
            return baseFetch(url, { ...request, redirect: vetted ? "error" : "follow" });
          }
          const target = new URL(url);
          // Connect to the address we just checked, so a DNS answer can't change between check and connect.
          if (pinnedHost) target.hostname = pinnedHost.includes(":") ? `[${pinnedHost}]` : pinnedHost;
          // Never let fetch follow a redirect on its own: every hop must pass the policy (a loopback
          // server could otherwise forward the prompt to any host).
          const res = await baseFetch(target, { ...request, redirect: "manual" });
          const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
          if (!location) return res;
          await res.body?.cancel();
          if (keyed) throw redirectRefused(purpose, url, new URL(location, url));
          if (hop >= MAX_REDIRECTS) throw new TypeError(`Too many redirects (${url.host})`);
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

