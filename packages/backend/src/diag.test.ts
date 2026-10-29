/**
 * The backend's failures as diagnostics: a user error (a sign-in to redo,
 * offline) is a warning with its code and never a record; a bug is one
 * record with its code, captured once, and the renderer learns which it was.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, installDiag, type DiagEntry, type ErrorRecord } from "@terno/core/diag";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { ProviderAuthError, ProviderError, type MailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";

const cleanups: (() => Promise<void> | void)[] = [];
let entries: DiagEntry[] = [];
let records: ErrorRecord[] = [];
beforeEach(() => {
  entries = [];
  records = [];
  installDiag({ proc: "backend", version: "t", build: "t", channel: "test", sink: { write: (e) => entries.push(e), capture: (r) => records.push(r) } });
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(syncError: () => Error | null) {
  const dir = mkdtempSync(join(tmpdir(), "terno-diag-"));
  const registry: ProviderRegistry = {
    create: () =>
      ({
        async verify() {},
        async sync() {
          const e = syncError();
          if (e) throw e;
        },
        async execute() {
          throw new TypeError("Cannot read properties of undefined (reading 'uid')");
        },
        async close() {},
      }) as unknown as MailProvider,
    async verifyImap() {},
    async connectGmail() {
      throw new Error("not in tests");
    },
  } as unknown as ProviderRegistry;
  const backend = new Backend({ dbPath: join(dir, "terno.db"), version: "t", cipher: plaintextCipher, providers: registry, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "renderer", origin: "renderer" });
  cleanups.push(async () => {
    await backend.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const accountId = createAccount(sqlDb(backend.store), { kind: "imap", email: "luis@empresa.mx", displayName: "Luis", color: "indigo", providerConfig: {} }).id;
  return { backend, client: new RpcClient(c), accountId };
}

describe("backend diagnostics", () => {
  it("a sign-in to redo or being offline is a warning, never a record", async () => {
    let next: Error | null = new ProviderAuthError("Invalid credentials for luis@empresa.mx");
    const { backend, accountId } = setup(() => next);
    await backend.syncAccount(accountId);
    next = new ProviderError("ETIMEDOUT imap.empresa.mx", true);
    await backend.syncAccount(accountId);
    expect(records).toEqual([]);
    const warnings = entries.filter((e) => e.code === "sync.failed");
    expect(warnings.map((e) => [e.level, e.fields])).toEqual([
      ["warn", { accountKind: "imap", errorClass: "ProviderAuthError", retryable: false }],
      ["warn", { accountKind: "imap", errorClass: "ProviderError", retryable: true }],
    ]);
    // the address in the message is scrubbed; no frame comes from the message line
    expect(JSON.stringify(entries)).not.toContain("luis@");
    expect(entries[0]!.err!.frames.every((f) => f.file !== "empresa.mx")).toBe(true);
  });

  it.each([true, false])("provider HTTP evidence and multiline messages stay out of diagnostics (retryable=%s)", async (retryable) => {
    const markers = ["S51BackendSecret", "s51-backend@example.invalid", "S51BackendSubject", "S51BackendBody", "S51BackendRetryHeader", "S51BackendCause"];
    const url = `https://provider.invalid/messages?access_token=${markers[0]}`;
    const error = Object.assign(new ProviderError(`${markers[3]} ${url}\n    at ${markers[2]} (${markers[1]}:1:2)`, retryable, false, false, {
      source: "http-response",
      request: { endpoint: "gmail-api", purpose: "mail" },
      status: 429,
      quotaScope: "unknown",
      received: { source: "date-now", kind: "wall", wallMs: Date.now() },
      retryAfter: { kind: "value", value: markers[4]! },
      serverDate: { kind: "value", value: markers[1]! },
    }), { status: 429, cause: new Error(markers[5]) });
    expect(error.httpResponse!.retryAfter).toEqual({ kind: "value", value: markers[4] });
    expect(Object.keys(error)).not.toContain("httpResponse");
    const { backend, accountId } = setup(() => error);
    await backend.syncAccount(accountId);
    const failures = entries.filter((e) => e.code === "sync.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ level: retryable ? "warn" : "error", fields: { errorClass: "ProviderError", retryable }, err: { name: "ProviderError", status: 429 } });
    expect(records).toHaveLength(retryable ? 0 : 1);
    const output = JSON.stringify({ entries, records, reports: records.map((r) => buildReport(r, { installId: "synthetic-install" })) });
    for (const marker of markers) expect(output).not.toContain(marker);
    // Recovery still has the provider's local message; diagnostic filtering must not mutate it.
    expect(error.message).toContain(markers[3]);
  });

  it("a bug in sync is one record with its code; the successful sync left a crumb", async () => {
    let next: Error | null = null;
    const { backend, accountId } = setup(() => next);
    await backend.syncAccount(accountId);
    next = new TypeError("undefined is not iterable");
    await backend.syncAccount(accountId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ code: "sync.failed", kind: "error", proc: "backend", fields: { accountKind: "imap", errorClass: "TypeError", retryable: false } });
    expect(records[0]!.crumbs.map((c) => c.code)).toContain("sync.done");
  });

  it("an RPC handler that throws is captured once, under its method; the renderer learns it was a bug", async () => {
    const { backend, client } = setup(() => null);
    (backend.store.threads as { get: unknown }).get = () => {
      throw new RangeError("boom");
    };
    await expect(client.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ code: "INTERNAL", expected: false });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ code: "rpc.handler_threw", fields: { method: "threads.get", rpcCode: "INTERNAL", errorClass: "RangeError" } });
  });
});
