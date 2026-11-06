import { parse } from "@babel/parser";
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
  // a session's own fetch (plan 78's reports session): the same network as net.fetch
  { name: "Electron session fetch", re: /\b(ses|session|\w+Session)\.fetch\s*\(/ },
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
  "packages/backend/src/unsubscribe-node.ts": { patterns: ["node:http client imports"], why: "plan 96: one POST per click on Unsubscribe, asserted by the policy (purpose unsubscribe) in unsubscribe.ts, to public addresses only, no redirects" },
  "packages/mail/src/imap.ts": { patterns: ["IMAP client"], why: "IMAP to the account's own server (purpose mail, always allowed)" },
  "packages/mail/src/registry.ts": { patterns: ["IMAP client"], why: "verifying the account's own IMAP server" },
  "packages/mail/src/smtp.ts": { patterns: ["SMTP client"], why: "SMTP to the account's own server" },
  "packages/ai/src/anthropic.ts": { patterns: ["Anthropic client"], why: "constructed with the policy fetch (checked below)" },
  "packages/ai/src/openai-chat.ts": { patterns: ["OpenAI client"], why: "constructed with the policy fetch (checked below)" },
  "apps/desktop/src/app.ts": { patterns: ["Electron net"], why: "app:// handler reading bundled files (file: URLs only)" },
  "apps/web/src/rpc/connection.ts": { patterns: ["WebSocket client"], why: "renderer ↔ loopback backend-dev; the renderer is fenced by main's webRequest backstop" },
  "apps/web/src/web/sw.js": { patterns: ["global fetch"], why: "web build's service worker: same-origin app files only (cross-origin requests are not intercepted)" },
  "packages/mcp/src/connection.ts": { patterns: ["raw sockets"], why: "unix socket to the local backend" },
  "apps/desktop/src/diag/reporter.ts": { patterns: ["Electron session fetch"], why: "plan 78: error reports from main, in a session fenced to the DSN's envelope URL, each asked of the consent boundary (the setting, the user's approval, the DSN)" },
  "apps/web/src/lib/diag-report.ts": { patterns: ["global fetch"], why: "plan 78: error reports from the web page to the DSN's envelope URL only (no redirects, no credentials), each asked of the consent boundary" },
  "apps/site/src/client.ts": { patterns: ["global fetch"], why: "plan 97: terno.app's waitlist form posts to its own Worker; the marketing site, not the mail client" },
  "apps/site/src/worker/index.ts": { patterns: ["global fetch"], why: "plan 97: the site Worker's own fetch handler (a method, not a request)" },
  "apps/desktop/src/mailbox/opening.fixture.ts": { patterns: ["globalThis.fetch"], why: "test fixture: replaces fetch with a guard that fails any network route" },
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

// A browser reads a script served without a charset as Windows-1252: a literal "Â-ô" range in a
// regex then turns into an out-of-order one and the whole bundle fails to load (gmail-wire.spec).
/** The little of Babel's tree this reads. */
type AstNode = { type: string; start: number; end: number; callee?: AstNode; arguments?: AstNode[]; name?: string | AstNode; property?: AstNode };

/** What loads code at run time, from the parser's tree: a type's `import("x")` is no call, and `typeof import("x")` in a value is. */
function runtimeLoads(code: string, rel: string): string[] {
  const found: string[] = [];
  const named = (node: AstNode | undefined, kind: string, name: string) => node?.type === kind && node.name === name;
  const visit = (node: AstNode): void => {
    if (node.type === "CallExpression") {
      const arg = node.arguments?.[0], text = arg ? code.slice(arg.start, arg.end) : "";
      if (node.callee?.type === "Import") found.push(`import(${text})`);
      else if ((named(node.callee, "Identifier", "require") || named(node.callee?.property, "Identifier", "require")) && !/^["'](node:|electron["'])/.test(text)) found.push(`require(${text})`);
      else if (named(node.callee, "Identifier", "lazy")) found.push("lazy()");
    }
    if (node.type === "JSXOpeningElement" && named(node.name as AstNode, "JSXIdentifier", "Suspense")) found.push("<Suspense>");
    for (const value of Object.values(node) as unknown[]) {
      for (const child of Array.isArray(value) ? value : [value]) if (typeof (child as AstNode | null)?.type === "string") visit(child as AstNode);
    }
  };
  visit(parse(code, { sourceType: "module", errorRecovery: true, plugins: rel.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] }).program as unknown as AstNode);
  return found;
}

/**
 * file → what it may load. The web host's code stays out of the desktop build: each of these sits behind
 * VITE_TARGET === "web", and `desktopGuard` (apps/web/vite.config.ts) fails a desktop build that holds any of it.
 * `require("./app")` is order, not laziness: the profile is prepared first.
 */
const MAY_LOAD: Record<string, string[]> = {
  "apps/desktop/src/main.ts": ['require("./app")'],
  "apps/web/src/components/add-account-dialog.tsx": ['import("~/web/google")'],
  "apps/web/src/components/settings/sender-pictures.tsx": ['import("~/web/google")'],
  "apps/web/src/lib/notify.ts": ['import("~/web/lifecycle")'],
  "apps/web/src/lib/sign-in.ts": ['import("~/web/google")'],
  "apps/web/src/rpc/connection.ts": ['import("~/web/connect")'],
};
/** The web host's own files, dev tools and test helpers. */
const NOT_THE_APP = /^apps\/web\/src\/web\/|^apps\/backend-dev\/|^packages\/store\/src\/conformance\/|harness\.tsx$|-owned-rpc\.ts$|\.fixture\.ts$/;

it("no lazy loading: a desktop app's code is on disk, and everything is a plain import", () => {
  const loads = (code: string) => runtimeLoads(code, "x.tsx");
  for (const load of ['const A = lazy(() => import("./x"));', 'const a = <Suspense fallback={null}><B /></Suspense>;', 'const load = () => import("./x");', 'import ("./x");', "import(url);", 'require("./scheduled");', 'require(join(__dirname, "reporter.cjs"));', 'const a = typeof import("./x");', 'const a = () => require("./app");', 'void import("~/web/google");', 'const a = () => module.require("./x");', 'const a = () => import /* chunk */ ("./x");']) expect(loads(load), load).not.toEqual([]);
  for (const fine of ['type A = typeof import("./x");', 'let a: import("./x").Name;', 'const a = b as typeof import("./x");', 'require("node:fs");', 'require("electron");', "// lazy(() => import(\"./x\"))", 'const a = "lazy(";']) expect(loads(fine), fine).toEqual([]);
  const files = SOURCE_DIRS.flatMap(sources).map((f) => ({ rel: relative(ROOT, f), code: readFileSync(f, "utf8") }));
  expect(files.some((f) => f.rel === "apps/web/src/app.tsx")).toBe(true);
  const found = new Map<string, string[]>();
  for (const { rel, code } of files) {
    if (NOT_THE_APP.test(rel)) continue;
    const here = runtimeLoads(code, rel);
    if (here.length) found.set(rel, here);
  }
  const allowed = new Map(Object.entries(MAY_LOAD));
  expect([...found].flatMap(([rel, here]) => here.filter((l) => !allowed.get(rel)?.includes(l)).map((l) => `${rel}: ${l}`))).toEqual([]);
  // no stale exemptions: a file that stopped loading it gives the exemption up
  for (const [rel, here] of allowed) expect(found.get(rel), rel).toEqual(expect.arrayContaining(here));
});

it("the address code is ASCII outside comments, so it parses however its bundle is decoded", () => {
  for (const file of ["packages/core/src/address.ts", "packages/core/src/encoded-words.ts"]) {
    const code = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
    expect(code.filter((l) => /[^\t -~]/.test(l)), file).toEqual([]);
  }
});
