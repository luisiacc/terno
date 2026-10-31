import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { BODY_PART_UNITS } from "./body-parts";

const unavailable = () => new RpcError("UNAVAILABLE", L("errors.mail.processingBusy"));

export interface BodyPreparationWorker {
  post(value: unknown, transfer: ArrayBuffer[]): void;
  terminate(): Promise<void>;
}
export type BodyPreparationFactory = (message: (value: unknown) => void, failure: () => void) => BodyPreparationWorker;

/** Runs only in an isolated worker; one input/output part is acknowledged at a time. */
export function bodyPreparationWorkerMain(): void {
  const host = globalThis as unknown as { onmessage: ((event: { data: { type: string; value?: Uint16Array } }) => void) | null; postMessage(value: unknown, transfer?: ArrayBuffer[]): void };
  const levels: (string | undefined)[] = [];
  let resume: (() => void) | undefined;
  host.onmessage = (event) => {
    const message = event.data;
    if (message.type === "ack") { const next = resume; resume = undefined; next?.(); return; }
    if (message.type === "part") {
      let text = String.fromCharCode(...message.value!), level = 0;
      while (levels[level] !== undefined) { text = levels[level]! + text; levels[level] = undefined; level++; }
      levels[level] = text;
      host.postMessage({ type: "ack" });
      return;
    }
    if (message.type !== "end") return;
    void (async () => {
      let text = "";
      for (let i = levels.length - 1; i >= 0; i--) if (levels[i] !== undefined) text += levels[i];
      levels.length = 0;
      const folded = text.normalize("NFD").replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, "$1").normalize("NFC").toLowerCase();
      text = "";
      const words = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
      let part = new Uint16Array(32768), at = 1;
      const flush = async () => {
        const output = at === part.length ? part : part.slice(0, at);
        const acknowledged = new Promise<void>((resolve) => { resume = resolve; });
        host.postMessage({ type: "tokens", value: output }, [output.buffer]);
        await acknowledged;
        part = new Uint16Array(32768); at = 0;
      };
      for (let match; (match = words.exec(folded));) {
        const token = match[0];
        for (let i = 0; i <= token.length; i++) {
          part[at++] = i === token.length ? 0 : token.charCodeAt(i);
          if (at === part.length) await flush();
        }
      }
      if (at) await flush();
      host.postMessage({ type: "done" });
    })().catch(() => host.postMessage({ type: "fault" }));
  };
}

export function browserBodyPreparationFactory(message: (value: unknown) => void, failure: () => void): BodyPreparationWorker {
  // The platform owns the browser APIs; the store package also typechecks without DOM ambient types.
  const host = globalThis as unknown as { Blob: new (parts: string[], options: { type: string }) => unknown; URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void }; Worker: new (url: string) => { onmessage: ((event: { data: unknown }) => void) | null; onerror: (() => void) | null; postMessage(value: unknown, transfer: ArrayBuffer[]): void; terminate(): void } };
  const url = host.URL.createObjectURL(new host.Blob([`(${bodyPreparationWorkerMain.toString()})()`], { type: "text/javascript" }));
  const worker = new host.Worker(url);
  host.URL.revokeObjectURL(url);
  worker.onmessage = (event) => message(event.data); worker.onerror = failure;
  return { post: (value, transfer) => worker.postMessage(value, transfer), async terminate() { worker.terminate(); } };
}

/** Parent work and transport are one exact UTF16 part per turn; normalization stays off-thread. */
export async function* prepareBodyTokens(text: string | readonly string[], yieldTo: () => Promise<void>, factory: BodyPreparationFactory, check?: () => void): AsyncGenerator<Uint16Array> {
  let waiting: { resolve(value: { type: string; value?: Uint16Array }): void; reject(error: Error): void } | undefined;
  let pending: { type: string; value?: Uint16Array } | undefined, failed = false;
  const fault = () => { failed = true; waiting?.reject(unavailable()); waiting = undefined; };
  const worker = factory((value) => {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") { fault(); return; }
    const reply = value as { type: string; value?: Uint16Array };
    if (reply.type === "fault" || pending) { fault(); return; }
    if (waiting) { const next = waiting; waiting = undefined; next.resolve(reply); } else pending = reply;
  }, fault);
  const next = async () => {
    if (failed) throw unavailable();
    if (pending) { const reply = pending; pending = undefined; return reply; }
    return new Promise<{ type: string; value?: Uint16Array }>((resolve, reject) => {
      const timer = setTimeout(() => { failed = true; waiting = undefined; reject(unavailable()); }, 30000);
      waiting = { resolve: (reply) => { clearTimeout(timer); resolve(reply); }, reject: (error) => { clearTimeout(timer); reject(error); } };
    });
  };
  try {
    const chunks = typeof text === "string" ? (function* () { for (let start = 0; start < text.length; start += BODY_PART_UNITS) yield text.slice(start, start + BODY_PART_UNITS); })() : text;
    for (const chunk of chunks) {
      check?.();
      if (chunk.length > BODY_PART_UNITS) throw new Error("Body preparation part exceeds its storage unit");
      const part = new Uint16Array(chunk.length);
      for (let i = 0; i < part.length; i++) part[i] = chunk.charCodeAt(i);
      worker.post({ type: "part", value: part }, [part.buffer]);
      if ((await next()).type !== "ack") throw unavailable();
      await yieldTo();
    }
    worker.post({ type: "end" }, []);
    for (;;) {
      check?.();
      const reply = await next();
      if (reply.type === "done") return;
      const part = reply.value;
      if (reply.type !== "tokens" || !(part instanceof Uint16Array) || !part.length || part.length > BODY_PART_UNITS || part.byteOffset || part.byteLength !== part.buffer.byteLength) throw unavailable();
      yield part;
      check?.();
      worker.post({ type: "ack" }, []);
    }
  } finally { await worker.terminate(); }
}
