/**
 * Plan 293 (CASA 4.1.4, 6.7.1): the one way backend code seals, opens, writes and deletes a stored secret (an
 * account's password or refresh token, an AI key, the legacy client secret), and the record of every access.
 *
 * - Any failure of the cipher, whatever its cause (no keychain, a refused item, a blob that doesn't decrypt: wrong key,
 *   bad padding or MAC, truncated), becomes one error, `SecretStorageError`: a fixed category code and message, no
 *   exception text, no cause, no stack kept anywhere.
 * - Every access is a `secret.access` line in this process's local diagnostics log: the operation, the kind of secret
 *   (never its value), the part of Terno that asked, the account's internal id, the outcome. The code is local: never a
 *   breadcrumb, so never in an error record or a report. Writes and deletes are recorded once they commit.
 * - Successful reads of one secret by one component within a minute are folded into one line with a count, so a busy
 *   minute (an AI pass opening its key for every message) writes two lines, not thousands.
 * - Three failed opens of one secret within ten minutes also write `secret.failures_repeated`.
 */
import { L } from "@terno/i18n";
import { RpcError } from "@terno/core/rpc";
import { log, type FieldValueOf } from "@terno/core/diag";
import type { MailStore } from "@terno/store";
import type { SecretCipher } from "./core";

export const SECRET_STORAGE_FAILED = "secret_storage_failed";

/**
 * Why a secret couldn't be used, kept off the wire (it only decides plan 264's local recheck): the keychain refused
 * it, or it is still sealed under Única's and not migrated.
 */
export type SecretFailure = "keychain" | "legacy";

/**
 * The one error every cryptographic or secret-storage failure becomes, whatever its cause (no keychain, a refused
 * item, bad padding or MAC, a wrong key, a legacy blob) and whatever the secret: one code, one category, one message
 * (errors.secret.unavailable). The renderer gets this payload as is; what to do is where the UI shows it.
 */
export class SecretStorageError extends RpcError {
  readonly category = SECRET_STORAGE_FAILED;
  readonly secretFailure: SecretFailure;
  constructor(secretFailure: SecretFailure = "keychain") {
    super("UNAVAILABLE", L("errors.secret.unavailable"), { category: SECRET_STORAGE_FAILED }, { expected: true });
    this.name = "SecretStorageError";
    this.secretFailure = secretFailure;
  }
}

export type SecretComponent = FieldValueOf<"component">;
type Outcome = FieldValueOf<"secretOutcome">;
type Op = FieldValueOf<"secretOp">;

/** A secret's kind and account, from its name (`account:<id>:<key>`, `ai:…:apiKey`, `gmailClientSecret`). */
export function describeSecret(name: string): { secretKind: FieldValueOf<"secretKind">; accountId?: number } {
  const account = /^account:(\d+):(\w+)$/.exec(name);
  const key = account?.[2] ?? /^account:[^:]*:(\w+)$/.exec(name)?.[1];
  const secretKind = key === "refreshToken" ? "refreshToken" : key === "password" ? "password" : name === "gmailClientSecret" ? "clientSecret" : name.startsWith("ai:") ? "apiKey" : "other";
  return account ? { secretKind, accountId: Number(account[1]) } : { secretKind };
}

const FOLD_MS = 60_000;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURES_NOTED = 3;
/** bounds on what's kept in memory between lines */
const MAX_KEYS = 256;

export class SecretAccess {
  /** reads folded per secret and component: how many since the line that opened the fold */
  private readonly folds = new Map<string, { name: string; component: SecretComponent; count: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly cipher: SecretCipher,
    private readonly store: Pick<MailStore, "secrets">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seals `plain` for the secret `name` (its write is recorded when it commits). */
  async seal(name: string, plain: string, component: SecretComponent): Promise<Uint8Array> {
    try {
      return await this.cipher.encrypt(plain);
    } catch {
      this.record("write", name, component, "failed");
      throw new SecretStorageError();
    }
  }

  /** Opens the blob stored as `name`; the read is recorded. */
  async open(name: string, blob: Uint8Array, component: SecretComponent): Promise<string> {
    let plain: string;
    try {
      plain = await this.cipher.decrypt(blob);
    } catch {
      this.record("read", name, component, "failed");
      throw new SecretStorageError();
    }
    this.record("read", name, component, "ok");
    return plain;
  }

  /** A read that couldn't open what's stored (the legacy keychain's helper gave nothing back for it). */
  unreadable(name: string, component: SecretComponent): void {
    this.record("read", name, component, "failed");
  }

  /** A read that found nothing stored. */
  missing(name: string, component: SecretComponent): void {
    this.record("read", name, component, "missing");
  }

  /** Seals and stores `plain` as `name`. */
  async put(name: string, plain: string, component: SecretComponent): Promise<void> {
    const blob = await this.seal(name, plain, component);
    await this.committing("write", name, component, () => this.store.secrets.put(name, blob));
  }

  /** Stores an already sealed blob as `name` (a blob sealed for it moments ago). */
  async putSealed(name: string, blob: Uint8Array, component: SecretComponent): Promise<void> {
    await this.committing("write", name, component, () => this.store.secrets.put(name, blob));
  }

  /** Replaces `expected` with `next` (exact bytes, never an upsert); a mismatch is recorded as refused. */
  async replace(name: string, expected: Uint8Array, next: Uint8Array, component: SecretComponent, stamp?: Parameters<MailStore["secrets"]["replace"]>[3]): Promise<boolean> {
    return this.committing("write", name, component, () => this.store.secrets.replace(name, expected, next, stamp), (ok) => (ok ? "ok" : "refused"));
  }

  async delete(name: string, component: SecretComponent): Promise<void> {
    await this.committing("delete", name, component, () => this.store.secrets.delete(name));
  }

  /** Plan 293 (2.2.1): deletes `name` only while it still holds exactly `expected`; a mismatch is recorded as refused. */
  async remove(name: string, expected: Uint8Array, component: SecretComponent): Promise<boolean> {
    return this.committing("delete", name, component, () => this.store.secrets.remove(name, expected), (ok) => (ok ? "ok" : "refused"));
  }

  /** A write or delete another store call made (an account created with its secret, an account removed with its). */
  committed(op: "write" | "delete", name: string, component: SecretComponent, outcome: Outcome = "ok"): void {
    this.record(op, name, component, outcome);
  }

  private async committing<T>(op: "write" | "delete", name: string, component: SecretComponent, run: () => Promise<T>, outcome: (result: T) => Outcome = () => "ok"): Promise<T> {
    let result: T;
    try {
      result = await run();
    } catch (error) {
      this.record(op, name, component, "failed");
      throw error;
    }
    this.record(op, name, component, outcome(result));
    return result;
  }

  /** Writes what's folded now (a stop). */
  flush(): void {
    for (const key of this.folds.keys()) this.closeFold(key);
  }

  private record(secretOp: Op, name: string, component: SecretComponent, secretOutcome: Outcome): void {
    const described = describeSecret(name);
    if (secretOp === "read" && secretOutcome === "ok") {
      const key = `${name}\u0000${component}`;
      const fold = this.folds.get(key);
      if (fold) {
        fold.count++;
        return;
      }
      if (this.folds.size >= MAX_KEYS) this.closeFold(this.folds.keys().next().value!);
      const timer = setTimeout(() => this.closeFold(key), FOLD_MS);
      (timer as { unref?: () => void }).unref?.();
      this.folds.set(key, { name, component, count: 0, timer });
    }
    const fields = { secretOp, ...described, component, secretOutcome, ...(secretOutcome === "failed" ? { errorCategory: SECRET_STORAGE_FAILED } as const : {}) };
    if (secretOutcome === "failed") {
      log.warn("secret.access", fields);
      this.noteFailure(name, component);
    } else log.info("secret.access", fields);
  }

  private closeFold(key: string): void {
    const fold = this.folds.get(key);
    if (!fold) return;
    clearTimeout(fold.timer);
    this.folds.delete(key);
    if (fold.count) log.info("secret.access", { secretOp: "read", ...describeSecret(fold.name), component: fold.component, secretOutcome: "ok", count: fold.count });
  }

  private noteFailure(name: string, component: SecretComponent): void {
    const at = this.now();
    const recent = (this.failures.get(name) ?? []).filter((t) => at - t < FAILURE_WINDOW_MS);
    recent.push(at);
    this.failures.delete(name);
    if (this.failures.size >= MAX_KEYS) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(name, recent);
    if (recent.length === FAILURES_NOTED) log.warn("secret.failures_repeated", { ...describeSecret(name), component, count: recent.length });
  }
}
