import { isLocalized, type Localized } from "@terno/i18n";

export const RPC_VERSION = 1 as const;

/** A user-facing message the renderer translates (@terno/i18n L()); message stays the English text. */
export interface I18nRef {
  key: string;
  params?: Readonly<Record<string, string | number>>;
}

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
  /** what the message says, as a catalog key: the renderer shows it in the user's language */
  i18n?: I18nRef;
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

/** The catalog reference an error carries (set from an L() message), checked: it comes from another process. */
export function i18nOf(error: unknown): I18nRef | undefined {
  const ref = (error as { i18n?: unknown } | null)?.i18n;
  if (!isLocalized(ref)) return undefined;
  return ref.params ? { key: ref.key, params: ref.params } : { key: ref.key };
}

export class RpcError extends Error {
  /** thrown on purpose by a handler (not found, invalid input…) unless said otherwise */
  readonly expected: boolean;
  readonly diag?: string;
  /** set when the message is a catalog message (L()): the renderer translates it */
  readonly i18n?: I18nRef;
  constructor(
    readonly code: RpcErrorPayload["code"],
    message: string | Localized,
    readonly details?: unknown,
    o: { expected?: boolean; diag?: string; cause?: unknown; i18n?: I18nRef } = {},
  ) {
    super(typeof message === "string" ? message : message.message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "RpcError";
    this.expected = o.expected ?? true;
    if (o.diag) this.diag = o.diag;
    const i18n = typeof message === "string" ? o.i18n : i18nOf({ i18n: message });
    if (i18n) this.i18n = i18n;
  }
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { v?: unknown; t?: unknown };
  return m.v === RPC_VERSION && (m.t === "req" || m.t === "res" || m.t === "evt");
}
