import { ProviderCooldownError, RequestNotDispatchedError, requestHttp, type ProviderRequests, type RequestDescriptor } from "@terno/mail/portable";
import { textRef, type TextRef } from "@terno/core";
import { L, type Localized } from "@terno/i18n";

/**
 * Why a connection is being made. Every outbound call path names its purpose
 * and goes through this module (an architecture test enforces it), so local
 * mode is one decision in one place instead of a convention.
 */
export type NetPurpose = "mail" | "ai" | "remote-content" | "telemetry" | "update" | "cloud" | "icons" | "unsubscribe";

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
  fetchGoogle(policy: ProviderRequests, descriptor: RequestDescriptor): typeof fetch;
  googlePending(): number;
  googleAvailable(admission?: RequestDescriptor["admission"]): boolean;
}

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

export interface NetworkPolicyOptions {
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
  /** plan 161: every decision, allowed or refused, for a test host that proves where requests went (never set in a release) */
  observe?: (decision: NetDecision) => void;
}

/** One connection the policy was asked about: its purpose, where it was going, and whether it may. */
export interface NetDecision {
  purpose: NetPurpose;
  url: string;
  allowed: boolean;
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

/** How long a retired Google response (admission refused it after headers) may take to reach EOF before it's cancelled. */
export const RETIRED_DRAIN_MS = 30_000;
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
  let backgroundPending = 0, foregroundPending = 0;
  const available = (admission?: RequestDescriptor["admission"]) => googlePending < 64 && (admission === "background" ? backgroundPending < 62 : admission ? foregroundPending < 2 : true);
  const availability = () => [available(), available("background"), available("reader")].join();
  /**
   * Plan 262: a Google slot counts a fetch that hasn't completed, and comes back when it does: the fetch rejects, or its
   * native body ends (EOF, an error, or a cancel once the cancel settles). An abort is one of those: the Fetch Standard
   * has an aborted signal reject a pending fetch and error a streaming body, and a body's cancel abort the fetch. Plan
   * 62 kept the slot after an abort; that leaked one per deadline or network reset, and after 62 of them background
   * sync was refused for the rest of the run. The tracker owns the native reader from the moment headers arrive, so
   * an abort or a native end is seen while nobody reads (admission may still be deciding, or the caller idle).
   */
  const track = (request: Request, reader: ReadableStreamDefaultReader<Uint8Array>, release: () => void) => {
    let cancelling: Promise<void> | undefined;
    let settled = false, finished = false;
    const ends = new Set<(error?: unknown) => void>();
    const finish = (failure: boolean, error?: unknown) => {
      if (finished) return;
      finished = true;
      request.signal.removeEventListener("abort", onAbort);
      release();
      for (const listener of ends) listener(failure ? error ?? new TypeError("Provider response failed") : undefined);
    };
    // one cancel for every path: a second would resolve at once against the closed stream, before the first settled
    const cancel = (reason: unknown) => (cancelling ??= reader.cancel(reason).catch(() => {}));
    // queued after the reactions already pending: a native EOF or error that came first stays the end (never the abort)
    function onAbort() { void Promise.resolve().then(() => { if (!settled) void cancel(request.signal.reason); }); }
    // a cancel closes the stream before the transport's cancel settles: a close while cancelling waits for it
    const ended = (failure: boolean, error?: unknown) => {
      settled = true;
      if (cancelling) void cancelling.then(() => finish(true, request.signal.aborted ? request.signal.reason : new DOMException("Provider request ended", "AbortError")));
      else finish(failure, error);
    };
    reader.closed.then(() => ended(false), (error: unknown) => ended(true, error));
    if (request.signal.aborted) void cancel(request.signal.reason);
    else request.signal.addEventListener("abort", onAbort, { once: true });
    return {
      reader, cancel,
      get cancelled() { return cancelling !== undefined; },
      /** the native end, once: undefined for EOF, the error (or the abort) otherwise */
      onEnd(listener: (error?: unknown) => void) { ends.add(listener); },
    };
  };
  type Tracked = ReturnType<typeof track>;

  const physical = (request: Request, tracked: Tracked, response: Response): Response => {
    const { reader } = tracked;
    let outward!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false, pulling = false;
    const close = (error?: unknown) => {
      if (closed) return;
      closed = true;
      try { if (error === undefined) outward.close(); else outward.error(error); } catch { /* already cancelled by the caller */ }
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) { outward = controller; },
      async pull(controller) {
        pulling = true;
        try {
          const chunk = await reader.read();
          if (!chunk.done) { controller.enqueue(chunk.value); return; }
          // a body cancelled under the caller (its request aborted) ends as the abort, never as a complete body
          close(tracked.cancelled ? (request.signal.aborted ? request.signal.reason : new DOMException("Provider request ended", "AbortError")) : undefined);
        } catch (error) {
          close(error);
        } finally { pulling = false; }
      },
      // an over-limit control body is cancelled at once too: draining its tail could wait on a stalled server for good
      cancel: (reason) => { closed = true; return tracked.cancel(reason); },
    }, { highWaterMark: 0 });
    // The native end reaches a caller that isn't reading (its reader.closed settles). With a read in flight the read
    // carries it: a stream closes before the read that emptied it delivers its last chunk, so closing here would drop it.
    tracked.onEnd((error) => { if (!pulling) close(error); });
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
      const allowed = !!(await options.siteIcons?.());
      options.observe?.({ purpose, url: url.href, allowed });
      if (!allowed) throw new NetworkPolicyError(L("errors.net.iconsOff", { host: url.host }), purpose, url.host);
      return {};
    }
    options.observe?.({ purpose, url: url.href, allowed: true });
    // plan 97: everything else is the feature's own decision (AI: the provider the user chose; updates: their
    // setting; an unsubscribe: their click); local mode means Terno keeps its copy of the mail here, nothing more
    void meta;
    return {};
  }

  return {
    assert,
    googlePending: () => googlePending,
    googleAvailable: available,
    fetchGoogle(policy, descriptor) {
      return (input, init) => {
        // Snapshot mutable init/Headers/body before the first asynchronous policy step.
        const request = new NativeRequest(input, { ...init, redirect: "error" });
        const run = async () => {
          await assert("mail", new URL(request.url));
          let tracked: Tracked | undefined;
          // A response's slot waits for the ticket to observe it (a 429's pause is installed, a 403 classified) or for
          // the request to be aborted: a body that ends first mustn't hand its slot to a request the pause would refuse.
          let observed = false, over = false, give: (() => void) | undefined;
          const settle = () => { if (over && (observed || request.signal.aborted)) give?.(); };
          const observe = () => { observed = true; request.signal.removeEventListener("abort", settle); settle(); };
          const ticketed: ProviderRequests = { ...policy, reserve: (input) => {
            const ticket = policy.reserve(input);
            return { ...ticket,
              headers429: (evidence) => { try { return ticket.headers429(evidence); } finally { observe(); } },
              headers: (status) => { try { ticket.headers(status); } finally { observe(); } },
              release: () => { try { ticket.release(); } finally { observe(); } },
            };
          } };
          try {
            const response = await requestHttp(ticketed, descriptor, () => {
              if (request.signal.aborted) throw new RequestNotDispatchedError(L("errors.accountGone"));
              if (!available(descriptor.admission)) throw new ProviderCooldownError(descriptor.request.endpoint, "0", "capacity");
              const before = availability();
              googlePending++;
              if (descriptor.admission === "background") backgroundPending++;
              else if (descriptor.admission) foregroundPending++;
              let released = false;
              const free = give = () => {
                if (released) return;
                released = true;
                request.signal.removeEventListener("abort", settle);
                const before = availability();
                googlePending--;
                if (descriptor.admission === "background") backgroundPending--;
                else if (descriptor.admission) foregroundPending--;
                if (before !== availability()) options.googleChanged?.();
              };
              let sent: Promise<Response>;
              // nothing between the count and the fetch may strand the slot, a synchronous throw included
              try {
                if (before !== availability()) options.googleChanged?.();
                sent = baseFetch(request);
              } catch (error) { free(); throw error; }
              return sent.then((response) => {
                const done = () => { over = true; settle(); };
                if (!observed) request.signal.addEventListener("abort", settle, { once: true });
                // Hold the native body until admission publishes or rejects the response; a bodyless one is over.
                if (response.body) tracked = track(request, response.body.getReader(), done);
                else done();
                return response;
              }, (error: unknown) => {
                free();
                throw error;
              });
            }, Date.now);
            return tracked ? physical(request, tracked, response) : response;
          } catch (error) {
            // a retired response is read to its end (EOF rather than a reset), within a bound: a stalled body is cancelled
            const owned = tracked;
            if (owned) {
              const timer = setTimeout(() => void owned.cancel(new DOMException("Retired response not finished", "TimeoutError")), RETIRED_DRAIN_MS);
              void (async () => {
                try { while (!(await owned.reader.read()).done) { /* discard without buffering */ } }
                catch { /* the tracker saw the end */ }
                finally { clearTimeout(timer); owned.reader.releaseLock(); }
              })();
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
    fetchFor(purpose, meta) {
      const policed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        // Request objects carry a one-shot body: normalise to url + init so a redirect can be re-sent.
        let url = requestUrl(input);
        let request: RequestInit = input instanceof NativeRequest ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, duplex: "half", ...init } as RequestInit : { ...init };
        // the SDKs' own redirect mode is never trusted: an AI key doesn't follow any redirect, here or in a browser
        const keyed = purpose === "ai" && carriesCredential(request.headers);
        // plan 125: a caller that refuses redirects (a token in the body: Google's revoke) gets none, on any hop
        const refuses = request.redirect === "error";
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
            // plan 96: an unsubscribe request goes where the mail said and nowhere else (a redirect comes back opaque);
            // a keyed AI request was refused above
            return baseFetch(url, { ...request, redirect: purpose === "unsubscribe" ? "manual" : refuses ? "error" : "follow" });
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
          if (keyed || refuses) throw redirectRefused(purpose, url, new URL(location, url));
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

