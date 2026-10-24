/**
 * Runs in an Electron utilityProcess (plain Node + node:sqlite). It owns the
 * database and sync; the renderer talks to it over a direct MessagePort, so
 * mail data never hops through the main process.
 */
import { Backend, seedDemo, startAgentSocket, type LegacySecretReader, type SecretCipher } from "@terno/backend";
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
  if (msg.type === "port") {
    const port = event.ports[0];
    if (port && backend) backend.connect(portTransport(port), { clientId: msg.clientId, origin: "renderer" });
    return;
  }
  if (msg.type === "init") {
    try {
      backend = new Backend({
        dbPath: msg.dbPath,
        version: msg.version,
        cipher,
        legacySecrets,
        providers: createRegistry(),
        openExternal: async (url) => send({ type: "open-external", url }),
        demoAi: msg.demo || msg.dev,
        demo: msg.demo,
        onPolicy: (policy) => send({ type: "policy", ...policy }),
        log: (level, message, extra) => send({ type: "log", level, message: extra ? `${message} ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : message }),
      });
      if (msg.demo && (await seedDemo(backend.store, { threads: 3000, accounts: 4 }))) {
        await backend.store.settings.set("app", { ai: { provider: "fake" } });
      }
      await backend.publishPolicy();
      await backend.start();
      await startAgentSocket(backend, msg.socketPath, msg.tokenPath).catch((e) =>
        send({ type: "log", level: "warn", message: `agent socket unavailable: ${e instanceof Error ? e.message : e}` }),
      );
      send({ type: "ready" });
    } catch (error) {
      send({ type: "fatal", message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
  }
});

process.on("uncaughtException", (e) => send({ type: "log", level: "error", message: `uncaught: ${e.stack ?? e.message}` }));
process.on("unhandledRejection", (e) => send({ type: "log", level: "error", message: `unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}` }));
