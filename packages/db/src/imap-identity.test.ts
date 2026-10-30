import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { writeLegacyCopy } from "./test/legacy";

const stores: SqlMailStore[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.isOpen) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(file?: string) {
  if (!file) { const dir = mkdtempSync(join(tmpdir(), "terno-identity-")); dirs.push(dir); file = join(dir, "mail.db"); }
  const store = new SqlMailStore(openDatabase(file)); stores.push(store); return store;
}
const location = { mailbox: "INBOX", uidvalidity: 7, uid: 1, flags: [] };

it("identity: SQL rollback cannot dispatch or retain a partly prepared hold", async () => {
  const store = open();
  const [, account] = await withAccounts(store);
  const { inserted: [id] } = await ingest(store, [msg({ accountId: account!, locations: [location] })]);
  const locations = store.providerStore(account!).locations;
  const captured = await locations.of([id!]);
  let refuse = true, issued = false;
  store.db.onBeforeCommit(() => { if (refuse) throw new Error("synthetic identity commit refusal"); });
  await expect(locations.dispatch([id!], captured, async () => { issued = true; }, [id!])).rejects.toThrow("synthetic identity commit refusal");
  refuse = false;
  expect(issued).toBe(false);
  expect(await locations.unresolved([id!])).toEqual([]);
  expect(await locations.of([id!])).toEqual(captured);
});

it("identity: schema29 guessed or absent locators cannot authorize dispatch after upgrade", async () => {
  const source = open();
  const [, account] = await withAccounts(source);
  const { inserted: ids } = await ingest(source, [msg({ accountId: account!, locations: [location] }), msg({ accountId: account!, locations: [] })]);
  const dir = mkdtempSync(join(tmpdir(), "terno-identity-upgrade-")); dirs.push(dir);
  const file = join(dir, "legacy.db");
  writeLegacyCopy(source.db, file, 29);
  const upgraded = open(file), locations = upgraded.providerStore(account!).locations;
  expect(await locations.unresolved(ids)).toEqual(ids);
  let issued = false;
  await expect(locations.dispatch([ids[0]!], await locations.of([ids[0]!]), async () => { issued = true; })).rejects.toThrow("IMAP identity unavailable");
  expect(issued).toBe(false);
  await upgraded.sync.remove(ids);
  expect((await upgraded.debug.snapshot()).messages.map((m) => m.id)).toEqual(ids);
  const { inserted: [fresh] } = await ingest(upgraded, [msg({ accountId: account!, providerMsgId: "new-trusted-import", locations: [{ ...location, uid: 99 }] })]);
  expect(await locations.unresolved([fresh!])).toEqual([]);
  await expect(locations.dispatch([fresh!], await locations.of([fresh!]), async () => "new import")).resolves.toBe("new import");
  expect(await locations.unresolved(ids)).toEqual(ids);

});

it("identity review: a concurrent fence survives cleanup of an undispatched SQL admission", async () => {
  const store = open();
  const [, account] = await withAccounts(store);
  const { inserted: ids } = await ingest(store, Array.from({ length: 257 }, (_, i) => msg({ accountId: account!, locations: [{ ...location, uid: i + 1 }] })));
  const locations = store.providerStore(account!).locations;
  const before = await locations.of(ids);
  let fenced: Promise<void> | undefined, issued = false, changed = false;
  store.db.onBeforeCommit(() => {
    if (!changed && store.db.get("SELECT 1 FROM imap_identity_holds WHERE message_id=?", ids[0]!)) {
      changed = true;
      fenced = locations.fence([ids[0]!]);
    }
  });
  await expect(locations.dispatch(ids, before, async () => { issued = true; }, ids)).rejects.toThrow("IMAP identity unavailable");
  await fenced;
  expect(changed).toBe(true);
  expect(issued).toBe(false);
  const file = store.db.path; await store.close();
  const reopened = open(file), current = reopened.providerStore(account!).locations;
  expect(await current.unresolved(ids)).toEqual([ids[0]]);
  await expect(current.dispatch(ids.slice(1), before.filter((l) => l.message_id !== ids[0]), async () => "still usable")).resolves.toBe("still usable");
});
