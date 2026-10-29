import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { createAccount, sqlDb } from "@terno/db";
import { ProviderError, type MailProvider, type ProviderRegistry } from "@terno/mail";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startDevServer, type DevServer } from "./server";

const markers = ["S51ConsoleSecret", "s51-console@example.invalid", "S51ConsoleSubject", "S51ConsoleBody", "S51ConsoleCause"];
const url = `https://provider.invalid/messages?access_token=${markers[0]}`;
const message = `${markers.join(" ")} ${url}\n    at ${markers[2]} (${markers[1]}:1:2)`;
const providerError = () => Object.assign(new ProviderError(message, true), {
  status: 429,
  code: "ETIMEDOUT",
  cause: new Error(markers[4]),
  response: { body: markers[3], url, headers: { authorization: markers[0] } },
});

let host: DevServer | undefined;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "terno-dev-log-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  try {
    await host?.close();
    rmSync(dir, { recursive: true, force: true });
  } finally {
    host = undefined;
    vi.restoreAllMocks();
  }
});

async function start(providers?: ProviderRegistry) {
  // Port 0 allocates an unused loopback port without touching another server.
  providers ??= { create() { throw new Error("unexpected fixture provider"); } } as unknown as ProviderRegistry;
  host = await startDevServer({ port: 0, dataDir: dir, token: "synthetic-dev-token", seed: false, autoSync: false, iconTransport: null, providers });
  return host;
}

function expectPrivate() {
  const output = inspect([vi.mocked(console.log).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls], { depth: null });
  for (const marker of [...markers, url]) expect(output).not.toContain(marker);
}

it.each(["info", "warn", "error"] as const)("the public dev adapter drops free-form %s messages and arbitrary extras", async (level) => {
  const { backend } = await start();
  const extra = { source: "store", count: 12, secret: markers[0], address: markers[1], subject: markers[2], body: markers[3], url, cause: { error: providerError() } };
  backend.log(level, message, extra);
  backend.log(level, "S51ConsoleSubject", message);
  backend.log(level, "constructor", [extra]);
  backend.log(level, "toString", extra);
  backend.log(level, "S51ConsoleSubject.event", extra);
  backend.log(level, `sync.done ${markers[2]}`, extra);
  expectPrivate();
  const calls = vi.mocked(level === "error" ? console.error : console.log).mock.calls;
  expect(calls).toEqual(Array.from({ length: 6 }, () => ["[backend] log.message", { fields: { source: "backend" } }]));
});

it("the dev adapter keeps only a known code's fields and normalizes actual Error extras", async () => {
  const { backend } = await start();
  backend.log("info", "sync.done", { accountKind: "imap", durationMs: 12, status: 429, subject: markers[2], cause: providerError(), url });
  const error = providerError();
  error.stack = `${error.name}: ${error.message}\n    at sync (/synthetic/app/src/provider.ts:20:4)`;
  const original = { message: error.message, stack: error.stack, cause: error.cause };
  backend.log("error", "sync.failed", error);
  backend.log("warn", message, error);
  expectPrivate();
  expect(console.log).toHaveBeenCalledWith("[backend] sync.done", { fields: { accountKind: "imap", durationMs: 12 } });
  const err = { name: "ProviderError", code: "ETIMEDOUT", status: 429, frames: [{ fn: "sync", file: "src/provider.ts", line: 20, col: 4 }] };
  expect(console.error).toHaveBeenCalledWith("[backend] sync.failed", { err });
  expect(console.log).toHaveBeenCalledWith("[backend] log.message", { fields: { source: "backend" }, err });
  expect(error).toMatchObject(original);
});

it("a real RPC failure cannot forward its raw stack to the dev console", async () => {
  const { backend } = await start();
  const [clientTransport, serverTransport] = createMemoryTransportPair();
  const disconnect = backend.connect(serverTransport, { clientId: "synthetic-renderer", origin: "renderer" });
  const client = new RpcClient(clientTransport);
  try {
    vi.spyOn(backend.store.threads, "get").mockRejectedValue(new RangeError(message, { cause: providerError() }));
    await expect(client.call("threads.get", { threadId: 1 })).rejects.toMatchObject({ code: "INTERNAL" });
    expectPrivate();
    expect(console.error).toHaveBeenCalledWith("[backend] log.message", { fields: { source: "backend" } });
  } finally { client.close(); disconnect(); }
});

it("a real provider sync failure cannot forward its message to the dev console", async () => {
  const error = providerError();
  const provider = { async sync() { throw error; }, async close() {} } as unknown as MailProvider;
  const providers = { create: () => provider } as unknown as ProviderRegistry;
  const { backend } = await start(providers);
  const account = createAccount(sqlDb(backend.store), { kind: "imap", email: "fixture@example.invalid", displayName: "Fixture", color: "indigo", providerConfig: {} });
  await backend.syncAccount(account.id);
  expectPrivate();
  expect(console.log).toHaveBeenCalledWith("[backend] log.message", { fields: { source: "backend" } });
  expect(error.message).toBe(message);
});
