import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Backend, plaintextCipher, seedDemo, startAgentSocket, webSocketTransport, type AiFactory, type BackendOptions, type LookupAll } from "@terno/backend";
import { demoRegistry, type ProviderRegistry } from "@terno/mail";
export { sqlDb } from "@terno/db";
import { WebSocketServer } from "ws";

export interface DevServerOptions {
  port: number;
  dataDir: string;
  token: string;
  /** wipe and reseed the demo mailbox */
  fresh?: boolean;
  threads?: number;
  accounts?: number;
  now?: () => number;
  providers?: ProviderRegistry;
  aiFactory?: AiFactory;
  autoSync?: boolean;
  lookup?: LookupAll;
  /** E2E: let accounts added through the demo registry become the owner */
  ownerClaims?: boolean;
  /** seed the demo mailbox into an empty database (default true); false starts like a fresh install */
  seed?: boolean;
  /** also open the MCP socket in dataDir (agent.sock + agent.token), as the desktop app does */
  agentSocket?: boolean;
  /** E2E (plan 20): the retry schedule */
  connectivity?: BackendOptions["connectivity"];
  /** plan 22: how website icons are fetched (default: the real one; E2E passes a stub that never touches the internet) */
  iconTransport?: BackendOptions["iconTransport"];
  /** E2E (plan 25): where Google's sign-in page would open (a test's fake Google never needs a browser) */
  openExternal?: BackendOptions["openExternal"];
}

export interface DevServer {
  backend: Backend;
  url: string;
  /** with agentSocket: the MCP socket and its token file */
  agents: { socketPath: string; tokenPath: string } | null;
  close(): Promise<void>;
}

/**
 * Hosts the real backend over WebSocket for browser dev and Playwright. Binds
 * to 127.0.0.1 only and requires the token (plus a localhost Origin) so other
 * sites in the browser can't talk to it.
 */
export async function startDevServer(o: DevServerOptions): Promise<DevServer> {
  mkdirSync(o.dataDir, { recursive: true });
  const dbPath = join(o.dataDir, "terno.db");
  if (o.fresh) for (const s of ["", "-wal", "-shm", ".search"]) rmSync(dbPath + s, { force: true });
  const backend = new Backend({
    dbPath,
    version: "dev",
    cipher: plaintextCipher,
    providers: o.providers ?? demoRegistry,
    aiFactory: o.aiFactory,
    demoAi: true,
    lookup: o.lookup,
    allowDemoOwnerClaims: o.ownerClaims,
    now: o.now,
    autoSync: o.autoSync ?? true,
    connectivity: o.connectivity,
    iconTransport: o.iconTransport,
    openExternal: o.openExternal,
    log: (level, message, extra) => (level === "error" ? console.error : console.log)(`[backend] ${message}`, extra ?? ""),
  });
  if (o.seed !== false && (await seedDemo(backend.store, { threads: o.threads, accounts: o.accounts }))) {
    await backend.store.settings.set("app", { ai: { provider: "fake" } });
    // warm model from the seeded categories (persisted on close, so E2E copies start ready)
    await backend.categorizer.rebuildNow();
  }
  await backend.start();
  const agents = o.agentSocket ? await startAgentSocket(backend, join(o.dataDir, "agent.sock"), join(o.dataDir, "agent.token")) : null;

  const http: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  let clients = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  http.on("upgrade", (req, socket, head) => {
    if (closing) { socket.destroy(); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin ?? "";
    const okOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (url.searchParams.get("token") !== o.token || !okOrigin) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (closing) { ws.terminate(); return; }
      backend.connect(webSocketTransport(ws), { clientId: `ws-${++clients}`, origin: "renderer" });
    });
  });
  await new Promise<void>((resolve) => http.listen(o.port, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : o.port;
  return {
    backend,
    url: `ws://127.0.0.1:${port}`,
    agents: agents ? { socketPath: agents.socketPath, tokenPath: agents.tokenPath } : null,
    close: () => {
      closing = true;
      return closePromise ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        const attempt = async (cleanup: () => unknown) => {
          try { await cleanup(); } catch (error) { errors.push(error); }
        };
        await Promise.all([
          attempt(async () => {
            const finished = new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
            await attempt(() => http.closeAllConnections());
            await finished;
          }),
          attempt(async () => {
            const finished = new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
            for (const client of wss.clients) await attempt(() => client.terminate());
            await finished;
          }),
        ]);
        await attempt(() => agents?.close());
        await attempt(() => backend.stop());
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors);
      });
    },
  };
}
