import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { openDatabase } from "@terno/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  start: vi.fn(async (_options: unknown) => ({ url: "ws://127.0.0.1:12345", close: async () => {} })),
}));
vi.mock("./server", () => ({ startDevServer: server.start }));

const secret = "S51CliSecret";
const address = "s51-cli@example.invalid";
const subject = "S51CliSubject";
const legacyKey = `UNICA_${subject}_${address}`;
const currentKey = `TERNO_${subject}_${address}`;
let dir: string;
let originalEnv: NodeJS.ProcessEnv;
let originalArgv: string[];

beforeEach(() => {
  vi.resetModules();
  server.start.mockClear();
  dir = mkdtempSync(join(tmpdir(), `${secret}-${address}-${subject}-`));
  originalEnv = process.env;
  originalArgv = process.argv;
  process.env = {};
  process.argv = [process.execPath, "synthetic-cli"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  process.argv = originalArgv;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function expectPrivate() {
  const output = inspect([vi.mocked(console.log).mock.calls, vi.mocked(console.warn).mock.calls, vi.mocked(console.error).mock.calls], { depth: null });
  for (const marker of [secret, address, subject, dir]) expect(output).not.toContain(marker);
}

it.each([false, true])("startup status hides tokens, paths and legacy names without changing env flow (current=%s)", async (current) => {
  process.env = {
    TERNO_DEV_PORT: "0", TERNO_DATA_DIR: dir, TERNO_DEV_TOKEN: secret,
    TERNO_FRESH: "1", TERNO_THREADS: "2", TERNO_ACCOUNTS: "1",
    [legacyKey]: secret, ...(current ? { [currentKey]: "synthetic-current" } : {}),
  };
  const on = vi.spyOn(process, "on").mockReturnValue(process);
  await import("./main");
  expect(server.start).toHaveBeenCalledExactlyOnceWith({ port: 0, dataDir: dir, token: secret, fresh: true, threads: 2, accounts: 1 });
  expect(process.env[currentKey]).toBe(current ? "synthetic-current" : secret);
  expect(process.env[legacyKey]).toBeUndefined();
  expectPrivate();
  expect(console.log).toHaveBeenCalledExactlyOnceWith("[backend-dev] listening on localhost");
  expect(console.warn).toHaveBeenCalledExactlyOnceWith("[backend-dev] legacy environment variable detected; use TERNO_* names");
  expect(on.mock.calls.map(([signal]) => signal)).toEqual(["SIGINT", "SIGTERM"]);
});

it.each([false, true])("seed status hides the output path while creating the requested database (print=%s)", async (print) => {
  process.argv.push("--out", dir, "--accounts", "1", "--threads", "2", ...(print ? ["--print-fixtures"] : []));
  await import("./seed");
  expect(existsSync(join(dir, "terno.db"))).toBe(true);
  const db = openDatabase(join(dir, "terno.db"));
  try {
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM accounts")!.n).toBe(1);
    const threads = db.get<{ n: number }>("SELECT count(*) AS n FROM threads")!.n;
    if (print) expect(threads).toBeGreaterThan(2);
    else expect(threads).toBe(2);
  } finally { db.close(); }
  expectPrivate();
  expect(console.log).toHaveBeenCalledExactlyOnceWith("[seed] demo mailbox ready");
});

it("missing seed output keeps a fixed usage status and exits before creating a database", async () => {
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("synthetic usage exit"); });
  await expect(import("./seed")).rejects.toThrow("synthetic usage exit");
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith("usage: seed.ts --out <profile dir> [--accounts 8] [--threads 12000]");
  expect(existsSync(join(dir, "terno.db"))).toBe(false);
  expectPrivate();
});
