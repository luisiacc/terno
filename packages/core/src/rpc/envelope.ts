export const RPC_VERSION = 1 as const;

export interface RpcRequest {
  v: typeof RPC_VERSION;
  t: "req";
  id: number;
  m: string;
  p: unknown;
}

export interface RpcErrorPayload {
  code: "BAD_REQUEST" | "NOT_FOUND" | "UNAVAILABLE" | "TIMEOUT" | "INTERNAL" | "UNKNOWN_METHOD" | "FORBIDDEN" | "CANCELLED" | "STALE";
  message: string;
  details?: unknown;
  /** a user error (classified where it was thrown): shown, never reported; false is a bug the backend already captured */
  expected?: boolean;
  /** the diagnostic code the backend logged it under */
  diag?: string;
}

export type RpcResponse =
  | { v: typeof RPC_VERSION; t: "res"; id: number; ok: true; r: unknown }
  | { v: typeof RPC_VERSION; t: "res"; id: number; ok: false; e: RpcErrorPayload };

export interface RpcEvent {
  v: typeof RPC_VERSION;
  t: "evt";
  e: string;
  p: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

/** Minimal duplex message channel. MessagePort, WebSocket and unix sockets all adapt to this. */
export interface Transport {
  send(message: RpcMessage): void;
  onMessage(listener: (message: RpcMessage) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export class RpcError extends Error {
  /** thrown on purpose by a handler (not found, invalid input…) unless said otherwise */
  readonly expected: boolean;
  readonly diag?: string;
  constructor(
    readonly code: RpcErrorPayload["code"],
    message: string,
    readonly details?: unknown,
    o: { expected?: boolean; diag?: string; cause?: unknown } = {},
  ) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "RpcError";
    this.expected = o.expected ?? true;
    if (o.diag) this.diag = o.diag;
  }
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { v?: unknown; t?: unknown };
  return m.v === RPC_VERSION && (m.t === "req" || m.t === "res" || m.t === "evt");
}
