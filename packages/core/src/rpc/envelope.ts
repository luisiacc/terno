export const RPC_VERSION = 1 as const;

export interface RpcRequest {
  v: typeof RPC_VERSION;
  t: "req";
  id: number;
  m: string;
  p: unknown;
}

export interface RpcErrorPayload {
  code: "BAD_REQUEST" | "NOT_FOUND" | "UNAVAILABLE" | "TIMEOUT" | "INTERNAL" | "UNKNOWN_METHOD" | "FORBIDDEN";
  message: string;
  details?: unknown;
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
  constructor(
    readonly code: RpcErrorPayload["code"],
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { v?: unknown; t?: unknown };
  return m.v === RPC_VERSION && (m.t === "req" || m.t === "res" || m.t === "evt");
}
