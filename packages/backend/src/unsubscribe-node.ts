import { request as httpsRequest } from "node:https";
import { ICON_HEADERS } from "./icons/transport";
import { publicOnlyLookup, type NodeIconTransportOptions } from "./icons/node-transport";
import { ONE_CLICK_BODY, postAllowed, type UnsubscribeTransport } from "./unsubscribe";

/**
 * Plan 96's one-click POST on Node: `node:https`, one socket, the icons' lookup (every answer
 * public, the socket on the address it checked), the URL checked first (an IP literal never
 * reaches the lookup), no redirect followed and no answer body read.
 */
export function nodeUnsubscribeTransport(o: Pick<NodeIconTransportOptions, "lookup" | "allowAddress" | "ca" | "port"> = {}): UnsubscribeTransport {
  const lookup = publicOnlyLookup({ lookup: o.lookup, allowAddress: o.allowAddress, what: "unsubscribe requests" });
  return {
    post(url, signal) {
      if (!postAllowed(url)) return Promise.reject(new Error(`unsubscribe requests never go to ${url.host}`));
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          {
            host: url.hostname.replace(/^\[|\]$/g, ""),
            servername: url.hostname,
            port: o.port ?? 443,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            agent: false,
            lookup,
            ca: o.ca,
            signal,
            headers: { "user-agent": ICON_HEADERS["user-agent"], "accept-encoding": "identity", "content-type": "application/x-www-form-urlencoded", "content-length": String(ONE_CLICK_BODY.length) },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            req.destroy();
            resolve({ status });
          },
        );
        req.on("error", reject);
        req.end(ONE_CLICK_BODY);
      });
    },
  };
}
