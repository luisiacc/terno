/**
 * Plan 283 (CASA 6.2.1): a packaged Terno can't be started with a debugger. Nothing here attaches Playwright, so it runs
 * on a shipped build too: TERNO_SMOKE_SHIPPED=1 says that's what it's given (`playwright.shipped.config.ts`, the release
 * jobs), otherwise it expects the inspectable build `pnpm dist:mac` makes. macOS: release/mac-arm64/Terno.app (or
 * TERNO_SMOKE_APP), copied out of the repo; Linux: the installed package (TERNO_LINUX_APP, else /opt/Terno/terno).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
// @ts-expect-error a build script (plain JS)
import { assertFuses } from "../scripts/fuses.mjs";
// @ts-expect-error a build script (plain JS)
import { electronDist } from "../scripts/package-stage.mjs";
import { copyTree, stopSpawned } from "./packaged-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const linux = process.platform === "linux";
const shipped = process.env.TERNO_SMOKE_SHIPPED === "1";
const SOURCE = linux ? (process.env.TERNO_LINUX_APP ?? "/opt/Terno/terno") : (process.env.TERNO_SMOKE_APP ?? join(here, "../release/mac-arm64/Terno.app"));
let work: string;
/** what the fuses are read from: the .app, or the Linux executable */
let app: string;
let executable: string;
let wrapper: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  const missing = linux ? "install the .deb (or set TERNO_LINUX_APP)" : "run `pnpm dist:mac` first";
  // a release's probe never passes by skipping
  if (shipped && !existsSync(SOURCE)) throw new Error(`${SOURCE} missing: ${missing}`);
  test.skip(!existsSync(SOURCE), missing);
  work = mkdtempSync(join(tmpdir(), "terno-debugging-"));
  if (linux) {
    app = executable = SOURCE;
    wrapper = join(dirname(SOURCE), "resources/bin/terno-mcp");
  } else {
    app = join(work, "Terno.app");
    copyTree(SOURCE, app);
    executable = join(app, "Contents/MacOS/Terno");
    wrapper = join(app, "Contents/Resources/bin/terno-mcp");
  }
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/**
 * The environment a launch gets: its own profile (`profile`), in the background, nothing inherited that would steer it.
 * The agents' socket and token are the profile's own: inherited ones would reach the Terno you're running (review).
 */
function env(extra: Record<string, string> = {}, profile = join(work, "profile")): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, TERNO_USER_DATA: profile, TERNO_SOCKET: join(profile, "agent.sock"), TERNO_TOKEN_FILE: join(profile, "agent.token"), TERNO_TEST_BACKGROUND: "1", TERNO_TEST_LANGUAGES: "en-US", TERNO_DEMO: "1", ...extra };
  for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "TERNO_DEV_URL"]) if (!(k in extra)) delete e[k];
  return e;
}

/** Waits for `child`'s output to drain ("close"), stopping it (and what it started) after `ms`. */
async function finished(child: ChildProcess, ms: number): Promise<number | null> {
  const closed = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  const spawnFailed = new Promise<never>((_, reject) => child.on("error", reject));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), ms)));
  const first = await Promise.race([closed, late, spawnFailed]);
  clearTimeout(timer);
  if (first !== "late") return first;
  await stopSpawned(child);
  throw new Error(`${child.spawnfile} didn't finish in ${ms} ms`);
}

/** Runs `bin` to its exit: its code and what it wrote. */
async function run(bin: string, args: string[], e: NodeJS.ProcessEnv, ms = 30_000): Promise<{ code: number | null; out: string }> {
  // fds 3 and 4: what --remote-debugging-pipe reads and writes
  const child = spawn(bin, args, { env: e, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (out += d));
  return { code: await finished(child, ms), out };
}

/** One `list_accounts` call through the bundled terno-mcp, as an agent makes it: the result, or null when it got none. */
async function listAccounts(e: NodeJS.ProcessEnv): Promise<{ isError?: boolean; content: { text: string }[] } | null> {
  const agent = spawn(wrapper, [], { env: e, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  agent.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
  const send = (m: unknown) => agent.stdin!.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_accounts", arguments: {} } });
  agent.stdin!.end();
  await finished(agent, 30_000);
  // whole lines only, once the output is drained
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2)?.result ?? null;
}

test(`the app is fused as ${shipped ? "a shipped" : "an inspectable"} build`, () => {
  assertFuses(app, { platform: process.platform, shipped });
});

test("the DevTools protocol is refused without Node's inspector, before anything starts: by port and by pipe", async () => {
  for (const flag of ["--remote-debugging-port=0", "--remote-debugging-pipe"]) {
    const { code, out } = await run(executable, [flag], env());
    expect(out, flag).toContain(`Terno doesn't open the DevTools protocol (${flag.replace(/=.*/, "")})`);
    expect(out, flag).not.toContain("DevTools listening");
    expect(code, flag).toBe(1);
  }
});

test("NODE_OPTIONS reaches nothing, not even Terno run as Node (the agents' connector)", async () => {
  const probe = join(work, "probe.cjs");
  const marker = join(work, "probe-ran");
  writeFileSync(probe, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  const node = (bin: string) => run(bin, ["-e", "0"], env({ ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: `--require ${probe}` }));
  // the control: Electron's own binary, its fuses at their defaults, does run it
  const stock = linux ? join(electronDist, "electron") : join(electronDist, "Electron.app/Contents/MacOS/Electron");
  if (shipped && !existsSync(stock)) throw new Error(`${stock} missing: the probe's control needs Electron's own binary (pnpm install)`);
  if (existsSync(stock)) {
    await node(stock);
    expect(existsSync(marker), "NODE_OPTIONS reaches an unfused Electron run as Node").toBe(true);
    rmSync(marker);
  }
  const { code } = await node(executable);
  expect(code).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test("Node's inspector: only an inspectable build opens it, and a shipped one refuses Playwright's launch outright", async () => {
  test.skip(!shipped, "Playwright attaching to the inspectable build is the rest of the smoke suite");
  const { code, out } = await run(executable, ["--inspect=0", "--remote-debugging-port=0"], env());
  expect(out).not.toContain("Debugger listening");
  expect(out).toContain("Terno doesn't open the DevTools protocol (--remote-debugging-port)");
  expect(code).toBe(1);
});

test("started as a user starts it, it opens its mailbox, and the agents' connector answers @launches", async () => {
  const e = env({}, join(work, "launched"));
  const child = spawn(executable, [], { env: e, stdio: "ignore" });
  try {
    // agents are allowed by default; the token comes a moment before the socket listens, so it's asked until it answers
    let result: Awaited<ReturnType<typeof listAccounts>> = null;
    for (const until = Date.now() + 60_000; Date.now() < until && child.exitCode === null; await delay(500)) {
      if (!existsSync(e.TERNO_TOKEN_FILE!)) continue;
      result = await listAccounts(e);
      if (result && !result.isError) break;
    }
    expect(result, "the backend never came up").not.toBeNull();
    expect(result!.isError, result!.content[0]?.text).toBeFalsy();
    expect(JSON.parse(result!.content[0]!.text).accounts.length).toBeGreaterThan(0);
  } finally {
    await stopSpawned(child);
  }
});
