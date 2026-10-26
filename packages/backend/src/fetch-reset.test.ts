/**
 * Plan 19: after a network change Node's fetch must not reuse a pooled keep-alive socket (a server
 * can stretch its idle life to 10 minutes; one the change killed would hang the next request).
 */
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resetFetchSockets } from "./backend";

let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

async function keepAliveServer() {
  const ids = new Map<Socket, number>();
  const closed: number[] = [];
  let next = 0;
  server = createServer((req, res) => {
    if (!ids.has(req.socket)) ids.set(req.socket, ++next);
    setTimeout(() => {
      // the server asks clients to keep the socket for 10 minutes
      res.writeHead(200, { "keep-alive": "timeout=600", connection: "keep-alive" });
      res.end(String(ids.get(req.socket)));
    }, req.url === "/slow" ? 400 : 0);
  });
  server.keepAliveTimeout = 600_000;
  server.on("connection", (s) => s.on("close", () => closed.push(ids.get(s) ?? 0)));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, closed };
}

const get = async (url: string) => (await fetch(url)).text();

describe("resetFetchSockets (plan 19)", () => {
  it("drops idle pooled sockets now, lets a request in flight finish, and new requests open new sockets", async () => {
    const { url, closed } = await keepAliveServer();
    const idle = await get(`${url}/a`);
    // let the socket go back to the pool
    await new Promise((r) => setTimeout(r, 50));
    const inFlight = get(`${url}/slow`);
    await new Promise((r) => setTimeout(r, 50));
    resetFetchSockets();
    const fresh = await get(`${url}/b`);
    expect(Number(fresh)).toBeGreaterThan(Number(idle));
    // the slow one (a send, say) wasn't cut short
    expect(await inFlight).toMatch(/^\d+$/);
    await expect.poll(() => closed.includes(Number(idle)), { timeout: 2000 }).toBe(true);
  });

  it("is a no-op before anything was fetched, and when called twice", () => {
    expect(() => {
      resetFetchSockets();
      resetFetchSockets();
    }).not.toThrow();
  });
});
