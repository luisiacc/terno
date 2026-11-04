import { L } from "@terno/i18n";
import { contract, type EventName, type Events, type MethodName, type ParamsOf, type ResultOf } from "./contract";
import { i18nOf, RPC_VERSION, RpcError, type I18nRef, type RpcMessage, type Transport } from "./envelope";

/** A body's parts travel a few at a time: each answer is its own task, so the page stays responsive, and the backend serves them in turn. */
const BODY_PART_READERS = 4;

/** Balanced, so a long body is never copied whole in one task (a rope, flattened when something reads it). */
function balancedConcat(parts: readonly string[]): string {
  const levels: (string | undefined)[] = [];
  for (let part of parts) {
    let level = 0;
    while (levels[level] !== undefined) { part = levels[level]! + part; levels[level] = undefined; level++; }
    levels[level] = part;
  }
  let text = "";
  for (let level = levels.length - 1; level >= 0; level--) if (levels[level] !== undefined) text += levels[level];
  return text;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcClientOptions {
  defaultTimeoutMs?: number;
  /** every call's outcome (diagnostics: a breadcrumb per failed or slow call) */
  observe?: (method: string, ms: number, error?: unknown) => void;
  /** renders an error's catalog message in this side's language (the renderer: @terno/i18n translate) */
  translate?: (message: I18nRef & { message: string }) => string;
}

export class RpcClient {
  private nextId = 1;
  connectionVersion = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private transport: Transport | null = null;
  private detach: (() => void)[] = [];
  private readonly defaultTimeoutMs: number;
  private readonly observe?: RpcClientOptions["observe"];
  private readonly translate?: RpcClientOptions["translate"];
  private readonly closeListeners = new Set<() => void>();
  private readonly attachListeners = new Set<() => void>();

  constructor(transport?: Transport, options: RpcClientOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.observe = options.observe;
    this.translate = options.translate;
    if (transport) this.attach(transport);
  }

  /** (Re)attach to a transport, e.g. after the backend restarted. In-flight calls fail fast. */
  attach(transport: Transport): void {
    this.detachTransport(this.failure("UNAVAILABLE", "errors.rpc.restarted"));
    this.connectionVersion++;
    this.transport = transport;
    this.detach = [
      transport.onMessage((msg) => this.receive(msg)),
      transport.onClose(() => {
        this.connectionVersion++;
        this.detachTransport(this.failure("UNAVAILABLE", "errors.rpc.closed"));
        for (const l of this.closeListeners) l();
      }),
    ];
    for (const listener of this.attachListeners) listener();
  }

  onAttach(listener: () => void): () => void {
    this.attachListeners.add(listener);
    return () => this.attachListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** A failure this side makes up (no answer to translate): a catalog message, in this side's language when it has one. */
  private failure(code: "UNAVAILABLE" | "TIMEOUT", key: "errors.rpc.restarted" | "errors.rpc.closed" | "errors.rpc.notConnected" | "errors.rpc.timeout", details?: unknown): RpcError {
    const d = L(key);
    return new RpcError(code, this.translate ? this.translate(d) : d.message, details, { i18n: { key: d.key } });
  }

  private detachTransport(reason: Error): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.transport = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (method !== "threads.get") return this.callRaw(method, params);
    const version = this.connectionVersion, timeoutMs = contract[method].timeoutMs ?? this.defaultTimeoutMs;
    const deadline = performance.now() + timeoutMs;
    let expired = false;
    const requests = new Set<number>();
    const check = () => {
      if (expired || performance.now() >= deadline) throw this.failure("TIMEOUT", "errors.rpc.timeout", { method, timeoutMs });
      if (this.connectionVersion !== version || !this.transport) throw this.failure("UNAVAILABLE", "errors.rpc.restarted");
    };
    // this read's requests only: whatever else is in flight on the connection goes on
    const abandon = (error: Error) => {
      for (const id of requests) { const request = this.pending.get(id); if (request) { this.pending.delete(id); clearTimeout(request.timer); request.reject(error); } }
      requests.clear();
    };
    const closed = () => { this.close(); return this.failure("UNAVAILABLE", "errors.rpc.closed"); };
    const task = this.callRaw(method, { ...params, bodyFormat: "parts" }, undefined, false, requests).then(async (result) => {
      const thread = result as ResultOf<"threads.get">;
      const fields: { message: ResultOf<"threads.get">["messages"][number]; field: "text" | "html"; parts: string[] }[] = [];
      // Shared by the readers, and a count is checked only when it's reached: a read that fails ends this for all of them.
      const reads = (function* () {
        for (const message of thread.messages) {
          const reference = message.bodyReference;
          if (!reference) continue;
          for (const field of ["text", "html"] as const) {
            const count = field === "text" ? reference.textParts : reference.htmlParts;
            if (count === null) continue;
            if (!Number.isSafeInteger(count) || count < 0) throw closed();
            const parts: string[] = [];
            fields.push({ message, field, parts });
            for (let ordinal = 0; ordinal < count; ordinal++) yield { message, version: reference.version, field, ordinal, parts };
          }
        }
      })();
      const reader = async () => {
        for (const { message, version: capture, field, ordinal, parts } of reads) {
          check();
          const part = await this.callRaw("threads.bodyPart", { accountId: message.accountId, messageId: message.id, version: capture, field, ordinal }, deadline - performance.now(), false, requests);
          if (typeof part !== "string" || part.length > 32768) throw closed();
          parts[ordinal] = part;
        }
      };
      try { await Promise.all(Array.from({ length: BODY_PART_READERS }, () => reader())); }
      catch (error) { abandon(error as Error); throw error; }
      check();
      for (const { message, field, parts } of fields) {
        if (field === "text") message.bodyText = balancedConcat(parts); else message.bodyHtml = balancedConcat(parts);
      }
      for (const message of thread.messages) delete message.bodyReference;
      return result;
    });
    const complete = new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        const error = this.failure("TIMEOUT", "errors.rpc.timeout", { method, timeoutMs });
        abandon(error); reject(error);
      }, Math.max(0, deadline - performance.now()));
      task.then(resolve, reject).finally(() => clearTimeout(timer));
    });
    const started = deadline - timeoutMs;
    if (this.observe) void complete.then(() => this.observe!(method, performance.now() - started), (error: unknown) => this.observe!(method, performance.now() - started, error));
    return complete;
  }

  private callRaw<M extends MethodName>(method: M, params: ParamsOf<M>, remainingMs?: number, report = true, requests?: Set<number>): Promise<ResultOf<M>> {
    const transport = this.transport;
    if (!transport) return Promise.reject(this.failure("UNAVAILABLE", "errors.rpc.notConnected"));
    const id = this.nextId++;
    requests?.add(id);
    const timeoutMs = remainingMs ?? contract[method].timeoutMs ?? this.defaultTimeoutMs;
    const call = new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.failure("TIMEOUT", "errors.rpc.timeout", { method, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { transport.send({ v: RPC_VERSION, t: "req", id, m: method, p: params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
    const observe = report ? this.observe : undefined;
    const result = requests ? call.finally(() => requests.delete(id)) : call;
    if (!observe) return result;
    const started = performance.now();
    call.then(
      () => observe(method, performance.now() - started),
      (error: unknown) => observe(method, performance.now() - started, error),
    );
    return result;
  }

  on<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (payload: unknown) => void);
    return () => set.delete(listener as (payload: unknown) => void);
  }

  private receive(msg: RpcMessage): void {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r);
      else {
        // a catalog message is shown in this side's language (the renderer passes translate; agents keep the English text)
        const i18n = i18nOf(msg.e);
        const message = i18n && this.translate ? this.translate({ ...i18n, message: msg.e.message }) : msg.e.message;
        p.reject(new RpcError(msg.e.code, message, msg.e.details, { expected: msg.e.expected !== false, diag: msg.e.diag, i18n }));
      }
    } else if (msg.t === "evt") {
      const set = this.listeners.get(msg.e);
      if (set) for (const l of set) l(msg.p);
    }
  }

  /** Calls awaiting a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  close(): void {
    const t = this.transport;
    this.detachTransport(this.failure("UNAVAILABLE", "errors.rpc.closed"));
    t?.close();
  }
}
