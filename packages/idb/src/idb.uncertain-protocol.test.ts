import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { expect, it, vi } from "vitest";
import { databaseName, writeMeta } from "./schema";
import { IdbMailStore } from "./store";
import { UNCERTAINTY_KEY, UncertainWriteError } from "./uncertainty";

const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const ended = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.addEventListener("complete", () => resolve()); tx.addEventListener("abort", () => reject(tx.error)); });

type Stage = "guard" | "marker" | "body" | "clear";

// These counts are real IDB request submissions/events, never MemDb writes or disk operations.
function observeWrites(fault?: { stage: Stage; kind: "enqueue" | "request" | "accepted enqueue"; complete: boolean }) {
  const transaction = IDBDatabase.prototype.transaction;
  const getKey = IDBObjectStore.prototype.getKey, put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete;
  const injected = new Error(`injected ${fault?.stage} enqueue refusal`);
  const counts = { guard: 0, marker: 0, body: 0, clear: 0, faults: 0, abortRefusals: 0 };
  const successes: Stage[] = [], submissions: Stage[] = [], terminals: string[] = [];
  let transactions = 0;
  let target: IDBTransaction | undefined, original: unknown, durability: IDBTransactionDurability | undefined, actualDurability: IDBTransactionDurability | undefined;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
    const tx = transaction.call(this, ...args);
    if (args[1] === "readwrite") transactions++;
    if (args[1] === "readwrite" && !target) {
      target = tx; durability = args[2]?.durability; actualDurability = tx.durability;
      tx.addEventListener("complete", () => terminals.push("complete"));
      tx.addEventListener("abort", () => terminals.push("abort"));
      if (fault?.complete && fault.kind !== "request") vi.spyOn(tx, "abort").mockImplementation(() => { counts.abortRefusals++; throw new Error("injected abort refusal"); });
    }
    return tx;
  });
  const submit = (store: IDBObjectStore, stage: Stage, normal: () => IDBRequest) => {
    if (fault?.stage === stage && fault.kind === "enqueue") { counts.faults++; throw injected; }
    counts[stage]++; submissions.push(stage);
    let result: IDBRequest;
    if (fault?.stage === stage && fault.kind === "request") {
      counts.faults++;
      // Existing metadata makes this an actual asynchronous ConstraintError with no successful effect.
      result = store.transaction.objectStore("meta").add("forbidden replacement", "logicalSchema");
      result.addEventListener("error", (event) => { original = result.error; if (fault.complete) event.preventDefault(); });
    } else result = normal();
    result.addEventListener("success", () => successes.push(stage));
    if (fault?.stage === stage && fault.kind === "accepted enqueue") { counts.faults++; throw injected; }
    return result;
  };
  vi.spyOn(IDBObjectStore.prototype, "getKey").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.transaction !== target || this.name !== "meta" || key !== UNCERTAINTY_KEY) return getKey.call(this, key);
    return submit(this, "guard", () => getKey.call(this, key)) as IDBRequest<IDBValidKey | undefined>;
  });
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.transaction !== target) return put.call(this, value, key);
    const stage = this.name === "meta" && key === UNCERTAINTY_KEY ? "marker" : "body";
    return submit(this, stage, () => put.call(this, value, key)) as IDBRequest<IDBValidKey>;
  });
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
    if (this.transaction !== target) return remove.call(this, key);
    return submit(this, this.name === "meta" && key === UNCERTAINTY_KEY ? "clear" : "body", () => remove.call(this, key)) as IDBRequest<undefined>;
  });
  return { counts, successes, submissions, terminals, error: () => fault?.kind !== "request" ? injected : original, durability: () => durability, actualDurability: () => actualDurability, transactions: () => transactions };
}

for (const stage of ["guard", "marker", "clear"] as const) {
  for (const kind of ["enqueue", "request"] as const) {
    for (const complete of [false, true]) {
      it(`${stage} ${kind} failure waits for actual ${complete ? "complete" : "abort"} and preserves exact local effects`, async () => {
        const factory = new IDBFactory(), name = crypto.randomUUID();
        let store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
        let raw: IDBDatabase | undefined;
        try {
          await store.settings.set("retained", { text: "before", draft: false });
          await store.whenLoaded();
          const observation = observeWrites({ stage, kind, complete });
          const error = await store.settings.set("retained", { text: "after", draft: true }).then(() => null, (failure: unknown) => failure);
          expect(observation.counts).toEqual({
            guard: stage === "guard" && kind === "enqueue" ? 0 : 1,
            marker: stage === "guard" || (stage === "marker" && kind === "enqueue") ? 0 : 1,
            body: stage === "clear" ? 1 : 0,
            clear: stage === "clear" && kind === "request" ? 1 : 0,
            faults: 1, abortRefusals: complete && kind === "enqueue" ? 1 : 0,
          });
          expect(observation.terminals).toEqual([complete ? "complete" : "abort"]);
          expect(error).toBe(observation.error());
          if (kind === "request") expect(error).toMatchObject({ name: "ConstraintError" });
          expect(store.isOpen).toBe(!complete);
          if (!complete) {
            expect(await store.settings.get("retained", null)).toEqual({ text: "before", draft: false });
            await store.debug.verify();
          } else await expect(store.settings.get("retained", null)).rejects.toThrow("closed");
          vi.restoreAllMocks();
          await store.close();
          raw = await request(factory.open(databaseName(name)));
          const tx = raw.transaction(["meta", "settings"]), finished = ended(tx);
          const values = await Promise.all([
            request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY)),
            request(tx.objectStore("settings").get("retained")),
            request(tx.objectStore("meta").get("logicalSchema")),
          ]);
          await finished;
          expect(values).toEqual([
            complete && stage === "clear" ? UNCERTAINTY_KEY : undefined,
            { key: "retained", value_json: JSON.stringify(complete && stage === "clear" ? { text: "after", draft: true } : { text: "before", draft: false }) },
            23,
          ]);
          raw.close(); raw = undefined;
          if (complete && stage === "clear") await expect(IdbMailStore.open({ factory, name, instantSearch: false, platform })).rejects.toBeInstanceOf(UncertainWriteError);
          else {
            store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
            expect(await store.settings.get("retained", null)).toEqual({ text: "before", draft: false });
          }
        } finally { vi.restoreAllMocks(); raw?.close(); await store.close(); }
      });
    }
  }
}

it("does not clear an accepted body request when its enqueue callback throws before returning", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  let raw: IDBDatabase | undefined;
  try {
    await store.settings.set("retained", "before"); await store.whenLoaded();
    const observation = observeWrites({ stage: "body", kind: "accepted enqueue", complete: true });
    const error = await store.settings.set("retained", "accepted prefix").then(() => null, (failure: unknown) => failure);
    expect(observation.counts).toEqual({ guard: 1, marker: 1, body: 1, clear: 0, faults: 1, abortRefusals: 1 });
    expect(observation.terminals).toEqual(["complete"]);
    expect(observation.successes).toEqual(["guard", "marker", "body"]);
    expect(error).toBe(observation.error()); expect(store.isOpen).toBe(false);
    vi.restoreAllMocks(); await store.close();
    raw = await request(factory.open(databaseName(name)));
    const tx = raw.transaction(["meta", "settings"]), finished = ended(tx);
    const values = await Promise.all([request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY)), request(tx.objectStore("settings").get("retained"))]);
    await finished;
    expect(values).toEqual([UNCERTAINTY_KEY, { key: "retained", value_json: '"accepted prefix"' }]);
    raw.close(); raw = undefined;
    await expect(IdbMailStore.open({ factory, name, instantSearch: false, platform })).rejects.toBeInstanceOf(UncertainWriteError);
  } finally { vi.restoreAllMocks(); raw?.close(); await store.close(); }
});

it.each([1, 4096])("a healthy single-row write submits three metadata requests for a %i-character value", async (length) => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  try {
    await store.whenLoaded();
    const observation = observeWrites();
    await store.settings.set("payload", "x".repeat(length));
    expect(observation.counts).toEqual({ guard: 1, marker: 1, body: 1, clear: 1, faults: 0, abortRefusals: 0 });
    expect(observation.submissions).toEqual(["guard", "marker", "body", "clear"]);
    expect(observation.successes).toEqual(["guard", "marker", "body", "clear"]);
    expect(observation.terminals).toEqual(["complete"]);
    expect(observation.durability()).toBe("strict"); expect(observation.actualDurability()).toBe("strict");
    expect(await store.settings.get("payload", null)).toBe("x".repeat(length));
    vi.restoreAllMocks(); await store.debug.verify();
  } finally { vi.restoreAllMocks(); await store.close(); }
});

it("preserves relaxed durability for a public sync write", async () => {
  const store = await IdbMailStore.open({ factory: new IDBFactory(), name: crypto.randomUUID(), instantSearch: false, platform });
  try {
    const [account] = await withAccounts(store, 1); await store.whenLoaded();
    const observation = observeWrites();
    await ingest(store, [msg({ accountId: account!, providerMsgId: "relaxed" })]);
    expect(observation.counts.guard).toBe(1); expect(observation.counts.marker).toBe(1);
    expect(observation.counts.body).toBeGreaterThan(0); expect(observation.counts.clear).toBe(1);
    expect(observation.terminals).toEqual(["complete"]);
    expect(observation.durability()).toBe("relaxed"); expect(observation.actualDurability()).toBe("relaxed");
    expect((await store.debug.snapshot()).messages).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await store.close(); }
});

it("refuses the reserved metadata key before a transaction, while ordinary metadata survives reopen", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  let store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  let raw: IDBDatabase | undefined;
  try {
    await store.settings.set("public-control", "exact"); await store.close();
    raw = await request(factory.open(databaseName(name)));
    const observation = observeWrites();
    await expect(writeMeta(raw, { [UNCERTAINTY_KEY]: undefined, logicalSchema: -1 })).rejects.toThrow("reserved");
    expect(observation.transactions()).toBe(0);
    expect(observation.counts).toEqual({ guard: 0, marker: 0, body: 0, clear: 0, faults: 0, abortRefusals: 0 });
    expect(observation.terminals).toEqual([]);
    await writeMeta(raw, { qualification: { exact: true } });
    expect(observation.counts).toEqual({ guard: 1, marker: 1, body: 1, clear: 1, faults: 0, abortRefusals: 0 });
    expect(observation.terminals).toEqual(["complete"]);
    vi.restoreAllMocks();
    const tx = raw.transaction("meta"), finished = ended(tx);
    const values = await Promise.all([request(tx.objectStore("meta").get("qualification")), request(tx.objectStore("meta").get("logicalSchema")), request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY))]);
    await finished; expect(values).toEqual([{ exact: true }, 23, undefined]);
    raw.close(); raw = undefined;
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect(await store.settings.get("public-control", null)).toBe("exact");
  } finally { vi.restoreAllMocks(); raw?.close(); await store.close(); }
});

for (const stage of ["guard", "marker", "clear"] as const) {
  it.each(["enqueue", "request"] as const)(`ordinary metadata ${stage} %s failure rolls back metadata and retains the public mailbox`, async (kind) => {
    const factory = new IDBFactory(), name = crypto.randomUUID();
    let store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    let raw: IDBDatabase | undefined;
    try {
      await store.settings.set("public-control", "kept"); await store.close();
      raw = await request(factory.open(databaseName(name)));
      const observation = observeWrites({ stage, kind, complete: false });
      const error = await writeMeta(raw, { qualification: "must roll back", logicalSchema: -1 }).then(() => null, (failure: unknown) => failure);
      expect(observation.counts).toEqual({
        guard: stage === "guard" && kind === "enqueue" ? 0 : 1,
        marker: stage === "guard" || (stage === "marker" && kind === "enqueue") ? 0 : 1,
        body: stage === "clear" ? 2 : 0, clear: stage === "clear" && kind === "request" ? 1 : 0,
        faults: 1, abortRefusals: 0,
      });
      expect(observation.terminals).toEqual(["abort"]); expect(error).toBe(observation.error());
      vi.restoreAllMocks();
      const tx = raw.transaction("meta"), finished = ended(tx);
      const values = await Promise.all([request(tx.objectStore("meta").get("qualification")), request(tx.objectStore("meta").get("logicalSchema")), request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY))]);
      await finished; expect(values).toEqual([undefined, 23, undefined]);
      raw.close(); raw = undefined;
      store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
      expect(await store.settings.get("public-control", null)).toBe("kept");
    } finally { vi.restoreAllMocks(); raw?.close(); await store.close(); }
  });
}

it("metadata writes cannot replace or clear a present undefined marker", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  const seed = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  let raw: IDBDatabase | undefined;
  try {
    await seed.settings.set("public-control", "preserved"); await seed.close();
    raw = await request(factory.open(databaseName(name)));
    const mark = raw.transaction("meta", "readwrite"), marked = ended(mark);
    mark.objectStore("meta").put(undefined, UNCERTAINTY_KEY); await marked;
    const observation = observeWrites();
    const error = await writeMeta(raw, { logicalSchema: -1 }).then(() => null, (failure: unknown) => failure);
    expect(observation.counts).toEqual({ guard: 1, marker: 0, body: 0, clear: 0, faults: 0, abortRefusals: 0 });
    expect(observation.terminals).toEqual(["abort"]);
    expect(error).toBeInstanceOf(UncertainWriteError);
    vi.restoreAllMocks();
    const tx = raw.transaction(["meta", "settings"]), finished = ended(tx);
    const values = await Promise.all([request(tx.objectStore("meta").getKey(UNCERTAINTY_KEY)), request(tx.objectStore("meta").get(UNCERTAINTY_KEY)), request(tx.objectStore("meta").get("logicalSchema")), request(tx.objectStore("settings").get("public-control"))]);
    await finished;
    expect(values).toEqual([UNCERTAINTY_KEY, undefined, 23, { key: "public-control", value_json: '"preserved"' }]);
    raw.close(); raw = undefined;
    await expect(IdbMailStore.open({ factory, name, instantSearch: false, platform })).rejects.toBeInstanceOf(UncertainWriteError);
  } finally { vi.restoreAllMocks(); raw?.close(); await seed.close(); }
});

it("delete-only public writes clear after their request, and an absent delete submits no requests", async () => {
  const factory = new IDBFactory(), name = crypto.randomUUID();
  let store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
  try {
    // Synthetic credential bytes exercise deletion without involving any real profile or provider.
    await store.secrets.put("qualification-only", new Uint8Array([1, 2, 3])); await store.whenLoaded();
    let observation = observeWrites();
    await store.secrets.delete("qualification-only");
    expect(observation.counts).toEqual({ guard: 1, marker: 1, body: 1, clear: 1, faults: 0, abortRefusals: 0 });
    expect(observation.successes).toEqual(["guard", "marker", "body", "clear"]); expect(observation.terminals).toEqual(["complete"]);
    vi.restoreAllMocks();
    observation = observeWrites();
    await store.secrets.delete("qualification-only");
    expect(observation.transactions()).toBe(0);
    expect(observation.counts).toEqual({ guard: 0, marker: 0, body: 0, clear: 0, faults: 0, abortRefusals: 0 });
    expect(observation.terminals).toEqual([]);
    vi.restoreAllMocks(); await store.debug.verify(); await store.close();
    store = await IdbMailStore.open({ factory, name, instantSearch: false, platform });
    expect(await store.secrets.get("qualification-only")).toBeNull();
  } finally { vi.restoreAllMocks(); await store.close(); }
});
