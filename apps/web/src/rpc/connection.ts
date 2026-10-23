import { isRpcMessage, RpcClient, type RpcMessage, type Transport } from "@unica/core/rpc";

function portTransport(port: MessagePort): Transport {
  const listeners = new Set<(m: RpcMessage) => void>();
  const closeListeners = new Set<() => void>();
  port.onmessage = (e) => {
    if (isRpcMessage(e.data)) for (const l of listeners) l(e.data);
  };
  // Chromium fires "close" on MessagePort when the other side goes away (utility process crash).
  port.addEventListener("close", () => {
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

function wsTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const listeners = new Set<(m: RpcMessage) => void>();
    const closeListeners = new Set<() => void>();
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (isRpcMessage(msg)) for (const l of listeners) l(msg);
    };
    ws.onclose = () => {
      for (const l of closeListeners) l();
    };
    ws.onerror = () => reject(new Error(`Cannot reach backend at ${url}`));
    ws.onopen = () =>
      resolve({
        send: (m) => ws.send(JSON.stringify(m)),
        onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
        onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
        close: () => ws.close(),
      });
  });
}

/** Desktop: wait for the preload to hand us a MessagePort to the backend utility process. */
function nextDesktopPort(): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === window && e.data === "unica:backend-port" && e.ports[0]) {
        window.removeEventListener("message", onMessage);
        resolve(e.ports[0]);
      }
    };
    window.addEventListener("message", onMessage);
  });
}

export const client = new RpcClient(undefined, { defaultTimeoutMs: 30_000 });

export async function connectBackend(): Promise<void> {
  if (window.unicaDesktop) {
    client.attach(portTransport(await nextDesktopPort()));
    // main re-sends a fresh port if the backend restarts; reattach transparently
    client.onClose(() => void nextDesktopPort().then((p) => client.attach(portTransport(p))));
    return;
  }
  const params = new URLSearchParams(location.search);
  const url = params.get("backend") ?? import.meta.env.VITE_BACKEND_URL ?? "ws://127.0.0.1:5174";
  const token = params.get("token") ?? import.meta.env.VITE_BACKEND_TOKEN ?? "dev";
  client.attach(await wsTransport(`${url}?token=${encodeURIComponent(token)}`));
}
