import type { RpcMessage, Transport } from "./envelope";

/**
 * In-memory transport pair. Messages are delivered asynchronously via a
 * microtask and deep-cloned with structuredClone, mirroring MessagePort semantics
 * so tests catch accidental reliance on shared object identity.
 */
export function createMemoryTransportPair(): [Transport, Transport] {
  type Side = { listeners: Set<(m: RpcMessage) => void>; closeListeners: Set<() => void>; closed: boolean };
  const a: Side = { listeners: new Set(), closeListeners: new Set(), closed: false };
  const b: Side = { listeners: new Set(), closeListeners: new Set(), closed: false };
  const make = (self: Side, peer: Side): Transport => ({
    send(message) {
      if (self.closed) throw new Error("transport closed");
      const copy = structuredClone(message);
      queueMicrotask(() => {
        if (!peer.closed) for (const l of peer.listeners) l(copy);
      });
    },
    onMessage(listener) {
      self.listeners.add(listener);
      return () => self.listeners.delete(listener);
    },
    onClose(listener) {
      self.closeListeners.add(listener);
      return () => self.closeListeners.delete(listener);
    },
    close() {
      for (const side of [self, peer]) {
        if (side.closed) continue;
        side.closed = true;
        for (const l of side.closeListeners) l();
      }
    },
  });
  return [make(a, b), make(b, a)];
}
