import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { icoBytes, pngBytes } from "../test/icons-fixtures";
import { TEST_TLS_CA, TEST_TLS_CERT, TEST_TLS_KEY } from "../test/icons-tls";
import { loadSuffixList, registrableDomain } from "./domain";
import { fetchSiteIcon } from "./fetcher";
import { nodeIconTransport } from "./node-transport";
import { IconNetworkError } from "./transport";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A local HTTPS server answering for example.com, example.org and example.net (and subdomains) by Host and path. */
let server: Server;
let port = 0;
const routes = new Map<string, Handler>();
const seen: { host: string; path: string; headers: IncomingMessage["headers"] }[] = [];

const html = (body: string): Handler => (_q, r) => r.writeHead(200, { "content-type": "text/html" }).end(body);
const bytes = (b: Uint8Array, type = "image/png"): Handler => (_q, r) => r.writeHead(200, { "content-type": type }).end(Buffer.from(b));
const redirect = (to: string, status = 301): Handler => (_q, r) => r.writeHead(status, { location: to }).end();

beforeAll(async () => {
  await loadSuffixList();
  server = createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    seen.push({ host, path: req.url ?? "", headers: req.headers });
    const h = routes.get(`${host}${req.url}`);
    if (h) h(req, res);
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  routes.clear();
  seen.length = 0;
});

const loopback = async () => [{ address: "127.0.0.1", family: 4 }];
const asserted: string[] = [];
function fetchIcon(domain: string, o: { strictAddresses?: boolean; timeoutMs?: number; assert?: (u: URL) => Promise<void> } = {}) {
  asserted.length = 0;
  const transport = nodeIconTransport({ lookup: loopback, allowAddress: o.strictAddresses ? undefined : () => true, ca: TEST_TLS_CA, port });
  return fetchSiteIcon(domain, {
    transport,
    assert: o.assert ?? (async (u) => void asserted.push(u.href)),
    registrable: registrableDomain,
    signal: new AbortController().signal,
    timeoutMs: o.timeoutMs ?? 2000,
  });
}

describe("fetching a site's icon over HTTPS (plan 22)", () => {
  it("the homepage's apple-touch-icon, fetched without query string, cookies or referrer, every request asked of the policy", async () => {
    routes.set("example.com/", html(`<head><link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png?v=3&u=someone"></head>`));
    routes.set("example.com/touch.png", bytes(pngBytes(180)));
    const icon = await fetchIcon("example.com");
    expect(icon).toMatchObject({ full: true, image: { mime: "image/png", px: 180 } });
    expect(seen.map((s) => s.path)).toEqual(["/", "/touch.png"]);
    for (const s of seen) {
      expect(s.headers.cookie).toBeUndefined();
      expect(s.headers.referer).toBeUndefined();
      expect(s.headers.authorization).toBeUndefined();
      expect(s.headers["user-agent"]).toMatch(/^Mozilla\/5\.0 \(Macintosh/);
    }
    expect(asserted).toEqual(["https://example.com/", "https://example.com/touch.png"]);
  });

  it("falls back to /favicon.ico (its largest PNG entry) when the page names nothing usable", async () => {
    routes.set("example.com/", html("<head><title>x</title></head>"));
    routes.set("example.com/favicon.ico", bytes(icoBytes([{ px: 16, bytes: pngBytes(16) }, { px: 32, bytes: pngBytes(32) }]), "image/x-icon"));
    expect(await fetchIcon("example.com")).toMatchObject({ full: false, image: { mime: "image/png", px: 32 } });
  });

  it("an icon on another site (a CDN, a tracker) is never requested: zero requests there, the domain's favicon instead", async () => {
    routes.set("example.com/", html(`<head><link rel="apple-touch-icon" href="https://cdn.example.net/t.png"><base href="https://example.org/"><link rel="icon" href="i.png"></head>`));
    routes.set("example.com/favicon.ico", bytes(pngBytes(32)));
    expect(await fetchIcon("example.com")).toMatchObject({ image: { px: 32 } });
    expect(seen.filter((s) => s.host !== "example.com")).toEqual([]);
  });

  it("redirects: within the site freely, to one other site once, never a second one, never to http", async () => {
    routes.set("example.com/", redirect("https://www.example.com/home"));
    routes.set("www.example.com/home", redirect("https://example.org/"));
    routes.set("example.org/", html(`<link rel="apple-touch-icon" href="/t.png">`));
    routes.set("example.org/t.png", redirect("https://example.net/t.png", 302));
    routes.set("example.org/favicon.ico", bytes(pngBytes(48)));
    // the touch icon's hop to a third site is refused; the moved-to site's favicon is used
    expect(await fetchIcon("example.com")).toMatchObject({ image: { px: 48 } });
    expect(seen.some((s) => s.host === "example.net")).toBe(false);

    seen.length = 0;
    routes.clear();
    routes.set("example.com/", redirect("http://example.com/"));
    routes.set("example.com/favicon.ico", redirect("http://example.com/favicon.ico"));
    expect(await fetchIcon("example.com")).toBeNull();
    expect(seen.map((s) => s.path)).toEqual(["/", "/favicon.ico"]);
  });

  it("a site that doesn't answer in time is a timeout (retried later), not 'no icon'", async () => {
    routes.set("example.com/", () => {});
    await expect(fetchIcon("example.com", { timeoutMs: 300 })).rejects.toMatchObject({ name: "IconNetworkError", kind: "timeout" });
  });

  it("bodies over the cap aren't read: a huge page is skipped, a huge icon refused", async () => {
    routes.set("example.com/", html(`<head><link rel="apple-touch-icon" href="/big.png"></head>${"x".repeat(400 * 1024)}`));
    routes.set("example.com/favicon.ico", (_q, r) => r.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(300 * 1024, 1)));
    expect(await fetchIcon("example.com")).toBeNull();
    expect(seen.map((s) => s.path)).toEqual(["/", "/favicon.ico"]);
  });

  it("content-type spoofing: an HTML 'image/png' or a GIF is not an icon", async () => {
    routes.set("example.com/", html(`<link rel="icon" href="/fake.png"><link rel="icon" href="/anim.gif" sizes="64x64">`));
    routes.set("example.com/fake.png", (_q, r) => r.writeHead(200, { "content-type": "image/png" }).end("<html>soft 404</html>"));
    routes.set("example.com/anim.gif", (_q, r) => r.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("GIF89a....................")));
    expect(await fetchIcon("example.com")).toBeNull();
  });

  it("a name resolving to a private or loopback address is never connected to (the real address check)", async () => {
    routes.set("example.com/", html("<head></head>"));
    routes.set("example.com/favicon.ico", bytes(pngBytes(32)));
    expect(await fetchIcon("example.com", { strictAddresses: true })).toBeNull();
    expect(seen).toEqual([]);
  });

  it("the policy refusing (icons turned off meanwhile) stops before any request", async () => {
    routes.set("example.com/", html("<head></head>"));
    const refused = new Error("off");
    await expect(fetchIcon("example.com", { assert: async () => Promise.reject(refused) })).rejects.toBe(refused);
    expect(seen).toEqual([]);
  });

  it("an unreachable site is a network error (nothing cached)", async () => {
    const transport = nodeIconTransport({ lookup: async () => Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })), allowAddress: () => true, ca: TEST_TLS_CA, port });
    await expect(fetchSiteIcon("example.com", { transport, assert: async () => {}, registrable: registrableDomain, signal: new AbortController().signal })).rejects.toBeInstanceOf(IconNetworkError);
  });
});
