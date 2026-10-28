import "fake-indexeddb/auto";
import { Buffer } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { IdbMailStore } from "./store";
import { ingest, msg, threadOf } from "@terno/store/conformance";

const NOW = Date.UTC(2026, 9, 27, 12);
const LARGE_BYTES = 1024 * 1024;
const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };

type Phase = ReturnType<typeof phase>;
function phase() {
  return { puts: 0, putSuccesses: 0, nonMetaPuts: 0, writeTransactions: 0, completed: 0, aborted: 0, syntheticPayloadBytes: 0, unchangedPayloadJsonBytes: 0 };
}

// Every '~' in these fixtures belongs to the synthetic wire body; UTF-8 is one byte per '~'.
// Inspect actual submitted string leaves without cloning, stringifying or retaining the put value.
function syntheticPayloadBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === "string") {
    let count = 0;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 126) count++;
    return count;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let count = 0;
  for (const child of Object.values(value)) count += syntheticPayloadBytes(child, seen);
  return count;
}

function unchangedPayloadJsonBytes(value: unknown, payload: string | null, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return payload !== null && value === payload ? Buffer.byteLength(value, "utf8") : 0;
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let count = 0;
  for (const child of Object.values(value)) count += unchangedPayloadJsonBytes(child, payload, seen);
  return count;
}

// OpRow currently consists of scalar fields. Compare every own key/value without dumping a wire body on failure.
function sameLogicalOp(actual: object | null, expected: object): boolean {
  if (!actual) return false;
  const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

function deleteMailbox(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Synthetic mailbox deletion was blocked by a leaked handle"));
  });
}

for (const instantSearch of [false, true]) {
  for (const large of [false, true]) {
    const mode = instantSearch ? "instant" : "scan";
    const description = large ? "1MiB CONTROL release submits zero unchanged wire-body bytes" : "small normal queue/claim/release delegates real puts and survives reopen";
    it(`${description} (${mode}; fake-IDB model)`, async () => {
      const factory = new IDBFactory();
      const name = `op-write-locality-${crypto.randomUUID()}`;
      const physicalName = `terno-${name}`;
      const stores: IdbMailStore[] = [];
      const bodyText = large ? "~".repeat(LARGE_BYTES) : "small synthetic wire body";
      const queuedWrites = phase(), claimedWrites = phase(), releasedWrites = phase();
      let active: Phase | null = null;
      let immutablePayload: string | null = null;
      const originalPut = IDBObjectStore.prototype.put;
      const originalTransaction = IDBDatabase.prototype.transaction;
      const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
        // Delegate the exact arguments and receiver FIRST. Never substitute a request or value.
        const request = Reflect.apply(originalPut, this, args) as IDBRequest;
        const sample = this.transaction.db.name === physicalName ? active : null;
        if (sample) {
          sample.puts++;
          if (this.name !== "meta") sample.nonMetaPuts++;
          sample.syntheticPayloadBytes += syntheticPayloadBytes(args[0]);
          sample.unchangedPayloadJsonBytes += unchangedPayloadJsonBytes(args[0], immutablePayload);
          request.addEventListener("success", () => { sample.putSuccesses++; });
        }
        return request;
      });
      const txSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
        const transaction = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
        const sample = this.name === physicalName && args[1] === "readwrite" ? active : null;
        if (sample) {
          sample.writeTransactions++;
          transaction.addEventListener("complete", () => { sample.completed++; });
          transaction.addEventListener("abort", () => { sample.aborted++; });
        }
        return transaction;
      });
      let cleanupFailure: PromiseRejectedResult | undefined;
      try {
        let store = await IdbMailStore.open({ name, factory, instantSearch, platform });
        stores.push(store);
        const { account } = await store.accounts.create({ kind: "gmail", email: "sender@example.com", displayName: "Synthetic sender", color: "indigo", now: NOW });
        active = queuedWrites;
        const queued = await store.compose.queueSend({ accountId: account.id, to: [{ name: "Synthetic recipient", email: "recipient@example.com" }], cc: [], bcc: [], subject: "Synthetic locality", bodyText, recordReply: false, now: NOW });
        active = null;
        const beforeClaim = await store.ops.get(queued.opId);
        expect(beforeClaim !== null, "public queue produced a durable operation").toBe(true);
        if (!beforeClaim) throw new Error("Missing queued operation");
        immutablePayload = beforeClaim.payload_json;
        expect(beforeClaim.state).toBe("queued");
        expect(beforeClaim.attempts).toBe(0);
        expect((JSON.parse(beforeClaim.payload_json) as { text?: unknown }).text === bodyText, "public wire payload equals exact synthetic body").toBe(true);

        active = claimedWrites;
        const claimed = await store.ops.claimReady(NOW + 1, 1);
        active = null;
        expect(claimed.length).toBe(1);
        expect(sameLogicalOp(claimed[0]!, { ...beforeClaim, state: "running", attempts: 1 }), "claim preserves every public operation field except state and attempts").toBe(true);
        const beforeRelease = await store.ops.get(queued.opId);
        expect(sameLogicalOp(beforeRelease, claimed[0]!), "public claimed operation is committed before release").toBe(true);

        active = releasedWrites;
        await store.ops.release(queued.opId, NOW + 2);
        active = null;
        const afterRelease = await store.ops.get(queued.opId);
        expect(sameLogicalOp(afterRelease, beforeClaim), "release exactly restores every public queued operation field").toBe(true);
        await store.close();
        store = await IdbMailStore.open({ name, factory, instantSearch, platform });
        stores.push(store);
        const reopened = await store.ops.get(queued.opId);
        expect(sameLogicalOp(reopened, beforeClaim), "real reopen preserves exact released public operation").toBe(true);

        // Positive instrumentation controls precede the locality assertions.
        for (const sample of [queuedWrites, claimedWrites, releasedWrites]) {
          expect(sample.nonMetaPuts > 0, "measured phase reached a delegated non-meta physical put").toBe(true);
          expect(sample.writeTransactions > 0, "measured phase reached a real native-model readwrite transaction").toBe(true);
          expect(sample.completed).toBe(sample.writeTransactions);
          expect(sample.aborted).toBe(0);
          expect(sample.putSuccesses).toBe(sample.puts);
        }
        if (large) expect(queuedWrites.syntheticPayloadBytes >= LARGE_BYTES, "queue physically submitted the known synthetic body witness").toBe(true);
        else expect(queuedWrites.syntheticPayloadBytes).toBe(0);
        if (!large) expect(releasedWrites.syntheticPayloadBytes).toBe(0);
        console.info("OP_WRITE_LOCALITY", mode, large ? "large" : "small", "queueBodyBytes", queuedWrites.syntheticPayloadBytes, "claimBodyBytes", claimedWrites.syntheticPayloadBytes, "releaseBodyBytes", releasedWrites.syntheticPayloadBytes, "releaseUnchangedWireJsonBytes", releasedWrites.unchangedPayloadJsonBytes, "wireJsonBytes", Buffer.byteLength(beforeClaim.payload_json, "utf8"), "releasePuts", releasedWrites.puts, "releaseNonMetaPuts", releasedWrites.nonMetaPuts, "releaseCompleted", releasedWrites.completed, "logicalAndReopen", true);
        if (large) {
          expect(releasedWrites.unchangedPayloadJsonBytes, "CONTROL transition resubmitted unchanged serialized wire payload bytes").toBe(0);
          expect(releasedWrites.syntheticPayloadBytes, "CONTROL transition resubmitted unchanged synthetic wire-body bytes").toBe(0);
        }
      } finally {
        active = null;
        putSpy.mockRestore();
        txSpy.mockRestore();
        const closed = await Promise.allSettled(stores.map((store) => store.close()));
        await deleteMailbox(factory, physicalName);
        cleanupFailure = closed.find((result) => result.status === "rejected");
      }
      if (cleanupFailure) throw cleanupFailure.reason;
    }, 20_000);
  }
}

const partNames = ["op_control", "op_target", "op_error"];
const native = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const terminal = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });

for (const instantSearch of [false, true]) it(`public target-locality ${instantSearch ? "instant" : "scan"}: partial supersession writes changed target without wire/error`, async () => {
  const factory = new IDBFactory(), name = `op-target-${crypto.randomUUID()}`, physicalName = `terno-${name}`;
  let store = await IdbMailStore.open({ factory, name, instantSearch, platform });
  const put = IDBObjectStore.prototype.put;
  let oldId = "", active = false, basePuts = 0, targetPuts = 0, errorPuts = 0, wireBytes = 0, payload = "";
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = Reflect.apply(put, this, args) as IDBRequest;
    if (active && this.transaction.db.name === physicalName && args[1] === oldId && ["ops", ...partNames].includes(this.name)) {
      if (this.name === "ops") basePuts++;
      if (this.name === "op_target") targetPuts++;
      if (this.name === "op_error") errorPuts++;
      wireBytes += unchangedPayloadJsonBytes(args[0], payload);
    }
    return request;
  });
  try {
    const { account } = await store.accounts.create({ kind: "gmail", email: "sender@example.com", displayName: "Synthetic", color: "indigo", now: NOW });
    const inserted = (await ingest(store, [
      msg({ accountId: account.id, providerMsgId: "one", providerThreadId: "one-thread" }),
      msg({ accountId: account.id, providerMsgId: "two", providerThreadId: "two-thread" }),
    ])).inserted;
    const one = await threadOf(store, "one"), two = await threadOf(store, "two");
    const action = await store.threads.act({ threadIds: [one, two], action: "markRead", signal: null, now: NOW });
    expect(action.opIds).toHaveLength(1); oldId = action.opIds[0]!;
    expect((await store.ops.claimReady(NOW + 1, 10)).some((op) => op.id === oldId)).toBe(true);
    await store.ops.awaitAuth(oldId, "synthetic retained flag error", NOW + 2);
    const before = (await store.ops.get(oldId))!; payload = before.payload_json;
    active = true;
    await store.threads.act({ threadIds: [one], action: "markUnread", signal: null, now: NOW + 3 });
    active = false;
    const after = (await store.ops.get(oldId))!;
    expect((JSON.parse(after.target_json) as { messageIds: number[] }).messageIds).toEqual([inserted[1]]);
    expect(after.payload_json).toBe(before.payload_json); expect(after.last_error).toBe(before.last_error);
    await store.close();
    store = await IdbMailStore.open({ factory, name, instantSearch, platform });
    expect(sameLogicalOp(await store.ops.get(oldId), after)).toBe(true);
    await store.debug.verify();
    expect({ basePuts, targetPuts, errorPuts, wireBytes }).toEqual({ basePuts: 0, targetPuts: 1, errorPuts: 0, wireBytes: 0 });
  } finally {
    active = false; spy.mockRestore(); await store.close(); await deleteMailbox(factory, physicalName);
  }
});

for (const instantSearch of [false, true]) for (const hidden of [false, true]) {
  it(`public part-persistence ${instantSearch ? "instant" : "scan"}: ${hidden ? "hidden C success poisons pending readers before fence" : "real C request abort restores the claimed operation"}`, async () => {
    const factory = new IDBFactory(), name = `op-terminal-${crypto.randomUUID()}`, physicalName = `terno-${name}`;
    const store = await IdbMailStore.open({ factory, name, instantSearch, platform });
    let reopened: IdbMailStore | undefined, raw: IDBDatabase | undefined;
    const put = IDBObjectStore.prototype.put;
    let active = false, hits = 0, errors = 0, actualTerminal: string | null = null;
    let pendingRead: Promise<unknown> | undefined, pendingWrite: Promise<unknown> | undefined;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (!active || this.name !== "op_control" || this.transaction.db.name !== physicalName) return Reflect.apply(put, this, args) as IDBRequest;
      active = false; hits++;
      const tx = this.transaction;
      tx.addEventListener("complete", () => { actualTerminal = "complete"; });
      tx.addEventListener("abort", () => { actualTerminal = "abort"; });
      const request = hidden ? Reflect.apply(put, this, args) as IDBRequest : this.add(args[0], args[1]);
      request.addEventListener("error", () => { errors++; });
      if (hidden) request.addEventListener("success", (event) => event.stopImmediatePropagation());
      pendingRead = store.ops.recent(10).then((value) => ({ ok: true, value }), () => ({ ok: false }));
      pendingWrite = store.settings.set("after-part-fault", true).then(() => ({ ok: true }), () => ({ ok: false }));
      return request;
    });
    let cleanupFailure: PromiseRejectedResult | undefined;
    try {
      const { account } = await store.accounts.create({ kind: "gmail", email: "sender@example.com", displayName: "Synthetic", color: "indigo", now: NOW });
      const queued = await store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [], subject: "terminal", bodyText: "synthetic", recordReply: false, now: NOW });
      await store.ops.claimReady(NOW + 1, 1);
      const before = (await store.ops.get(queued.opId))!;
      active = true;
      const failure = await store.ops.release(queued.opId, NOW + 2).then(() => null, (error: unknown) => error);
      expect(hits).toBe(1);
      expect(actualTerminal).toBe(hidden ? "complete" : "abort");
      expect(errors).toBe(hidden ? 0 : 1);
      expect(failure).not.toBeNull();
      expect(pendingRead).toBeDefined(); expect(pendingWrite).toBeDefined();
      const outcomes = await Promise.all([pendingRead!, pendingWrite!]);
      if (hidden) {
        expect(outcomes).toEqual([{ ok: false }, { ok: false }]);
        raw = await native(factory.open(physicalName));
        const tx = raw.transaction("meta"), done = terminal(tx);
        expect(await native(tx.objectStore("meta").getKey("uncertainWrite"))).toBe("uncertainWrite");
        await done; raw.close(); raw = undefined;
        await expect(IdbMailStore.open({ factory, name, instantSearch, platform })).rejects.toMatchObject({ name: "UncertainWriteError" });
      } else {
        expect((outcomes[0] as { ok: boolean }).ok).toBe(true);
        const observed = (outcomes[0] as { value: { id: string }[] }).value.find((op) => op.id === queued.opId)!;
        expect(sameLogicalOp(observed, before), "pending reader sees reconciled claimed operation").toBe(true);
        expect(outcomes[1]).toEqual({ ok: true });
        expect(sameLogicalOp(await store.ops.get(queued.opId), before)).toBe(true);
        await store.debug.verify();
        await store.close();
        reopened = await IdbMailStore.open({ factory, name, instantSearch, platform });
        expect(sameLogicalOp(await reopened.ops.get(queued.opId), before)).toBe(true);
      }
    } finally {
      active = false; spy.mockRestore(); raw?.close();
      const closed = await Promise.allSettled([store.close(), ...(reopened ? [reopened.close()] : [])]);
      await deleteMailbox(factory, physicalName);
      // close() joins the poisoned queue internally; every public close must still fulfill.
      cleanupFailure = closed.find((result) => result.status === "rejected");
    }
    if (cleanupFailure) throw cleanupFailure.reason;
  });
}

for (const instantSearch of [false, true]) {
  for (const legacyClear of [false, true]) {
    it(`public ${instantSearch ? "instant" : "scan"}: ${legacyClear ? "legacy error clears with explicit null" : "complete restores unchanged warning without error rewrite"}`, async () => {
      const factory = new IDBFactory(), name = `op-errors-${crypto.randomUUID()}`, physicalName = `terno-${name}`;
      const opened: IdbMailStore[] = [];
      let raw: IDBDatabase | undefined;
      const warning = "synthetic-warning-".repeat(512);
      let active = false, wireBytes = 0, errorBytes = 0, hits = 0;
      let payload = "";
      const put = IDBObjectStore.prototype.put;
      const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = Reflect.apply(put, this, args) as IDBRequest;
        if (active && this.transaction.db.name === physicalName) {
          hits++;
          wireBytes += unchangedPayloadJsonBytes(args[0], payload);
          errorBytes += unchangedPayloadJsonBytes(args[0], warning);
        }
        return request;
      });
      let cleanupFailure: PromiseRejectedResult | undefined;
      try {
        let store = await IdbMailStore.open({ factory, name, instantSearch, platform }); opened.push(store);
        const { account } = await store.accounts.create({ kind: "gmail", email: "sender@example.com", displayName: "Synthetic", color: "indigo", now: NOW });
        const queued = await store.compose.queueSend({ accountId: account.id, to: [{ name: "", email: "recipient@example.com" }], cc: [], bcc: [], subject: "errors", bodyText: "synthetic wire", recordReply: false, now: NOW });
        await store.ops.claimReady(NOW + 1, 1);
        await store.ops.awaitAuth(queued.opId, warning, NOW + 2);
        const parked = (await store.ops.get(queued.opId))!;
        payload = parked.payload_json;
        expect((JSON.parse(payload) as { text: string }).text).toBe("synthetic wire");
        if (legacyClear) {
          await store.close();
          raw = await native(factory.open(physicalName));
          const legacyParts = partNames.filter((part) => raw!.objectStoreNames.contains(part));
          const tx = raw.transaction(["ops", ...legacyParts], "readwrite"), done = terminal(tx);
          const read = tx.objectStore("ops").get(queued.opId);
          read.onsuccess = () => {
            // Supported legacy wide row, derived from the actual public auth transition.
            tx.objectStore("ops").put({ ...read.result, ...parked, updated_at: NOW + 2 }, queued.opId);
            for (const part of legacyParts) tx.objectStore(part).delete(queued.opId);
          };
          await done; raw.close(); raw = undefined;
          store = await IdbMailStore.open({ factory, name, instantSearch, platform }); opened.push(store);
        }
        await store.ops.resumeAuth(account.id, NOW + 3);
        expect((await store.ops.claimReady(NOW + 4, 1)).map((op) => op.id)).toEqual([queued.opId]);
        active = true;
        await store.ops.complete(queued.opId, legacyClear ? undefined : { warning }, NOW + 5);
        active = false;
        expect(hits).toBeGreaterThan(0);
        expect((await store.ops.get(queued.opId))!.last_error).toBe(legacyClear ? null : warning);
        await store.close();
        store = await IdbMailStore.open({ factory, name, instantSearch, platform }); opened.push(store);
        expect((await store.ops.get(queued.opId))!.last_error).toBe(legacyClear ? null : warning);
        await store.debug.verify();
        console.info("OP_ERROR_LOCALITY", instantSearch ? "instant" : "scan", legacyClear ? "legacy-clear" : "warning-restore",
          "wireBytes", wireBytes, "errorBytes", errorBytes, "hits", hits, "logicalAndReopen", true);
        expect(wireBytes, "complete resubmitted unchanged wire after logical/reopen checks").toBe(0);
        if (!legacyClear) expect(errorBytes, "complete rewrote unchanged first-preimage warning").toBe(0);
        if (legacyClear) {
          raw = await native(factory.open(physicalName));
          const tx = raw.transaction(["ops", "op_error"]), done = terminal(tx);
          const [base, error] = await Promise.all([native(tx.objectStore("ops").get(queued.opId)), native(tx.objectStore("op_error").get(queued.opId))]);
          await done;
          expect(base.last_error).toBe(warning);
          expect(error).toEqual({ last_error: null });
          raw.close(); raw = undefined;
        }
        await store.accounts.remove(account.id);
        expect(await store.ops.get(queued.opId)).toBeNull();
        await store.close();
        raw = await native(factory.open(physicalName));
        const tx = raw.transaction(["ops", ...partNames]), done = terminal(tx);
        const keys = await Promise.all(["ops", ...partNames].map((part) => native(tx.objectStore(part).getKey(queued.opId))));
        await done;
        expect(keys).toEqual([undefined, undefined, undefined, undefined]);
      } finally {
        active = false; spy.mockRestore(); raw?.close();
        const closed = await Promise.allSettled(opened.map((store) => store.close()));
        await deleteMailbox(factory, physicalName);
        cleanupFailure = closed.find((result) => result.status === "rejected");
      }
      if (cleanupFailure) throw cleanupFailure.reason;
    });
  }
}
