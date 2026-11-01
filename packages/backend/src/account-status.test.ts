import { expect, it } from "vitest";
import { AccountStatus } from "./account-status";

const initial = { status: "idle" as const, syncedSince: null, bodiesPending: 0, lastError: null, lastSyncAt: null };
it("only verified current recovery clears sign-in; run completion and masked policy Retry cannot", async () => {
  let generation = 1, live = true;
  const status = new AccountStatus({ initial, generation: () => generation, write: async () => {}, changed() {} });
  const authority = { generation, live: () => live }, run = status.begin(authority);
  await status.refuse(authority, { message: "Sign in" });
  await status.forbid(authority, status.policyRevision, { message: "Enable Gmail" });
  await run.end({ status: "idle", authRequired: false, lastError: null });
  expect(status.project()).toMatchObject({ status: "error", authRequired: true, lastError: "Sign in" });
  expect(status.recoverPolicy()).toBe(false);
  expect(status.policyPaused).toBe(true);
  generation++;
  await status.verified(authority);
  expect(status.signInRequired).toBe(true);
  await status.verified({ generation, live: () => live });
  expect(status.project()).toMatchObject({ status: "idle", authRequired: false, lastError: null });
  live = false;
  await status.refuse({ generation, live: () => live }, { message: "Old refusal" });
  expect(status.signInRequired).toBe(false);
});

it("an admitted old write finishes before the new generation's status and cannot change the current projection", async () => {
  let generation = 1, release!: () => void, entered = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: string[] = [];
  const status = new AccountStatus({ initial, generation: () => generation, changed() {}, write: async (state) => {
    if (!entered) { entered = true; await gate; }
    writes.push(state.status);
  } });
  const running = status.begin({ generation, live: () => true }).update({ status: "syncing" });
  await Promise.resolve();
  generation++;
  const refused = status.refuse({ generation, live: () => true }, { message: "Sign in" });
  expect(status.project()).toMatchObject({ status: "error", lastError: "Sign in" });
  release(); await Promise.all([running, refused]);
  expect(writes).toEqual(["syncing", "error"]);
});

it("an admitted persistence failure remains observable to callers and the drain", async () => {
  const failure = new Error("Synthetic storage failure");
  const status = new AccountStatus({ initial, generation: () => 1, changed() {}, write: async () => { throw failure; } });
  const refused = status.refuse({ generation: 1, live: () => true }, { message: "Sign in" });
  const drained = status.flush();
  await expect(refused).rejects.toBe(failure);
  await expect(drained).rejects.toBe(failure);
});

it("a verified recovery proof cannot clear a refusal published after verification began", async () => {
  const status = new AccountStatus({ initial, generation: () => 1, changed() {}, write: async () => {} });
  const authority = { generation: 1, live: () => true };
  await status.refuse(authority, { message: "First refusal" });
  const complete = status.recoveryProof(authority);
  await status.refuse(authority, { message: "New refusal" });
  await complete();
  expect(status.project()).toMatchObject({ status: "error", authRequired: true, lastError: "New refusal" });
  await status.recoveryProof(authority)();
  expect(status.project()).toMatchObject({ status: "idle", authRequired: false });
});

it("completed runs cannot publish delayed progress and lower constraints survive verified sign-in", async () => {
  let blocked = true;
  const status = new AccountStatus({ initial, generation: () => 1, changed() {}, write: async () => {} });
  const authority = { generation: 1, live: () => true }, run = status.begin(authority);
  await status.constrain(authority, { message: "Paused" }, () => blocked);
  await status.refuse(authority, { message: "Sign in" });
  await status.verified(authority);
  expect(status.project()).toMatchObject({ status: "error", lastError: "Paused" });
  blocked = false;
  const next = status.begin(authority);
  await next.end({ status: "idle", lastError: null });
  await run.update({ status: "syncing", bodiesPending: 100 });
  expect(status.project()).toMatchObject({ status: "idle", bodiesPending: 0 });
});
