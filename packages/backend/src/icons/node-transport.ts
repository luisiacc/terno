import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { ICON_HEADERS, IconNetworkError, isPublicAddress, type IconRequest, type IconResponse, type IconTransport } from "./transport";

export interface NodeIconTransportOptions {
  /** tests: resolve names without DNS (to 127.0.0.1) */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** tests only: let a test server on loopback through the address check */
  allowAddress?: (ip: string) => boolean;
  /** tests only: the test server's certificate authority and port */
  ca?: string;
  port?: number;
}

const ADDRESS_REFUSED = "ICON_ADDRESS_REFUSED";

/**
 * Sender icons on Node (plan 22): `node:https`, one socket per request (no pool for a network
 * change to leave dead), and a DNS lookup that refuses any non-public address. The socket
 * connects to the address that lookup checked, so nothing can change between the check and the
 * connection. Redirects come back to the fetcher.
 */
export function nodeIconTransport(o: NodeIconTransportOptions = {}): IconTransport {
  const allowed = o.allowAddress ?? isPublicAddress;
  const guarded: LookupFunction = (hostname, options, callback) => {
    const resolve = o.lookup ? o.lookup(hostname) : new Promise<{ address: string; family: number }[]>((res, rej) => dnsLookup(hostname, { all: true }, (e, a) => (e ? rej(e) : res(a))));
    resolve.then(
      (all) => {
        // every address must be public: a name with one private answer is refused, not filtered
        if (all.length === 0 || !all.every((a) => allowed(a.address))) {
          const error = Object.assign(new Error(`${hostname} resolves to an address icons never go to`), { code: ADDRESS_REFUSED });
          return callback(error, "", 0);
        }
        const wanted = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
        if (wanted.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
        if (options.all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, wanted);
        else callback(null, wanted[0]!.address, wanted[0]!.family);
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, "", 0),
    );
  };

  return {
    get(r: IconRequest): Promise<IconResponse> {
      return new Promise<IconResponse>((resolve, reject) => {
        let settled = false;
        const done = (f: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          r.signal.removeEventListener("abort", onAbort);
          f();
        };
        const req = httpsRequest(
          {
            host: r.url.hostname,
            servername: r.url.hostname,
            port: o.port ?? 443,
            path: `${r.url.pathname}${r.url.search}`,
            method: "GET",
            agent: false,
            lookup: guarded,
            ca: o.ca,
            headers: { ...ICON_HEADERS, accept: r.accept },
            timeout: r.timeoutMs,
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              const location = res.headers.location ?? null;
              return done(() => resolve({ status, location, bytes: null, tooLarge: false }));
            }
            if (status !== 200) {
              res.resume();
              return done(() => resolve({ status, location: null, bytes: null, tooLarge: false }));
            }
            const declared = Number(res.headers["content-length"]);
            if (declared > r.maxBytes) {
              req.destroy();
              return done(() => resolve({ status, location: null, bytes: null, tooLarge: true }));
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
              size += c.length;
              if (size > r.maxBytes) {
                req.destroy();
                done(() => resolve({ status, location: null, bytes: null, tooLarge: true }));
                return;
              }
              chunks.push(c);
            });
            res.on("end", () => {
              const all = Buffer.concat(chunks);
              done(() => resolve({ status, location: null, bytes: new Uint8Array(all.buffer, all.byteOffset, all.byteLength), tooLarge: false }));
            });
            res.on("error", (e) => done(() => reject(new IconNetworkError("network", e.message))));
          },
        );
        // the socket's idle timeout and an overall deadline (a trickle of bytes doesn't keep it alive)
        const deadline = setTimeout(() => {
          req.destroy();
          done(() => reject(new IconNetworkError("timeout", `no answer in ${r.timeoutMs} ms`)));
        }, r.timeoutMs);
        const onAbort = () => {
          req.destroy();
          done(() => reject(new IconNetworkError("network", "aborted")));
        };
        if (r.signal.aborted) onAbort();
        else r.signal.addEventListener("abort", onAbort, { once: true });
        req.on("timeout", () => {
          req.destroy();
          done(() => reject(new IconNetworkError("timeout", `no answer in ${r.timeoutMs} ms`)));
        });
        req.on("error", (e: NodeJS.ErrnoException) => done(() => reject(new IconNetworkError(e.code === ADDRESS_REFUSED ? "address" : "network", e.message))));
        req.end();
      });
    },
  };
}
