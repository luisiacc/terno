/**
 * The MCP sidecar's diagnostics: JSON lines on stderr (its host, Claude or
 * Codex, keeps them), and, when the app's profile exists, logs/mcp.jsonl and
 * crash records beside the app's own, where main finds them on its next
 * start (main is the only process that reports).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile, rename, rm, stat } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { captureError, installDiag, RotatingLog, type DiagEntry, type ErrorRecord } from "@terno/core/diag";

const MODE = 0o600;

function profileDir(): string {
  return process.env.TERNO_USER_DATA ?? join(homedir(), "Library", "Application Support", "Terno");
}

export function installMcpDiag(version: string): void {
  const profile = profileDir();
  const here = existsSync(join(profile, "logs"));
  const file = here
    ? new RotatingLog(join(profile, "logs", "mcp.jsonl"), {
        appendFile: (p, d) => appendFile(p, d, { mode: MODE }),
        appendFileSync: (p, d) => appendFileSync(p, d, { mode: MODE }),
        size: async (p) => (await stat(p).catch(() => null))?.size ?? 0,
        sizeSync: (p) => statSync(p, { throwIfNoEntry: false })?.size ?? 0,
        rename: (a, b) => rename(a, b),
        renameSync: (a, b) => renameSync(a, b),
        remove: (p) => rm(p, { force: true }),
        removeSync: (p) => rmSync(p, { force: true }),
      })
    : null;
  const record = (r: ErrorRecord) => {
    if (!here || !existsSync(join(profile, "crashes"))) return;
    try {
      const path = join(profile, "crashes", `${r.ts}-mcp-${r.id}.json`);
      const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmp, JSON.stringify(r).slice(0, 64 * 1024), { mode: MODE });
      renameSync(tmp, path);
    } catch {
      // a record that can't be written is still on stderr
    }
  };
  installDiag({
    proc: "mcp",
    version,
    build: `${version}+${process.env.TERNO_BUILD_SHA ?? "dev"}`,
    channel: process.env.TERNO_BUILD_SHA ? "production" : "dev",
    context: () => ({ os: process.platform === "darwin" ? "darwin" : "other", arch: process.arch === "arm64" ? "arm64" : "other", runtime: `node-${process.versions.node}`, memMb: Math.round(totalmem() / 1048576) }),
    sink: {
      // stdout carries only MCP frames
      write: (e: DiagEntry) => {
        const line = JSON.stringify(e);
        if (e.level !== "info") process.stderr.write(`${line}\n`);
        file?.write(line);
      },
      capture: record,
      flush: () => file?.flushSync(),
    },
  });
  process.on("uncaughtException", (error) => {
    captureError(error, { code: "process.uncaught", fields: { source: "mcp" }, fatal: true, expected: false });
    process.exit(70);
  });
  process.on("unhandledRejection", (reason) => {
    captureError(reason, { code: "process.unhandled_rejection", fields: { source: "mcp" }, fatal: true, expected: false });
    process.exit(70);
  });
}
