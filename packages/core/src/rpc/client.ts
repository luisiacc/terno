import { L } from "@terno/i18n";
import { contract, type EventName, type Events, type MethodName, type ParamsOf, type ResultOf } from "./contract";
import { i18nOf, RPC_VERSION, RpcError, type I18nRef, type RpcMessage, type Transport } from "./envelope";

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
    const transport = this.transport;
    if (!transport) return Promise.reject(this.failure("UNAVAILABLE", "errors.rpc.notConnected"));
    const id = this.nextId++;
    const timeoutMs = contract[method].timeoutMs ?? this.defaultTimeoutMs;
    const call = new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.failure("TIMEOUT", "errors.rpc.timeout", { method, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      transport.send({ v: RPC_VERSION, t: "req", id, m: method, p: params });
    });
    const observe = this.observe;
    if (!observe) return call;
    const started = performance.now();
    call.then(
      () => observe(method, performance.now() - started),
      (error: unknown) => observe(method, performance.now() - started, error),
    );
    return call;
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
