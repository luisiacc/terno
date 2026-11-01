import { Worker } from "node:worker_threads";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, afterAll, expect, it } from "vitest";
import { Db, MIGRATIONS, nodeSqliteDriver, createAccount, ingestMessages, registerFunctions, listBackups, SCHEMA_VERSION } from "@terno/db";
import { msg } from "../../../../packages/store/src/conformance/fixtures";
import { openNodeMailbox, nodeStore } from "@terno/backend";
import type { MainToBackend } from "../ipc";

const text = "😀e\u0301\r\nexact old entry phrase ".repeat(9000), html = `<p>${text}</p>`;
let fixtureDirectory: string;
beforeAll(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "terno-entry-fixture-"));
  await build({ entryPoints: [fileURLToPath(new URL("./opening.fixture.ts", import.meta.url))], outfile: join(fixtureDirectory, "entry.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["node:*"], logLevel: "silent", define: { "import.meta.url": "__fixtureMetaUrl" }, banner: { js: "const __fixtureMetaUrl = require('node:url').pathToFileURL(__filename).href;" } });
  copyFileSync(fileURLToPath(new URL("../../../../packages/backend/dist/incoming.worker.cjs", import.meta.url)), join(fixtureDirectory, "incoming.worker.cjs"));
});
afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

type Event = { tag: string; outcome?: string; kind?: string; reason?: string; code?: number };
function owner(mode: string) {
  const worker = new Worker(join(fixtureDirectory, "entry.cjs"), { workerData: { mode }, execArgv: [], env: { NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" } });
  const events: Event[] = [], waiting = new Set<{ tag: string; resolve(event: Event): void }>();
  let exited = false;
  const record = (event: Event) => { events.push(event); for (const waiter of waiting) if (waiter.tag === event.tag || event.tag === "exit" || event.tag === "error") { waiting.delete(waiter); waiter.resolve(event); } };
  worker.on("message", (value) => {
    if (value.type === "secret") worker.postMessage({ type: "secret-result", id: value.id, ok: false, error: "No synthetic credential" });
    record({ tag: value.fixture ?? value.type, outcome: value.outcome, kind: value.gate?.kind, reason: value.gate?.reason });
  });
  worker.on("error", () => record({ tag: "error" }));
  worker.on("exit", (code) => { exited = true; record({ tag: "exit", code }); });
  const until = (tag: string): Promise<Event> => { const prior = events.find((event) => event.tag === tag || event.tag === "exit" || event.tag === "error"); return prior ? Promise.resolve(prior) : new Promise((resolve) => waiting.add({ tag, resolve })); };
  return { events, worker, until, async barrier() { const count = events.filter((event) => event.tag === "barrier").length; worker.postMessage({ fixture: "barrier" }); if (count === 0) await until("barrier"); }, async close() { if (!exited) { worker.postMessage({ fixture: "dispose" }); await until("disposed"); await worker.terminate(); } } };
}
function legacy(path: string, fail: boolean) {
  const db = new Db(nodeSqliteDriver, path);
  try {
    registerFunctions(db);
    for (const migration of MIGRATIONS) if (migration.version <= 38) db.tx(() => { db.exec(migration.sql); db.exec(`PRAGMA user_version=${migration.version}`); });
    const account = createAccount(db, { kind: "gmail", email: "synthetic@example.test", displayName: "Synthetic", color: "indigo" }, 1);
    db.exec("ALTER TABLE messages ADD COLUMN unsubscribe TEXT");
    ingestMessages(db, [msg({ accountId: account.id, providerMsgId: "legacy", bodyText: text, bodyHtml: html, bodyState: "partial" })], 1);
    db.exec("ALTER TABLE messages DROP COLUMN unsubscribe");
    if (fail) db.exec("CREATE TABLE body_parts(synthetic_collision INTEGER)");
  } finally { db.close(); }
}
function init(directory: string): MainToBackend {
  return { type: "init", dbPath: join(directory, "mail.db"), demo: false, dev: false, online: false, socketPath: join(directory, "agent.sock"), tokenPath: join(directory, "agent.token"), version: "test", diag: { session: "synthetic-opening-session", build: "test", channel: "test" } };
}
function exactOld(path: string, version: number) {
  const db = new Db(nodeSqliteDriver, path, { readonly: true });
  try { expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(version); const row = db.get<{ body_text: string; body_html: string }>("SELECT body_text,body_html FROM message_bodies")!; expect(row.body_text === text && row.body_html === html).toBe(true); }
  finally { db.close(); }
}

for (const mode of ["prepared-cancel", "prepared-success", "backup-cancel", "migration-error"] as const) it(`actual native entry retains opening ownership through ${mode}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "terno-entry-opening-")), path = join(directory, "mail.db");
  legacy(path, mode === "migration-error");
  const native = owner(mode);
  try {
    expect((await native.until("booted")).tag).toBe("booted"); native.worker.postMessage(init(directory));
    const phase = mode === "backup-cancel" ? "backup-held" : mode === "migration-error" ? "native-exit" : "prepared";
    expect((await native.until(phase)).tag, "entry must enter the owned asynchronous admission path").toBe(phase);
    if (mode !== "backup-cancel") {
      const backups = listBackups(join(directory, "backups")); expect(backups).toHaveLength(1); exactOld(backups[0]!.file, 38);
    } else exactOld(path, 38);
    expect(native.events.some((event) => event.tag === "host-open" || event.tag === "ready")).toBe(false);
    if (mode === "migration-error") {
      native.worker.postMessage({ fixture: "release-retirement" });
      const failure = await native.until("open-failed"); expect(failure.kind).toBe("failed"); expect(failure.reason).toBe("migration"); exactOld(path, 40);
    } else if (mode === "prepared-success") {
      native.worker.postMessage({ fixture: "release-prepared" }); expect((await native.until("native-exit")).tag).toBe("native-exit");
      await native.barrier(); expect(native.events.some((event) => event.tag === "ready" || event.tag === "host-open")).toBe(false);
      native.worker.postMessage({ fixture: "release-retirement" }); expect((await native.until("ready")).tag).toBe("ready");
      expect(native.events.some((event) => event.tag === "host-open")).toBe(true);
      native.worker.postMessage({ type: "shutdown", id: 1, force: true, deadlineMs: 5000 }); expect((await native.until("shutdown-result")).outcome).toBe("closed");
    } else {
      native.worker.postMessage({ type: "shutdown", id: 1, force: true, deadlineMs: 5000 });
      if (mode === "prepared-cancel") { expect((await native.until("native-exit")).tag).toBe("native-exit"); exactOld(path, SCHEMA_VERSION); }
      await native.barrier(); expect(native.events.some((event) => event.tag === "shutdown-result"), "logical abort must not acknowledge owned physical work").toBe(false);
      native.worker.postMessage({ fixture: mode === "backup-cancel" ? "release-backup" : "release-retirement" });
      expect((await native.until("shutdown-result")).outcome).toBe("closed");
      expect(native.events.some((event) => event.tag === "ready" || event.tag === "host-open")).toBe(false);
      expect(listBackups(join(directory, "backups"))).toHaveLength(1); exactOld(path, mode === "backup-cancel" ? 38 : SCHEMA_VERSION);
      await native.close();
      const store = nodeStore(await openNodeMailbox(path), { instantSearch: false });
      try { const message = (await store.threads.get(1))!.messages[0]!; expect(message.bodyText === text && message.bodyHtml === html).toBe(true); expect(message.bodyState).toBe("partial"); }
      finally { await store.close(); }
    }
    expect(native.events.some((event) => event.tag === "unexpected-route")).toBe(false);
  } finally { await native.close(); rmSync(directory, { recursive: true, force: true }); }
});
