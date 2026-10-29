/**
 * Plan 65: the backend's side of an account's own folders. A pass hands the list to the store (an unchanged one
 * writes and says nothing); a provider's folders() runs after a pass that worked, and its own failure waits
 * for the next pass, while a sign-in to redo doesn't.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folder } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { ProviderAuthError, ProviderError, type MailProvider, type ProviderRegistry, type SyncSink } from "@terno/mail/portable";
import type { ProviderFolder } from "@terno/store";
import { afterEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup() {
  const script = {
    list: [] as ProviderFolder[],
    sync: async (_sink: SyncSink) => {},
    folders: undefined as undefined | ((sink: SyncSink) => Promise<void>),
    foldersCalls: 0,
  };
  const registry: ProviderRegistry = {
    create() {
      const p: MailProvider = {
        async verify() {},
        async execute() {},
        async close() {},
        async sync(sink) {
          await sink.setFolders?.(script.list);
          await script.sync(sink);
        },
        async folders(sink) {
          script.foldersCalls++;
          await script.folders?.(sink);
        },
      };
      return p;
    },
    async verifyImap() {},
    async connectGmail() {
      throw new Error("unused");
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "terno-folders-"));
  const backend = new Backend({ dbPath: join(dir, "t.db"), version: "test", providers: registry, cipher: plaintextCipher, autoSync: false, iconTransport: null, openExternal: async () => {} });
  const account = (await backend.store.accounts.create({ kind: "imap", email: "me@example.test", displayName: "Me", color: "indigo", providerConfig: {}, now: 1 })).account;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "folders", origin: "renderer" });
  const client = new RpcClient(c);
  const events: Folder[][] = [];
  client.on("folders", (f) => events.push(f));
  cleanup.push(async () => {
    client.close();
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, client, account, script, events };
}

describe("an account's own folders (plan 65): the backend", () => {
  it("a pass hands the list to the store and says so once; the same list again says nothing; bootstrap has it", async () => {
    const t = await setup();
    t.script.list = [{ key: "Work", path: ["Work"], selectable: true }];
    await t.backend.syncAccount(t.account.id);
    await expect.poll(() => t.events.length).toBe(1);
    expect(t.events[0]).toEqual([{ accountId: t.account.id, key: "Work", path: ["Work"], selectable: true }]);
    await t.backend.syncAccount(t.account.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.events).toHaveLength(1);
    expect((await t.client.call("app.bootstrap", {})).folders).toEqual(t.events[0]);
  });

  it("folders() runs after a pass that worked, never after one that failed", async () => {
    const t = await setup();
    await t.backend.syncAccount(t.account.id);
    expect(t.script.foldersCalls).toBe(1);
    t.script.sync = async () => {
      throw new ProviderError("synthetic failure", true);
    };
    await t.backend.syncAccount(t.account.id).catch(() => {});
    expect(t.script.foldersCalls).toBe(1);
  });

  it("its own failure waits for the next pass; a sign-in to redo is the account's", async () => {
    const t = await setup();
    t.script.folders = async () => {
      throw new ProviderError("synthetic labels failure", true);
    };
    await t.backend.syncAccount(t.account.id);
    const ok = (await t.backend.store.accounts.get(t.account.id))!.syncState;
    expect(ok.lastError ?? null).toBeNull();
    expect(ok.authRequired ?? false).toBe(false);
    t.script.folders = async () => {
      throw new ProviderAuthError("synthetic revoked");
    };
    await t.backend.syncAccount(t.account.id).catch(() => {});
    expect((await t.backend.store.accounts.get(t.account.id))!.syncState.authRequired).toBe(true);
  });
});
