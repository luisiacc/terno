import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorRecord } from "@terno/core/diag";
import { afterEach, expect, it } from "vitest";
import { writeMcpRecord } from "./diag";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const record = (over: Partial<ErrorRecord> = {}): ErrorRecord => ({
  id: (++seq).toString(16).padStart(32, "0"),
  ts: Date.now() - 1000 + seq,
  kind: "crash",
  proc: "mcp",
  code: "process.uncaught",
  fatal: true,
  crumbs: Array.from({ length: 3000 }, (_, i) => ({ ts: i, cat: "rpc" as const, code: "rpc.call" as const, level: "info" as const, fields: { method: "threads.list", durationMs: i } })),
  context: { version: "0.1.0", build: "0.1.0+abc", channel: "production", session: "s", os: "darwin" },
  ...over,
});

it("the sidecar's crash records are bounded like main's: 20, 30 days, 64 KB (review finding 4)", () => {
  const profile = mkdtempSync(join(tmpdir(), "terno-mcp-diag-"));
  dirs.push(profile);
  mkdirSync(join(profile, "crashes"));
  // a stale one from a month ago, then a sidecar failing over and over
  writeFileSync(join(profile, "crashes", `${Date.now() - 31 * 86_400_000}-mcp-${"a".repeat(32)}.json`), "{}");
  for (let i = 0; i < 30; i++) writeMcpRecord(profile, record());
  const files = readdirSync(join(profile, "crashes"));
  expect(files).toHaveLength(20);
  expect(files.some((f) => f.includes("a".repeat(32)))).toBe(false);
  for (const f of files) {
    expect(statSync(join(profile, "crashes", f)).size).toBeLessThanOrEqual(64 * 1024);
    expect(statSync(join(profile, "crashes", f)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(profile, "crashes", f), "utf8")).proc).toBe("mcp");
  }
});
