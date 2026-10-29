import { createNodeIncomingProcessor } from "../../../backend/src/incoming-worker";
import { watchLoop } from "../../../db/src/test/timing";
import { createGmailApiProvider } from "../gmail-api";
import { IncomingPipeline } from "../incoming";
import { IncomingProcessingError, type IncomingProcessor } from "../incoming-processing";
import type { ProviderContext, SyncSink } from "../types";

export class GmailFixtureEntryError extends Error {
  constructor() { super("Gmail fixture never entered an actual Response body consumer"); }
}

type BodyMode = "stream" | "empty-json-only";
type Failure = { error: unknown };
interface ReaderRecord {
  id: string;
  produced: number;
  expected: number;
  entered: boolean;
  producerClosed: boolean;
  producerCanceled: boolean;
  readerObtained: boolean;
  readerClosed: boolean;
  closed?: Promise<void>;
  cancelUnused?: () => Promise<void>;
}

function sameData(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return !!a && "value" in a && a.value === b.value && a.writable === b.writable
    && a.enumerable === b.enumerable && a.configurable === b.configurable;
}

/** Real processor and real shared admission; no request/mock histories. */
export class GmailFixturePool {
  private readonly native = createNodeIncomingProcessor();
  readonly jobs: { id: string; bytes: number; maxChunk: number; settled: boolean; code?: string; succeeded: boolean }[] = [];
  private monitor: ReturnType<typeof watchLoop> | undefined;
  private timing: ReturnType<ReturnType<typeof watchLoop>["stop"]> | undefined;
  private monitorBudget: number | undefined;
  active = 0;
  idleJoined = false;
  closeFulfilled = false;
  readonly processor: IncomingProcessor = {
    run: async (input, signal) => {
      if (input.kind !== "gmail" || this.jobs.length >= 6) throw new Error("Unexpected Gmail fixture worker input");
      let bytes = 0, maxChunk = 0;
      for (const chunk of input.chunks) {
        bytes += chunk.byteLength;
        maxChunk = Math.max(maxChunk, chunk.byteLength);
      }
      const job = { id: input.expectedId, bytes, maxChunk, settled: false, succeeded: false, code: undefined as string | undefined };
      this.jobs.push(job);
      this.active++;
      try {
        const result = await this.native.run(input, signal);
        job.succeeded = true;
        return result;
      } catch (error) {
        job.code = error instanceof IncomingProcessingError ? error.code : "unexpected-error-class";
        throw error;
      } finally { job.settled = true; this.active--; }
    },
    whenIdle: () => this.native.whenIdle(),
    close: () => this.native.close(),
  };
  readonly incoming = new IncomingPipeline(this.processor);

  beginConsumer(budget: number): void {
    if (this.timing || (this.monitorBudget !== undefined && this.monitorBudget !== budget)) throw new Error("Gmail fixture monitor scope changed");
    this.monitorBudget = budget;
    this.monitor ??= watchLoop(budget);
  }

  timingReport(): ReturnType<ReturnType<typeof watchLoop>["stop"]> {
    if (!this.monitor) throw new GmailFixtureEntryError();
    return this.timing ??= this.monitor.stop();
  }

  stopMonitor(): void {
    if (this.monitor && !this.timing) this.timing = this.monitor.stop();
  }

  async joinIdle(): Promise<void> {
    await this.native.whenIdle();
    this.idleJoined = true;
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try { this.incoming.close(); } catch (error) { failures.push(error); }
    const close = async () => this.native.close();
    const idle = async () => this.native.whenIdle();
    const results = await Promise.allSettled([close(), idle()]);
    failures.push(...results.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Actual Gmail worker close/idle failed");
    this.closeFulfilled = true;
  }
}

/** Synthetic HTTP bodies; the provider still uses its public incoming path. */
export class GmailResponseFixture {
  private readonly ownPool: boolean;
  readonly pool: GmailFixturePool;
  readonly readers: ReaderRecord[] = [];
  readonly checkpoints: unknown[] = [];
  readonly historyStarts: string[] = [];
  private readonly undos: (() => void)[] = [];
  private readonly passSignals = new Set<AbortSignal>();
  readonly counts = {
    requests: 0, consumers: 0, jsonCalls: 0, checkpoints: 0, effects: 0, ingested: 0,
    acquireCalls: 0, acquireGranted: 0, acquireRejected: 0, acquireReleaseCalls: 0,
    promotionCalls: 0, promotionGranted: 0, promotionRejected: 0, promotionReleaseCalls: 0,
    maxProducerChunk: 0, maxProducerBacking: 0, restored: 0,
  };
  syncSettled = false;
  providerCloseFulfilled = false;
  lastBodyText: string | null | undefined;
  readonly provider: ReturnType<typeof createGmailApiProvider>;
  private readonly sink: SyncSink;

  constructor(readonly source: string, readonly ids: readonly string[], readonly budget: number,
    options: { mode?: BodyMode; accountId?: number; pool?: GmailFixturePool } = {}) {
    if (!ids.length || ids.length > 6 || new Set(ids).size !== ids.length) throw new Error("Unexpected fixed Gmail fixture IDs");
    this.ownPool = !options.pool;
    this.pool = options.pool ?? new GmailFixturePool();
    const incoming: NonNullable<ProviderContext["incoming"]> = {
      acquire: async (id, signal, reset) => {
        this.counts.acquireCalls++;
        this.passSignals.add(signal);
        try {
          const release = await this.pool.incoming.acquire(id, signal, reset);
          this.counts.acquireGranted++;
          return () => { release(); this.counts.acquireReleaseCalls++; };
        } catch (error) { this.counts.acquireRejected++; throw error; }
      },
      promote: async (id, signal, reset) => {
        this.counts.promotionCalls++;
        try {
          const release = await this.pool.incoming.promote(id, signal, reset);
          this.counts.promotionGranted++;
          return () => { release(); this.counts.promotionReleaseCalls++; };
        } catch (error) { this.counts.promotionRejected++; throw error; }
      },
      retainCompleted: (bytes) => this.pool.incoming.retainCompleted(bytes),
    };
    const ctx = {
      account: { id: options.accountId ?? 1 }, config: {}, incoming, incomingProcessor: this.pool.processor,
      store: { messageByProviderId: async () => null, syncedMessages: async () => [], pendingAttachmentBodies: async () => [] },
      loadCursor: async () => null,
      saveCursor: async (cursor: unknown) => { this.counts.checkpoints++; this.checkpoints.push(cursor); },
      fetch: async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/profile")) return Response.json({ historyId: "10" });
        if (url.pathname.endsWith("/history")) { this.historyStarts.push(url.searchParams.get("startHistoryId")!); return Response.json({ historyId: "10" }); }
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: ids.map((id) => ({ id })) });
        const id = url.pathname.split("/").at(-1)!;
        if (!ids.includes(id) || url.searchParams.get("format") !== "raw") throw new Error("Unexpected Gmail fixture resource");
        this.counts.requests++;
        if (this.counts.requests > ids.length) throw new Error("Unexpected repeated Gmail fixture request");
        if (options.mode === "empty-json-only") {
          const response = new Response();
          Object.defineProperty(response, "json", { value: async () => {
            this.counts.jsonCalls++;
            return { id, threadId: id, raw: source };
          } });
          return response;
        }
        return this.response(id);
      },
    } as unknown as ProviderContext;
    this.provider = createGmailApiProvider(ctx, { tokens: { get: async () => "synthetic", invalidate() {} }, buildRaw: async () => new Uint8Array() });
    const effect = async () => { this.counts.effects++; };
    this.sink = {
      ingest: async (messages) => {
        this.counts.effects++;
        this.counts.ingested += messages.length;
        this.lastBodyText = messages.at(-1)?.bodyText;
      },
      updateFlags: effect, removeMessages: effect, setBody: effect, setSyncState: effect,
      pendingMessageIds: async () => new Set(), windowStart: 0, signal: new AbortController().signal,
    };
  }

  wireBytes(id: string): number {
    return this.prefix(id).length + this.source.length + 2;
  }

  private prefix(id: string): string {
    // Only tiny synthetic IDs are stringified; raw content is streamed as-is.
    return `{"id":${JSON.stringify(id)},"threadId":${JSON.stringify(id)},"raw":"`;
  }

  private response(id: string): Response {
    const segments = [this.prefix(id), this.source, '"}'];
    const record: ReaderRecord = { id, produced: 0, expected: this.wireBytes(id), entered: false,
      producerClosed: false, producerCanceled: false, readerObtained: false, readerClosed: false };
    this.readers.push(record);
    let segment = 0, offset = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (!record.entered) {
          record.entered = true;
          this.counts.consumers++;
          this.pool.beginConsumer(this.budget);
        }
        const bytes = new Uint8Array(Math.min(65536, record.expected - record.produced));
        let used = 0;
        while (used < bytes.length) {
          const text = segments[segment]!;
          const count = Math.min(text.length - offset, bytes.length - used);
          const encoded = encoder.encodeInto(text.slice(offset, offset + count), bytes.subarray(used));
          if (encoded.read !== count || encoded.written !== count) throw new Error("Gmail fixture framing requires the original ASCII raw data");
          used += count;
          offset += count;
          if (offset === text.length) { segment++; offset = 0; }
        }
        record.produced += used;
        this.counts.maxProducerChunk = Math.max(this.counts.maxProducerChunk, bytes.byteLength);
        this.counts.maxProducerBacking = Math.max(this.counts.maxProducerBacking, bytes.buffer.byteLength);
        controller.enqueue(bytes);
        if (record.produced === record.expected) { record.producerClosed = true; controller.close(); }
      },
      cancel: () => { record.producerCanceled = true; },
    }, { highWaterMark: 0 });
    record.cancelUnused = () => stream.cancel();
    const before = Object.getOwnPropertyDescriptor(stream, "getReader");
    const original = stream.getReader;
    const installed: PropertyDescriptor = { configurable: true, enumerable: false, writable: true,
      value: function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
        if (record.readerObtained) throw new Error("Unexpected second Gmail body reader");
        const reader = Reflect.apply(original, this, args) as ReadableStreamDefaultReader<Uint8Array>;
        record.readerObtained = true;
        record.closed = reader.closed.then(() => { record.readerClosed = true; });
        // Observe rejection immediately; the original promise is still joined below.
        void record.closed.catch(() => {});
        return reader;
      },
    };
    Object.defineProperty(stream, "getReader", installed);
    this.undos.push(() => {
      if (!sameData(Object.getOwnPropertyDescriptor(stream, "getReader"), installed)) throw new Error("Newer Gmail body reader descriptor preserved");
      if (before) Object.defineProperty(stream, "getReader", before);
      else if (!Reflect.deleteProperty(stream, "getReader")) throw new Error("Gmail body reader restoration failed");
      this.counts.restored++;
    });
    const response = new Response(stream);
    if (response.body !== stream) throw new Error("Gmail fixture must observe the actual Response body stream");
    return response;
  }

  async run(): Promise<unknown> {
    try { await this.provider.sync(this.sink); return undefined; }
    catch (error) { return error; }
    finally { this.syncSettled = true; }
  }

  async joinActualTerminals(): Promise<void> {
    const terminals = this.readers.map((reader) => {
      if (!reader.closed) throw new GmailFixtureEntryError();
      return reader.closed;
    });
    await Promise.all(terminals);
    await this.pool.joinIdle();
  }

  timingReport(): ReturnType<ReturnType<typeof watchLoop>["stop"]> {
    return this.pool.timingReport();
  }

  abortedPassCount(): number {
    return [...this.passSignals].filter((signal) => signal.aborted).length;
  }

  async finish(failure?: Failure): Promise<void> {
    const errors: unknown[] = failure ? [failure.error] : [];
    const providerClose = async () => { await this.provider.close(); this.providerCloseFulfilled = true; };
    const closes: Promise<unknown>[] = [providerClose()];
    if (this.ownPool) closes.push(this.pool.close());
    const closed = await Promise.allSettled(closes);
    errors.push(...closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    const readers = await Promise.allSettled(this.readers.map(async (reader) => reader.closed ? await reader.closed : await reader.cancelUnused!()));
    errors.push(...readers.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    try { if (this.ownPool) this.pool.stopMonitor(); } catch (error) { errors.push(error); }
    for (const undo of this.undos.splice(0).reverse()) {
      try { undo(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Gmail fixture body/cleanup failures");
  }
}
