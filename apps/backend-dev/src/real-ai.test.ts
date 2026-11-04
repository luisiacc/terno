import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiOptions, ProviderConfig } from "@terno/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusalToTypeKeys, writeGuardMarker } from "./proof-guard";
import { realAiFactory } from "./real-ai";

const URL_ = "http://127.0.0.1:5999/?backend=ws://127.0.0.1:5998";
const temp = () => mkdtempSync(join(tmpdir(), "terno-guard-"));
const base: ProviderConfig = { id: "anthropic", model: "claude-sonnet-5-5", apiKey: "stub", fetch: (() => { throw new Error("no network in a test"); }) as never, timeoutMs: 1, maxRetries: 1 };

describe("the real-app factory", () => {
  beforeEach(() => void vi.stubEnv("TERNO_AI_LEDGER", join(temp(), "spend.jsonl")));
  afterEach(() => void vi.unstubAllEnvs());

  it("takes the SDK's retry away, since a filter session keeps one the ledger would never see", () => {
    const create = vi.fn(() => ({}) as never);
    realAiFactory(create)(base, {});
    expect((create.mock.calls[0] as unknown as [ProviderConfig])[0].maxRetries).toBe(0);
  });

  it("holds a request to the shared ledger: reserved before it goes, and the same file the evals use", async () => {
    let wrap!: NonNullable<AiOptions["wrapTransport"]>;
    const create = vi.fn((_c: ProviderConfig, o: AiOptions) => ((wrap = o.wrapTransport!), {}) as never);
    realAiFactory(create as never)(base, {});
    let lines = "";
    const seen = wrap({ complete: async () => ((lines = readFileSync(process.env.TERNO_AI_LEDGER!, "utf8")), { text: "", stop: "end" }) });
    await seen.complete({ system: "s", messages: [], output: "text", maxTokens: 10, signal: new AbortController().signal });
    expect(lines).toContain(`"type":"reserve"`);
  });
});

describe("the proof's guard", () => {
  const env = (dir: string) => ({ TERNO_AI_REAL: "1", TERNO_AI_GUARD_DIR: dir });

  it("needs TERNO_AI_REAL=1", () => {
    expect(refusalToTypeKeys(URL_, { TERNO_AI_GUARD_DIR: temp() })).toMatch(/TERNO_AI_REAL/);
  });

  it("refuses a backend with no marker, or one on another port", () => {
    const dir = temp();
    expect(refusalToTypeKeys(URL_, env(dir))).toMatch(/no guard marker/);
    writeGuardMarker(5997, env(dir));
    expect(refusalToTypeKeys(URL_, env(dir))).toMatch(/no guard marker/);
  });

  it("refuses a page that names no backend, and a marker that lies about its port", () => {
    const dir = temp();
    expect(refusalToTypeKeys("http://127.0.0.1:5999/", env(dir))).toMatch(/backend port/);
    writeFileSync(join(dir, "backend-guard-5998.json"), JSON.stringify({ port: 1, pid: process.pid }));
    expect(refusalToTypeKeys(URL_, env(dir))).toMatch(/live backend/);
  });

  it("refuses a marker whose process has gone", async () => {
    const dir = temp();
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = child.pid!;
    await new Promise((r) => child.once("exit", r));
    writeFileSync(join(dir, "backend-guard-5998.json"), JSON.stringify({ port: 5998, pid }));
    expect(refusalToTypeKeys(URL_, env(dir))).toMatch(/live backend/);
  });

  it("allows a live guarded backend until it takes the claim back", () => {
    const dir = temp();
    const remove = writeGuardMarker(5998, env(dir));
    expect(refusalToTypeKeys(URL_, env(dir))).toBeNull();
    remove();
    expect(refusalToTypeKeys(URL_, env(dir))).toMatch(/no guard marker/);
  });

  const proof = fileURLToPath(new URL("../../../scripts/ai-real/app-proof.mjs", import.meta.url));
  const runProof = (extra: Record<string, string>) => new Promise<string>((resolve) => {
    // a cwd with no .env and no browser: reaching either fails with a different message
    const { TERNO_AI_REAL: _real, ...rest } = process.env;
    execFile(process.execPath, [proof], { cwd: temp(), env: { ...rest, TERNO_AI_GUARD_DIR: temp(), PROOF_URL: URL_, PROOF_OUT: temp(), ...extra } }, (error, _out, stderr) => {
      expect(error).toBeTruthy();
      resolve(stderr);
    });
  });

  it("the script itself stops before it reads .env or opens a browser", async () => {
    await expect(runProof({})).resolves.toMatch(/Refusing to read real keys/);
    await expect(runProof({ TERNO_AI_REAL: "1" })).resolves.toMatch(/no guard marker/);
  });
});
