import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createGmailApiProvider, type ProviderRegistry } from "@terno/mail/portable";
import { Backend, plaintextCipher } from "./backend";

// Every bound here holds per page and per batch (500 listed, 50 ingested or refreshed, six readers), and no limit in the
// provider sits between this and 50k, so three list pages take as many of each step as it takes. 50k itself is in
// gmail-batches.perf: "keeps 50k small-message processing" and "bounds 50k cached refresh pages".
const COUNT = 1500;
const idAt = (i: number) => `m${String(i).padStart(5, "0")}`;
function mailbox() {
  const dir = mkdtempSync(join(tmpdir(), "terno-resource-"));
  const abort = new AbortController();
  let pass = new AbortController();
  let stopAfterEnumeration = false;
  let boundaryStopped = false;
  let lastStage: string | undefined;
  let phaseStarted = performance.now();
  const observe = (name: string, detail: object = {}) => console.log("resource-phase", JSON.stringify({ name, elapsedMs: performance.now() - phaseStarted, ...detail }));
  let backend: Backend | undefined, work: Promise<void> | undefined;
  const expected = Array.from({ length: COUNT }, (_, i) => idAt(i));
  const expectedSet = new Set(expected);
  const rawIds: string[] = [], minimalIds: string[] = [];
  let readers = 0, maxReaders = 0, nativeBytes = 0, maxNativeBytes = 0, unreleasedLocks = 0;
  const backing = new Map<ArrayBufferLike, number>();
  let held = 0, maxHeld = 0, active = 0, maxActive = 0, queued = 0, maxQueued = 0;
  let maxBatch = 0, batches = 0, refused = false, recovery = false;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (input instanceof Request && input.method !== "GET") throw new Error("Unexpected synthetic method");
    if (url.origin !== "https://gmail.googleapis.com" || !url.pathname.startsWith("/gmail/v1/users/me/")) throw new Error(`Unexpected synthetic route ${url.origin}${url.pathname}`);
    const path = url.pathname.slice("/gmail/v1/users/me".length);
    if (path === "/profile") return Response.json({ historyId: "10", emailAddress: "me@example.test" });
    if (path === "/labels") return Response.json({ labels: [] });
    if (path === "/history") return Response.json(url.searchParams.get("startHistoryId") === "1" ? {} : { historyId: "10" }, { status: url.searchParams.get("startHistoryId") === "1" ? 404 : 200 });
    if (path === "/messages") {
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      expect(url.searchParams.get("maxResults")).toBe("500");
      if (!Number.isInteger(start) || start < 0 || start >= COUNT || start % 500) throw new Error("Unexpected continuation");
      return Response.json({ messages: Array.from({ length: 500 }, (_, i) => ({ id: idAt(start + i) })), ...(start + 500 < COUNT && { nextPageToken: String(start + 500) }) });
    }
    const id = path.slice("/messages/".length);
    if (!/^m\d{5}$/.test(id) || !expectedSet.has(id)) throw new Error("Unexpected synthetic identity");
    if (url.searchParams.get("format") === "minimal") {
      minimalIds.push(id);
      if (recovery && id === idAt(COUNT - 1) && !refused) { refused = true; return Response.json({}, { status: 503 }); }
      return Response.json({ id, labelIds: recovery ? ["INBOX", "UNREAD"] : ["INBOX"] });
    }
    if (url.searchParams.get("format") !== "raw") throw new Error("Unexpected synthetic format");
    rawIds.push(id);
    const bytes = new TextEncoder().encode(JSON.stringify({ id, threadId: id, labelIds: ["INBOX"], raw: Buffer.from(`From: sender@example.test\r\nSubject: ${id}\r\nMessage-ID: <${id}@example.test>\r\nContent-Type: text/plain\r\n\r\nBody ${id}`).toString("base64url") }));
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const getReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", { value: () => {
      const reader = getReader();
      readers++; unreleasedLocks++;
      const owners = backing.get(bytes.buffer) ?? 0;
      backing.set(bytes.buffer, owners + 1);
      if (!owners) nativeBytes += bytes.buffer.byteLength;
      let settled = false;
      const terminal = () => {
        if (settled) return; settled = true;
        readers--;
        const owners = backing.get(bytes.buffer)! - 1;
        if (owners) backing.set(bytes.buffer, owners);
        else { backing.delete(bytes.buffer); nativeBytes -= bytes.buffer.byteLength; }
      };
      void reader.closed.then(terminal, terminal);
      maxReaders = Math.max(maxReaders, readers); maxNativeBytes = Math.max(maxNativeBytes, nativeBytes);
      const unlock = reader.releaseLock.bind(reader);
      reader.releaseLock = () => { unreleasedLocks--; terminal(); unlock(); };
      return reader;
    } });
    return new Response(body);
  });
  const providers: ProviderRegistry = {
    create(ctx) {
      const incoming = ctx.incoming!;
      const provider = createGmailApiProvider({ ...ctx,
        async saveCursor(value, check) {
          await ctx.saveCursor(value, check);
          const state = value as { reconciliation?: { stage: string; pages?: number } };
          const stage = state.reconciliation?.stage ?? "terminal";
          if (stage !== lastStage) { lastStage = stage; observe("checkpoint", { stage, pages: state.reconciliation?.pages }); }
          if (stopAfterEnumeration && stage === "refresh") {
            boundaryStopped = true;
            pass.abort(new DOMException("Synthetic durable enumeration boundary", "AbortError"));
          }
        }, incoming: {
        async acquire(...args) {
          queued++; maxQueued = Math.max(maxQueued, queued);
          let owned: () => void;
          try { owned = await incoming.acquire(...args); } finally { queued--; }
          active++; maxActive = Math.max(maxActive, active);
          return () => { active--; owned(); };
        },
        promote: incoming.promote!.bind(incoming),
        retainCompleted(bytes) {
          const owned = incoming.retainCompleted!(bytes);
          if (!owned) return;
          held += bytes; maxHeld = Math.max(maxHeld, held);
          return () => { held -= bytes; owned(); };
        },
      } }, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
      return { ...provider, sync: (sink) => provider.sync({ ...sink, signal: AbortSignal.any([sink.signal, abort.signal, pass.signal]), ingest: async (messages, options) => {
        maxBatch = Math.max(maxBatch, messages.length); batches++;
        if (batches === 1) { entered(); await blocked; }
        await sink.ingest(messages, options);
      } }) };
    }, async verifyImap() {}, async connectGmail() { throw new Error("Unused synthetic consent"); },
  };
  const open = async () => {
    backend = new Backend({ dbPath: join(dir, "mail.db"), providers, cipher: plaintextCipher, autoSync: false, instantSearch: false, iconTransport: null, version: "test" });
    await backend.ready;
    return backend;
  };
  let accountId: number;
  const cursor = async () => (await backend!.store.accounts.config<{ cursor?: unknown }>(accountId))!.config.cursor;
  const assertIdle = () => {
    expect(held).toBe(0); expect(active).toBe(0); expect(queued).toBe(0);
    expect(readers).toBe(0); expect(nativeBytes).toBe(0); expect(backing.size).toBe(0);
  };
  const assertCoverage = async (read: (id: string) => boolean) => {
    const snapshot = await backend!.store.debug.snapshot();
    const rows = snapshot.messages;
    const threads = new Map(snapshot.threads.map((t) => [t.id, t.providerThreadId]));
    expect(snapshot.threads).toHaveLength(COUNT);
    expect(rows.every((m) => threads.get(m.threadId) === m.providerMsgId)).toBe(true);
    expect(rows.every((m) => m.isRead === read(m.providerMsgId!))).toBe(true);
    expect(rows.map((m) => m.providerMsgId).sort()).toEqual(expected);
    expect(new Set(rows.map((m) => m.threadId)).size).toBe(COUNT);
    expect(rows[0]!.bodyText).toBe(`Body ${rows[0]!.providerMsgId}\n`);
    expect(rows.every((m) => m.bodyText === `Body ${m.providerMsgId}\n`)).toBe(true);
    expect(rows.every((m) => !m.hasAttachments)).toBe(true);
  };
  const metrics = () => ({ count: COUNT, maxBatch, batches, maxActive, maxQueued, maxReaders, maxNativeBytes, unreleasedLocks, maxHeld, raw: rawIds.length });
  const cancel = () => { release(); abort.abort(); };
  return {
    cancel,
    observeFailure() { observe("failed-phase", { raw: rawIds.length, minimal: minimalIds.length, held, active, queued, readers, nativeBytes }); },
    async close() {
      cancel();
      try { await work; }
      finally {
        try { await backend?.stop(); }
        finally { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); }
      }
    },
    async enumerate() {
      phaseStarted = performance.now(); observe("initial-enumeration-start");
      stopAfterEnumeration = true;
      const first = await open();
      const { account } = await first.store.accounts.create({ kind: "gmail", email: "me@example.test", displayName: "Synthetic", color: "brown", now: 1 });
      accountId = account.id;
      await (await first.provider(accountId))!.verify();
      work = first.syncAccount(accountId);
      try {
        await Promise.race([started, work.then(() => { throw new Error("Initial ingest never blocked"); })]);
        abort.signal.throwIfAborted();
        expect(held).toBeGreaterThan(0);
        expect(held).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(await cursor()).toMatchObject({ reconciliation: { stage: "enumerate", pages: 0 } });
        expect((await first.store.debug.snapshot()).messages).toEqual([]);
      } finally { release(); }
      await work; abort.signal.throwIfAborted();
      expect(rawIds.slice().sort()).toEqual(expected);
      expect(boundaryStopped).toBe(true);
      expect(minimalIds).toHaveLength(0);
      await assertCoverage(() => true);
      expect(await cursor()).toMatchObject({ reconciliation: { stage: "refresh", pages: COUNT / 500 } });
      assertIdle();
      observe("initial-enumeration-complete", metrics());
    },
    async initialRefresh() {
      phaseStarted = performance.now(); observe("initial-refresh-start");
      stopAfterEnumeration = false; pass = new AbortController();
      work = backend!.syncAccount(accountId); await work; abort.signal.throwIfAborted();
      expect(rawIds.slice().sort()).toEqual(expected);
      expect(minimalIds.slice().sort()).toEqual(expected);
      await assertCoverage(() => true);
      expect(await cursor()).toEqual({ historyId: "10" });
      assertIdle();
      observe("initial-refresh-complete", metrics());
    },
    async recover() {
      phaseStarted = performance.now(); observe("recovery-start");
      await backend!.store.accounts.setCursor(accountId, { historyId: "1" });
      recovery = true; minimalIds.length = 0;
      work = backend!.syncAccount(accountId); await work; abort.signal.throwIfAborted();
      expect(refused).toBe(true);
      expect(minimalIds.slice().sort()).toEqual(expected);
      expect(await cursor()).toMatchObject({ historyId: "1", reconciliation: { stage: "refresh", refreshAfter: idAt(COUNT - 51) } });
      await assertCoverage((id) => id > idAt(COUNT - 51));
      assertIdle();
      observe("recovery-refusal-complete", metrics());
    },
    async reopen() {
      phaseStarted = performance.now(); observe("reopen-start");
      await backend!.stop(); await open();
      minimalIds.length = 0;
      work = backend!.syncAccount(accountId); await work; abort.signal.throwIfAborted();
      expect(minimalIds.slice().sort()).toEqual(expected.slice(-50));
      expect(rawIds.slice().sort()).toEqual(expected);
      await assertCoverage(() => false);
      expect(await cursor()).toEqual({ historyId: "10" });
      observe("reopen-complete", metrics());
      expect(maxBatch).toBeLessThanOrEqual(50); expect(maxActive).toBeLessThanOrEqual(6);
      expect(maxReaders).toBeLessThanOrEqual(6); expect(maxQueued).toBeLessThanOrEqual(6);
      expect(maxHeld).toBeLessThanOrEqual(4 * 1024 * 1024);
      assertIdle();
    },
  };
}

// Each case inherits the database and durable checkpoint produced by its predecessor.
describe("native SQLite Gmail ordered resource qualification", { concurrent: false }, () => {
  let fixture: ReturnType<typeof mailbox> | undefined;
  let phase: Promise<void> | undefined;
  let completed = 0;
  afterEach(async ({ task }) => {
    if (task.result?.state === "fail") {
      fixture?.cancel();
      await phase?.catch(() => {});
      fixture?.observeFailure();
    }
  });
  afterAll(async () => {
    fixture?.cancel();
    try { await phase?.catch(() => {}); }
    finally { await fixture?.close(); }
  });
  it("initial provider enumeration persists all messages, threads and bodies before refresh", async () => {
    fixture = mailbox();
    phase = fixture.enumerate();
    await phase;
    completed = 1;
  });
  it("initial refresh verifies all cached flags and completes history", async () => {
    expect(completed, "initial enumeration must complete; dependent phases never skip").toBe(1);
    phase = fixture!.initialRefresh();
    await phase;
    completed = 2;
  });
  it("recovery changes all flags and preserves the late 503 checkpoint", async () => {
    expect(completed, "initial sync must complete before recovery").toBe(2);
    phase = fixture!.recover();
    await phase;
    completed = 3;
  });
  it("graceful reopen resumes exactly final 50 and verifies all identities and bodies", async () => {
    expect(completed, "recovery refusal must settle before reopen").toBe(3);
    phase = fixture!.reopen();
    await phase;
    completed = 4;
  });
});
