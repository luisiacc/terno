import { z } from "zod";
import { contract, type EventName, type Events, type MethodName, type ParsedParamsOf, type ResultOf } from "./contract";
import { RPC_VERSION, RpcError, type RpcErrorPayload, type RpcRequest, type Transport } from "./envelope";

export interface CallContext {
  /** identifies the connection (renderer, mcp, ws) for per-client coalescing and permissions */
  clientId: string;
  origin: "renderer" | "mcp" | "dev";
}

export type Handlers = {
  [M in MethodName]: (params: ParsedParamsOf<M>, ctx: CallContext) => ResultOf<M> | Promise<ResultOf<M>>;
};

export interface RpcServerOptions {
  onError?: (error: unknown, method: string) => void;
  /** Return false to reject a method for a given connection (e.g. MCP permissions). */
  authorize?: (method: MethodName, ctx: CallContext) => boolean;
}

function toErrorPayload(error: unknown): RpcErrorPayload {
  if (error instanceof RpcError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof z.ZodError) {
    return { code: "BAD_REQUEST", message: z.prettifyError(error), details: error.issues };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

export class RpcServer {
  private readonly connections = new Map<Transport, CallContext>();

  constructor(
    private readonly handlers: Handlers,
    private readonly options: RpcServerOptions = {},
  ) {}

  connect(transport: Transport, ctx: CallContext): () => void {
    this.connections.set(transport, ctx);
    const offMessage = transport.onMessage((msg) => {
      if (msg.t === "req") void this.dispatch(transport, ctx, msg);
    });
    const offClose = transport.onClose(() => this.connections.delete(transport));
    return () => {
      offMessage();
      offClose();
      this.connections.delete(transport);
    };
  }

  /** Executes a call directly (used by in-process callers and tests). */
  async invoke<M extends MethodName>(method: M, params: unknown, ctx: CallContext): Promise<ResultOf<M>> {
    const def = contract[method];
    if (!def) throw new RpcError("UNKNOWN_METHOD", `Unknown method ${String(method)}`);
    if (this.options.authorize && !this.options.authorize(method, ctx)) {
      throw new RpcError("FORBIDDEN", `${method} is not allowed for ${ctx.origin}`);
    }
    const parsed = def.params.parse(params ?? {}) as ParsedParamsOf<M>;
    const handler = this.handlers[method] as (p: ParsedParamsOf<M>, c: CallContext) => ResultOf<M> | Promise<ResultOf<M>>;
    return await handler(parsed, ctx);
  }

  private async dispatch(transport: Transport, ctx: CallContext, req: RpcRequest): Promise<void> {
    try {
      const result = await this.invoke(req.m as MethodName, req.p, ctx);
      transport.send({ v: RPC_VERSION, t: "res", id: req.id, ok: true, r: result });
    } catch (error) {
      const payload = toErrorPayload(error);
      if (payload.code === "INTERNAL") this.options.onError?.(error, req.m);
      transport.send({ v: RPC_VERSION, t: "res", id: req.id, ok: false, e: payload });
    }
  }

  /** Pushes an event to every connection, or only to the given origins (e.g. keep identity away from MCP). */
  emit<E extends EventName>(event: E, payload: Events[E], options: { origins?: readonly CallContext["origin"][] } = {}): void {
    for (const [transport, ctx] of this.connections) {
      if (options.origins && !options.origins.includes(ctx.origin)) continue;
      try {
        transport.send({ v: RPC_VERSION, t: "evt", e: event, p: payload });
      } catch {
        this.connections.delete(transport);
      }
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}
