import { expect } from "vitest";
import { OAUTH_SUBJECT, type OAuthKind } from "@terno/core";
import type { MailStore } from "../mail-store";

/**
 * Plan 259: a credential commit for an OAuth account checks and stores the subject under its own kind's key (Gmail:
 * `googleSubject`, Outlook: `microsoftSubject`), atomically, and never another kind's.
 */
export async function oauthIdentityAdmission(store: MailStore, kind: OAuthKind = "gmail") {
  const key = OAUTH_SUBJECT[kind];
  const { account } = await store.accounts.create({ kind, email: "reader@example.test", displayName: "Reader", color: "brown", providerConfig: { senderName: "Preserved", cursor: "cursor" }, secret: { key: "refreshToken", blob: Uint8Array.of(1) }, now: 1 });
  const stamp = (await store.accounts.stamp(account.id))!;
  const name = `account:${account.id}:refreshToken`;
  const oauth = { expectedSubject: null, subject: "first" };
  const intent = { kind: "replace" as const, name, expectedBlob: Uint8Array.of(1), blob: Uint8Array.of(2), oauth };
  expect(await store.secrets.commit({ ...intent, oauth: { ...oauth, eligible: () => false } }, stamp)).toBe(false);
  expect(await store.secrets.commit({ ...intent, expectedBlob: Uint8Array.of(9) }, stamp)).toBe(false);
  expect(await store.secrets.commit(intent, { ...stamp, createdAt: 2 })).toBe(false);
  expect((await store.accounts.config<Record<string, unknown>>(account.id))!.config).toEqual({ senderName: "Preserved", cursor: "cursor" });
  expect(await store.secrets.commit(intent, stamp)).toBe(true);
  expect(await store.secrets.commit({ ...intent, expectedBlob: Uint8Array.of(2), oauth: { ...oauth, subject: "competitor" } }, stamp)).toBe(false);
  expect(await store.accounts.admitOAuth(stamp, { expectedSubject: "first", subject: "different" })).toBe(false);
  expect(await store.accounts.admitOAuth(stamp, { expectedSubject: "first", subject: "first" })).toBe(true);
  expect(await store.secrets.get(name)).toEqual(Uint8Array.of(2));
  expect((await store.accounts.config<Record<string, unknown>>(account.id))!.config).toEqual({ senderName: "Preserved", cursor: "cursor", [key]: "first" });
  return { stamp, name, intent };
}

/** An IMAP account takes no OAuth admission: its password commit can't be made to carry one. */
export async function oauthAdmissionRefusesImap(store: MailStore) {
  const { account } = await store.accounts.create({ kind: "imap", email: "imap@example.test", displayName: "IMAP", color: "brown", providerConfig: {}, secret: { key: "password", blob: Uint8Array.of(1) }, now: 1 });
  const stamp = (await store.accounts.stamp(account.id))!;
  expect(await store.accounts.admitOAuth(stamp, { expectedSubject: null, subject: "first" })).toBe(false);
  expect(await store.secrets.commit({ kind: "replace", name: `account:${account.id}:password`, expectedBlob: Uint8Array.of(1), blob: Uint8Array.of(2), oauth: { expectedSubject: null, subject: "first" } }, stamp)).toBe(false);
  expect(await store.secrets.get(`account:${account.id}:password`)).toEqual(Uint8Array.of(1));
}
