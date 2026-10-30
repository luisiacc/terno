import { expect } from "vitest";
import type { MailStore } from "../mail-store";

export async function googleIdentityAdmission(store: MailStore) {
  const { account } = await store.accounts.create({ kind: "gmail", email: "reader@example.test", displayName: "Reader", color: "indigo", providerConfig: { senderName: "Preserved", cursor: "cursor" }, secret: { key: "refreshToken", blob: Uint8Array.of(1) }, now: 1 });
  const stamp = (await store.accounts.stamp(account.id))!;
  const name = `account:${account.id}:refreshToken`;
  const google = { expectedSubject: null, subject: "first" };
  const intent = { kind: "replace" as const, name, expectedBlob: Uint8Array.of(1), blob: Uint8Array.of(2), google };
  expect(await store.secrets.commit({ ...intent, google: { ...google, eligible: () => false } }, stamp)).toBe(false);
  expect(await store.secrets.commit({ ...intent, expectedBlob: Uint8Array.of(9) }, stamp)).toBe(false);
  expect(await store.secrets.commit(intent, { ...stamp, createdAt: 2 })).toBe(false);
  expect((await store.accounts.config<Record<string, unknown>>(account.id))!.config).toEqual({ senderName: "Preserved", cursor: "cursor" });
  expect(await store.secrets.commit(intent, stamp)).toBe(true);
  expect(await store.secrets.commit({ ...intent, expectedBlob: Uint8Array.of(2), google: { ...google, subject: "competitor" } }, stamp)).toBe(false);
  expect(await store.accounts.admitGoogle(stamp, { expectedSubject: "first", subject: "different" })).toBe(false);
  expect(await store.accounts.admitGoogle(stamp, { expectedSubject: "first", subject: "first" })).toBe(true);
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
  expect((await store.accounts.config<Record<string, unknown>>(account.id))!.config).toEqual({ senderName: "Preserved", cursor: "cursor", googleSubject: "first" });
  return { stamp, name, intent };
}
