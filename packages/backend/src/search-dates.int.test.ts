import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { nodePlatform, openDatabase, SqlMailStore } from "@terno/db";
import type { ProviderRegistry } from "@terno/mail";
import { defineDateSearch } from "../../db/src/test/search-dates";
import { BackendCore, plaintextCipher } from "./core";

const unexpected = async (): Promise<never> => { throw new Error("Date search must stay local"); };
const providers: ProviderRegistry = { create: () => { throw new Error("Date search must stay local"); }, verifyImap: unexpected, connectGmail: unexpected };

defineDateSearch("RPC threads.search (real handler and SQL)", async (now) => {
  const dir = mkdtempSync(join(tmpdir(), "terno-date-rpc-"));
  const store = new SqlMailStore(openDatabase(join(dir, "mail.db")));
  const backend = new BackendCore({ store, platform: nodePlatform, providers, cipher: plaintextCipher, version: "test", now: () => now, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "date-search", origin: "renderer" });
  const client = new RpcClient(c);
  return {
    store, instant: false, rpc: true, fallback: "sql",
    search: async (query, cursor, limit = 100) => {
      const accounts = await store.accounts.list();
      return client.call("threads.search", { query, cursor, limit, accountId: accounts.find((a) => a.email === "reader@example.test")!.id });
    },
    ready: async () => {},
    close: async () => {
      c.close();
      try { await backend.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
});
