import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { ownerHistory } from "./owner";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

describe("owner credential compound transaction", () => {
  it("retains exact bytes; conflicts preserve owner/history/secret; missing replacement is deliberate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-owner-credential-"));
    const store = new SqlMailStore(openDatabase(join(dir, "test.db")));
    cleanup.push(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
    const claim = { displayName: "Reader", provider: "gmail" as const, verifiedBy: "google_oauth" as const, evidence: { googleSub: "synthetic-sub", emailVerified: true } };
    const create = async (email: string, now: number) => (await store.accounts.create({ kind: "gmail", email, displayName: "Reader", color: "indigo", providerConfig: {}, ownerClaim: claim, now })).account;
    await create("first@example.test", 1); const target = await create("second@example.test", 2);
    const stamp = (await store.accounts.stamp(target.id))!, name = `account:${target.id}:refreshToken`, old = Uint8Array.of(1, 2);
    await store.secrets.put(name, old);
    const owner = await store.owner.get();
    const change = (secret: Parameters<typeof store.owner.change>[0]["secret"], expectedStamp = stamp) => store.owner.change({ claim: { ...claim, accountId: target.id, email: target.email }, stamp: expectedStamp, secret, now: 3, reason: "synthetic test" });
    expect(await change({ kind: "retain", name, expectedBlob: Uint8Array.of(9) })).toBe(false);
    expect(await change({ kind: "replace", name, expectedBlob: Uint8Array.of(9), blob: Uint8Array.of(3) })).toBe(false);
    expect(await change({ kind: "replace", name, expectedBlob: null, blob: Uint8Array.of(3) })).toBe(false);
    await expect(change({ kind: "retain", name, expectedBlob: old }, { ...stamp, createdAt: 99 })).rejects.toThrow();
    expect(await store.owner.get()).toEqual(owner); expect(ownerHistory(store.db)).toEqual([]); expect(await store.secrets.get(name)).toEqual(old);
    expect(await change({ kind: "retain", name, expectedBlob: Uint8Array.of(9, 1, 2, 9).subarray(1, 3) })).toBe(true);
    expect(await store.secrets.get(name)).toEqual(old); expect(ownerHistory(store.db)).toHaveLength(1);
    await store.secrets.delete(name);
    expect(await change({ kind: "retain", name, expectedBlob: old })).toBe(false);
    expect(await change({ kind: "replace", name, expectedBlob: old, blob: Uint8Array.of(3) })).toBe(false);
    expect(await change({ kind: "replace", name, expectedBlob: null, blob: Uint8Array.of(3) })).toBe(true);
    expect(await store.secrets.get(name)).toEqual(Uint8Array.of(3));
    expect(ownerHistory(store.db)).toHaveLength(2);
  });
});
