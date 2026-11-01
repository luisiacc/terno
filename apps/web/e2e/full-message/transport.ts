import { useThreads } from "../../src/state/threads";
import { client } from "../../src/rpc/connection";
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0u0AAAAASUVORK5CYII=";
export const calls: string[] = [];
let receive: Parameters<Parameters<typeof client.attach>[0]["onMessage"]>[0] | undefined;
client.attach({
  send(message) {
    if (message.t !== "req") return;
    calls.push(message.m);
    const result = message.m === "attachments.info" ? { size: atob(PNG).length, mime: "image/png", filename: "Logo.png" } : message.m === "attachments.read" ? { dataBase64: PNG } : message.m === "threads.get" ? useThreads.getState().details.get(1) : undefined;
    queueMicrotask(() => receive?.({ v: message.v, t: "res", id: message.id, ok: true, r: result }));
  },
  onMessage(listener) { receive = listener; return () => { receive = undefined; }; },
  onClose() { return () => {}; },
  close() {},
});
