/**
 * Plan 20's network in a box: a TCP proxy in front of a test server that can break the way real
 * networks break.
 *
 * - `blackholeExisting()`: a VPN switch. Open connections stay open, but every byte is dropped
 *   both ways, so nobody gets an error; new connections go through (the new route works).
 * - `blackholeAll()`: a dead network. Connections are accepted, nothing is forwarded.
 * - `refuse()`: the server is down (ECONNREFUSED).
 * - `resetAll()`: every connection reset (ECONNRESET).
 * - `pass()`: healthy again.
 *
 * From a userspace proxy the black hole is silence at the application layer: the kernel still
 * ACKs, so TCP keepalive can't see it. That is the harder case, the one only Terno's own timeouts
 * and heartbeat catch.
 */
import { createServer, connect as tcpConnect, type Server, type Socket } from "node:net";

type Mode = "pass" | "blackhole" | "refuse";

interface Pair {
  client: Socket;
  upstream: Socket;
  /** bytes no longer flow (this connection lived through a black hole) */
  dead: boolean;
}

export interface NetProxy {
  port: number;
  /** connections accepted so far (a refused one isn't) */
  readonly accepted: number;
  /** connections currently open */
  readonly open: number;
  pass(): Promise<void>;
  blackholeExisting(): void;
  blackholeAll(): Promise<void>;
  refuse(): Promise<void>;
  resetAll(): void;
  close(): Promise<void>;
}

export async function startNetProxy(upstreamPort: number, host = "127.0.0.1"): Promise<NetProxy> {
  let mode: Mode = "pass";
  let accepted = 0;
  const pairs = new Set<Pair>();
  let server: Server | null = null;
  let port = 0;

  const onConnection = (client: Socket) => {
    accepted++;
    client.on("error", () => {});
    const blackholed = mode === "blackhole";
    const upstream = tcpConnect(upstreamPort, host);
    upstream.on("error", () => client.destroy());
    const pair: Pair = { client, upstream, dead: blackholed };
    pairs.add(pair);
    client.on("data", (d) => {
      if (!pair.dead) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (!pair.dead) client.write(d);
    });
    const end = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    // a dead connection never tells the other side anything (no FIN, no RST): that's the point
    client.on("close", () => (pair.dead ? (pairs.delete(pair), upstream.destroy()) : end()));
    upstream.on("close", () => (pair.dead ? (pairs.delete(pair), undefined) : end()));
  };

  const listen = async (p = 0) => {
    server = createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(p, host, () => resolve());
    });
    port = (server!.address() as { port: number }).port;
  };
  const unlisten = async () => {
    const s = server;
    server = null;
    // stops accepting at once; close's callback would wait for every open connection to end
    s?.close();
  };

  await listen();
  return {
    get port() {
      return port;
    },
    get accepted() {
      return accepted;
    },
    get open() {
      return pairs.size;
    },
    async pass() {
      mode = "pass";
      if (!server) await listen(port);
    },
    blackholeExisting() {
      for (const p of pairs) p.dead = true;
    },
    async blackholeAll() {
      mode = "blackhole";
      for (const p of pairs) p.dead = true;
      if (!server) await listen(port);
    },
    async refuse() {
      mode = "refuse";
      await unlisten();
    },
    resetAll() {
      for (const p of pairs) {
        pairs.delete(p);
        p.client.resetAndDestroy();
        p.upstream.destroy();
      }
    },
    async close() {
      for (const p of pairs) {
        p.client.destroy();
        p.upstream.destroy();
      }
      pairs.clear();
      await unlisten();
    },
  };
}
