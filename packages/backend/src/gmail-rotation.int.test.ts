import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdbMailStore } from "@terno/idb";
import { IDBFactory } from "fake-indexeddb";
import { createGmailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  cleanup.push(async () => release());
  return { promise, release };
}

async function setup(kind: "SQL" | "IndexedDB") {
  let refresh = "initial";
  let exchanges = 0;
  let mailboxRequests = 0;
  const submitted: string[] = [];
  const access = new Set<string>();
  const server = createServer(async (req, res) => {
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const token = new URLSearchParams(body).get("refresh_token");
      submitted.push(token ?? "");
      if (token !== refresh) return json({ error: "invalid_grant" }, 400);
      exchanges++;
      refresh = `rotation-${exchanges}`;
      const tokenValue = `access-${exchanges}`;
      access.add(tokenValue);
      return json({ access_token: tokenValue, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
    }
    if (req.url === "/gmail/profile") {
      mailboxRequests++;
      if (!access.has(String(req.headers.authorization).replace(/^Bearer /, ""))) return json({}, 401);
      return json({ historyId: "9007199254740995", emailAddress: "synthetic@example.test" });
    }
    json({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server has no port");
  const url = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "terno-gmail-rotation-"));
  const factory = new IDBFactory();
  const name = crypto.randomUUID();
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  const registry: ProviderRegistry = {
    create: (ctx) => createGmailProvider(ctx, { endpoints: { token: `${url}/token`, api: `${url}/gmail` } }),
    async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic OAuth flow"); },
  };
  const open = async () => new Backend({
    dbPath: join(dir, "synthetic.db"),
    store: kind === "IndexedDB" ? await IdbMailStore.open({ name, factory, platform, instantSearch: false }) : undefined,
    platform, version: "test", providers: registry, cipher: plaintextCipher,
    autoSync: false, instantSearch: false, iconTransport: null,
  });
  let backend = await open();
  const { account } = await backend.store.accounts.create({ kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo", providerConfig: {}, now: 1 });
  await backend.store.settings.set("app", { gmailClientId: "synthetic-client" });
  const secretName = `account:${account.id}:refreshToken`;
  await backend.setSecret(secretName, refresh);
  cleanup.push(async () => {
    await backend.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    account, secretName, get backend() { return backend; },
    get exchanges() { return exchanges; }, get mailboxRequests() { return mailboxRequests; }, submitted,
    async provider() { const provider = await backend.provider(account.id); if (!provider) throw new Error("Missing synthetic provider"); return provider; },
    async reopen() { await backend.stop(); backend = await open(); },
    expireAccess() { access.clear(); },
  };
}

describe.each(["SQL", "IndexedDB"] as const)("%s real Gmail credential rotation", (kind) => {
  it("coalesces exchange and durable replacement, dispatches only after commit, and reopens with the rotated credential", async () => {
    const t = await setup(kind);
    const entered = gate(), blocked = gate();
    const replace = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
    const writes = vi.spyOn(t.backend.store.secrets, "replace").mockImplementationOnce(async (...args) => {
      entered.release(); await blocked.promise; return replace(...args);
    });
    const provider = await t.provider();
    const waiting = Promise.all(Array.from({ length: 20 }, () => provider.verify()));
    await entered.promise;
    expect(t.exchanges).toBe(1);
    expect(t.mailboxRequests).toBe(0);
    expect(await t.backend.getSecret(t.secretName)).toBe("initial");
    blocked.release(); await waiting;
    expect(writes).toHaveBeenCalledTimes(1);
    expect(t.mailboxRequests).toBe(20);
    expect(await t.backend.getSecret(t.secretName)).toBe("rotation-1");
    await t.reopen();
    await (await t.provider()).verify();
    expect(t.submitted).toEqual(["initial", "rotation-1"]);
    expect(await t.backend.getSecret(t.secretName)).toBe("rotation-2");
  });

  it.each(["before", "after"] as const)("a %s-commit failure retries only candidate persistence and never exchanges the spent credential", async (boundary) => {
    const t = await setup(kind);
    const replace = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "replace").mockImplementationOnce(async (...args) => {
      if (boundary === "after") await replace(...args);
      throw new Error("synthetic-private-persistence-detail");
    });
    const provider = await t.provider();
    await expect(provider.verify()).rejects.toMatchObject({ retryable: true, ambiguous: false });
    expect(t.exchanges).toBe(1);
    expect(t.mailboxRequests).toBe(0);
    await provider.verify();
    expect(t.submitted).toEqual(["initial"]);
    expect(t.mailboxRequests).toBe(1);
    expect(await t.backend.getSecret(t.secretName)).toBe("rotation-1");
    await t.reopen();
    await (await t.provider()).verify();
    expect(t.submitted).toEqual(["initial", "rotation-1"]);
  });

  it("a newer credential wins a blocked rotation without access publication or stale recovery", async () => {
    const t = await setup(kind);
    const entered = gate(), blocked = gate();
    const replace = t.backend.store.secrets.replace.bind(t.backend.store.secrets);
    vi.spyOn(t.backend.store.secrets, "replace").mockImplementationOnce(async (...args) => {
      entered.release(); await blocked.promise; return replace(...args);
    });
    const provider = await t.provider();
    const result = Promise.allSettled([provider.verify()]);
    await entered.promise;
    await t.backend.setSecret(t.secretName, "newer-explicit-sign-in");
    blocked.release();
    expect((await result)[0]).toMatchObject({ status: "rejected" });
    expect(t.mailboxRequests).toBe(0);
    expect(await t.backend.getSecret(t.secretName)).toBe("newer-explicit-sign-in");
    await t.reopen();
    expect(await t.backend.getSecret(t.secretName)).toBe("newer-explicit-sign-in");
  });
});
