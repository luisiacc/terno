// Plan 259 stage 2a: the dev server (what the E2E runs) connects an Outlook account against a synthetic Microsoft and
// syncs its mail from the synthetic Graph: the registry's moved endpoints, the build's app registration, no real host.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail";
import { afterEach, expect, it } from "vitest";
import { SyntheticMicrosoft } from "../../../packages/mail/src/test/microsoft.fixture";
import { startDevServer } from "./server";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("connects Outlook and syncs its Inbox and folders from a synthetic Graph", async () => {
  const ms = await new SyntheticMicrosoft().start();
  cleanups.push(() => ms.stop());
  const folder = ms.folder("Projects");
  ms.deliver("inbox-id", { subject: "Hello from Graph" });
  ms.deliver(folder, { subject: "Filed" });
  const dataDir = mkdtempSync(join(tmpdir(), "terno-dev-outlook-"));
  const browser = ms.browser();
  const server = await startDevServer({
    port: 0, dataDir, token: "t", seed: false, autoSync: false,
    providers: createRegistry({ microsoft: { endpoints: ms.endpoints(), requestsPerSecond: Infinity } }),
    microsoftClients: { preferred: ms.clientId, clients: [{ clientId: ms.clientId, clientSecret: "" }] },
    openExternal: (url) => browser(url),
  });
  cleanups.push(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const [c, s] = createMemoryTransportPair();
  server.backend.connect(s, { clientId: "dev", origin: "renderer" });
  const client = new RpcClient(c, { defaultTimeoutMs: 20_000 });
  const account = await client.call("accounts.connectMicrosoft", {});
  await server.backend.syncAccount(account.id);
  expect(await server.backend.store.providerStore(account.id).syncedMessages()).toHaveLength(2);
  expect((await server.backend.store.folders.list()).filter((f) => f.accountId === account.id).map((f) => f.path)).toEqual([["Projects"]]);
  client.close();
});
