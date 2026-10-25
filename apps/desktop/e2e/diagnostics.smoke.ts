/**
 * Plan 10 on the PACKAGED app (a copy outside the repo, demo mailbox, temp
 * profile). Reports go to a local HTTP sink through a test DSN (honored only
 * by demo/dev builds with TERNO_DIAG_TEST): every envelope is decoded and
 * every item checked. Local mode is proven by the counter at the transport,
 * not by the sink (main's fence lets loopback through).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const SOURCE_APP = join(here, "../release/mac-arm64/Terno.app");

interface Envelope {
  header: Record<string, unknown>;
  items: { header: Record<string, unknown>; payload: Record<string, unknown> }[];
}
let sink: Server;
let envelopes: Envelope[] = [];
let requests = 0;
let workdir: string;
let appPath: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
let dsn: string;

type Hooks = {
  view(): { pending: { id: string; kind: string; code: string }[]; reporting: { offer: string; localMode: boolean; errorReports: string }; build: { id: string } };
  records(): { id: string; kind: string; code: string; fatal: boolean; error?: { frames: { file: string; line?: number; col?: number }[] }; context: { build: string } }[];
  counters(): { allowed: number; refused: number; sent: number; failed: number };
  preview(id: string): { event: Record<string, unknown> } | null;
  decide(ids: string[], d: "send" | "dismiss"): Promise<{ sent: number }>;
  exportTo(path: string, native: boolean): Promise<{ status: string }>;
  paths(): { logs: string; crashes: string; diag: string };
  throwKnown(): string | null;
  flush(): void;
};
const hooks = <T,>(fn: (h: Hooks, arg: unknown) => T, arg?: unknown): Promise<Awaited<T>> =>
  app.evaluate((_electron, [src, a]) => new Function("h", "a", `return (${src})(h, a)`)((globalThis as unknown as { __ternoDiag: unknown }).__ternoDiag, a), [fn.toString(), arg] as const) as Promise<Awaited<T>>;

async function launch(): Promise<void> {
  const env = { ...process.env, TERNO_DEMO: "1", TERNO_USER_DATA: userData, TERNO_DIAG_TEST: "1", TERNO_TEST_SENTRY_DSN: dsn, TERNO_TEST_EXPORT_DIR: workdir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: join(appPath, "Contents/MacOS/Terno"), env });
  page = await app.firstWindow();
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 60_000 });
}

/** The subjects and senders on screen: the strings that must never leave. */
async function fixtureStrings(): Promise<string[]> {
  const out = new Set<string>();
  for (const row of await page.locator("[data-testid=thread-row]").all()) {
    for (const id of ["row-subject", "row-from"]) {
      const t = (await row.getByTestId(id).textContent())?.trim();
      if (t && t.length > 3) out.add(t);
    }
  }
  return [...out];
}

async function setReports(value: "ask" | "always" | "never"): Promise<void> {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  await page.getByTestId("error-reports-select").click();
  await page.getByTestId(`error-reports-${value}`).click();
  await expect.poll(() => hooks((h) => h.view().reporting.errorReports)).toBe(value);
  await page.keyboard.press("Escape");
}

// one app and one profile, in order: a failure stops the rest instead of restarting into a fresh profile
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.skip(!existsSync(SOURCE_APP), "run `pnpm dist:mac` first");
  sink = createServer((req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
      const env: Envelope = { header: JSON.parse(lines[0]!), items: [] };
      for (let i = 1; i < lines.length; i += 2) env.items.push({ header: JSON.parse(lines[i]!), payload: JSON.parse(lines[i + 1]!) });
      envelopes.push(env);
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  dsn = `http://publickey@127.0.0.1:${(sink.address() as AddressInfo).port}/1`;
  workdir = mkdtempSync(join("/tmp", "terno-diag-smoke-"));
  appPath = join(workdir, "Terno.app");
  execFileSync("ditto", [SOURCE_APP, appPath]);
  userData = join(workdir, "profile");
  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  sink?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

test("the packaged app ships no source map, and its maps are archived for its build", async () => {
  const resources = join(appPath, "Contents/Resources");
  const asar = readFileSync(join(resources, "app.asar"));
  expect(asar.includes(Buffer.from(".map\""))).toBe(false);
  const build = await hooks((h) => h.view().build.id);
  const archive = join(repo, "apps/desktop/.maps", build.replace("+", "-"));
  for (const f of ["dist/main.cjs.map", "dist/backend.cjs.map", "dist/preload.cjs.map", "dist/reporter.cjs.map", "dist/mcp/terno-mcp.cjs.map"]) expect(existsSync(join(archive, f)), f).toBe(true);
  expect(readdirSync(join(archive, "dist/renderer/assets")).some((f) => f.endsWith(".js.map"))).toBe(true);
});

test("local mode (the default): nothing reaches the network, even an approved report", async () => {
  expect(await hooks((h) => h.view().reporting)).toMatchObject({ localMode: true, offer: "local" });
  const id = await hooks((h) => h.throwKnown());
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  await hooks((h, a) => h.decide([a as string], "send"), id);
  expect(await hooks((h) => h.counters())).toMatchObject({ allowed: 0, sent: 0 });
  expect((await hooks((h) => h.counters())).refused).toBeGreaterThan(0);
  expect(requests).toBe(0);
});

test("always: one scrubbed event per error, exactly what 'What gets sent' showed", async () => {
  const never = await fixtureStrings();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("local-mode-switch").click();
  await page.getByTestId("local-mode-confirm-off").click();
  await expect.poll(() => hooks((h) => h.view().reporting.localMode)).toBe(false);
  await page.keyboard.press("Escape");
  envelopes = [];
  requests = 0;
  await setReports("always");
  // switching to always sends what this run recorded and nobody acted on: let that settle first
  await page.waitForTimeout(1500);
  const before = envelopes.length;
  const id = (await hooks((h) => h.throwKnown())) as string;
  await expect.poll(() => envelopes.length).toBe(before + 1);
  const env = envelopes.at(-1)!;
  expect(env.header.event_id).toBe(id);
  expect(env.items).toHaveLength(1);
  expect(env.items[0]!.header.type).toBe("event");
  const event = env.items[0]!.payload;
  const preview = await hooks((h, a) => h.preview(a as string), id);
  expect(event).toEqual(preview!.event);
  expect(event).toMatchObject({ level: "error", tags: { proc: "main", code: "diag.selftest" }, exception: { values: [{ type: "TypeError", value: "diag.selftest" }] } });
  expect((event.release as string).startsWith("terno@0.1.0+")).toBe(true);
  expect((event.debug_meta as { images: { code_file: string }[] }).images.map((i) => i.code_file)).toContain("app:///dist/main.cjs");
  const text = JSON.stringify(env);
  expect(text).not.toContain("diag selftest: a known failure");
  for (const s of never) expect(text).not.toContain(s);
  expect(text).not.toMatch(/\/Users\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  expect(requests).toBe(envelopes.length);
});

test("never sends nothing, even when asked; ask sends exactly what was approved", async () => {
  await setReports("never");
  const sent = envelopes.length;
  const refused = (await hooks((h) => h.counters())).refused;
  const id = (await hooks((h) => h.throwKnown())) as string;
  await hooks((h, a) => h.decide([a as string], "send"), id);
  expect(envelopes.length).toBe(sent);
  expect((await hooks((h) => h.counters())).refused).toBe(refused + 1);

  await setReports("ask");
  const asked = (await hooks((h) => h.throwKnown())) as string;
  await page.waitForTimeout(500);
  expect(envelopes.length).toBe(sent);
  // the row asks, in place
  await expect(page.getByTestId("report-row")).toHaveAttribute("data-offer", "ask");
  await page.getByTestId("report-send").click();
  await expect.poll(() => envelopes.map((e) => e.header.event_id)).toContain(asked);
  await expect(page.getByTestId("report-row")).toHaveCount(0);
});

test("a known minified exception resolves to its source line through the archived maps", async () => {
  const records = await hooks((h) => h.records());
  const known = records.find((r) => r.code === "diag.selftest")!;
  const { archiveFor, symbolicate } = await import(join(repo, "scripts/symbolicate.mjs"));
  const archive = archiveFor(known.context.build);
  expect(archive).toBeTruthy();
  const [top] = symbolicate(known, archive);
  const source = readFileSync(join(repo, "apps/desktop/src/diag/main.ts"), "utf8").split("\n");
  const line = source.findIndex((l) => l.includes('throw new TypeError("diag selftest: a known failure")')) + 1;
  expect(top.source).toMatch(/(^|\/)src\/diag\/main\.ts$/);
  expect(top.sourceLine).toBe(line);
});

test("a renderer crash: a record, a native dump kept locally, the window back, and the row says so", async () => {
  await setReports("never");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.forcefullyCrashRenderer());
  await expect.poll(async () => (await hooks((h) => h.records())).some((r) => r.kind === "renderer_gone")).toBe(true);
  // main reloads the window in a fresh renderer (Playwright's page stays the crashed one: ask the window itself)
  const inWindow = (js: string) => app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.executeJavaScript(code).catch(() => null), js);
  await expect.poll(() => inWindow("document.querySelectorAll('[data-testid=thread-row]').length"), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => inWindow("document.querySelector('[data-testid=report-row-title]')?.textContent ?? null"), { timeout: 15_000 }).toBe("Terno's window closed because of an error");
  const native = join((await hooks((h) => h.paths())).crashes, "native");
  const dumps = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? dumps(join(dir, n)) : n.endsWith(".dmp") ? [n] : [])) : []);
  await expect.poll(() => dumps(native).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await inWindow("document.querySelector('[data-testid=report-close]').click()");
  // a fresh launch for the rest (a clean quit: no unclean-exit record)
  await app.close();
  await launch();
});

test("the backend dies: recorded, restarted with backoff, then stopped visibly until Try again", async () => {
  test.setTimeout(120_000);
  const backendPid = () => app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.type === "Utility" && (m.serviceName === "Terno Mail Engine" || m.name === "Terno Mail Engine"))?.pid ?? null);
  const kill = async () => {
    const pid = await expect.poll(backendPid, { timeout: 20_000 }).not.toBeNull().then(() => backendPid());
    process.kill(pid!, "SIGKILL");
    await expect.poll(backendPid, { timeout: 20_000 }).not.toBe(pid);
  };
  const exits = async () => (await hooks((h) => h.records())).filter((r) => r.kind === "backend_exit").length;
  const before = await exits();
  await kill();
  await expect.poll(exits).toBe(before + 1);
  // it comes back: the window reconnects and shows mail
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 30_000 });
  // five quick deaths in a row: main stops trying and says so
  const engine = () => hooks((h) => (h.view() as unknown as { engine: string }).engine);
  for (let i = 0; i < 6 && (await engine()) !== "stopped"; i++) {
    const pid = await backendPid();
    if (pid !== null) process.kill(pid, "SIGKILL");
    // the next one is up (after its backoff), or main gave up
    await expect
      .poll(async () => {
        const next = await backendPid();
        return (next !== null && next !== pid) || (await engine()) === "stopped";
      }, { timeout: 20_000 })
      .toBe(true);
  }
  await expect(page.getByTestId("engine-stopped")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("engine-retry").click();
  await expect(page.getByTestId("engine-stopped")).toHaveCount(0, { timeout: 30_000 });
  await page.locator("[data-testid=thread-row]").first().waitFor({ timeout: 30_000 });
});

test("the export is Terno's diagnostics only, scrubbed; native dumps only when asked", async () => {
  const never = await fixtureStrings();
  const zipPath = join(workdir, "export.zip");
  expect(await hooks((h, a) => h.exportTo(a as string, false), zipPath)).toMatchObject({ status: "saved" });
  const listing = execFileSync("unzip", ["-Z1", zipPath]).toString().split("\n").filter(Boolean);
  expect(listing).toContain("README.txt");
  expect(listing).toContain("logs/main.jsonl");
  expect(listing.some((f) => f.startsWith("crashes/"))).toBe(true);
  expect(listing.some((f) => f.startsWith("native/"))).toBe(false);
  const text = execFileSync("unzip", ["-p", zipPath]).toString("utf8");
  for (const s of never) expect(text).not.toContain(s);
  expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  const withNative = join(workdir, "export-native.zip");
  await hooks((h, a) => h.exportTo(a as string, true), withNative);
  expect(execFileSync("unzip", ["-Z1", withNative]).toString()).toMatch(/^native\/.*\.dmp$/m);
});

test("killed outright: the next start finds the marker and says Terno quit unexpectedly; in local mode nothing goes", async () => {
  // "always", then local mode on: a restart into local mode sends nothing it recorded
  await setReports("always");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("tab-general").click();
  await page.getByTestId("local-mode-switch").click();
  await expect.poll(() => hooks((h) => h.view().reporting.localMode)).toBe(true);
  await page.keyboard.press("Escape");
  const sent = envelopes.length;
  const pid = app.process().pid!;
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));
  await launch();
  await expect(page.getByTestId("report-row-title")).toHaveText("Terno quit unexpectedly");
  await expect(page.getByTestId("report-row")).toHaveAttribute("data-offer", "local");
  expect((await hooks((h) => h.records())).some((r) => r.kind === "unclean_exit")).toBe(true);
  await page.waitForTimeout(1000);
  expect(envelopes.length).toBe(sent);
  expect((await hooks((h) => h.counters())).allowed).toBe(0);
});
