/**
 * Runs in an Electron utilityProcess (plain Node + node:sqlite). It owns the
 * database and sync; the renderer talks to it over a direct MessagePort, so
 * mail data never hops through the main process.
 */
import { dirname } from "node:path";
import { Backend, demoEditionOf, openNodeMailbox, nodeStore, parseGoogleClients, parseOAuthClients, seedDemo, seedDemoCode, seedDemoSince, type LegacySecretReader, type SecretCipher } from "@terno/backend";
import { devAiKeys } from "@terno/core";
import { GATE_OPEN } from "@terno/core/mailbox";
import { classifyOpenError, diskFree, mailboxBytes, mailboxSchema, migrateHeadroom, nodePlatform, removeOldBackups, SCHEMA_VERSION, SqlMailStore } from "@terno/db";
import { captureError, diagPlatform, installDiag, log, type DiagEntry, type DiagOptions } from "@terno/core/diag";
import { isRpcMessage, type RpcMessage, type Transport } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail/registry";
import { serveMcp } from "@terno/mcp";
import { loopbackInsecure } from "./imap-seam";
import type { BackendToMain, MainToBackend } from "./ipc";
import { demoCodeWanted, demoSinceWanted, netRecorder, offsetClock } from "./test-hooks";
import { readDemoCorpus } from "./demo-corpus";

type PortMain = {
  on(event: "message", l: (e: { data: unknown }) => void): void;
  on(event: "close", l: () => void): void;
  postMessage(m: unknown): void;
  start(): void;
  close(): void;
};
const parentPort = (process as unknown as { parentPort: { on(e: "message", l: (e: { data: MainToBackend; ports: PortMain[] }) => void): void; postMessage(m: BackendToMain): void } }).parentPort;

const send = (m: BackendToMain) => parentPort.postMessage(m);

// ───────────────────────────── diagnostics: batched to main over the parent port ─────────────────────────────

let batch: DiagEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const flushDiag = () => {
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = null;
  if (batch.length) send({ type: "diag", entries: batch });
  batch = [];
};
let accounts = { imap: 0, gmail: 0 };
const diagOptions = (o: Partial<DiagOptions> = {}): DiagOptions => ({
  proc: "backend",
  version: "0",
  build: "0",
  channel: "dev",
  ...o,
  context: () => ({ ...diagPlatform(process.platform, process.arch), runtime: `node-${process.versions.node}`, engine: "node-sqlite", accounts }),
  sink: {
    // every 500 ms or 100 entries
    write: (e) => {
      batch.push(e);
      if (batch.length >= 100) flushDiag();
      else batchTimer ??= setTimeout(flushDiag, 500);
    },
    capture: (record) => {
      flushDiag();
      send({ type: "diag-record", record });
    },
    mirror: (crumbs) => send({ type: "diag-ring", crumbs }),
    flush: flushDiag,
  },
});
installDiag(diagOptions());

/**
 * Node can't be trusted after an uncaught exception: record it, give the
 * parent port a moment to carry the record, and exit. Main restarts the
 * backend with a bounded backoff (a send in flight stays "unknown").
 */
function die(error: unknown, code: "process.uncaught" | "process.unhandled_rejection" | "backend.init_failed"): void {
  captureError(error, { code, fields: { source: "backend" }, fatal: true, expected: false });
  flushDiag();
  setTimeout(() => process.exit(70), 100);
}

let nextSecret = 1;
const pendingSecrets = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** safeStorage lives in main; ask it over the parent port. */
const cipher: SecretCipher = {
  encrypt: (plain) =>
    new Promise((resolve, reject) => {
      const id = nextSecret++;
      pendingSecrets.set(id, { resolve: (v) => resolve(Uint8Array.from(v as number[])), reject });
      send({ type: "secret", id, op: "encrypt", plain });
    }),
  decrypt: (blob) =>
    new Promise((resolve, reject) => {
      const id = nextSecret++;
      pendingSecrets.set(id, { resolve: (v) => resolve(v as string), reject });
      send({ type: "secret", id, op: "decrypt", blob: [...blob] });
    }),
};

/** Única's secrets: main opens them with the keychain helper (one plaintext or null per blob). */
const legacySecrets: LegacySecretReader = (blobs) =>
  new Promise((resolve, reject) => {
    const id = nextSecret++;
    pendingSecrets.set(id, { resolve: (v) => resolve(v as (string | null)[]), reject });
    send({ type: "legacy-secrets", id, blobs: blobs.map((b) => [...b]) });
  });

function portTransport(port: PortMain): Transport {
  const listeners = new Set<(m: RpcMessage) => void>();
  const closeListeners = new Set<() => void>();
  port.on("message", (e) => {
    if (isRpcMessage(e.data)) for (const l of listeners) l(e.data);
  });
  port.on("close", () => {
    for (const l of closeListeners) l();
  });
  port.start();
  return {
    send: (m) => port.postMessage(m),
    onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
    onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
    close: () => port.close(),
  };
}

let backend: Backend | null = null;
/** plan 176: whether a Terno window has focus (main's word, kept from init on) */
let focused = false;
/** plan 263: main's latest word on the network from init on (one told while the mailbox opens is kept for the backend) */
let online = true;
/** the focus main reports isn't a renderer's: one name for it among the clients (quick-checks.ts) */
const MAIN_CLIENT = "main";
let opening: { abort: AbortController; done: Promise<void> } | null = null;

parentPort.on("message", async (event) => {
  const msg = event.data;
  if (msg.type === "secret-result") {
    const p = pendingSecrets.get(msg.id);
    pendingSecrets.delete(msg.id);
    if (!p) return;
    if (msg.ok) p.resolve(msg.value);
    // plan 293: main says only that it failed; the backend's secret access turns it into its one generic error
    else p.reject(new Error("secret storage failed"));
    return;
  }
  if (msg.type === "shutdown") {
    void shutdown(msg);
    return;
  }
  if (msg.type === "port") {
    const port = event.ports[0];
    if (port && backend) backend.connect(portTransport(port), { clientId: msg.clientId, origin: "renderer" });
    return;
  }
  if (msg.type === "focus") {
    focused = msg.focused;
    backend?.windowFocus(MAIN_CLIENT, focused);
    return;
  }
  if (msg.type === "network") {
    // before init there is nothing to tell (init carries the state); while the mailbox opens the backend starts from it
    online = msg.online;
    backend?.networkChanged(msg.online, msg.reason);
    return;
  }
  if (msg.type === "init") {
    if (opening || backend || closing) return;
    focused = msg.focused;
    online = msg.online;
    const abort = new AbortController();
    const current = { abort, done: initialize(msg, abort.signal) };
    opening = current;
    try { await current.done; } finally { if (opening === current) opening = null; }

  }
});

async function initialize(msg: Extract<MainToBackend, { type: "init" }>, signal: AbortSignal): Promise<void> {
  installDiag(diagOptions({ version: msg.version, build: msg.diag.build, channel: msg.diag.channel, session: msg.diag.session }));
  // plan 95: the mailbox first (migrated, plan 255: with no backup); what goes wrong here is explained by the window,
  // not restarted
  if (!(await openMailbox(msg, signal))) return;
  if (signal.aborted) { await mailbox?.close(); mailbox = null; return; }
  try {
    const registry = createRegistry(msg.demo && msg.testSmtpPort ? { demoSmtpPort: msg.testSmtpPort } : {});
    backend = new Backend({
      dbPath: msg.dbPath,
      version: msg.version,
      cipher,
      legacySecrets,
      // plan 183: the MCP socket opens there only while the user has agents on (start() and the switch decide);
      // plan 293: the MCP server runs here, the agent's command only carries its stdio to the socket
      agentEndpoint: { socketPath: msg.socketPath, tokenPath: msg.tokenPath, serve: (socket, rpc) => serveMcp(socket, rpc, msg.version) },
      // the demo mailbox's sends go to the packaged smoke's SMTP server when it asks (main checked it may)
      // and plan 41's notification smoke adds an IMAP account on its own plain-text servers (the demo mailbox only,
      // and only for an account whose servers are loopback: imap-seam.ts)
      providers: msg.demo && msg.testImapInsecure ? loopbackInsecure(registry, createRegistry({ imap: { allowInsecure: true } })) : registry,
      openExternal: async (url) => send({ type: "open-external", url }),
      googleClients: parseGoogleClients(process.env.TERNO_GOOGLE_CLIENTS),
      microsoftClients: parseOAuthClients(process.env.TERNO_MICROSOFT_CLIENTS),
      demoAi: msg.demo || msg.dev,
      devAi: msg.devMode ? devAiKeys(process.env) : undefined,
      demo: msg.demo,
      // plan 161: main sends these only for the demo mailbox (test-hooks.ts)
      ...(msg.testNow !== undefined ? { now: offsetClock(msg.testNow) } : {}),
      ...(msg.testNetLog ? { onNet: netRecorder(msg.testNetLog) } : {}),
      online,
      onPolicy: (policy) => send({ type: "policy", ...policy }),
      // plan 41: main owns the Dock and the notifications (they work with every window closed)
      attention: { badge: (count) => send({ type: "badge", count }), notify: (notice) => send({ type: "notify", notice }) },
      log: storeLog(msg.dev),
      store: mailbox ?? undefined,
    });
    mailbox = null;
    if (signal.aborted) return;
    send({ type: "gate", gate: GATE_OPEN });
    // plan 292: the written mailbox when `dev.mjs` names it (a dev build only, main checked), else plan 289's demo edition
    const corpus = msg.demoCorpus;
    if (msg.demo && (await seedDemo(backend.store, corpus ? { mailbox: () => readDemoCorpus(corpus) } : { threads: 3000, accounts: 4, edition: "demo" }))) {
      if (signal.aborted) return;
      // AI off, as on a real install: the AI features show only once a real model is set up (the demo model is still
      // in the AI tab to try them)
      await backend.store.settings.set("app", { ai: { provider: "none" } });
    }
    if (signal.aborted) return;
    // `pnpm dev:demo`: a fresh verification code every launch, to try the list's code chip (plan 72); not in smokes
    if (demoCodeWanted(msg)) await seedDemoCode(backend.store, Date.now());
    if (signal.aborted) return;
    // plan 279's hand-written conversations belong to the generated mailbox; the written one has its own (plan 292)
    if (demoSinceWanted(msg) && (await demoEditionOf(backend.store)) !== "corpus") await seedDemoSince(backend.store);
    if (signal.aborted) return;
    await backend.publishPolicy();
    if (signal.aborted) return;
    await backend.start();
    if (signal.aborted) return;
    backend.windowFocus(MAIN_CLIENT, focused);
    const b = backend;
    const countAccounts = async () => {
      const list = await b.store.accounts.list().catch(() => []);
      accounts = { imap: list.filter((a) => a.kind === "imap").length, gmail: list.filter((a) => a.kind === "gmail").length };
    };
    void countAccounts();
    // recounted when the accounts change (they're announced then), never on a timer
    const emitAccounts = b.emitAccounts.bind(b);
    b.emitAccounts = async () => {
      await emitAccounts();
      await countAccounts();
    };
    send({ type: "ready" });
  } catch (error) {
    if (signal.aborted) return;
    // a backend that can't open its mailbox is no backend: main restarts it, then shows that it stopped
    die(error, "backend.init_failed");
  }
}

// ───────────────────────────── plan 95: opening the mailbox ─────────────────────────────

let mailbox: SqlMailStore | null = null;

/** free-form lines (the store, the search engine): the log keeps that one happened, never its text (it can quote a
 * provider's or a model's answer); a dev build also prints it */
const storeLog =
  (dev: boolean) =>
  (level: "info" | "warn" | "error", message: string, extra?: unknown): void => {
    log[level]("log.message", { source: "backend" });
    if (dev) console[level](`[backend] ${message}`, extra ?? "");
  };
/**
 * Opens (and migrates) the mailbox. There is no backup before a migration
 * (plan 255): a step that fails rolls back in its own transaction. A
 * classified failure becomes the window's gate and ends this process without
 * a restart; anything else is a crash.
 */
async function openMailbox(msg: Extract<MainToBackend, { type: "init" }>, signal: AbortSignal): Promise<boolean> {
  let from: number | null = null;
  try {
    signal.throwIfAborted();
    // an earlier build's pre-update backups: nothing reads them now, and a clone holds disk (not waited for)
    void removeOldBackups(msg.dbPath);
    from = mailboxSchema(msg.dbPath);
    if (from !== null && from < SCHEMA_VERSION) send({ type: "gate", gate: { kind: "upgrading", from, to: SCHEMA_VERSION } });
    const db = await openNodeMailbox(msg.dbPath, { uuid: () => nodePlatform.uuid() }, signal);
    try {
      signal.throwIfAborted();
      mailbox = nodeStore(db, { log: storeLog(msg.dev) });
    } catch (error) {
      try { db.close(); } catch { /* the open's error explains it */ }
      throw error;
    }
    return true;
  } catch (error) {
    // an opening ended by a shutdown isn't a failure to show
    if (signal.aborted) return false;
    const failure = classifyOpenError(error, () => {
      const size = mailboxBytes(msg.dbPath);
      let free = 0;
      try { free = diskFree(dirname(msg.dbPath)); } catch { /* unknown */ }
      return { needBytes: migrateHeadroom(size), freeBytes: free };
    });
    if (!failure) {
      die(error, "backend.init_failed");
      return false;
    }
    const kind = failure.kind === "failed" ? failure.reason : failure.kind;
    // the world's doing (a newer copy, a full or read-only disk) is logged; a step that failed or a damaged file is ours to fix
    const expected = kind === "newer" || kind === "no-room" || kind === "unwritable";
    captureError(error, { code: "mailbox.open_failed", fields: { openFailure: kind, schema: from ?? undefined, step: failure.kind === "failed" ? (failure.step ?? undefined) : undefined }, expected });
    send({ type: "open-failed", gate: failure });
    flushDiag();
    setTimeout(() => process.exit(75), 100);
    return false;
  }
}

let closing: Promise<void> | null = null;

/** See MainToBackend "shutdown": a send in flight is never cut short unless main says so. */
async function shutdown(msg: Extract<MainToBackend, { type: "shutdown" }>): Promise<void> {
  const b = backend;
  const pending = opening;
  if (!b || closing) {
    pending?.abort.abort(new DOMException("Mailbox opening stopped", "AbortError"));
    await pending?.done;
    await closing;
    return send({ type: "shutdown-result", id: msg.id, outcome: "closed" });
  }
  const outcome = await b.quiesce(msg.deadlineMs);
  if (outcome === "sending" && !msg.force) {
    b.resume();
    send({ type: "shutdown-result", id: msg.id, outcome: "sending" });
    void b.sendsIdle().then(() => send({ type: "sends-idle" }));
    return;
  }
  pending?.abort.abort(new DOMException("Mailbox opening stopped", "AbortError"));
  await pending?.done;
  if (closing) await closing;
  else closing = b.stop().catch((error: unknown) => void captureError(error, { code: "backend.fatal", expected: false }));
  await closing;
  flushDiag();
  send({ type: "shutdown-result", id: msg.id, outcome: outcome === "sending" ? "forced" : "closed" });
}

process.on("uncaughtException", (e) => die(e, "process.uncaught"));
process.on("unhandledRejection", (e) => die(e, "process.unhandled_rejection"));
