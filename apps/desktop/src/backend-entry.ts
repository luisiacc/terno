/**
 * Runs in an Electron utilityProcess (plain Node + node:sqlite). It owns the
 * database and sync; the renderer talks to it over a direct MessagePort, so
 * mail data never hops through the main process.
 */
import { Backend, seedDemo, startAgentSocket, type LegacySecretReader, type SecretCipher } from "@terno/backend";
import { captureError, installDiag, log, type DiagEntry, type DiagOptions } from "@terno/core/diag";
import { isRpcMessage, type RpcMessage, type Transport } from "@terno/core/rpc";
import { createRegistry } from "@terno/mail/registry";
import type { BackendToMain, MainToBackend } from "./ipc";

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
  context: () => ({ os: process.platform === "darwin" ? "darwin" : "other", arch: process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other", runtime: `node-${process.versions.node}`, engine: "node-sqlite", accounts }),
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

parentPort.on("message", async (event) => {
  const msg = event.data;
  if (msg.type === "secret-result") {
    const p = pendingSecrets.get(msg.id);
    pendingSecrets.delete(msg.id);
    if (!p) return;
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error ?? "secret storage failed"));
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
  if (msg.type === "network") {
    // before init there is nothing to tell (init carries the state); after a stop, nothing to do
    backend?.networkChanged(msg.online, msg.reason);
    return;
  }
  if (msg.type === "init") {
    installDiag(diagOptions({ version: msg.version, build: msg.diag.build, channel: msg.diag.channel, session: msg.diag.session }));
    try {
      backend = new Backend({
        dbPath: msg.dbPath,
        version: msg.version,
        cipher,
        legacySecrets,
        // the demo mailbox's sends go to the packaged smoke's SMTP server when it asks (main checked it may)
        // and plan 38's notification smoke adds an IMAP account on its own plain-text server (the demo mailbox only)
        providers: createRegistry({ ...(msg.demo && msg.testSmtpPort && { demoSmtpPort: msg.testSmtpPort }), ...(msg.demo && msg.testImapInsecure && { imap: { allowInsecure: true } }) }),
        openExternal: async (url) => send({ type: "open-external", url }),
        demoAi: msg.demo || msg.dev,
        demo: msg.demo,
        online: msg.online,
        onPolicy: (policy) => send({ type: "policy", ...policy }),
        // plan 38: main owns the Dock and the notifications (they work with every window closed)
        attention: { badge: (count) => send({ type: "badge", count }), notify: (notice) => send({ type: "notify", notice }) },
        // free-form lines (the store, the search engine): the log keeps that one happened, never its text
        // (it can quote a provider's or a model's answer); a dev build also prints it
        log: (level, message, extra) => {
          log[level]("log.message", { source: "backend" });
          if (msg.dev) console[level](`[backend] ${message}`, extra ?? "");
        },
      });
      if (msg.demo && (await seedDemo(backend.store, { threads: 3000, accounts: 4 }))) {
        await backend.store.settings.set("app", { ai: { provider: "fake" } });
      }
      await backend.publishPolicy();
      await backend.start();
      await startAgentSocket(backend, msg.socketPath, msg.tokenPath).catch((e) => log.warn("agents.socket_failed", { errno: (e as { code?: string }).code }));
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
      // a backend that can't open its mailbox is no backend: main restarts it, then shows that it stopped
      die(error, "backend.init_failed");
    }
  }
});

let closing: Promise<void> | null = null;

/** See MainToBackend "shutdown": a send in flight is never cut short unless main says so. */
async function shutdown(msg: Extract<MainToBackend, { type: "shutdown" }>): Promise<void> {
  const b = backend;
  if (!b || closing) {
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
  if (closing) await closing;
  else closing = b.stop().catch((error: unknown) => void captureError(error, { code: "backend.fatal", expected: false }));
  await closing;
  flushDiag();
  send({ type: "shutdown-result", id: msg.id, outcome: outcome === "sending" ? "forced" : "closed" });
}

process.on("uncaughtException", (e) => die(e, "process.uncaught"));
process.on("unhandledRejection", (e) => die(e, "process.unhandled_rejection"));
