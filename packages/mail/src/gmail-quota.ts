// Gmail's per-user quota for projects created since May 2026: 6,000 units a minute, and a full
// (raw) message read costs 60, so about 100 messages a minute. Going faster only earns 403s
// that pause the account (plan 62); this paces every Gmail call just under the limit instead.
// https://developers.google.com/workspace/gmail/api/reference/quota

/** units a second: 5,100 a minute, so a full burst plus a minute of pacing stays within 6,000 */
export const GMAIL_UNITS_PER_SECOND = 85;
/** what may go at once after a quiet spell (an everyday sync never waits) */
export const GMAIL_BURST_UNITS = 900;
/** a wait ending later than this past its slot (a suspended Mac, a starved timer) spends again */
const LATE_MS = 1000;

/** What a Gmail API request costs in quota units (Google's table; unknown calls count as a list). */
export function gmailUnits(path: string, method = "GET"): number {
  if (path.startsWith("https://")) return 0; // People API and userinfo: not Gmail's quota
  const [route = "", query = ""] = path.split("?");
  const format = /(?:^|&)format=([a-z]+)/.exec(query)?.[1];
  if (route === "/messages/send") return 100;
  if (route === "/messages/batchModify") return 50;
  if (route === "/messages/batchDelete") return 50;
  if (/^\/messages\/[^/]+\/attachments\/[^/]+$/.test(route)) return 20;
  if (route === "/messages/import" || route === "/messages") return method === "POST" ? 25 : 5;
  if (route === "/watch") return 100;
  if (/^\/messages\/[^/]+\/trash$/.test(route)) return 20;
  if (/^\/messages\/[^/]+\/(?:modify|untrash)$/.test(route)) return 5;
  // no format is "full"; minimal and metadata cost 20
  if (/^\/messages\/[^/]+$/.test(route)) return method === "DELETE" ? 10 : format === "minimal" || format === "metadata" ? 20 : 60;
  if (/^\/threads\/[^/]+$/.test(route)) return format === "full" ? 120 : 40;
  if (route === "/history") return 2;
  if (route === "/labels" || route.startsWith("/labels/") || route === "/profile") return 1;
  return 5;
}

export interface QuotaPacer {
  /** waits until `units` may be spent (at once within the burst); rejects with the signal's reason */
  spend(units: number, signal?: AbortSignal): Promise<void>;
  /** counts units that must not wait (a send the user asked for) */
  charge(units: number): void;
  /** never waits (callers skip it) */
  readonly unpaced?: true;
}

/**
 * A generic cell rate limiter over quota units: a theoretical arrival time advanced by each spend's
 * cost, with the burst as tolerance. Units of a spend whose wait is aborted stay counted (that only
 * ever slows the next call, never speeds it).
 */
export function createQuotaPacer(o: { perSecond?: number; burst?: number; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}): QuotaPacer {
  const perSecond = o.perSecond ?? GMAIL_UNITS_PER_SECOND;
  if (!(perSecond > 0) || perSecond === Infinity) return { spend: async (_units, signal) => signal?.throwIfAborted(), charge() {}, unpaced: true };
  const msPerUnit = 1000 / perSecond;
  const tolerance = (o.burst ?? GMAIL_BURST_UNITS) * msPerUnit;
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? abortableSleep;
  let arrival = -Infinity;
  const advance = (units: number) => {
    const t = now();
    arrival = Math.max(arrival, t) + units * msPerUnit;
    return arrival - tolerance - t;
  };
  return {
    async spend(units, signal) {
      signal?.throwIfAborted();
      let wait = advance(units);
      while (wait > 0) {
        const slot = now() + wait;
        await sleep(wait, signal);
        // late: the bucket refilled meanwhile, and going now beside a fresh burst would overspend
        if (now() - slot <= LATE_MS) return;
        wait = advance(units);
      }
    },
    charge(units) { advance(units); },
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
