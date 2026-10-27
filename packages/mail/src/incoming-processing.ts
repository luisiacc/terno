import { MAX_INCOMING_MIME_BYTES } from "@terno/core";
import type { ParsedMessage } from "./mime";

export type IncomingProcessingInput =
  | { kind: "gmail"; expectedId: string; chunks: Uint8Array[] }
  | { kind: "mime"; chunks: Uint8Array[] };

export interface IncomingGmailMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
}

export type IncomingProcessingResult =
  | { kind: "gmail"; metadata: IncomingGmailMetadata; message: ParsedMessage }
  | { kind: "mime"; message: ParsedMessage };

export interface IncomingProcessingLimits {
  maxResultTextCodeUnits?: number;
  maxResultMetadataCodeUnits?: number;
}

export interface IncomingProcessor {
  run(input: IncomingProcessingInput, signal: AbortSignal): Promise<IncomingProcessingResult>;
  close(): Promise<void>;
}

export const INCOMING_GMAIL_WIRE_BYTES = 4 * Math.ceil(MAX_INCOMING_MIME_BYTES / 3) + 256 * 1024;
const FAILURE_CODES = [
  "malformed-json", "malformed-resource", "malformed-base64", "envelope-unavailable",
  "mime-limit-parts", "mime-limit-depth", "mime-limit-headers", "mime-limit-addresses",
  "input-limit", "result-limit", "worker-unavailable", "worker-fault", "worker-busy", "worker-closed",
] as const;
export type IncomingProcessingFailureCode = typeof FAILURE_CODES[number];

export class IncomingProcessingError extends Error {
  constructor(readonly code: IncomingProcessingFailureCode) {
    super(`Incoming processing failed (${code})`);
    this.name = "IncomingProcessingError";
  }
}

export interface IncomingWorkerRequest {
  type: "process";
  incarnation: number;
  job: number;
  input: IncomingProcessingInput;
  limits?: IncomingProcessingLimits;
}
export type IncomingWorkerReply =
  | { type: "result"; incarnation: number; job: number; result: IncomingProcessingResult }
  | { type: "error"; incarnation: number; job: number; code: IncomingProcessingFailureCode };

export interface IncomingWorkerEvents {
  message(value: unknown): void;
  fault(): void;
}
export interface IncomingWorkerHost {
  postMessage(request: IncomingWorkerRequest, transfer: ArrayBuffer[]): void;
  terminate(): void | Promise<void>;
  setActive?(active: boolean): void;
}
export type IncomingWorkerFactory = (events: IncomingWorkerEvents) => IncomingWorkerHost | Promise<IncomingWorkerHost>;

export function isIncomingFailureCode(value: unknown): value is IncomingProcessingFailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}

/** The collector owns exact buffers; no host-side copy can hide pooled neighbors. */
export function incomingInputTransfers(input: IncomingProcessingInput): ArrayBuffer[] {
  if (!input || (input.kind !== "gmail" && input.kind !== "mime") || !Array.isArray(input.chunks) || input.chunks.length > 4096) throw new IncomingProcessingError("input-limit");
  if (input.kind === "gmail" && (typeof input.expectedId !== "string" || !input.expectedId.trim())) throw new IncomingProcessingError("malformed-resource");
  const buffers = new Set<ArrayBuffer>();
  const cap = input.kind === "gmail" ? INCOMING_GMAIL_WIRE_BYTES : MAX_INCOMING_MIME_BYTES + 1;
  let bytes = 0;
  for (const chunk of input.chunks) {
    if (!(chunk instanceof Uint8Array) || !(chunk.buffer instanceof ArrayBuffer) || chunk.byteOffset !== 0 || chunk.byteLength !== chunk.buffer.byteLength) throw new IncomingProcessingError("input-limit");
    try { new Uint8Array(chunk.buffer, 0, 0); } catch { throw new IncomingProcessingError("input-limit"); }
    bytes += chunk.byteLength;
    if (bytes > cap) throw new IncomingProcessingError("input-limit");
    buffers.add(chunk.buffer);
  }
  return [...buffers];
}

function processingLimits(limits: IncomingProcessingLimits): IncomingProcessingLimits {
  const result: IncomingProcessingLimits = {};
  for (const key of ["maxResultTextCodeUnits", "maxResultMetadataCodeUnits"] as const) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new IncomingProcessingError("input-limit");
    result[key] = value;
  }
  return result;
}

function canceled(): Error {
  const error = new Error("Incoming processing canceled");
  error.name = "AbortError";
  return error;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface WorkerSlot {
  incarnation: number;
  host?: IncomingWorkerHost;
  retiring: boolean;
  termination?: Promise<void>;
  retirementFailed?: boolean;
}
interface Job {
  id: number;
  slot: WorkerSlot;
  input?: IncomingProcessingInput;
  signal: AbortSignal;
  abort(): void;
  resolve(result: IncomingProcessingResult): void;
  reject(error: Error): void;
}

export function createIncomingProcessor(factory: IncomingWorkerFactory, options: IncomingProcessingLimits = {}): IncomingProcessor {
  const limits = processingLimits(options);
  let incarnation = 0;
  let jobId = 0;
  let slot: WorkerSlot | undefined;
  let active: Job | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const retire = (owned: WorkerSlot): Promise<void> => {
    owned.retiring = true;
    if (owned.termination) return owned.termination;
    // A canceled startup keeps its slot until the factory answers.
    if (!owned.host) return Promise.resolve();
    const clear = () => { if (slot === owned) slot = undefined; };
    try {
      const ending = owned.host.terminate();
      if (!ending) { clear(); return Promise.resolve(); }
      owned.termination = ending.then(clear, () => { owned.retirementFailed = true; });
    } catch {
      owned.retirementFailed = true;
      owned.termination = Promise.resolve();
    }
    return owned.termination;
  };
  const finish = (job: Job, result?: IncomingProcessingResult, error?: Error) => {
    if (active !== job) return;
    active = undefined;
    job.input = undefined;
    job.signal.removeEventListener("abort", job.abort);
    if (!job.slot.retiring) job.slot.host?.setActive?.(false);
    if (error) job.reject(error);
    else job.resolve(result!);
  };
  const fault = (owned: WorkerSlot) => {
    if (slot !== owned || owned.retiring) return;
    const job = active;
    if (job?.slot === owned) finish(job, undefined, new IncomingProcessingError("worker-fault"));
    void retire(owned);
  };
  const reply = (owned: WorkerSlot, value: unknown) => {
    const job = active;
    if (slot !== owned || owned.retiring || !job || job.slot !== owned) return;
    if (!record(value)) { fault(owned); return; }
    if (!Number.isSafeInteger(value.incarnation) || !Number.isSafeInteger(value.job)) { fault(owned); return; }
    if (value.incarnation !== owned.incarnation || value.job !== job.id) return;
    if (job.signal.aborted) { job.abort(); return; }
    if (value.type === "error" && isIncomingFailureCode(value.code)) {
      finish(job, undefined, new IncomingProcessingError(value.code));
      if (value.code === "worker-fault" || value.code === "worker-unavailable") void retire(owned);
      return;
    }
    const result = value.result;
    if (value.type !== "result" || !record(result) || result.kind !== job.input?.kind || !record(result.message) || !Array.isArray(result.message.attachments) || (result.kind === "gmail" && !record(result.metadata))) { fault(owned); return; }
    finish(job, result as unknown as IncomingProcessingResult);
  };
  const post = (job: Job) => {
    const owned = job.slot;
    if (active !== job || owned.retiring || !owned.host) return;
    if (job.signal.aborted) { job.abort(); return; }
    let transfer: ArrayBuffer[];
    try { transfer = incomingInputTransfers(job.input!); }
    catch (error) {
      finish(job, undefined, error instanceof IncomingProcessingError ? error : new IncomingProcessingError("input-limit"));
      return;
    }
    try {
      owned.host.setActive?.(true);
      owned.host.postMessage({ type: "process", incarnation: owned.incarnation, job: job.id, input: job.input!, limits }, transfer);
    } catch { fault(owned); }
  };
  const attach = (owned: WorkerSlot, host: IncomingWorkerHost) => {
    owned.host = host;
    if (closed || owned.retiring || slot !== owned) { void retire(owned); return; }
    if (active?.slot === owned) post(active);
  };
  const unavailable = (owned: WorkerSlot) => {
    if (slot !== owned) return;
    if (active?.slot === owned) finish(active, undefined, new IncomingProcessingError("worker-unavailable"));
    slot = undefined;
  };

  return {
    async run(input, signal) {
      if (signal.aborted) throw canceled();
      if (closed) throw new IncomingProcessingError("worker-closed");
      if (active || slot?.retiring) throw new IncomingProcessingError(slot?.retirementFailed ? "worker-unavailable" : "worker-busy");
      incomingInputTransfers(input);
      const projected: IncomingProcessingInput = input.kind === "gmail"
        ? { kind: "gmail", expectedId: input.expectedId, chunks: [...input.chunks] }
        : { kind: "mime", chunks: [...input.chunks] };
      const owned = slot ?? { incarnation: ++incarnation, retiring: false };
      const fresh = slot === undefined;
      slot = owned;
      return new Promise<IncomingProcessingResult>((resolve, reject) => {
        const job: Job = {
          id: ++jobId, slot: owned, input: projected, signal, resolve, reject,
          abort: () => {
            if (active !== job) return;
            finish(job, undefined, canceled());
            void retire(owned);
          },
        };
        active = job;
        signal.addEventListener("abort", job.abort, { once: true });
        if (signal.aborted) { job.abort(); return; }
        if (!fresh) { post(job); return; }
        try {
          const started = factory({ message: (value) => reply(owned, value), fault: () => fault(owned) });
          if (started instanceof Promise) void started.then((host) => attach(owned, host), () => unavailable(owned));
          else attach(owned, started);
        } catch { unavailable(owned); }
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      if (active) finish(active, undefined, new IncomingProcessingError("worker-closed"));
      closing = slot ? retire(slot) : Promise.resolve();
      return closing;
    },
  };
}
