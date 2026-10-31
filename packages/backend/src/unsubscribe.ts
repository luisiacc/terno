import { RpcError } from "@terno/core/rpc";
import { unsubscribeOffer, unsubscribePlan, type UnsubscribeOffer, type UnsubscribeOutcome } from "@terno/core";
import { L } from "@terno/i18n";
import type { MailStore } from "@terno/store";
import { isPublicAddress } from "./icons/transport";
import { ipFamily } from "./net-policy";

/**
 * Plan 94: how a one-click unsubscribe (RFC 8058) reaches the sender. One POST of
 * `List-Unsubscribe=One-Click`, no cookies, no referrer, no redirect followed, the answer's
 * body never read. `opaque`: the request went out but its answer can't be seen (a browser).
 */
export interface UnsubscribeTransport {
  post(url: URL, signal: AbortSignal): Promise<{ status: number } | { opaque: true }>;
}

export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
export const UNSUBSCRIBE_TIMEOUT_MS = 10_000;

/** Names that only ever mean this machine or its network (a browser can't resolve them to check). */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/i;

/**
 * Where a one-click POST may go, checked before any request: https on the default port, no
 * credentials, and never this Mac or its networks by address or by a local name. (Names are
 * checked again by the Node transport's lookup, which also pins the address it checked.)
 */
export function postAllowed(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (ipFamily(host)) return isPublicAddress(host);
  return host.includes(".") && !LOCAL_NAME.test(host);
}

/** The web's transport: a no-cors form POST through the network policy (its answer is opaque: "requested"). */
export function browserUnsubscribeTransport(policed: typeof fetch): UnsubscribeTransport {
  return {
    async post(url, signal) {
      const res = await policed(url, { method: "POST", mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { "content-type": "application/x-www-form-urlencoded" }, body: ONE_CLICK_BODY, signal });
      await res.body?.cancel();
      return res.type === "opaque" || res.type === "opaqueredirect" ? { opaque: true } : { status: res.status };
    },
  };
}

export interface UnsubscribeDeps {
  store: MailStore;
  transport: UnsubscribeTransport | null;
  assert: (url: URL) => Promise<unknown>;
  /** queues the mail a mailto asks for; its op id */
  send: (accountId: number, mail: { to: string; subject: string; body: string }) => Promise<string>;
  signal: AbortSignal;
}

export async function findUnsubscribe(store: MailStore, threadId: number): Promise<UnsubscribeOffer | null> {
  const source = await store.threads.unsubscribeSource(threadId);
  const plan = source && unsubscribePlan(source);
  return plan && unsubscribeOffer(plan);
}

/** Does what the menu offered, only if the conversation still offers exactly that (plan 94, Codex review #9). */
export async function runUnsubscribe(deps: UnsubscribeDeps, threadId: number, shown: Pick<UnsubscribeOffer, "messageId" | "method" | "target">): Promise<UnsubscribeOutcome> {
  const source = await deps.store.threads.unsubscribeSource(threadId);
  const plan = source && unsubscribePlan(source);
  if (!source || !plan || plan.messageId !== shown.messageId || plan.method !== shown.method || plan.target !== shown.target) {
    throw new RpcError("STALE", L("unsubscribe.changed"), undefined, { expected: true });
  }
  const target = plan.target;
  switch (plan.method) {
    case "page":
      return { outcome: "open", target, url: plan.url, failed: false };
    case "mailto":
      return { outcome: "queued", target, opId: await deps.send(source.accountId, plan.mail) };
    case "oneClick": {
      const url = new URL(plan.url);
      // a host that can't POST (none given), or a destination never posted to: its page instead, when there is one
      const fallback = (failed: boolean): UnsubscribeOutcome => {
        if (plan.page) return { outcome: "open", target, url: plan.page, failed };
        throw new RpcError("UNAVAILABLE", L("unsubscribe.failed", { host: target }));
      };
      if (!deps.transport || !postAllowed(url)) return fallback(!!deps.transport);
      await deps.assert(url);
      let answer: { status: number } | { opaque: true };
      try {
        answer = await deps.transport.post(url, AbortSignal.any([deps.signal, AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS)]));
      } catch {
        return fallback(true);
      }
      if ("opaque" in answer) return { outcome: "requested", target };
      if (answer.status >= 200 && answer.status < 300) return { outcome: "unsubscribed", target };
      if (answer.status >= 300 && answer.status < 400) return { outcome: "requested", target };
      return fallback(true);
    }
  }
}
