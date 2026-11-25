/**
 * Plan 278's "Counts as a person": a rule changes the sender's threads' facts in one command, every window hears the list,
 * the lists and counts are told (and the facts' job woken for a sender with more threads), and an Undo is exact.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_RULES_MAX, type PersonRule } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { ingest, msg, threadOf } from "@terno/store/conformance";
import { afterEach, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 86_400_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "terno-people-"));
  const backend = new Backend({ dbPath: join(dir, "a.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, now: () => NOW });
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await backend.store.ready;
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "r", origin: "renderer" });
  const client = new RpcClient(c);
  const { account } = await backend.store.accounts.create({ kind: "imap", email: "me@terno.test", displayName: "Me", color: "brown", now: 0 });
  await backend.start();
  const lists: PersonRule[][] = [];
  client.on("personRules", (e) => void lists.push(e.rules));
  const put = async (id: string, email: string, i = 0) => {
    await ingest(backend.store, [msg({ accountId: account.id, providerMsgId: id, providerThreadId: id, from: { name: "", email }, to: [{ name: "Me", email: "me@terno.test" }], date: NOW - DAY + i })], NOW);
    return threadOf(backend.store, id);
  };
  const person = async (thread: number) => (await backend.store.threads.summaries([thread]))[0]!.person;
  return { backend, client, lists, put, person };
}

it("Never takes a person out at once and every window hears it; its Undo puts back exactly what was, never over a later change", async () => {
  const { client, lists, put, person } = await setup();
  const ana = await put("ana", "ana@friends.test");
  expect((await client.call("counts.get", {})).inboxWaiting).toBe(1);
  const r = await client.call("people.setRule", { email: "Ana@Friends.test", name: "Ana", person: false });
  expect(r).toMatchObject({ set: { key: "ana@friends.test", person: false, at: NOW }, prior: null });
  expect(await person(ana)).toBe(false);
  await vi.waitFor(() => expect(lists.at(-1)?.map((x) => x.key)).toEqual(["ana@friends.test"]));
  expect((await client.call("counts.get", {})).inboxWaiting).toBe(0);
  // the same again changes nothing
  expect(await client.call("people.setRule", { email: "ana@friends.test", name: "Ana", person: false })).toEqual({ set: null, prior: null });
  // Undo of a first rule: none again, only while it's still that rule
  expect(await client.call("people.restoreRule", { email: "ana@friends.test", expect: "not-it", to: null })).toEqual({ restored: false });
  expect(await client.call("people.restoreRule", { email: "ana@friends.test", expect: r.set!.id, to: null })).toEqual({ restored: true });
  expect(await person(ana)).toBe(true);
  await vi.waitFor(() => expect(lists.at(-1)).toEqual([]));
  // Undo of Always over Never: Never back as it was (its id and moment)
  const never = await client.call("people.setRule", { email: "ana@friends.test", name: "Ana", person: false });
  const always = await client.call("people.setRule", { email: "ana@friends.test", name: "Ana", person: true });
  expect(always.prior).toEqual(never.set);
  const { key: _key, ...prior } = always.prior!;
  expect(await client.call("people.restoreRule", { email: "ana@friends.test", expect: always.set!.id, to: prior })).toEqual({ restored: true });
  expect(await client.call("people.rules", {})).toEqual({ rules: [never.set] });
  // Reset (Automatically), and its Undo
  const { removed } = await client.call("people.removeRule", { email: "ana@friends.test" });
  expect(removed).toEqual(never.set);
  expect(await client.call("people.restoreRule", { email: "ana@friends.test", expect: null, to: prior })).toEqual({ restored: true });
  expect(await person(ana)).toBe(false);
});

it("a sender with more threads than one command recomputes: the facts' job finishes them with no more mail arriving", async () => {
  const { backend, client, put, person } = await setup();
  let first = 0;
  for (let i = 0; i < 205; i++) {
    const t = await put(`many-${i}`, "carlos@acme.test", i);
    first ||= t;
  }
  await backend.facts.idle();
  expect(await person(first)).toBe(true);
  await client.call("people.setRule", { email: "carlos@acme.test", name: "Carlos", person: false });
  await vi.waitFor(async () => expect(await backend.store.facts.idle()).toBe(true));
  await backend.facts.idle();
  expect(await person(first)).toBe(false);
  expect((await client.call("counts.get", {})).inboxWaiting).toBe(0);
});

it("says plainly what's wrong: an address that isn't one, and the cap for a new sender (a change to one there is taken)", async () => {
  const { backend, client } = await setup();
  await expect(client.call("people.setRule", { email: "nobody", name: "", person: false })).rejects.toThrow("That sender’s address can’t be used here.");
  for (let i = 0; i < PERSON_RULES_MAX; i++) await backend.store.facts.rules.set({ id: `n${i}`, email: `n${i}@a.test`, name: "", person: false, at: NOW });
  await expect(client.call("people.setRule", { email: "over@a.test", name: "", person: false })).rejects.toThrow(`You’ve already chosen for ${PERSON_RULES_MAX.toLocaleString("en-US")} senders`);
  expect((await client.call("people.setRule", { email: "n1@a.test", name: "", person: true })).set).toMatchObject({ key: "n1@a.test", person: true });
});
