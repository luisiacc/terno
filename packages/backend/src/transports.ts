import type { Socket } from "node:net";
import { isRpcMessage, type RpcMessage, type Transport } from "@terno/core/rpc";
import type { WebSocket } from "ws";

/** Newline-delimited JSON over a stream socket (MCP sidecar ↔ backend). */
export function socketTransport(socket: Socket): Transport {
  const listeners = new Set<(m: RpcMessage) => void>();
  const closeListeners = new Set<() => void>();
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (isRpcMessage(msg)) for (const l of listeners) l(msg);
      } catch {
        socket.destroy(new Error("malformed frame"));
      }
    }
  });
  socket.on("close", () => {
    for (const l of closeListeners) l();
  });
  socket.on("error", () => {});
  return {
    send: (m) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
    },
    onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
    onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
    close: () => socket.end(),
  };
}

/** WebSocket transport (dev-in-browser and Playwright). */
export function webSocketTransport(ws: WebSocket): Transport {
  const listeners = new Set<(m: RpcMessage) => void>();
  const closeListeners = new Set<() => void>();
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (isRpcMessage(msg)) for (const l of listeners) l(msg);
    } catch {
      ws.close(1003, "malformed frame");
    }
  });
  ws.on("close", () => {
    for (const l of closeListeners) l();
  });
  return {
    send: (m) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    },
    onMessage: (l) => (listeners.add(l), () => listeners.delete(l)),
    onClose: (l) => (closeListeners.add(l), () => closeListeners.delete(l)),
    close: () => ws.close(),
  };
}
