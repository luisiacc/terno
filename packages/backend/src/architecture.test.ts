import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Local mode is only a guarantee if no code path can open a connection
 * without asking the network policy. This scans every shipped source file for
 * the ways Node, Electron and the AI SDKs can reach the network.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_DIRS = ["packages", "apps"].flatMap((d) =>
  readdirSync(join(ROOT, d))
    .map((p) => join(ROOT, d, p, "src"))
    .filter((p) => statSync(p, { throwIfNoEntry: false })?.isDirectory()),
);

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "global fetch", re: /(^|[^\w.$])fetch\s*\(/ },
  { name: "globalThis.fetch", re: /globalThis\.fetch/ },
  { name: "Electron net", re: /\bnet\.(fetch|request)\s*\(/ },
  { name: "http(s).request/get", re: /\bhttps?\.(request|get)\s*\(/ },
  { name: "node:http client imports", re: /import\s*\{[^}]*\b(request|get)\b[^}]*\}\s*from\s*["']node:https?["']/ },
  { name: "raw sockets", re: /\b(net|tls)\.connect\s*\(|\bimport\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*["']node:(net|tls)["']/ },
  { name: "OpenAI client", re: /new\s+(OpenAI|AzureOpenAI)\s*\(/ },
  { name: "Anthropic client", re: /new\s+Anthropic\s*\(/ },
  { name: "IMAP client", re: /new\s+ImapFlow\s*\(/ },
  { name: "SMTP client", re: /createTransport\s*\(/ },
  { name: "WebSocket client", re: /new\s+WebSocket\s*\(/ },
  { name: "XHR / EventSource", re: /\b(XMLHttpRequest|EventSource)\b/ },
];

/** file → patterns it may use, and why. Anything else is a violation. */
const ALLOWED: Record<string, { patterns: string[]; why: string }> = {
  "packages/backend/src/net-policy.ts": { patterns: ["globalThis.fetch"], why: "the policy itself performs the vetted request" },
  "packages/backend/src/icons/node-transport.ts": { patterns: ["node:http client imports"], why: "plan 22: one GET per hop for sender icons, each asserted by the policy (purpose icons) in fetcher.ts, to public addresses only" },
  "packages/mail/src/imap.ts": { patterns: ["IMAP client"], why: "IMAP to the account's own server (purpose mail, always allowed)" },
  "packages/mail/src/registry.ts": { patterns: ["IMAP client"], why: "verifying the account's own IMAP server" },
  "packages/mail/src/smtp.ts": { patterns: ["SMTP client"], why: "SMTP to the account's own server" },
  "packages/ai/src/anthropic.ts": { patterns: ["Anthropic client"], why: "constructed with the policy fetch (checked below)" },
  "packages/ai/src/openai-chat.ts": { patterns: ["OpenAI client"], why: "constructed with the policy fetch (checked below)" },
  "apps/desktop/src/app.ts": { patterns: ["Electron net"], why: "app:// handler reading bundled files (file: URLs only)" },
  "apps/web/src/rpc/connection.ts": { patterns: ["WebSocket client"], why: "renderer ↔ loopback backend-dev; the renderer is fenced by main's webRequest backstop" },
  "apps/web/src/web/sw.js": { patterns: ["global fetch"], why: "web build's service worker: same-origin app files only (cross-origin requests are not intercepted)" },
  "packages/mcp/src/connection.ts": { patterns: ["raw sockets"], why: "unix socket to the local backend" },
  "packages/core/src/diag/sentry.ts": { patterns: ["SMTP client"], why: "Sentry's createTransport (not SMTP): every envelope passes consentTransport, which refuses in local mode, without a DSN or consent" },
  "apps/desktop/src/diag/reporter.ts": { patterns: ["Electron net"], why: "error reports from main, through consentTransport (local mode, the setting and the DSN, checked per envelope)" },
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "test" ? [] : sources(p);
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !/\.(test|perf\.test|spec)\.\w+$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("architecture: every outbound connection goes through the network policy", () => {
  const files = SOURCE_DIRS.flatMap(sources).map((f) => ({ rel: relative(ROOT, f), code: stripComments(readFileSync(f, "utf8")) }));

  it("scans the shipped sources", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === "packages/mail/src/gmail.ts")).toBe(true);
  });

  it("finds no network call outside the allowlist", () => {
    const violations: string[] = [];
    for (const { rel, code } of files) {
      for (const { name, re } of PATTERNS) {
        if (!re.test(code)) continue;
        if (ALLOWED[rel]?.patterns.includes(name)) continue;
        violations.push(`${rel}: ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("AI SDK clients always receive the injected policy fetch", () => {
    for (const { rel, code } of files) {
      for (const m of code.matchAll(/new\s+(OpenAI|AzureOpenAI|Anthropic)\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
        expect(m[2], `${rel}: ${m[1]} without fetch`).toMatch(/\bfetch\b/);
      }
    }
  });

  it("Electron's net.fetch is only used for bundled file: URLs", () => {
    const main = files.find((f) => f.rel === "apps/desktop/src/app.ts")!;
    for (const m of main.code.matchAll(/net\.fetch\(([^)]*)\)/g)) expect(m[1]).toMatch(/pathToFileURL/);
  });

  it("the allowlist has no stale entries", () => {
    for (const [rel, { patterns }] of Object.entries(ALLOWED)) {
      const file = files.find((f) => f.rel === rel);
      if (!file) continue; // optional locations (e.g. a transport not built yet)
      for (const name of patterns) expect(PATTERNS.find((p) => p.name === name)!.re.test(file.code), `${rel} no longer uses ${name}`).toBe(true);
    }
  });
});
