import { z } from "zod";
import { isExpected } from "../diag/error";
import { contract, type EventName, type Events, type MethodName, type ParsedParamsOf, type ResultOf } from "./contract";
import { i18nOf, RPC_VERSION, RpcError, type RpcErrorPayload, type RpcRequest, type Transport } from "./envelope";

export interface CallContext {
  /** identifies the connection (renderer, mcp, ws) for per-client coalescing and permissions */
  clientId: string;
  origin: "renderer" | "mcp" | "dev";
}

export type Handlers = {
  [M in MethodName]: (params: ParsedParamsOf<M>, ctx: CallContext) => ResultOf<M> | Promise<ResultOf<M>>;
};

export interface RpcServerOptions {
  /** an unexpected failure (a bug, not a user error): the host captures it once, here */
  onError?: (error: unknown, method: string, payload: RpcErrorPayload) => void;
  /** Return false to reject a method for a given connection (e.g. MCP permissions). */
  authorize?: (method: MethodName, ctx: CallContext) => boolean | Promise<boolean>;
}

/**
 * The error as it crosses the wire, classified: a handler's RpcError keeps
 * its own verdict; params that fail the contract are the caller's bug; any
 * other throw is expected only if its class says so (ProviderAuthError,
 * SettingsError, AiError…).
 */
export function toErrorPayload(error: unknown): RpcErrorPayload {
  const i18n = i18nOf(error);
  if (error instanceof RpcError) return { code: error.code, message: error.message, details: error.details, expected: error.expected, ...(error.diag ? { diag: error.diag } : {}), ...(i18n ? { i18n } : {}) };
  if (error instanceof z.ZodError) {
    return { code: "BAD_REQUEST", message: z.prettifyError(error), details: error.issues, expected: false, diag: "rpc.handler_threw" };
  }
  const expected = isExpected(error);
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error), expected, ...(expected ? {} : { diag: "rpc.handler_threw" }), ...(i18n ? { i18n } : {}) };
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
    // i18n-ignore: protocol errors for developers and agents (a method the UI doesn't call, or an origin without access)
    if (!def) throw new RpcError("UNKNOWN_METHOD", `Unknown method ${String(method)}`);
    if (this.options.authorize && !(await this.options.authorize(method, ctx))) {
      // i18n-ignore: as above, a protocol error for developers and agents
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
      if (!payload.expected) this.options.onError?.(error, req.m, payload);
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
