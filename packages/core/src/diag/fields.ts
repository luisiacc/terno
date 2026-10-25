/**
 * The only values a diagnostic may carry. Every field name has one type
 * (enums, bounded ints, booleans, short ids); a value that doesn't fit is
 * replaced with "<redacted>" (strings) or dropped, so a subject, an address
 * or a file name can never ride along by accident.
 */
import { VIEWS } from "../types";

export type FieldType =
  | { t: "enum"; values: readonly string[] }
  | { t: "int"; min: number; max: number }
  | { t: "bool" }
  /** a short machine id: error classes, errno names, socket codes (camelCase allowed: class and method names are) */
  | { t: "id" };

export type FieldValue = string | number | boolean;
export type Fields = Record<string, FieldValue>;

export const REDACTED = "<redacted>";
const ID = /^[A-Za-z0-9_.-]{1,40}$/;

const enumOf = <const V extends readonly string[]>(...values: V) => ({ t: "enum", values }) as const;
const int = (min: number, max: number) => ({ t: "int", min, max }) as const;
const bool = { t: "bool" } as const;
const id = { t: "id" } as const;

const RPC_CODES = ["BAD_REQUEST", "NOT_FOUND", "UNAVAILABLE", "TIMEOUT", "INTERNAL", "UNKNOWN_METHOD", "FORBIDDEN", "CANCELLED", "STALE"] as const;
const THREAD_ACTIONS = ["archive", "trash", "spam", "notSpam", "moveToInbox", "markRead", "markUnread", "star", "unstar"] as const;

/** Every field any code may use, with its type. */
export const FIELD_TYPES = {
  accountKind: enumOf("imap", "gmail", "demo", "other"),
  aiKind: enumOf("invalid_output", "refused", "auth", "rate_limited", "unavailable", "timeout", "blocked", "not_configured", "unsupported", "cancelled", "other"),
  action: enumOf(...THREAD_ACTIONS, "print", "pdf", "other"),
  ambiguous: bool,
  area: enumOf("app", "reader", "settings", "compose", "list", "other"),
  attempt: int(0, 1000),
  childType: enumOf("Utility", "Zygote", "Sandbox helper", "GPU", "Pepper Plugin", "Pepper Plugin Broker", "Unknown"),
  count: int(0, 10_000_000),
  delayMs: int(0, 3_600_000),
  deliberate: bool,
  dialog: enumOf("settings", "shortcuts", "palette", "categoryPicker", "filters", "addAccount", "print", "other"),
  durationMs: int(0, 86_400_000),
  engine: enumOf("node-sqlite", "wasm-opfs", "wasm-memory", "idb", "other"),
  errno: id,
  errorClass: id,
  exitCode: int(-2_147_483_648, 4_294_967_295),
  expected: bool,
  fatalCode: enumOf("SCHEMA_NEWER", "OPEN_FAILED", "UNAVAILABLE", "BUILD_MISMATCH", "CRASHED", "other"),
  kind: enumOf("error", "crash", "unclean_exit", "renderer_gone", "backend_exit", "child_gone", "other"),
  // an RPC method name (threads.list): an id, so main's bundle doesn't need the contract (and zod) to check it
  method: id,
  ok: bool,
  op: enumOf("encrypt", "decrypt", "legacy", "sync", "send", "move", "import", "export", "persist", "rebuild", "restore", "generate", "test", "classify", "other"),
  opKind: enumOf(...THREAD_ACTIONS, "send", "move", "other"),
  packaged: bool,
  reason: enumOf("clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction", "policy", "rate", "size", "schema", "error", "other"),
  retryable: bool,
  rpcCode: enumOf(...RPC_CODES),
  source: enumOf("backend", "store", "search", "categorizer", "keychain", "main", "renderer", "worker", "mcp", "other"),
  status: int(0, 999),
  tab: enumOf("general", "appearance", "accounts", "categories", "filters", "ai", "agents", "data", "other"),
  threadId: int(0, Number.MAX_SAFE_INTEGER),
  tool: id,
  view: enumOf(...VIEWS, "search", "category", "other"),
} as const satisfies Record<string, FieldType>;

export type FieldName = keyof typeof FIELD_TYPES;

type ValueOf<T extends FieldType> = T extends { t: "enum"; values: readonly (infer V)[] } ? V : T extends { t: "int" } ? number : T extends { t: "bool" } ? boolean : string;
export type FieldValueOf<K extends FieldName> = ValueOf<(typeof FIELD_TYPES)[K]>;

/** The value as it may be kept, or undefined when it can't be kept at all (wrong primitive type). */
export function sanitizeField(name: string, value: unknown): FieldValue | undefined {
  const type = (FIELD_TYPES as Record<string, FieldType>)[name];
  if (!type) return undefined;
  switch (type.t) {
    case "enum":
      return typeof value === "string" ? (type.values.includes(value) ? value : type.values.includes("other") ? "other" : REDACTED) : undefined;
    case "int":
      return typeof value === "number" && Number.isFinite(value) ? Math.min(type.max, Math.max(type.min, Math.round(value))) : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "id":
      return typeof value === "string" ? (ID.test(value) ? value : REDACTED) : typeof value === "number" && Number.isInteger(value) ? String(value) : undefined;
  }
}
